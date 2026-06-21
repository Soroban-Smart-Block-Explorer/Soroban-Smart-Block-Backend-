import rateLimit, { Store, RateLimitRequestHandler } from 'express-rate-limit';
import { Request, Response, NextFunction } from 'express';

/**
 * @swagger
 * components:
 *   schemas:
 *     RateLimitInfo:
 *       type: object
 *       description: >
 *         IP-based rate limiting is applied to all API endpoints. Pass an
 *         X-API-Key header to access higher throughput tiers.
 *       properties:
 *         tiers:
 *           type: object
 *           properties:
 *             public:
 *               type: string
 *               example: "100 requests/minute (no key required)"
 *             developer:
 *               type: string
 *               example: "300 requests/minute (API_KEYS_DEVELOPER)"
 *             premium:
 *               type: string
 *               example: "1000 requests/minute (API_KEYS_PREMIUM)"
 */

/**
 * API-key tiers (set via X-API-Key header).
 * Keys are loaded from env: API_KEYS_DEVELOPER, API_KEYS_PREMIUM (comma-separated).
 */
const developerKeys = new Set((process.env.API_KEYS_DEVELOPER ?? '').split(',').filter(Boolean));
const premiumKeys = new Set((process.env.API_KEYS_PREMIUM ?? '').split(',').filter(Boolean));

// Tier limits (requests per minute)
const TIERS = {
  premium: { windowMs: 60_000, max: 1000 },
  developer: { windowMs: 60_000, max: 300 },
  public: { windowMs: 60_000, max: 100 },
};

function getTier(apiKey: string | undefined): keyof typeof TIERS {
  if (apiKey && premiumKeys.has(apiKey)) return 'premium';
  if (apiKey && developerKeys.has(apiKey)) return 'developer';
  return 'public';
}

type Limiters = Record<keyof typeof TIERS, RateLimitRequestHandler>;

function buildLimiters(store?: Store): Limiters {
  const make = (tierName: keyof typeof TIERS) =>
    rateLimit({
      ...TIERS[tierName],
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req) => `${tierName}:${req.ip}`,
      ...(store ? { store } : {}),
    });

  return {
    premium: make('premium'),
    developer: make('developer'),
    public: make('public'),
  };
}

// Default: in-memory store (works immediately, single-instance only)
let limiters: Limiters = buildLimiters();

/**
 * Call once at startup. If REDIS_URL is set and rate-limit-redis is installed,
 * replaces the in-memory store with a shared Redis store so rate limits are
 * enforced consistently across multiple API instances.
 */
export async function initRateLimitStore(): Promise<void> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return;

  try {
    const { createClient } = await import('redis');
    const { RedisStore } = await import('rate-limit-redis');

    const client = createClient({ url: redisUrl });
    client.on('error', (err: unknown) =>
      console.warn('[rate-limit] Redis error:', err instanceof Error ? err.message : String(err)),
    );
    await client.connect();

    const store = new RedisStore({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sendCommand: (...args: string[]) => (client as any).sendCommand(args),
      prefix: 'rl:',
    });

    limiters = buildLimiters(store);
    console.log('[rate-limit] Using Redis store at', redisUrl);
  } catch (err) {
    console.warn(
      '[rate-limit] Redis unavailable, falling back to in-memory store:',
      (err as Error).message,
    );
  }
}

/**
 * Middleware: reads X-API-Key, selects the appropriate rate limiter tier,
 * and delegates to it.
 */
export function tieredRateLimit(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.headers['x-api-key'] as string | undefined;
  const tier = getTier(apiKey);
  return limiters[tier](req, res, next);
}
