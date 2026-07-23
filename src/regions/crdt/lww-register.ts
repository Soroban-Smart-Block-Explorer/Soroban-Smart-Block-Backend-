import { compareHlc, type HlcTimestamp } from '../hlc';
import type { Crdt } from './types';

export interface LwwState<T> {
  value: T;
  timestamp: HlcTimestamp;
}

/**
 * Last-Writer-Wins register. Used for `TokenPrice` (Issue #556): every
 * region can write a fresh price locally, and on merge the write with the
 * higher HLC timestamp wins outright. This is lossy by design — the
 * loser's write is discarded, not queued or reconciled — which is the
 * correct tradeoff for a value like a price quote where only the latest
 * observation matters.
 */
export class LwwRegister<T> implements Crdt<LwwState<T>, T> {
  constructor(readonly state: LwwState<T>) {}

  static init<T>(value: T, timestamp: HlcTimestamp): LwwRegister<T> {
    return new LwwRegister({ value, timestamp });
  }

  value(): T {
    return this.state.value;
  }

  merge(other: LwwState<T>): LwwRegister<T> {
    return compareHlc(other.timestamp, this.state.timestamp) > 0
      ? new LwwRegister(other)
      : new LwwRegister(this.state);
  }
}
