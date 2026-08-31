import { createHash } from 'crypto';
import { config } from './config';
import type { RedisClientType } from 'redis';
import { logger } from './logger';
import { cacheBackendStatus } from './metrics';
import { cacheResourceFor, ttlForResource } from './cache-ttl';

const CACHE_URL = config.cacheUrl ?? 'memory://';
const CACHE_MODE = config.cacheMode ?? 'standalone'; // 'standalone' or 'sentinel'

const MAX_CACHE_SIZE = Math.max(1, parseInt(process.env.CACHE_MAX_SIZE ?? '1000'));
const DEFAULT_MEMORY_TTL_SECONDS = Math.max(1, parseInt(process.env.CACHE_MEMORY_TTL ?? '300'));
const L1_STALE_REFRESH_FACTOR = 0.8;
const INVALIDATION_CHANNEL = '__cache:invalidate';

// ── Cache-key hardening (#894) ──────────────────────────────────────────────
// Callers routinely build keys by concatenating user-controlled input
// directly, e.g. `abi:${address}` or `anchor:proof:${address}:${version}`.
// Left un-normalized that allows: (a) unbounded key cardinality — an
// attacker varying case/whitespace, or supplying arbitrarily long free-text
// (an NLQ query, a JSON-serialized filter object), can multiply cache
// entries for what should be one logical resource, evicting legitimate
// entries out of the bounded in-memory LRU or growing the Redis keyspace
// without limit; and (b) key collisions across logically distinct requests
// — a dynamic segment containing the ':' delimiter can make two different
// (segment1, segment2) pairs concatenate to the identical storage key,
// letting one cached response be served for an unrelated request (cache
// poisoning). `normalizeKeyInput` is applied to every key that reaches
// storage; `buildCacheKey` is the safe way to assemble a key from more than
// one dynamic segment.
const CACHE_SCHEMA_VERSION = 'v1'; // bump to invalidate every cached entry after a schema change
const MAX_KEY_LENGTH = 300;
const MAX_KEY_SEGMENT_LENGTH = 128;

interface MemoryEntry {
  payload: string;
  expiresAt: number | null;
  versionHash: string | null;
}

const memoryStore = new Map<string, MemoryEntry>();
let redisClient: RedisClientType | null = null;
let redisAvailable = false;
let _evictionCount = 0;
let _pubSubClient: RedisClientType | null = null;
let cleanupInterval: ReturnType<typeof setInterval> | null = null;
const CLEANUP_INTERVAL_MS = 60_000; // 1 minute

/**
 * Parse Redis Sentinel URL format:
 * sentinel://sentinelHost1:26379,sentinelHost2:26379,sentinelHost3:26379?sentinels=mymaster&password=xxxx&db=0
 */
function parseSentinelUrl(url: string): {
  sentinels: Array<{ host: string; port: number }>;
  name: string;
  password?: string;
  db?: number;
  username?: string;
  sentinelPassword?: string;
} {
  try {
    const urlObj = new URL(url);
    const hostPort = urlObj.hostname + (urlObj.port ? ':' + urlObj.port : '');
    const hosts = urlObj.pathname.slice(1).split(',').concat(hostPort.split(','));

    const sentinels = hosts
      .filter((h) => h.trim())
      .map((h) => {
        const [host, port] = h.trim().split(':');
        return {
          host: host || 'localhost',
          port: parseInt(port || '26379', 10),
        };
      });

    const name = urlObj.searchParams.get('sentinels') || 'mymaster';
    const password = urlObj.searchParams.get('password') || undefined;
    const username = urlObj.searchParams.get('username') || undefined;
    const db = urlObj.searchParams.get('db') ? parseInt(urlObj.searchParams.get('db')!, 10) : 0;
    const sentinelPassword = urlObj.searchParams.get('sentinel-password') || undefined;

    return { sentinels, name, password, username, db, sentinelPassword };
  } catch (err) {
    throw new Error(
      `Invalid Sentinel URL format: ${url}. Expected: sentinel://host1:26379,host2:26379?sentinels=mymaster&password=xxx`,
    );
  }
}

export function cacheStats(): { size: number; evictions: number } {
  return { size: memoryStore.size, evictions: _evictionCount };
}

function localNow(): number {
  return Date.now();
}

function computeVersionHash(payload: string): string {
  let hash = 0;
  for (let i = 0; i < payload.length; i++) {
    const chr = payload.charCodeAt(i);
    hash = ((hash << 5) - hash + chr) | 0;
  }
  return (hash >>> 0).toString(36);
}

function stripControlChars(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x1f\x7f]/g, '');
}

/**
 * Normalizes any key before it touches the memory store or Redis: trims,
 * strips control characters, and folds case so equivalent-but-differently-
 * cased inputs (an address typed in mixed case, say) share one cache entry
 * instead of silently multiplying. Keys longer than MAX_KEY_LENGTH — a
 * free-text NLQ query or a JSON-serialized filter object used as a cache
 * key, for example — are collapsed to a bounded, content-addressed form so
 * a single caller cannot grow the keyspace without limit.
 */
function normalizeKeyInput(rawKey: string): string {
  const cleaned = stripControlChars(String(rawKey)).trim().toLowerCase();
  if (cleaned.length <= MAX_KEY_LENGTH) return cleaned;
  const digest = createHash('sha256').update(cleaned).digest('hex').slice(0, 32);
  return `${cleaned.slice(0, MAX_KEY_LENGTH - 40)}~h.${digest}`;
}

/**
 * Prepares one dynamic segment for use inside a colon-delimited key built by
 * buildCacheKey(). Percent-encodes '%' and ':' so a segment that itself
 * contains the ':' delimiter (an unusual — or malicious — address, tx hash,
 * or query string) can't be mistaken for an extra path segment once joined.
 * That's what stops, say, buildCacheKey('anchor:proof', 'abc', '1') and
 * buildCacheKey('anchor:proof', 'abc:1') from colliding on the same storage
 * key despite carrying different (address, version) pairs. Segments longer
 * than MAX_KEY_SEGMENT_LENGTH are hashed down for the same
 * unbounded-cardinality reason as normalizeKeyInput above.
 */
function escapeKeySegment(part: string | number): string {
  const cleaned = stripControlChars(String(part)).trim().toLowerCase();
  const escaped = cleaned.replace(/%/g, '%25').replace(/:/g, '%3a');
  if (escaped.length <= MAX_KEY_SEGMENT_LENGTH) return escaped;
  const digest = createHash('sha256').update(escaped).digest('hex').slice(0, 24);
  return `h.${digest}`;
}

/**
 * Safely builds a namespaced, multi-part cache key from a fixed
 * (developer-controlled) namespace and one or more dynamic (potentially
 * user-controlled) parts. Prefer this over manual `${a}:${b}` template
 * strings whenever a key has more than one dynamic segment — see
 * escapeKeySegment for why. cacheGet/cacheSet/cacheDelete still apply the
 * schema-version prefix and final normalization on top; this only prevents
 * segment collisions at the point the key is assembled.
 */
export function buildCacheKey(namespace: string, ...parts: Array<string | number>): string {
  const ns = stripControlChars(namespace).trim().toLowerCase();
  return [ns, ...parts.map(escapeKeySegment)].join(':');
}

function buildExpiry(ttlSeconds: number | null | undefined): number | null {
  if (ttlSeconds === undefined || ttlSeconds === null) return null;
  if (ttlSeconds <= 0) return null;
  return localNow() + ttlSeconds * 1000;
}

function computeMemoryExpiry(redisTTLms: number): number {
  if (redisTTLms > 0) {
    const l1Ttl = redisTTLms * L1_STALE_REFRESH_FACTOR;
    return localNow() + l1Ttl;
  }
  return localNow() + DEFAULT_MEMORY_TTL_SECONDS * 1000;
}

function isExpired(entry: MemoryEntry): boolean {
  return entry.expiresAt !== null && entry.expiresAt <= localNow();
}

function lruSet(key: string, entry: MemoryEntry): void {
  if (memoryStore.has(key)) {
    memoryStore.delete(key);
  } else if (memoryStore.size >= MAX_CACHE_SIZE) {
    const oldestKey = memoryStore.keys().next().value;
    if (oldestKey !== undefined) {
      memoryStore.delete(oldestKey);
      _evictionCount++;
    }
  }
  memoryStore.set(key, entry);
}

function lruGet(key: string): MemoryEntry | undefined {
  const entry = memoryStore.get(key);
  if (entry !== undefined) {
    memoryStore.delete(key);
    memoryStore.set(key, entry);
  }
  return entry;
}

async function getRedisClient(): Promise<RedisClientType | null> {
  if (CACHE_URL === '' || CACHE_URL.startsWith('memory://')) return null;
  if (redisClient) return redisClient;

  try {
    const { createClient } = await import('redis');

    if (CACHE_MODE === 'sentinel') {
      const sentinelConfig = parseSentinelUrl(CACHE_URL);
      logger.info('[cache] Connecting to Redis Sentinel', {
        backend: 'sentinel',
        sentinelCount: sentinelConfig.sentinels.length,
        masterName: sentinelConfig.name,
      });

      const clientOptions: Record<string, unknown> = {
        socket: {
          sentinels: sentinelConfig.sentinels,
          sentinelRetryStrategy: (retries: number) => Math.min(retries * 50, 500),
        },
        name: sentinelConfig.name,
        password: sentinelConfig.password,
        username: sentinelConfig.username,
        db: sentinelConfig.db,
      };

      if (sentinelConfig.sentinelPassword) {
        (clientOptions.socket as Record<string, unknown>).sentinelPassword =
          sentinelConfig.sentinelPassword;
      }

      const client = createClient(clientOptions) as RedisClientType;

      client.on('error', (err: unknown) => {
        logger.error('[cache] Redis Sentinel client error', {
          backend: 'sentinel',
          error: String(err),
        });
        redisAvailable = false;
        cacheBackendStatus.set(0);
      });

      client.on('reconnecting', () => {
        logger.info('[cache] Redis Sentinel reconnecting', { backend: 'sentinel' });
      });

      await client.connect();
      redisClient = client;
      redisAvailable = true;
      logger.info('[cache] Connected to Redis Sentinel', {
        backend: 'sentinel',
        masterName: sentinelConfig.name,
      });
      cacheBackendStatus.set(1);
      return redisClient;
    } else {
      // Standalone mode
      const client = createClient({ url: CACHE_URL }) as RedisClientType;
      client.on('error', (err: unknown) => {
        logger.error('[cache] Redis client error', { backend: 'redis', error: String(err) });
        redisAvailable = false;
        cacheBackendStatus.set(0);
      });
      await client.connect();
      redisClient = client;
      redisAvailable = true;
      logger.info('[cache] Connected to Redis cache', { backend: 'redis' });
      cacheBackendStatus.set(1);
      return redisClient;
    }
  } catch (err: unknown) {
    logger.warn('[cache] Could not connect to Redis, falling back to in-memory cache', {
      backend: CACHE_MODE,
      error: String(err),
      cacheBackend: 'memory',
      alert: 'CACHE_FALLBACK',
    });
    redisAvailable = false;
    cacheBackendStatus.set(0);
    return null;
  }
}

function versionKey(key: string): string {
  return `__v:${key}`;
}

async function setupPubSub(): Promise<void> {
  if (CACHE_URL === '' || CACHE_URL.startsWith('memory://') || _pubSubClient) return;

  try {
    const { createClient } = await import('redis');

    if (CACHE_MODE === 'sentinel') {
      const sentinelConfig = parseSentinelUrl(CACHE_URL);
      const clientOptions: Record<string, unknown> = {
        socket: {
          sentinels: sentinelConfig.sentinels,
          sentinelRetryStrategy: (retries: number) => Math.min(retries * 50, 500),
        },
        name: sentinelConfig.name,
        password: sentinelConfig.password,
        username: sentinelConfig.username,
        db: sentinelConfig.db,
      };

      if (sentinelConfig.sentinelPassword) {
        (clientOptions.socket as Record<string, unknown>).sentinelPassword =
          sentinelConfig.sentinelPassword;
      }

      const sub = createClient(clientOptions) as RedisClientType;

      sub.on('error', (err: unknown) => {
        logger.error('[cache] Pub/sub Sentinel client error', {
          backend: 'sentinel',
          error: String(err),
        });
      });

      await sub.connect();
      await sub.subscribe(INVALIDATION_CHANNEL, (message: string) => {
        memoryStore.delete(message);
      });
      _pubSubClient = sub;
      logger.info('[cache] Pub/sub listener registered (Sentinel)', {
        channel: INVALIDATION_CHANNEL,
      });
    } else {
      // Standalone
      const sub = createClient({ url: CACHE_URL }) as RedisClientType;
      sub.on('error', (err: unknown) => {
        logger.error('[cache] Pub/sub client error', { backend: 'redis', error: String(err) });
      });

      await sub.connect();
      await sub.subscribe(INVALIDATION_CHANNEL, (message: string) => {
        memoryStore.delete(message);
      });
      _pubSubClient = sub;
      logger.info('[cache] Pub/sub listener registered', { channel: INVALIDATION_CHANNEL });
    }
  } catch (err: unknown) {
    logger.warn('[cache] Could not set up pub/sub listener', { error: String(err) });
  }
}

async function publishInvalidation(key: string): Promise<void> {
  if (CACHE_URL === '' || CACHE_URL.startsWith('memory://') || !redisClient) return;
  try {
    await redisClient.publish(INVALIDATION_CHANNEL, key);
  } catch (err) {
    logger.warn('[cache] Failed to publish invalidation', {
      key: redactKey(key),
      error: String(err),
    });
  }
}

export function redactKey(key: string): string {
  const parts = key.split(':');
  if (parts.length <= 1) return key;
  // A leading schema-version segment (e.g. "v1") isn't sensitive and isn't
  // useful for identifying which cache namespace failed, so skip past it
  // when present and keep the real namespace segment visible instead.
  const start = /^v\d+$/i.test(parts[0]) && parts.length > 2 ? 1 : 0;
  return `${parts.slice(0, start + 1).join(':')}:[redacted]`;
}

export async function cacheConnect(): Promise<void> {
  performStaleCleanup();
  cleanupInterval = setInterval(performStaleCleanup, CLEANUP_INTERVAL_MS);

  const isMemoryOnly = CACHE_URL === '' || CACHE_URL.startsWith('memory://');
  if (isMemoryOnly) {
    // Pure in-memory mode is intentional — metric reflects actual backend.
    cacheBackendStatus.set(0);
    logger.info('[cache] Operating in pure in-memory cache mode', {
      backend: 'memory',
      cacheBackend: 'memory',
    });
  }

  await getRedisClient();
  await setupPubSub();
}

export function isCacheReady(): boolean {
  const isMemoryOnly = CACHE_URL === '' || CACHE_URL.startsWith('memory://');
  return isMemoryOnly || redisAvailable;
}

export function cacheBackendType(): 'redis' | 'sentinel' | 'memory' {
  if (CACHE_URL === '' || CACHE_URL.startsWith('memory://')) return 'memory';
  if (!redisAvailable) return 'memory';
  if (CACHE_MODE === 'sentinel') return 'sentinel';
  return 'redis';
}

export async function pingRedis(): Promise<boolean> {
  if (CACHE_URL === '' || CACHE_URL.startsWith('memory://')) return true;
  if (!redisClient || !redisAvailable) return false;
  try {
    const reply = await redisClient.ping();
    return reply === 'PONG';
  } catch {
    return false;
  }
}

export async function cacheClose(): Promise<void> {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
  if (_pubSubClient) {
    try {
      await _pubSubClient.unsubscribe(INVALIDATION_CHANNEL);
      await _pubSubClient.quit();
    } catch {
      await _pubSubClient.disconnect();
    }
    _pubSubClient = null;
  }
  if (redisClient) {
    try {
      await redisClient.quit();
    } catch {
      await redisClient.disconnect();
    }
    redisClient = null;
    redisAvailable = false;
  }
}

export function cacheClear(): void {
  memoryStore.clear();
  _evictionCount = 0;
}

/** Removes expired entries from the in-memory store. */
function performStaleCleanup(): void {
  let removed = 0;
  for (const [key, entry] of memoryStore) {
    if (isExpired(entry)) {
      memoryStore.delete(key);
      removed++;
    }
  }
  if (removed > 0) {
    _evictionCount += removed;
  }
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  const normalizedKey = `${CACHE_SCHEMA_VERSION}:${normalizeKeyInput(key)}`;

  const local = lruGet(normalizedKey);
  if (local) {
    if (isExpired(local)) {
      memoryStore.delete(normalizedKey);
    } else {
      try {
        return JSON.parse(local.payload) as T;
      } catch {
        memoryStore.delete(normalizedKey);
      }
    }
  }

  const client = await getRedisClient();
  if (!client) return null;

  try {
    const payload = await client.get(normalizedKey);
    const vHash = await client.get(versionKey(normalizedKey));
    const pttl = await (
      client as RedisClientType & { pTTL: (key: string) => Promise<number> }
    ).pTTL(normalizedKey);

    if (!payload) return null;

    const versionHash = vHash ?? null;

    if (
      local &&
      local.versionHash !== null &&
      versionHash !== null &&
      local.versionHash !== versionHash
    ) {
      memoryStore.delete(normalizedKey);
      const value = JSON.parse(payload) as T;
      lruSet(normalizedKey, {
        payload,
        expiresAt: computeMemoryExpiry(Math.max(pttl, 0)),
        versionHash,
      });
      return value;
    }

    const expiresAt =
      pttl > 0
        ? localNow() + pttl * L1_STALE_REFRESH_FACTOR
        : localNow() + DEFAULT_MEMORY_TTL_SECONDS * 1000;
    const value = JSON.parse(payload) as T;
    lruSet(normalizedKey, { payload, expiresAt, versionHash });
    return value;
  } catch (err) {
    logger.warn('[cache] Failed to read key from Redis', {
      backend: CACHE_MODE,
      operation: 'get',
      key: redactKey(normalizedKey),
      error: String(err),
    });
    return null;
  }
}

export async function cacheSet<T>(
  key: string,
  value: T,
  ttlSeconds?: number | null,
): Promise<void> {
  // #917 — when the caller doesn't specify a TTL, resolve one from the
  // per-route TTL registry (src/cache-ttl.ts) keyed by the resource namespace
  // (first `:`-delimited segment of the key). Explicit TTLs always win, so
  // existing tuned call sites are untouched.
  const resolvedTtl = ttlSeconds === undefined ? ttlForResource(cacheResourceFor(key)) : ttlSeconds;

  const normalizedKey = `${CACHE_SCHEMA_VERSION}:${normalizeKeyInput(key)}`;
  const payload = JSON.stringify(value);
  const versionHash = computeVersionHash(payload);
  lruSet(normalizedKey, {
    payload,
    expiresAt: buildExpiry(resolvedTtl),
    versionHash,
  });

  const client = await getRedisClient();
  if (!client) return;

  try {
    const multi = client.multi();
    if (resolvedTtl && resolvedTtl > 0) {
      multi.set(normalizedKey, payload, { EX: resolvedTtl });
      multi.set(versionKey(normalizedKey), versionHash, { EX: resolvedTtl });
    } else {
      multi.set(normalizedKey, payload);
      multi.set(versionKey(normalizedKey), versionHash);
    }
    await multi.exec();
    await publishInvalidation(normalizedKey);
  } catch (err) {
    logger.warn('[cache] Failed to write key to Redis', {
      backend: CACHE_MODE,
      operation: 'set',
      key: redactKey(normalizedKey),
      error: String(err),
    });
  }
}

export async function cacheDelete(key: string): Promise<void> {
  const normalizedKey = `${CACHE_SCHEMA_VERSION}:${normalizeKeyInput(key)}`;
  memoryStore.delete(normalizedKey);
  const client = await getRedisClient();
  if (!client) return;

  try {
    await Promise.all([client.del(normalizedKey), client.del(versionKey(normalizedKey))]);
    await publishInvalidation(normalizedKey);
  } catch (err) {
    logger.warn('[cache] Failed to delete key from Redis', {
      backend: CACHE_MODE,
      operation: 'delete',
      key: redactKey(normalizedKey),
      error: String(err),
    });
  }
}
