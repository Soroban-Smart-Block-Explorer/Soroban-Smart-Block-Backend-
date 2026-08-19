import type { Crdt } from './types';

export type GSetState<T> = T[];

/**
 * Grow-only set: add-only, no removal. Used for `FeedMessage` (Issue #556)
 * where messages are append-only and deletions never need to propagate.
 * Merge is a set union, which is trivially commutative, associative and
 * idempotent. Elements are compared by JSON-stable identity (callers should
 * pass a plain object with a stable `id` field).
 */
export class GSet<T> implements Crdt<GSetState<T>, T[]> {
  constructor(readonly state: GSetState<T> = []) {}

  static init<T>(): GSet<T> {
    return new GSet<T>([]);
  }

  value(): T[] {
    return [...this.state];
  }

  add(element: T): GSet<T> {
    const key = JSON.stringify(element);
    if (this.state.some((e) => JSON.stringify(e) === key)) {
      return this;
    }
    return new GSet([...this.state, element]);
  }

  merge(other: GSetState<T>): GSet<T> {
    const seen = new Set(this.state.map((e) => JSON.stringify(e)));
    const merged = [...this.state];
    for (const element of other) {
      const key = JSON.stringify(element);
      if (!seen.has(key)) {
        merged.push(element);
        seen.add(key);
      }
    }
    return new GSet(merged);
  }
}
