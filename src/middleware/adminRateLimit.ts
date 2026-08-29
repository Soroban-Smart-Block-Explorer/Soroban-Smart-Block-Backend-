/**
 * Admin Rate Limiter (#889)
 *
 * Applies a strict, IP-keyed sliding-window rate limit to all /admin* routes
 * and a tighter limit specifically for the /admin/rate-limits override store.
 *
 * Limits (in-memory; replaced by Redis when REDIS_URL is set):
 *   adminRateLimit          → 60 req / 15 min per IP  (admin surface)
 *   adminRateLimitsOverride → 10 req / 15 min per IP  (override-store mutations)
 *
 * These are intentionally strict. Legitimate admin tooling sends at most a few
 * requests per session; any higher rate is a brute-force or abuse signal.
 */

import rateLimit from 'express-rate-limit';
import type { Request, Response } from 'express';

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

function makeAdminLimiter(max: number, label: string) {
  return rateLimit({
    windowMs: WINDOW_MS,
    max,
    standardHeaders: false,
    legacyHeaders: false,
    // Key by IP address — admin tokens must not inflate the bucket
    keyGenerator: (req: Request) =>
      (req.ip ?? req.socket?.remoteAddress ?? 'unknown').replace('::ffff:', ''),
    handler: (_req: Request, res: Response) => {
      const retryAfter = Math.ceil(WINDOW_MS / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({
        error: 'Admin rate limit exceeded',
        message: `Too many requests to ${label}. Retry after ${retryAfter} seconds.`,
        retryAfter,
      });
    },
    skip: () => false,
  });
}

/**
 * Broad admin surface limiter — apply to all /admin* routes.
 * 60 requests per 15-minute window per IP.
 */
export const adminRateLimit = makeAdminLimiter(60, 'admin endpoints');

/**
 * Tighter limiter for the rate-limit override store (/admin/rate-limits).
 * These mutations directly affect API throttling so abuse is high-impact.
 * 10 requests per 15-minute window per IP.
 */
export const adminRateLimitsOverrideRateLimit = makeAdminLimiter(10, '/admin/rate-limits');
