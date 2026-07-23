import type { Crdt } from './types';

interface Tag {
  nodeId: string;
  counter: number;
}

export interface OrSetState<T> {
  /** Every element ever added, tagged with a unique (nodeId, counter) per add. */
  added: Array<{ element: T; tag: Tag }>;
  /** Tags that have since been removed (tombstones). */
  removed: Tag[];
}

function tagKey(tag: Tag): string {
  return `${tag.nodeId}:${tag.counter}`;
}

/**
 * Observed-Remove Set. Used for `ComplianceScreeningResult` (Issue #556:
 * "positive-negative flag with observed-remove set"): a screening result
 * can flip (flagged -> cleared -> re-flagged) across regions, and unlike a
 * plain 2P-Set, an OR-Set lets an element be re-added after removal because
 * each add gets a fresh unique tag. An element is "present" iff it has at
 * least one add tag that isn't in the tombstone set.
 */
export class OrSet<T> implements Crdt<OrSetState<T>, T[]> {
  private counter = 0;

  constructor(
    readonly state: OrSetState<T> = { added: [], removed: [] },
    private readonly nodeId: string = 'local',
  ) {}

  static init<T>(nodeId: string): OrSet<T> {
    return new OrSet<T>({ added: [], removed: [] }, nodeId);
  }

  value(): T[] {
    const removedKeys = new Set(this.state.removed.map(tagKey));
    const present = new Map<string, T>();
    for (const { element, tag } of this.state.added) {
      if (!removedKeys.has(tagKey(tag))) {
        present.set(JSON.stringify(element), element);
      }
    }
    return [...present.values()];
  }

  has(element: T): boolean {
    return this.value().some((v) => JSON.stringify(v) === JSON.stringify(element));
  }

  add(element: T): OrSet<T> {
    this.counter += 1;
    const tag: Tag = { nodeId: this.nodeId, counter: this.counter };
    const next = new OrSet<T>(
      { added: [...this.state.added, { element, tag }], removed: this.state.removed },
      this.nodeId,
    );
    next.counter = this.counter;
    return next;
  }

  /** Removes every currently-observed add-tag for this element (a "remove wins" over concurrent observed adds). */
  remove(element: T): OrSet<T> {
    const removedTags = this.state.added
      .filter((a) => JSON.stringify(a.element) === JSON.stringify(element))
      .map((a) => a.tag);
    const next = new OrSet<T>(
      { added: this.state.added, removed: [...this.state.removed, ...removedTags] },
      this.nodeId,
    );
    next.counter = this.counter;
    return next;
  }

  merge(other: OrSetState<T>): OrSet<T> {
    const seenAdds = new Set(this.state.added.map((a) => tagKey(a.tag)));
    const mergedAdds = [...this.state.added];
    for (const a of other.added) {
      if (!seenAdds.has(tagKey(a.tag))) {
        mergedAdds.push(a);
        seenAdds.add(tagKey(a.tag));
      }
    }
    const seenRemoves = new Set(this.state.removed.map(tagKey));
    const mergedRemoves = [...this.state.removed];
    for (const tag of other.removed) {
      if (!seenRemoves.has(tagKey(tag))) {
        mergedRemoves.push(tag);
        seenRemoves.add(tagKey(tag));
      }
    }
    const next = new OrSet<T>({ added: mergedAdds, removed: mergedRemoves }, this.nodeId);
    next.counter = this.counter;
    return next;
  }
}
