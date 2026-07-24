import { createHash } from 'crypto';
import type { IndexHashInput } from './types';

/**
 * Canonical hash of what a node has indexed for a given ledger. Two honest
 * nodes that independently indexed the same ledger must produce the same
 * hash regardless of insertion order — callers MUST pass pre-sorted arrays
 * (sorting itself is not done here so this stays a pure, allocation-light
 * function usable on both the challenge-response and query-response paths).
 */
export function computeIndexHash(input: IndexHashInput): string {
  const canonical = JSON.stringify({
    ledgerHash: input.ledgerHash,
    txHashes: input.txHashesSorted,
    eventIds: input.eventIdsSorted,
    eventPayloadHashes: input.eventPayloadHashesSorted,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** Sorts raw arrays and computes the canonical hash in one step. */
export function computeIndexHashFromRaw(
  ledgerHash: string,
  txHashes: string[],
  eventIds: string[],
  eventPayloadHashes: string[],
): string {
  return computeIndexHash({
    ledgerHash,
    txHashesSorted: [...txHashes].sort(),
    eventIdsSorted: [...eventIds].sort(),
    eventPayloadHashesSorted: [...eventPayloadHashes].sort(),
  });
}
