import { createHash } from 'crypto';

/**
 * Highest-Random-Weight (rendezvous) hashing: deterministic assignment of a
 * key (here, a ledger range id) to the top-K highest-scoring peers out of a
 * given active set, with no coordination round and the minimal-disruption
 * property on membership change (only ranges where a joining/leaving peer
 * lands in/out of the top-K are affected).
 *
 * See docs/P2P_INDEXER_DESIGN.md §2 for why this replaces RAFT/PBFT for
 * range-ownership assignment.
 */
export function scoreFor(peerId: string, rangeId: string): bigint {
  const digest = createHash('sha256').update(`${peerId}|${rangeId}`).digest('hex');
  return BigInt(`0x${digest}`);
}

/**
 * Returns the top-K peer ids responsible for `rangeId`, given the current
 * locally-observed active peer set. Pure function — no I/O, no network calls.
 * Callers must include their own peerId in `activePeerIds` if they want to be
 * eligible.
 */
export function ownersFor(rangeId: string, activePeerIds: string[], k: number): string[] {
  if (k <= 0) return [];
  const unique = Array.from(new Set(activePeerIds));
  return unique
    .map((peerId) => ({ peerId, score: scoreFor(peerId, rangeId) }))
    .sort((a, b) =>
      a.score === b.score ? a.peerId.localeCompare(b.peerId) : a.score > b.score ? -1 : 1,
    )
    .slice(0, k)
    .map((entry) => entry.peerId);
}

/** Convenience: is `peerId` among the top-K owners of `rangeId`? */
export function isOwner(
  peerId: string,
  rangeId: string,
  activePeerIds: string[],
  k: number,
): boolean {
  return ownersFor(rangeId, activePeerIds, k).includes(peerId);
}
