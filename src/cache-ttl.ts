/**
 * #917 — Per-route cache TTL policy registry.
 *
 * Single source of truth for intended cache freshness per resource. Previously
 * most cacheSet() calls relied on module defaults: in-memory entries expired
 * after CACHE_MEMORY_TTL (300s) and Redis entries without an explicit TTL
 * never expired — so volatile data (latest ledger, prices, fee stats) could be
 * served stale for up to 5 minutes while stable data (ABIs, contract metadata)
 * was either unbounded or thrashed by expiring too soon. Tuning was ad-hoc and
 * impossible to audit.
 *
 * Every cache key's first `:`-delimited segment is mapped to a resource here;
 * cacheSet() resolves the TTL from this registry when the caller doesn't pass
 * an explicit one (explicit TTLs always win). Volatile resources get short
 * TTLs (seconds), stable resources long TTLs (hours–days).
 */
export const RESOURCE_TTL_SECONDS = {
  // ── Volatile resources — seconds ─────────────────────────────────────────
  // Market/chain data that goes stale within seconds-to-a-minute.
  cg_price: 30, // CoinGecko price feed
  cmc_price: 30, // CoinMarketCap price feed
  se_price: 30, // StellarExpert price feed
  chain_price: 30, // on-chain derived cross-chain price
  dex_price: 5, // DEX pool price (real-time)
  composite_price: 5, // composite oracle price (real-time)
  arbitrage: 5, // arbitrage opportunities / graph (real-time)
  graph: 5, // arbitrage engine graph snapshot
  fee: 60, // fee stats / gas estimates

  // ── Stable resources — minutes to days ────────────────────────────────────
  // Immutable or slowly-changing data that benefits from long TTLs.
  abi: 7 * 86400, // contract ABIs are immutable — 7 days
  'token-metadata': 3600, // token symbol/name/decimals — 1 hour
  'classic-asset': 86400, // classic asset metadata — 1 day
  ledger: 86400, // historical ledger snapshots are immutable — 1 day
  proof: 86400, // deterministic audit proofs — 1 day
  'audit-verify': 3600, // audit verification results — 1 hour
  'audit-anchor': 600, // anchor audit tree — 10 minutes
  'audit-embed': 300, // embedded audit snippet — 5 minutes
  'audit-auditors': 3600, // auditor directory — 1 hour
  'contract-audit': 120, // per-contract audit result — 2 minutes
  'audit-benchmark': 600, // benchmark snapshots — 10 minutes
  'audit-bot': 120, // bot audit results — 2 minutes
  'materialized-views': 300, // analytics materialized view cache — 5 minutes
  auth: 3600, // auth keys/sessions — 1 hour
  profile: 3600, // IPFS profiles — 1 hour
  challenge: 60, // auth challenges are short-lived by nature — 1 minute
  flow: 60, // auth flows are short-lived by nature — 1 minute
  p2p: 60, // p2p distributed cache default — 1 minute

  // ── Legacy default ────────────────────────────────────────────────────────
  // Resources not yet classified keep the historical 5-minute default so the
  // registry is safe to adopt incrementally.
  default: 300,
} as const;

export type CacheResource = keyof typeof RESOURCE_TTL_SECONDS;

/** Map a cache key to its resource namespace (first `:`-delimited segment). */
export function cacheResourceFor(key: string): CacheResource {
  const namespace = String(key).split(':')[0] ?? 'default';
  return (namespace in RESOURCE_TTL_SECONDS ? namespace : 'default') as CacheResource;
}

/** Resolve the policy TTL (seconds) for a resource; falls back to the legacy default. */
export function ttlForResource(resource: string): number {
  return RESOURCE_TTL_SECONDS[resource as CacheResource] ?? RESOURCE_TTL_SECONDS.default;
}
