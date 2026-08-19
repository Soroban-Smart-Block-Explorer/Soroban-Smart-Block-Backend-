import { compareHlc, type HlcTimestamp } from '../hlc';
import type { Crdt } from './types';

export interface AddOnceRecordState<TImmutable, TMutable extends Record<string, unknown>> {
  /** Set once at creation; never changes across regions (e.g. a Transaction's hash, ledger, operations). */
  immutable: TImmutable;
  /** Per-field LWW registers for values that legitimately change after creation (e.g. `status`). */
  mutable: { [K in keyof TMutable]: { value: TMutable[K]; timestamp: HlcTimestamp } };
}

/**
 * Custom composite CRDT for records that are created once but have a small
 * number of mutable fields — the shape Issue #556 calls out explicitly:
 * "transactions are essentially add-only, but status updates need LWW".
 *
 * The immutable part merges by "first write wins" (any region can create
 * the record; every region ends up with the same immutable payload because
 * it's derived from the same on-chain event). Each mutable field merges
 * independently as its own LWW register, so a `status` update from one
 * region can't accidentally clobber a `confirmations` update from another.
 */
export class AddOnceRecord<TImmutable, TMutable extends Record<string, unknown>> implements Crdt<
  AddOnceRecordState<TImmutable, TMutable>,
  { immutable: TImmutable } & TMutable
> {
  constructor(readonly state: AddOnceRecordState<TImmutable, TMutable>) {}

  static init<TImmutable, TMutable extends Record<string, unknown>>(
    immutable: TImmutable,
    mutable: TMutable,
    timestamp: HlcTimestamp,
  ): AddOnceRecord<TImmutable, TMutable> {
    const fields = {} as AddOnceRecordState<TImmutable, TMutable>['mutable'];
    for (const key of Object.keys(mutable) as Array<keyof TMutable>) {
      fields[key] = { value: mutable[key], timestamp };
    }
    return new AddOnceRecord({ immutable, mutable: fields });
  }

  value(): { immutable: TImmutable } & TMutable {
    const mutableValues = {} as TMutable;
    for (const key of Object.keys(this.state.mutable) as Array<keyof TMutable>) {
      mutableValues[key] = this.state.mutable[key].value;
    }
    return { immutable: this.state.immutable, ...mutableValues };
  }

  /** Set a mutable field locally, e.g. transaction status flips to "confirmed". */
  setField<K extends keyof TMutable>(
    field: K,
    value: TMutable[K],
    timestamp: HlcTimestamp,
  ): AddOnceRecord<TImmutable, TMutable> {
    return new AddOnceRecord({
      immutable: this.state.immutable,
      mutable: { ...this.state.mutable, [field]: { value, timestamp } },
    });
  }

  merge(other: AddOnceRecordState<TImmutable, TMutable>): AddOnceRecord<TImmutable, TMutable> {
    const mergedMutable = { ...this.state.mutable };
    for (const key of Object.keys(other.mutable) as Array<keyof TMutable>) {
      const ours = mergedMutable[key];
      const theirs = other.mutable[key];
      if (!ours || compareHlc(theirs.timestamp, ours.timestamp) > 0) {
        mergedMutable[key] = theirs;
      }
    }
    // Immutable payloads are expected to be identical across regions since
    // they derive from the same source-of-truth ledger event; if they ever
    // diverge that's a data-integrity bug, not something merge should hide.
    return new AddOnceRecord({ immutable: this.state.immutable, mutable: mergedMutable });
  }
}
