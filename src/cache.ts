import { config } from './config';
import type { RedisClientType } from 'redis';

const CACHE_URL = config.cacheUrl ?? 'memory://';
const USE_REDIS = CACHE_URL !== '' && !CACHE_URL.startsWith('memory://');

interface MemoryEntry {
  payload: string;
  expiresAt: number | null;
}

const memoryStore = new Map<string, MemoryEntry>();
let redisClient: RedisClientType | null = null;
let redisAvailable = false;

function localNow(): number {
  return Date.now();
}

async function getRedisClient(): Promise<RedisClientType | null> {
  if (!USE_REDIS) return null;
  if (redisClient) return redisClient;

  try {
    const { createClient } = await import('redis');
    const client = createClient({ url: CACHE_URL });
    client.on('error', (err: unknown) => {
      console.error('[cache] Redis client error:', err);
      redisAvailable = false;
    });
    await client.connect();
    redisClient = client;
    redisAvailable = true;
    console.log('[cache] Connected to Redis cache');
    return redisClient;
  } catch (err: unknown) {
    console.warn('[cache] Could not connect to Redis, falling back to in-memory cache:', err);
    redisAvailable = false;
    return null;
  }
}

function isExpired(entry: MemoryEntry): boolean {
  return entry.expiresAt !== null && entry.expiresAt <= localNow();
}

function buildExpiry(ttlSeconds: number | null | undefined): number | null {
  if (ttlSeconds === undefined || ttlSeconds === null) return null;
  if (ttlSeconds <= 0) return null;
  return localNow() + ttlSeconds * 1000;
}

export async function cacheConnect(): Promise<void> {
  await getRedisClient();
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
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  const normalizedKey = key;

  const local = memoryStore.get(normalizedKey);
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
    const value = JSON.parse(payload) as T;
    memoryStore.set(normalizedKey, { payload, expiresAt: null });
    return value;
  } catch (err) {
    console.warn(`[cache] Failed to read key ${normalizedKey} from Redis:`, err);
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
  memoryStore.set(normalizedKey, {
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
    console.warn(`[cache] Failed to write key ${normalizedKey} to Redis:`, err);
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
    console.warn(`[cache] Failed to delete key ${normalizedKey} from Redis:`, err);
  }
}
