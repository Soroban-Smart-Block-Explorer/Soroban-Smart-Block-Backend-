import type { NetworkName, RangeBounds } from './types';

/** Ledger sequences [startLedger, endLedger) that ledgerSeq falls into, for a given bucket size. */
export function rangeBoundsForLedger(
  network: NetworkName,
  ledgerSeq: number,
  rangeSize: number,
): RangeBounds {
  if (rangeSize <= 0) throw new Error(`rangeSize must be positive, got ${rangeSize}`);
  const startLedger = Math.floor(ledgerSeq / rangeSize) * rangeSize;
  const endLedger = startLedger + rangeSize;
  return {
    rangeId: rangeKey(network, startLedger, endLedger),
    network,
    startLedger,
    endLedger,
  };
}

export function rangeKey(network: NetworkName, startLedger: number, endLedger: number): string {
  return `${network}:${startLedger}-${endLedger}`;
}
