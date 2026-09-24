/**
 * Enterprise Rate Limit Middleware
 *
 * Applies per-organisation custom rate limits for enterprise tenants.
 * Falls back gracefully to standard enterprise defaults when:
 *  - No custom config is registered for the org.
 *  - Redis / DB is unavailable (graceful-degradation strategy).
 *
 * Header contract (RFC 6585 + enterprise policy extension):
 *   X-RateLimit-Limit     — effective ceiling for this window.
 *   X-RateLimit-Remaining — requests still allowed in the current window.
 *   X-RateLimit-Reset     — UTC epoch seconds when the window resets.
 *   X-RateLimit-Tier      — 'enterprise-custom' | 'enterprise'.
 *   X-RateLimit-Policy    — human-readable policy label from the tier config.
 */

import { Request, Response, NextFunction } from 'express';
import { logger } from '../logger';
import { setRateLimitHeaders } from './rateLimit';
import {
  getEnterpriseTierConfig,
  ENTERPRISE_DEFAULTS,
  type EnterpriseTierConfig,
} from './enterpriseTierCache';

// ── In-memory bucket store (fallback when Redis is down) ──────────────────────

interface BucketState {
  count: number;
  resetAt: number; // unix ms
}

const orgBuckets = new Map<string, BucketState>();

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract the organisation ID from the request.
 * Priority: `X-Org-Id` header → `x-api-key` prefix before first underscore.
 */
function resolveOrgId(req: Request): string | null {
  const headerOrgId = req.headers['x-org-id'] as string | undefined;
  if (headerOrgId && headerOrgId.trim().length > 0) return headerOrgId.trim();

  // Derive org from API key prefix  e.g. "org_acme_xxx" → "org_acme"
  const apiKey = req.headers['x-api-key'] as string | undefined;
  if (apiKey) {
    const parts = apiKey.split('_');
    if (parts.length >= 2) return `${parts[0]}_${parts[1]}`;
  }

  return null;
}

/**
 * Check whether a request carries all required feature flags for the tier.
 * Returns `true` when no flags are required or all required flags are present.
 *
 * Flags are read from the `X-Feature-Flags` header (comma-separated).
 */
export function hasRequiredFeatureFlags(req: Request, tierFlags: string[]): boolean {
  if (tierFlags.length === 0) return true;
  const raw = req.headers['x-feature-flags'] as string | undefined;
  if (!raw) return false;
  const provided = new Set(raw.split(',').map((f) => f.trim()));
  return tierFlags.every((flag) => provided.has(flag));
}

/**
 * Enforce in-memory sliding-window rate limit against the effective config.
 * Returns `{ allowed, remaining, resetAt }` without mutating the response.
 */
function checkBucket(
  bucketKey: string,
  config: EnterpriseTierConfig,
  now: number,
): { allowed: boolean; remaining: number; resetAt: number } {
  let bucket = orgBuckets.get(bucketKey);

  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + config.windowMs };
    orgBuckets.set(bucketKey, bucket);
  }

  bucket.count += 1;
  const remaining = Math.max(0, config.maxPerMinute - bucket.count);
  const allowed = bucket.count <= config.maxPerMinute;

  return { allowed, remaining, resetAt: bucket.resetAt };
}

// ── Middleware ────────────────────────────────────────────────────────────────

/**
 * Express middleware that applies enterprise custom rate limits.
 *
 * Mount this **after** standard auth middleware so `req.apiKey` and the
 * `X-Org-Id` header are already available.
 *
 * Graceful degradation logic:
 *  - If `getEnterpriseTierConfig` throws, the error is caught and logged; the
 *    standard enterprise defaults are applied instead so the request is not
 *    dropped due to an infrastructure fault.
 *  - If the org's graceDegradation strategy is 'drop', a 503 is returned.
 *  - If it is 'queue' (unsupported at this layer), we fall back to 'fallback'.
 *  - If it is 'fallback' (or 'queue' fall-through), standard enterprise limits
 *    are used.
 */
export async function applyEnterpriseRateLimit(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const orgId = resolveOrgId(req);

  // Resolve effective tier config ─────────────────────────────────────────────
  let tierConfig: EnterpriseTierConfig = ENTERPRISE_DEFAULTS;
  let isCustom = false;
  let usedFallback = false;

  if (orgId) {
    try {
      const custom = await getEnterpriseTierConfig(orgId);
      if (custom) {
        tierConfig = custom;
        isCustom = true;
      }
    } catch (err) {
      logger.warn('[enterprise-rate-limit] Failed to load tier config, using defaults', {
        orgId,
        err: String(err),
      });
      usedFallback = true;

      // Honour the registered degradation strategy if we still have it cached.
      // (In the error path, tierConfig stays as ENTERPRISE_DEFAULTS.)
    }
  }

  // Graceful degradation when infrastructure is down ──────────────────────────
  if (usedFallback && tierConfig.graceDegradation === 'drop') {
    logger.error('[enterprise-rate-limit] Dropping request per graceDegradation=drop policy', {
      orgId,
    });
    res.status(503).json({
      error: 'Service temporarily unavailable. Rate-limit enforcement failed.',
      tier: 'enterprise',
    });
    return;
  }
  // 'queue' falls through to 'fallback' at this layer (queue is a future concern).

  // Feature-flag gating ───────────────────────────────────────────────────────
  if (isCustom && !hasRequiredFeatureFlags(req, tierConfig.featureFlags)) {
    logger.warn('[enterprise-rate-limit] Missing required feature flags', {
      orgId,
      required: tierConfig.featureFlags,
    });
    res.status(403).json({
      error: 'Missing required feature flags for this enterprise tier.',
      required: tierConfig.featureFlags,
    });
    return;
  }

  // In-memory bucket enforcement ──────────────────────────────────────────────
  const now = Date.now();
  const bucketKey = orgId ? `ent:${orgId}` : `ent:ip:${req.ip ?? 'unknown'}`;
  const { allowed, remaining, resetAt } = checkBucket(bucketKey, tierConfig, now);

  const resetTimestamp = Math.ceil(resetAt / 1000);
  const tierLabel = isCustom ? 'enterprise-custom' : 'enterprise';
  const policyLabel = tierConfig.label;

  setRateLimitHeaders(res, {
    'X-RateLimit-Limit': String(tierConfig.maxPerMinute),
    'X-RateLimit-Remaining': String(remaining),
    'X-RateLimit-Reset': String(resetTimestamp),
    'X-RateLimit-Tier': tierLabel,
    'X-RateLimit-Policy': policyLabel,
  });

  if (!allowed) {
    const retryAfter = Math.max(1, resetTimestamp - Math.floor(Date.now() / 1000));
    setRateLimitHeaders(res, {
      'X-RateLimit-Remaining': '0',
      'Retry-After': String(retryAfter),
    });

    logger.warn('[enterprise-rate-limit] Rate limit exceeded', {
      orgId,
      tier: tierLabel,
      policy: policyLabel,
      limit: tierConfig.maxPerMinute,
    });

    res.status(429).json({
      error: 'Enterprise rate limit exceeded',
      tier: tierLabel,
      policy: policyLabel,
      retryAfter,
      resetAt: new Date(resetAt).toISOString(),
    });
    return;
  }

  next();
}
