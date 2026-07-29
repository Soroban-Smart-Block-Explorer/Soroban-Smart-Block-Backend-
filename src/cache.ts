import { config } from './config';
import type { RedisClientType } from 'redis';
import { logger } from './logger';

const CACHE_URL = config.cacheUrl ?? 'memory://';
const USE_REDIS = CACHE_URL !== '' && !CACHE_URL.startsWith('memory://');

const MAX_CACHE_SIZE = Math.max(1, parseInt(process.env.CACHE_MAX_SIZE ?? '1000'));
const DEFAULT_MEMORY_TTL_SECONDS = Math.max(1, parseInt(process.env.CACHE_MEMORY_TTL ?? '300'));
const L1_STALE_REFRESH_FACTOR = 0.8;
const INVALIDATION_CHANNEL = '__cache:invalidate';

interface MemoryEntry {
  payload: string;
  expiresAt: number | null;
  versionHash: string | null;
}

const memoryStore = new Map<string, MemoryEntry>();
const MAX_MEMORY_ENTRIES = 10_000;
let redisClient: RedisClientType | null = null;
let redisAvailable = false;
let _evictionCount = 0;
let _pubSubClient: RedisClientType | null = null;

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
  if (!USE_REDIS) return null;
  if (redisClient) return redisClient;

  try {
    const { createClient } = await import('redis');
    const client = createClient({ url: CACHE_URL });
    client.on('error', (err: unknown) => {
      logger.error('[cache] Redis client error', { backend: 'redis', error: String(err) });
      redisAvailable = false;
    });
    await client.connect();
    redisClient = client;
    redisAvailable = true;
    logger.info('[cache] Connected to Redis cache', { backend: 'redis' });
    return redisClient;
  } catch (err: unknown) {
    logger.warn('[cache] Could not connect to Redis, falling back to in-memory cache', {
      backend: 'redis',
      error: String(err),
    });
    redisAvailable = false;
    return null;
  }
}

function versionKey(key: string): string {
  return `__v:${key}`;
}

async function setupPubSub(): Promise<void> {
  if (!USE_REDIS || _pubSubClient) return;
  try {
    const { createClient } = await import('redis');
    const sub = createClient({ url: CACHE_URL });
    sub.on('error', (err: unknown) => {
      logger.error('[cache] Pub/sub client error', { backend: 'redis', error: String(err) });
    });
    await sub.connect();
    await sub.subscribe(INVALIDATION_CHANNEL, (message: string) => {
      memoryStore.delete(message);
    });
    _pubSubClient = sub;
    logger.info('[cache] Pub/sub listener registered', { channel: INVALIDATION_CHANNEL });
  } catch (err: unknown) {
    logger.warn('[cache] Could not set up pub/sub listener', { error: String(err) });
  }
}

async function publishInvalidation(key: string): Promise<void> {
  if (!USE_REDIS || !redisClient) return;
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
  const separatorIndex = key.indexOf(':');
  if (separatorIndex === -1) return key;
  return `${key.slice(0, separatorIndex + 1)}***`;
}

export async function cacheConnect(): Promise<void> {
  await getRedisClient();
  await setupPubSub();
}

export function isCacheReady(): boolean {
  return !USE_REDIS || redisAvailable;
}

export function cacheBackendType(): 'redis' | 'memory' {
  return USE_REDIS && redisAvailable ? 'redis' : 'memory';
}

export async function pingRedis(): Promise<boolean> {
  if (!USE_REDIS) return true;
  if (!redisClient || !redisAvailable) return false;
  try {
    const reply = await redisClient.ping();
    return reply === 'PONG';
  } catch {
    return false;
  }
}

export async function cacheClose(): Promise<void> {
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

export async function cacheGet<T>(key: string): Promise<T | null> {
  const normalizedKey = key;

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
    const [payload, vHash, pttl] = await Promise.all([
      client.get(normalizedKey),
      client.get(versionKey(normalizedKey)),
      (client as RedisClientType & { pTTL: (key: string) => Promise<number> }).pTTL(normalizedKey),
    ]);
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
      backend: 'redis',
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
  const normalizedKey = key;
  const payload = JSON.stringify(value);
  const versionHash = computeVersionHash(payload);
  lruSet(normalizedKey, {
    payload,
    expiresAt: buildExpiry(ttlSeconds),
    versionHash,
  });

  const client = await getRedisClient();
  if (!client) return;

  try {
    const multi = client.multi();
    if (ttlSeconds && ttlSeconds > 0) {
      multi.set(normalizedKey, payload, { EX: ttlSeconds });
      multi.set(versionKey(normalizedKey), versionHash, { EX: ttlSeconds });
    } else {
      multi.set(normalizedKey, payload);
      multi.set(versionKey(normalizedKey), versionHash);
    }
    await multi.exec();
    await publishInvalidation(normalizedKey);
  } catch (err) {
    logger.warn('[cache] Failed to write key to Redis', {
      backend: 'redis',
      operation: 'set',
      key: redactKey(normalizedKey),
      error: String(err),
    });
  }
}

export async function cacheDelete(key: string): Promise<void> {
  const normalizedKey = key;
  memoryStore.delete(normalizedKey);
  const client = await getRedisClient();
  if (!client) return;

  try {
    await Promise.all([client.del(normalizedKey), client.del(versionKey(normalizedKey))]);
    await publishInvalidation(normalizedKey);
  } catch (err) {
    logger.warn('[cache] Failed to delete key from Redis', {
      backend: 'redis',
      operation: 'delete',
      key: redactKey(normalizedKey),
      error: String(err),
    });
  }
}
