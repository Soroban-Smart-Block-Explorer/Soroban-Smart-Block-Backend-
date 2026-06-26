/**
 * Rate Limiting Middleware
 *
 * Combines the token bucket (Redis-backed distributed rate limiter) with
 * API key auth context. Falls back to express-rate-limit for non-Redis env.
 *
 * Tier resolution order:
 *  1. req.apiKey.tier (set by apiKeyAuth middleware)
 *  2. X-API-Key matches legacy env key sets (backward compat)
 *  3. 'unauthenticated'
 *
 * Attaches rate limit headers + req.rateLimitResult for audit logging.
 */

import rateLimit, { Store, RateLimitRequestHandler } from 'express-rate-limit';
import { Request, Response, NextFunction } from 'express';
import {
  checkTokenBucket,
  setRateLimitRedisClient,
  RateLimitTier,
  TokenBucketResult,
} from './tokenBucket';
import { logger } from '../logger';

// ─── Backward-compat env-key sets ────────────────────────────────────────────

const developerKeys = new Set((process.env.API_KEYS_DEVELOPER ?? '').split(',').filter(Boolean));
const premiumKeys   = new Set((process.env.API_KEYS_PREMIUM ?? '').split(',').filter(Boolean));

function getTierFromEnvKey(apiKey: string | undefined): RateLimitTier {
  if (apiKey && premiumKeys.has(apiKey))   return 'pro';
  if (apiKey && developerKeys.has(apiKey)) return 'developer';
  return 'unauthenticated';
}

// ─── Legacy fallback (express-rate-limit) ────────────────────────────────────

const TIERS = {
  premium:   { windowMs: 60_000, max: 10000 },
  developer: { windowMs: 60_000, max: 1000 },
  public:    { windowMs: 60_000, max: 60 },
};

type Limiters = Record<'premium' | 'developer' | 'public', RateLimitRequestHandler>;

function buildLimiters(store?: Store): Limiters {
  const make = (tierName: keyof typeof TIERS) =>
    rateLimit({
      ...TIERS[tierName],
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req: Request) => `${tierName}:${req.ip}`,
      ...(store ? { store } : {}),
    });
  return { premium: make('premium'), developer: make('developer'), public: make('public') };
}

let legacyLimiters: Limiters = buildLimiters();
let useTokenBucket = false;

// ─── Startup initialisation ───────────────────────────────────────────────────

export async function initRateLimitStore(): Promise<void> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return;

  try {
    const { createClient } = await import('redis');
    const { RedisStore } = await import('rate-limit-redis');

    const client = createClient({ url: redisUrl });
    client.on('error', (err: unknown) =>
      logger.warn(`[rate-limit] Redis error: ${String(err)}`),
    );
    await client.connect();

    // Wire Redis into token bucket
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setRateLimitRedisClient(client as any);
    useTokenBucket = true;

    // Also build legacy limiters with Redis store for backward compat
    const store = new RedisStore({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sendCommand: (...args: string[]) => (client as any).sendCommand(args),
      prefix: 'rl:',
    });
    legacyLimiters = buildLimiters(store);

    logger.info('[rate-limit] Redis token bucket active');
  } catch (err) {
    logger.warn(`[rate-limit] Redis unavailable, using in-memory fallback: ${String(err)}`);
  }
}

// ─── Main middleware ──────────────────────────────────────────────────────────

export async function tieredRateLimit(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Resolve tier + client key
  const keyCtx = req.apiKey;
  const rawKey  = req.headers['x-api-key'] as string | undefined;

  const tier: RateLimitTier = keyCtx?.tier
    ?? getTierFromEnvKey(rawKey);

  const clientKey = keyCtx?.id ?? req.ip ?? 'anonymous';

  if (useTokenBucket) {
    try {
      const result: TokenBucketResult = await checkTokenBucket(
        clientKey,
        tier,
        req.method,
        req.path,
        keyCtx?.rateLimitOverride,
      );

      res.setHeader('X-RateLimit-Limit',     result.limit);
      res.setHeader('X-RateLimit-Remaining', result.remaining);
      res.setHeader('X-RateLimit-Reset',     result.resetAt);
      res.setHeader('X-RateLimit-Tier',      result.tier);

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

      return next();
    } catch (err) {
      logger.warn(`[rate-limit] Token bucket error, falling through: ${String(err)}`);
    }
  }

  // Legacy fallback
  const legacyTier =
    tier === 'pro' || tier === 'enterprise' ? 'premium' :
    tier === 'developer' ? 'developer' : 'public';

  return legacyLimiters[legacyTier](req, res, next);
}
