import type { Crdt } from './types';

export type GCounterState = Record<string /* nodeId */, number>;

/**
 * Grow-only counter. Used for `ReputationScore` (Issue #556: "increment-only
 * counter, merge = max"). Each region only ever increments its own slot;
 * merge takes the pointwise max per region (safe because a region's own
 * count is monotonic, so a lower observed value is just a stale replica),
 * and the externally visible score is the sum across regions.
 */
export class GCounter implements Crdt<GCounterState, number> {
  constructor(readonly state: GCounterState = {}) {}

  static init(): GCounter {
    return new GCounter({});
  }

  value(): number {
    return Object.values(this.state).reduce((sum, n) => sum + n, 0);
  }

  /** Increment this region's own slot. `nodeId` must be the local region's id. */
  increment(nodeId: string, amount = 1): GCounter {
    if (amount < 0) {
      throw new Error('GCounter.increment amount must be >= 0; use PnCounter for decrements');
    }
    return new GCounter({
      ...this.state,
      [nodeId]: (this.state[nodeId] ?? 0) + amount,
    });
  }

  merge(other: GCounterState): GCounter {
    const merged: GCounterState = { ...this.state };
    for (const [nodeId, count] of Object.entries(other)) {
      merged[nodeId] = Math.max(merged[nodeId] ?? 0, count);
    }
    return new GCounter(merged);
  }
}
