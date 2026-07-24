/**
 * Hybrid Logical Clock (Lamport/Kulkarni-Demirbas HLC).
 *
 * Provides a total, causality-respecting order across regions without
 * requiring synchronized wall clocks. Every CRDT merge and the audit log
 * (Issue #556 "Compliance & Auditing" requirement) uses HLC timestamps
 * instead of raw `Date.now()` so that "last write wins" is well-defined
 * even when two regions' physical clocks disagree.
 *
 * Encoding: `<physical>-<logical>-<nodeId>` sorts lexicographically once
 * `physical` and `logical` are zero-padded, which is convenient for storing
 * the timestamp as a plain indexable string column.
 */

export interface HlcTimestamp {
  /** Physical time component (ms since epoch, from Date.now() or an injected clock). */
  physical: number;
  /** Logical tie-breaker, incremented when events would otherwise collide. */
  logical: number;
  /** Origin region/node id, used only as the final tie-breaker. */
  nodeId: string;
}

const PHYSICAL_PAD = 15; // enough digits for ms timestamps through year ~5138
const LOGICAL_PAD = 10;

export function compareHlc(a: HlcTimestamp, b: HlcTimestamp): number {
  if (a.physical !== b.physical) return a.physical - b.physical;
  if (a.logical !== b.logical) return a.logical - b.logical;
  return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
}

export function encodeHlc(ts: HlcTimestamp): string {
  return `${String(ts.physical).padStart(PHYSICAL_PAD, '0')}-${String(ts.logical).padStart(LOGICAL_PAD, '0')}-${ts.nodeId}`;
}

export function decodeHlc(encoded: string): HlcTimestamp {
  const [physical, logical, ...rest] = encoded.split('-');
  return {
    physical: Number(physical),
    logical: Number(logical),
    nodeId: rest.join('-'),
  };
}

/**
 * Per-node HLC generator. One instance per process/region; the same
 * instance must be used for every local event and every merge of a
 * remote timestamp so `lastKnown` stays monotonic.
 */
export class HybridLogicalClock {
  private lastKnown: HlcTimestamp;

  constructor(
    private readonly nodeId: string,
    private readonly now: () => number = Date.now,
  ) {
    this.lastKnown = { physical: now(), logical: 0, nodeId };
  }

  /** Produce a new timestamp for a local event, e.g. a write in this region. */
  tick(): HlcTimestamp {
    const physicalNow = this.now();
    if (physicalNow > this.lastKnown.physical) {
      this.lastKnown = { physical: physicalNow, logical: 0, nodeId: this.nodeId };
    } else {
      this.lastKnown = {
        physical: this.lastKnown.physical,
        logical: this.lastKnown.logical + 1,
        nodeId: this.nodeId,
      };
    }
    return { ...this.lastKnown };
  }

  /**
   * Merge in a timestamp observed from a remote region (e.g. attached to a
   * replicated write), advancing the local clock so subsequent local events
   * are ordered after it. Returns the new local timestamp for the merge
   * event itself.
   */
  receive(remote: HlcTimestamp): HlcTimestamp {
    const physicalNow = this.now();
    const physical = Math.max(physicalNow, this.lastKnown.physical, remote.physical);
    let logical: number;
    if (physical === this.lastKnown.physical && physical === remote.physical) {
      logical = Math.max(this.lastKnown.logical, remote.logical) + 1;
    } else if (physical === this.lastKnown.physical) {
      logical = this.lastKnown.logical + 1;
    } else if (physical === remote.physical) {
      logical = remote.logical + 1;
    } else {
      logical = 0;
    }
    this.lastKnown = { physical, logical, nodeId: this.nodeId };
    return { ...this.lastKnown };
  }
}
