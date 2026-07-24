import { config } from './config';
import type { RedisClientType } from 'redis';
import { logger } from './logger';

const CACHE_URL = config.cacheUrl ?? 'memory://';
const USE_REDIS = CACHE_URL !== '' && !CACHE_URL.startsWith('memory://');

// Maximum number of entries kept in the process-local store before LRU eviction kicks in.
const MAX_CACHE_SIZE = Math.max(1, parseInt(process.env.CACHE_MAX_SIZE ?? '1000'));

interface MemoryEntry {
  payload: string;
  expiresAt: number | null;
}

// Map insertion order is used as LRU order: oldest entry is first.
const memoryStore = new Map<string, MemoryEntry>();
const MAX_MEMORY_ENTRIES = 10_000;
let redisClient: RedisClientType | null = null;
let redisAvailable = false;
let _evictionCount = 0;

/** Returns current cache size and cumulative eviction count for metrics. */
export function cacheStats(): { size: number; evictions: number } {
  return { size: memoryStore.size, evictions: _evictionCount };
}

function localNow(): number {
  return Date.now();
}

/** Insert or update an entry, evicting the LRU entry when the cache is full. */
function lruSet(key: string, entry: MemoryEntry): void {
  if (memoryStore.has(key)) {
    // Re-insert at tail to mark as most-recently used.
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

/** Read an entry and move it to the tail (most-recently used). */
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

function isExpired(entry: MemoryEntry): boolean {
  return entry.expiresAt !== null && entry.expiresAt <= localNow();
}

export function redactKey(key: string): string {
  const separatorIndex = key.indexOf(':');
  if (separatorIndex === -1) return key;
  return `${key.slice(0, separatorIndex + 1)}***`;
}

function buildExpiry(ttlSeconds: number | null | undefined): number | null {
  if (ttlSeconds === undefined || ttlSeconds === null) return null;
  if (ttlSeconds <= 0) return null;
  return localNow() + ttlSeconds * 1000;
}

export async function cacheConnect(): Promise<void> {
  await getRedisClient();
}

/**
 * Returns true when the cache layer is operational:
 * - always true when using the in-process memory store (no Redis configured)
 * - true only after a successful Redis connection when a Redis URL is configured
 */
export function isCacheReady(): boolean {
  return !USE_REDIS || redisAvailable;
}

/** Returns which backing store is currently in use. */
export function cacheBackendType(): 'redis' | 'memory' {
  return USE_REDIS && redisAvailable ? 'redis' : 'memory';
}

export async function cacheClose(): Promise<void> {
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
    const payload = await client.get(normalizedKey);
    if (!payload) return null;
    // Mirror the remaining Redis TTL into the local store so the entry expires at
    // the same time as the Redis key, preventing stale data from living forever.
    // pTTL returns: >0 = ms remaining, -1 = no expiry, -2 = key missing.
    const pttl = await (
      client as RedisClientType & { pTTL: (key: string) => Promise<number> }
    ).pTTL(normalizedKey);
    const expiresAt = pttl > 0 ? localNow() + pttl : null;
    const value = JSON.parse(payload) as T;
    lruSet(normalizedKey, { payload, expiresAt });
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
  lruSet(normalizedKey, {
    payload,
    expiresAt: buildExpiry(ttlSeconds),
  });

  const client = await getRedisClient();
  if (!client) return;

  try {
    if (ttlSeconds && ttlSeconds > 0) {
      await client.set(normalizedKey, payload, { EX: ttlSeconds });
    } else {
      await client.set(normalizedKey, payload);
    }
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
    await client.del(normalizedKey);
  } catch (err) {
    logger.warn('[cache] Failed to delete key from Redis', {
      backend: 'redis',
      operation: 'delete',
      key: redactKey(normalizedKey),
      error: String(err),
    });
  }
}
