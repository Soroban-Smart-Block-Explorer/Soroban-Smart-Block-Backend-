/**
 * Token Bucket Rate Limiter
 *
 * Implements a distributed token bucket algorithm using a Redis Lua script
 * (similar to CL.THROTTLE from redis-cell). Falls back to an in-memory map
 * when Redis is unavailable.
 *
 * Tiers:
 *   unauthenticated  60 req/min  burst 10
 *   free            1000 req/min burst 50
 *   pro            10000 req/min burst 200
 *   enterprise      custom      custom
 *
 * Per-endpoint groups add an additional multiplier on top of the tier limit.
 */

import type { Request, Response, NextFunction } from 'express';
import { logger } from '../logger';

// ─── Tier definitions ─────────────────────────────────────────────────────────

export type RateLimitTier = 'unauthenticated' | 'free' | 'developer' | 'pro' | 'enterprise';

interface TierLimits {
  perMinute: number;
  burst: number;
  ttlSeconds: number;
}

export const TIER_LIMITS: Record<RateLimitTier, TierLimits> = {
  unauthenticated: { perMinute: 60, burst: 10, ttlSeconds: 3600 },
  free: { perMinute: 1000, burst: 50, ttlSeconds: 86400 },
  developer: { perMinute: 1000, burst: 50, ttlSeconds: 86400 },
  pro: { perMinute: 10000, burst: 200, ttlSeconds: 2592000 },
  enterprise: { perMinute: 60000, burst: 500, ttlSeconds: 2592000 },
};

// ─── Endpoint group multipliers (fraction of tier limit) ─────────────────────

interface EndpointGroup {
  pattern: RegExp;
  name: string;
  multiplier: number; // 1.0 = full tier limit
}

const ENDPOINT_GROUPS: EndpointGroup[] = [
  { pattern: /^\/api\/v1\/events/, name: 'events', multiplier: 1.0 },
  { pattern: /^\/api\/v1\/(search|nft\/search)/, name: 'search', multiplier: 0.5 },
  { pattern: /^\/api\/v1\/contracts.*POST/, name: 'contracts', multiplier: 0.17 },
  { pattern: /^\/api\/v1\/simulate/, name: 'simulate', multiplier: 0.08 },
  { pattern: /^\/ws/, name: 'websocket', multiplier: 0.05 },
];

function getEndpointMultiplier(method: string, path: string): number {
  const key = `${path}${method}`;
  for (const group of ENDPOINT_GROUPS) {
    if (group.pattern.test(key) || group.pattern.test(path)) return group.multiplier;
  }
  return 1.0;
}

// ─── Lua script for atomic token bucket ──────────────────────────────────────
// Returns: [allowed (0|1), remaining, resetAt (unix seconds)]

const TOKEN_BUCKET_LUA = `
local key        = KEYS[1]
local capacity   = tonumber(ARGV[1])
local refillRate = tonumber(ARGV[2])  -- tokens per second
local now        = tonumber(ARGV[3])  -- current unix timestamp (ms)
local ttl        = tonumber(ARGV[4])

local data = redis.call('HMGET', key, 'tokens', 'last_refill')
local tokens     = tonumber(data[1])
local lastRefill = tonumber(data[2])

if tokens == nil then
  tokens     = capacity
  lastRefill = now
end

-- Refill tokens based on elapsed time
local elapsed      = math.max(0, now - lastRefill)
local newTokens    = elapsed / 1000 * refillRate
tokens = math.min(capacity, tokens + newTokens)
lastRefill = now

local allowed = 0
if tokens >= 1 then
  tokens    = tokens - 1
  allowed   = 1
end

redis.call('HMSET', key, 'tokens', tokens, 'last_refill', lastRefill)
redis.call('EXPIRE', key, ttl)

local resetAt = math.ceil(now/1000 + (capacity - tokens) / refillRate)
return {allowed, math.floor(tokens), resetAt}
`;

// ─── In-memory fallback ───────────────────────────────────────────────────────

interface MemBucket {
  tokens: number;
  lastRefill: number;
}

const memBuckets = new Map<string, MemBucket>();

function checkMemoryBucket(
  key: string,
  capacity: number,
  refillRate: number,
  now: number,
): [allowed: boolean, remaining: number, resetAt: number] {
  let bucket = memBuckets.get(key);
  if (!bucket) {
    bucket = { tokens: capacity, lastRefill: now };
  }

  const elapsed = Math.max(0, now - bucket.lastRefill);
  bucket.tokens = Math.min(capacity, bucket.tokens + (elapsed / 1000) * refillRate);
  bucket.lastRefill = now;

  const allowed = bucket.tokens >= 1;
  if (allowed) bucket.tokens -= 1;
  memBuckets.set(key, bucket);

  const resetAt = Math.ceil(now / 1000 + (capacity - bucket.tokens) / refillRate);
  return [allowed, Math.floor(bucket.tokens), resetAt];
}

// ─── Public interface ─────────────────────────────────────────────────────────

interface TokenBucketRedisClient {
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

let redisClient: TokenBucketRedisClient | null = null;

export function setRateLimitRedisClient(client: TokenBucketRedisClient): void {
  redisClient = client;
}

export interface TokenBucketResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetAt: number; // unix seconds
  tier: RateLimitTier;
}

export async function checkTokenBucket(
  clientKey: string,
  tier: RateLimitTier,
  method: string,
  path: string,
  overridePerMinute?: number,
): Promise<TokenBucketResult> {
  const baseLimits = TIER_LIMITS[tier];
  const multiplier = getEndpointMultiplier(method, path);

  const capacity = overridePerMinute
    ? Math.ceil(overridePerMinute * multiplier)
    : Math.ceil(baseLimits.perMinute * multiplier);
  const refillRate = capacity / 60; // tokens per second
  const burst = Math.min(capacity, overridePerMinute ? capacity : baseLimits.burst);
  const effectiveCapacity = Math.max(capacity, burst);
  const now = Date.now();

  const redisKey = `tb:${tier}:${clientKey}:${path.replace(/\//g, '_')}`;

  if (redisClient) {
    try {
      const result = (await redisClient.eval(TOKEN_BUCKET_LUA, {
        keys: [redisKey],
        arguments: [
          String(effectiveCapacity),
          String(refillRate),
          String(now),
          String(baseLimits.ttlSeconds),
        ],
      })) as [number, number, number];

      return {
        allowed: result[0] === 1,
        remaining: result[1],
        limit: capacity,
        resetAt: result[2],
        tier,
      };
    } catch (err) {
      logger.warn('[token-bucket] Redis eval failed, using memory fallback', { err });
    }
  }

  const [allowed, remaining, resetAt] = checkMemoryBucket(
    redisKey,
    effectiveCapacity,
    refillRate,
    now,
  );
  return { allowed, remaining, limit: capacity, resetAt, tier };
}

// ─── Express middleware ───────────────────────────────────────────────────────

export function tokenBucketMiddleware(
  getTier: (req: Request) => { tier: RateLimitTier; key: string; override?: number },
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { tier, key, override } = getTier(req);
    const result = await checkTokenBucket(key, tier, req.method, req.path, override);

    // Set standard rate limit headers
    res.setHeader('X-RateLimit-Limit', result.limit);
    res.setHeader('X-RateLimit-Remaining', result.remaining);
    res.setHeader('X-RateLimit-Reset', result.resetAt);
    res.setHeader('X-RateLimit-Tier', result.tier);

    // Attach to request for audit logging
    (req as Request & { rateLimitResult?: TokenBucketResult }).rateLimitResult = result;

    if (!result.allowed) {
      const retryAfter = Math.max(1, result.resetAt - Math.floor(Date.now() / 1000));
      res.setHeader('Retry-After', retryAfter);
      res.status(429).json({
        error: 'Rate limit exceeded',
        tier: result.tier,
        retryAfter,
        resetAt: new Date(result.resetAt * 1000).toISOString(),
      });
      return;
    }

    next();
  };
}
