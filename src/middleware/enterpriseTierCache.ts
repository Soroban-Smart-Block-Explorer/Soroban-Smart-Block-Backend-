/**
 * Enterprise Tier Cache
 *
 * In-memory TTL cache for enterprise custom tier configurations.
 * Keyed by organisation ID. Entries expire after CACHE_TTL_MS (default 5 min)
 * so that admin updates propagate to all running instances within a predictable
 * window without requiring a restart.
 *
 * Design notes:
 *  - Pure in-process Map — no Redis dependency, so the cache layer can never
 *    become a bottleneck or single point of failure on its own.
 *  - TTL is checked lazily on every read; a periodic sweep is intentionally
 *    omitted to keep the module dependency-free and GC-friendly for the
 *    typical cardinality of enterprise orgs (< 10 000).
 *  - clearEnterpriseTierCache() is called by the admin API on every mutating
 *    operation so the fresh value is visible in the next request window.
 */

import { logger } from '../logger';
import { TIER_CONFIG } from '../auth/rbac';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Graceful-degradation strategy when upstream systems are unavailable. */
export type GraceDegradationStrategy = 'drop' | 'queue' | 'fallback';

/**
 * Custom rate-limit configuration for a single enterprise organisation.
 *
 * @property maxPerMinute      - Sustained request ceiling per 60-second window.
 * @property maxBurst          - Instantaneous burst allowance (token-bucket capacity).
 * @property windowMs          - Rolling window length in milliseconds.
 * @property label             - Human-readable tier label shown in X-RateLimit-Tier.
 * @property featureFlags      - Opt-in feature flags scoped to this org's tier.
 * @property graceDegradation  - Behaviour when Redis/DB is unavailable:
 *                               'drop'     → reject with 503 immediately.
 *                               'queue'    → queue request and drain when healthy.
 *                               'fallback' → apply standard enterprise defaults.
 */
export interface EnterpriseTierConfig {
  maxPerMinute: number;
  maxBurst: number;
  windowMs: number;
  label: string;
  featureFlags: string[];
  graceDegradation: GraceDegradationStrategy;
}

// ── Cache internals ───────────────────────────────────────────────────────────

/** How long a cached entry stays valid before it is evicted on next read. */
const CACHE_TTL_MS = 5 * 60_000; // 5 minutes

interface CacheEntry {
  config: EnterpriseTierConfig;
  expiresAt: number;
}

const tierCache = new Map<string, CacheEntry>();

// ── Standard enterprise defaults (sourced from TIER_CONFIG for consistency) ──

/** Standard enterprise limits used as a fallback when no custom config exists. */
export const ENTERPRISE_DEFAULTS: EnterpriseTierConfig = {
  maxPerMinute: TIER_CONFIG.enterprise.rateLimit.perMinute,
  maxBurst: TIER_CONFIG.enterprise.rateLimit.burst,
  windowMs: 60_000,
  label: 'enterprise',
  featureFlags: [],
  graceDegradation: 'fallback',
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Retrieve the enterprise tier config for an organisation from the in-memory
 * cache.  Returns `null` if no custom config has been registered for `orgId`.
 *
 * This is a synchronous operation that exposes an async signature so callers
 * can transparently swap in a DB-backed implementation in the future without
 * changing call sites.
 */
export async function getEnterpriseTierConfig(orgId: string): Promise<EnterpriseTierConfig | null> {
  if (!orgId) return null;

  const entry = tierCache.get(orgId);

  if (!entry) return null;

  if (entry.expiresAt <= Date.now()) {
    // Lazy TTL eviction — expired entry is removed on first stale read.
    tierCache.delete(orgId);
    logger.debug('[enterprise-tier-cache] TTL expired, entry evicted', { orgId });
    return null;
  }

  return entry.config;
}

/**
 * Store or overwrite the enterprise tier config for an organisation.
 * The entry is automatically evicted after `CACHE_TTL_MS` milliseconds.
 */
export function setEnterpriseTierConfig(orgId: string, config: EnterpriseTierConfig): void {
  if (!orgId) return;
  tierCache.set(orgId, { config, expiresAt: Date.now() + CACHE_TTL_MS });
  logger.debug('[enterprise-tier-cache] Config cached', { orgId, label: config.label });
}

/**
 * Evict one or all entries from the in-memory cache.
 *
 * @param orgId - When supplied, only that org's entry is removed.
 *                When omitted (or `undefined`), the entire cache is cleared.
 */
export function clearEnterpriseTierCache(orgId?: string): void {
  if (orgId !== undefined) {
    tierCache.delete(orgId);
    logger.debug('[enterprise-tier-cache] Cache cleared for org', { orgId });
  } else {
    tierCache.clear();
    logger.debug('[enterprise-tier-cache] Full cache cleared');
  }
}

/**
 * Return the number of currently cached entries (expired entries included
 * until they are lazily evicted).  Primarily useful in tests.
 */
export function getEnterpriseTierCacheSize(): number {
  return tierCache.size;
}
