import type { HlcTimestamp } from '../hlc';

/**
 * Common shape every CRDT in this module implements: a pure, commutative,
 * associative, idempotent `merge`. `merge` must never throw and must never
 * depend on arrival order — that's what makes cross-region replication
 * eventually consistent without coordination (Issue #556).
 */
export interface Crdt<TState, TValue> {
  readonly state: TState;
  value(): TValue;
  merge(other: TState): Crdt<TState, TValue>;
}

export { HlcTimestamp };
