import crypto from 'crypto';
import rateLimit, { RateLimitRequestHandler, Store } from 'express-rate-limit';
import { NextFunction, Request, Response } from 'express';
import { config } from '../config';
import { prismaRead } from '../db';
import { logger } from '../logger';
import { TIER_CONFIG } from '../auth/rbac';
import {
  checkTokenBucket,
  RateLimitTier,
  setRateLimitRedisClient,
  TokenBucketResult,
} from './tokenBucket';

/**
 * #715 — API keys must never be stored as plaintext in memory.
 * We hash each raw key with SHA-256 on startup and keep only the digest.
 * Lookups hash the incoming key and compare digests, so plaintext is never
 * retained beyond the single comparison call.
 *
 * Key-prefix convention (mirrors Stripe):
 *   dev_  — developer tier  (e.g. dev_xxxx)
 *   pro_  — premium / pro tier  (e.g. pro_xxxx)
 *
 * Keys without a recognised prefix are also accepted for backward-compat;
 * the tier is determined solely by which env-var set they appear in.
 */

function hashApiKey(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Parse a comma-separated list of raw API keys from an env var, hash each one,
 * and return a Set of SHA-256 digests.  Plaintext values are never stored.
 */
function buildHashedKeySet(envValue: string | undefined): Set<string> {
  return new Set(
    (envValue ?? '')
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean)
      .map(hashApiKey),
  );
}

// Stored as SHA-256 hashes — plaintext is never kept in memory (#715)
const developerKeys = buildHashedKeySet(process.env.API_KEYS_DEVELOPER);
const premiumKeys = buildHashedKeySet(process.env.API_KEYS_PREMIUM);

const DEFAULT_TIERS: Record<TierName, TierConfig> = {
  free: { windowMs: 60_000, max: TIER_CONFIG.free.rateLimit.perMinute },
  developer: { windowMs: 60_000, max: TIER_CONFIG.developer.rateLimit.perMinute },
  premium: { windowMs: 60_000, max: TIER_CONFIG.premium.rateLimit.perMinute },
  enterprise: { windowMs: 60_000, max: TIER_CONFIG.enterprise.rateLimit.perMinute },
};

type TierName = 'free' | 'developer' | 'premium' | 'enterprise';
type TierConfig = { windowMs: number; max: number };
type BucketState = { count: number; resetAt: number };
type Limiters = Record<TierName, RateLimitRequestHandler>;

const overrideCache = new Map<string, { config: TierConfig; expiresAt: number }>();
const requestBuckets = new Map<string, BucketState>();

function sanitizeTierValue(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) return fallback;
  return value > 0 ? Math.floor(value) : fallback;
}

export function normalizeTierConfig(
  input: Partial<Record<TierName, TierConfig>> = {},
): Record<TierName, TierConfig> {
  const raw = {
    free: input.free ?? {
      windowMs: config.rateLimitPublicWindowMs,
      max: config.rateLimitPublicMax,
    },
    developer: input.developer ?? {
      windowMs: config.rateLimitDeveloperWindowMs,
      max: config.rateLimitDeveloperMax,
    },
    premium: input.premium ?? {
      windowMs: config.rateLimitPremiumWindowMs,
      max: config.rateLimitPremiumMax,
    },
    enterprise: input.enterprise ?? {
      windowMs: config.rateLimitPremiumWindowMs,
      max: config.rateLimitPremiumMax,
    },
  };

  return {
    free: {
      windowMs: sanitizeTierValue(raw.free?.windowMs, DEFAULT_TIERS.free.windowMs),
      max: sanitizeTierValue(raw.free?.max, DEFAULT_TIERS.free.max),
    },
    developer: {
      windowMs: sanitizeTierValue(raw.developer?.windowMs, DEFAULT_TIERS.developer.windowMs),
      max: sanitizeTierValue(raw.developer?.max, DEFAULT_TIERS.developer.max),
    },
    premium: {
      windowMs: sanitizeTierValue(raw.premium?.windowMs, DEFAULT_TIERS.premium.windowMs),
      max: sanitizeTierValue(raw.premium?.max, DEFAULT_TIERS.premium.max),
    },
    enterprise: {
      windowMs: sanitizeTierValue(raw.enterprise?.windowMs, DEFAULT_TIERS.enterprise.windowMs),
      max: sanitizeTierValue(raw.enterprise?.max, DEFAULT_TIERS.enterprise.max),
    },
  };
}

export function getRateLimitTier(
  apiKey: string | undefined,
  developerApiKeys = developerKeys,
  premiumApiKeys = premiumKeys,
): TierName {
  if (!apiKey) return 'free';
  // Hash before comparing so plaintext is never matched against stored digests (#715)
  const hashed = hashApiKey(apiKey);
  if (premiumApiKeys.has(hashed)) return 'premium';
  if (developerApiKeys.has(hashed)) return 'developer';
  return 'free';
}

function getTierFromEnvKey(apiKey: string | undefined): RateLimitTier {
  if (!apiKey) return 'free';
  const hashed = hashApiKey(apiKey);
  if (premiumKeys.has(hashed)) return 'pro';
  if (developerKeys.has(hashed)) return 'developer';
  return 'free';
}

function applyAdaptiveThrottle(
  req: Request,
  res: Response,
  tierConfigValue: TierConfig,
): TierConfig {
  if (!config.rateLimitAdaptiveEnabled) return tierConfigValue;

  const load = Number(process.env.RATE_LIMIT_LOAD_FACTOR ?? '0');
  if (Number.isNaN(load) || load <= 0) return tierConfigValue;

  const threshold = config.rateLimitAdaptiveThreshold;
  if (load < threshold) return tierConfigValue;

  const throttledMax = Math.max(
    1,
    Math.floor(tierConfigValue.max * config.rateLimitAdaptiveMultiplier),
  );
  const currentMax = Math.min(throttledMax, tierConfigValue.max);
  res.setHeader('X-RateLimit-Warn', 'true');
  res.setHeader('X-RateLimit-Predicted', `${currentMax}`);
  req.app.locals.rateLimitPredictedMax = currentMax;
  return { ...tierConfigValue, max: currentMax };
}

function getRequestBucketKey(req: Request, tier: TierName, userIdentifier?: string): string {
  const endpoint = req.path || req.originalUrl || '/';
  const keySource = userIdentifier ?? req.ip ?? 'unknown';
  return `${tier}:${keySource}:${endpoint}`;
}

async function getUserOverride(identifier: string, endpoint: string): Promise<TierConfig | null> {
  const cacheKey = `override:${identifier}:${endpoint}`;
  const cached = overrideCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.config;

  try {
    const prisma = prismaRead as any;
    const override = await prisma.rateLimitOverride.findUnique({
      where: { identifier_endpoint: { identifier, endpoint: endpoint || '/' } },
    });

    if (!override) {
      overrideCache.set(cacheKey, {
        config: { windowMs: DEFAULT_TIERS.free.windowMs, max: DEFAULT_TIERS.free.max },
        expiresAt: Date.now() + 60_000,
      });
      return null;
    }

    const overrideConfig = { windowMs: override.windowMs, max: override.max };
    overrideCache.set(cacheKey, { config: overrideConfig, expiresAt: Date.now() + 60_000 });
    return overrideConfig;
  } catch (error) {
    logger.warn('[rate-limit] unable to read overrides', { error });
    return null;
  }
}

export function clearRateLimitOverrideCache(): void {
  overrideCache.clear();
}

function buildLimiters(store?: Store): Limiters {
  const tiers = normalizeTierConfig();
  const make = (tierName: TierName) => {
    const limiter = rateLimit({
      ...tiers[tierName],
      standardHeaders: false, // We set headers manually for consistency
      legacyHeaders: false,
      keyGenerator: (req: Request) => `${tierName}:${req.ip ?? 'unknown'}`,
      handler: (req: Request, res: Response) => {
        // This handler is only called when the rate limit is exceeded.
        // For requests within the limit, express-rate-limit calls next() automatically.
        const resetTimestamp = Math.ceil((Date.now() + tiers[tierName].windowMs) / 1000);

        setRateLimitHeaders(res, {
          'X-RateLimit-Limit': String(tiers[tierName].max),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(resetTimestamp),
          'X-RateLimit-Tier': tierName,
          'Retry-After': String(Math.ceil(tiers[tierName].windowMs / 1000)),
        });

        res.status(429).json({
          error: 'Rate limit exceeded',
          tier: tierName,
          retryAfter: Math.ceil(tiers[tierName].windowMs / 1000),
          resetAt: new Date(resetTimestamp * 1000).toISOString(),
        });
      },
      skip: (_req: Request) => false,
      ...(store ? { store } : {}),
    });

    // Wrap the limiter to set headers on all responses (allowed and rate-limited)
    return (req: Request, res: Response, next: NextFunction) => {
      const originalJson = res.json.bind(res);

      // Hook into response to add headers before sending
      res.json = function (body: any) {
        if (!res.headersSent) {
          const rateLimit = (req as any).rateLimit;
          if (rateLimit) {
            const resetTimestamp = Math.ceil((Date.now() + tiers[tierName].windowMs) / 1000);
            setRateLimitHeaders(res, {
              'X-RateLimit-Limit': String(tiers[tierName].max),
              'X-RateLimit-Remaining': String(
                Math.max(0, tiers[tierName].max - (rateLimit.current ?? 0)),
              ),
              'X-RateLimit-Reset': String(resetTimestamp),
              'X-RateLimit-Tier': tierName,
            });
          }
        }
        return originalJson(body);
      } as any;

      limiter(req, res, next);
    };
  };

  return {
    free: make('free'),
    developer: make('developer'),
    premium: make('premium'),
    enterprise: make('enterprise'),
  };
}

let legacyLimiters: Limiters = buildLimiters();
let useTokenBucket = false;

export async function initRateLimitStore(): Promise<void> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return;

  try {
    const { createClient } = await import('redis');
    const { RedisStore } = await import('rate-limit-redis');

    const client = createClient({ url: redisUrl });
    client.on('error', (err: unknown) => logger.warn(`[rate-limit] Redis error: ${String(err)}`));
    await client.connect();

    setRateLimitRedisClient(client as any);
    useTokenBucket = true;

    const store = new RedisStore({
      sendCommand: (...args: string[]) => (client as any).sendCommand(args),
      prefix: 'rl:',
    });
    legacyLimiters = buildLimiters(store);

    logger.info('[rate-limit] Redis token bucket active');
  } catch (err) {
    logger.warn(`[rate-limit] Redis unavailable, using in-memory fallback: ${String(err)}`);
  }
}

function runLocalRateLimit(req: Request, res: Response, next: NextFunction): void {
  void (async () => {
    const apiKey = req.headers['x-api-key'] as string | undefined;
    const tier = getRateLimitTier(apiKey);
    const userIdentifier = req.headers['x-user-id'] as string | undefined;
    const endpoint = req.path || req.originalUrl || '/';
    const configOverride = userIdentifier ? await getUserOverride(userIdentifier, endpoint) : null;
    const baseConfig = configOverride ?? normalizeTierConfig()[tier];
    const effectiveConfig = applyAdaptiveThrottle(req, res, baseConfig);
    const now = Date.now();
    const bucketKey = getRequestBucketKey(req, tier, userIdentifier);
    const existing = requestBuckets.get(bucketKey);

    if (!existing || existing.resetAt <= now) {
      requestBuckets.set(bucketKey, { count: 1, resetAt: now + effectiveConfig.windowMs });
    } else {
      existing.count += 1;
    }

    const bucket = requestBuckets.get(bucketKey) ?? {
      count: 1,
      resetAt: now + effectiveConfig.windowMs,
    };
    const remaining = Math.max(0, effectiveConfig.max - bucket.count);
    const resetTimestamp = Math.ceil(bucket.resetAt / 1000);

    setRateLimitHeaders(res, {
      'X-RateLimit-Limit': String(effectiveConfig.max),
      'X-RateLimit-Remaining': String(remaining),
      'X-RateLimit-Reset': String(resetTimestamp),
      'X-RateLimit-Tier': tier,
      'X-RateLimit-Policy': configOverride ? 'user-override' : undefined,
    });

    if (bucket.count > effectiveConfig.max) {
      const retryAfter = Math.max(1, resetTimestamp - Math.floor(Date.now() / 1000));
      setRateLimitHeaders(res, {
        'X-RateLimit-Remaining': '0',
        'Retry-After': String(retryAfter),
      });
      res.status(429).json({
        error: 'Rate limit exceeded',
        tier,
        retryAfter,
        resetAt: new Date(resetTimestamp * 1000).toISOString(),
      });
      return;
    }

    next();
  })().catch(next);
}

export async function tieredRateLimit(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const keyCtx = req.apiKey;
  const rawKey = req.headers['x-api-key'] as string | undefined;
  const tier: RateLimitTier = keyCtx?.tier ?? getTierFromEnvKey(rawKey);
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

      const resetTimestamp = result.resetAt;
      setRateLimitHeaders(res, {
        'X-RateLimit-Limit': String(result.limit),
        'X-RateLimit-Remaining': String(result.remaining),
        'X-RateLimit-Reset': String(resetTimestamp),
        'X-RateLimit-Tier': result.tier,
      });
      (req as Request & { rateLimitResult?: TokenBucketResult }).rateLimitResult = result;

      if (!result.allowed) {
        const retryAfter = Math.max(1, resetTimestamp - Math.floor(Date.now() / 1000));
        setRateLimitHeaders(res, {
          'X-RateLimit-Remaining': '0',
          'Retry-After': String(retryAfter),
        });
        res.status(429).json({
          error: 'Rate limit exceeded',
          tier: result.tier,
          retryAfter,
          resetAt: new Date(resetTimestamp * 1000).toISOString(),
        });
        return;
      }

      next();
      return;
    } catch (err) {
      logger.warn(`[rate-limit] Token bucket error, falling through: ${String(err)}`);
    }
  }

  if (keyCtx?.rateLimitOverride) {
    runLocalRateLimit(req, res, next);
    return;
  }

  const legacyTier: TierName =
    tier === 'enterprise'
      ? 'enterprise'
      : tier === 'pro' || tier === 'premium'
        ? 'premium'
        : tier === 'developer'
          ? 'developer'
          : 'free';
  legacyLimiters[legacyTier](req, res, next);
}
