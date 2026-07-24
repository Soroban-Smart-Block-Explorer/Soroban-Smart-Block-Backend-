import { cacheGet, cacheSet } from '../cache';
import type { NetworkName } from './types';

/**
 * Not a new distributed-cache protocol — reuses the existing Redis/memory LRU
 * (src/cache.ts), namespaced per network/ledger. "Sharded across nodes" falls
 * out naturally: a node only ever populates cache entries for ranges it owns
 * or has recently forwarded, so the cache is sharded by access pattern rather
 * than by an explicit consistent-hash-over-cache-nodes scheme.
 */
function cacheKey(network: NetworkName, ledgerSeq: number): string {
  return `p2p:${network}:query:${ledgerSeq}`;
}

export interface CachedQueryResult {
  payload: unknown;
  indexHash: string;
  servedByPeerId: string;
}

export async function getCachedQueryResult(
  network: NetworkName,
  ledgerSeq: number,
): Promise<CachedQueryResult | null> {
  const raw = await cacheGet<CachedQueryResult>(cacheKey(network, ledgerSeq));
  return raw ?? null;
}

export async function setCachedQueryResult(
  network: NetworkName,
  ledgerSeq: number,
  result: CachedQueryResult,
  ttlMs: number,
): Promise<void> {
  await cacheSet(cacheKey(network, ledgerSeq), result, Math.ceil(ttlMs / 1000));
}
