/**
 * Metrics Endpoint Authentication & Rate Limiting (#907)
 *
 * Gates `GET /metrics` behind an IP/CIDR allowlist (METRICS_ALLOWED_IPS) and/or
 * a shared-secret bearer token (METRICS_TOKEN), and rate-limits scrape
 * requests to defend against a scraping DoS.
 *
 * This is defense in depth: k8s/ingress.yaml already refuses to route
 * /metrics to the public internet, and k8s/network-policy.yaml restricts who
 * on the pod network may even reach the port. This middleware protects
 * anyone who can still reach the pod directly (same-namespace pod, port-
 * forward, a misconfigured Ingress/NetworkPolicy elsewhere).
 */

import crypto from 'crypto';
import * as ipaddr from 'ipaddr.js';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config';
import { logger } from '../logger';

function parseAllowedIps(raw: string): string[] {
  return raw
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function ipMatchesCidr(ip: string, cidr: string): boolean {
  try {
    // ipaddr.process normalizes IPv4-mapped IPv6 (::ffff:x.x.x.x) to plain IPv4
    const addr = ipaddr.process(ip);
    if (cidr.includes('/')) {
      const range = ipaddr.parseCIDR(cidr);
      if (addr.kind() === 'ipv4' && range[0].kind() === 'ipv4') {
        return (addr as ipaddr.IPv4).match(range as [ipaddr.IPv4, number]);
      }
      if (addr.kind() === 'ipv6' && range[0].kind() === 'ipv6') {
        return (addr as ipaddr.IPv6).match(range as [ipaddr.IPv6, number]);
      }
      return false;
    }
    return ipaddr.process(cidr).toString() === addr.toString();
  } catch {
    return false;
  }
}

function isIpAllowed(clientIp: string | undefined, allowList: string[]): boolean {
  if (!clientIp || allowList.length === 0) return false;
  return allowList.some((cidr) => ipMatchesCidr(clientIp, cidr));
}

/** Constant-time comparison so token checks don't leak timing information. */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function extractBearerToken(req: Request): string | undefined {
  const header = req.headers['authorization'];
  if (!header || Array.isArray(header)) return undefined;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : undefined;
}

/**
 * Rejects requests to /metrics unless the client IP is in METRICS_ALLOWED_IPS
 * (comma-separated CIDR/IP list) or the request carries a valid
 * `Authorization: Bearer <METRICS_TOKEN>` header.
 *
 * If neither METRICS_ALLOWED_IPS nor METRICS_TOKEN is configured:
 *  - production: fail closed — deny with 403 rather than silently expose metrics.
 *  - non-production: allow, for local/dev/CI convenience (matches other
 *    opt-in guards in this codebase, e.g. app.ts's ENABLE_DOCS gate).
 */
export function metricsAuth(req: Request, res: Response, next: NextFunction): void {
  const allowList = parseAllowedIps(config.metricsAllowedIps);
  const token = config.metricsToken;

  if (allowList.length === 0 && !token) {
    if (config.nodeEnv === 'production') {
      logger.error(
        '[metrics-auth] /metrics has no METRICS_ALLOWED_IPS or METRICS_TOKEN configured in production; denying by default',
      );
      res.status(403).json({ error: 'Metrics access is not configured' });
      return;
    }
    next();
    return;
  }

  if (isIpAllowed(req.ip, allowList)) {
    next();
    return;
  }

  const presentedToken = extractBearerToken(req);
  if (presentedToken) {
    if (token && tokenMatches(presentedToken, token)) {
      next();
      return;
    }
    logger.warn('[metrics-auth] rejected /metrics request: invalid bearer token', { ip: req.ip });
    res.status(401).json({ error: 'Unauthorized: invalid metrics token' });
    return;
  }

  logger.warn(
    '[metrics-auth] rejected /metrics request: IP not allowlisted and no token provided',
    {
      ip: req.ip,
    },
  );
  res.status(403).json({ error: 'Forbidden: not permitted to access metrics' });
}

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

const rateLimitBuckets = new Map<string, RateLimitBucket>();

/**
 * Simple fixed-window rate limiter dedicated to /metrics, independent of the
 * tiered API rate limiter (metrics scrapers aren't API-key holders and
 * shouldn't share that budget). Mirrors the in-memory bucket approach already
 * used in src/middleware/rateLimit.ts's `runLocalRateLimit`.
 */
export function metricsRateLimiter(req: Request, res: Response, next: NextFunction): void {
  const max = config.metricsRateLimitMax;
  const windowMs = config.metricsRateLimitWindowMs;
  const key = req.ip ?? 'unknown';
  const now = Date.now();

  const existing = rateLimitBuckets.get(key);
  const bucket: RateLimitBucket =
    !existing || existing.resetAt <= now
      ? { count: 1, resetAt: now + windowMs }
      : { count: existing.count + 1, resetAt: existing.resetAt };
  rateLimitBuckets.set(key, bucket);

  const remaining = Math.max(0, max - bucket.count);
  res.setHeader('X-RateLimit-Limit', String(max));
  res.setHeader('X-RateLimit-Remaining', String(remaining));

  if (bucket.count > max) {
    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    logger.warn('[metrics-auth] /metrics rate limit exceeded', { ip: key });
    res.status(429).json({ error: 'Too many requests to /metrics', retryAfter });
    return;
  }

  next();
}

/** Exposed for testing only — do not call in production code. */
export function _clearMetricsRateLimitBuckets(): void {
  rateLimitBuckets.clear();
}
