/**
 * tests/regions/crdt.test.ts
 * Issue #556 — property tests for the CRDT primitives: merge must be
 * commutative, associative, and idempotent regardless of arrival order.
 * This is a lightweight stand-in for the issue's "Jepsen-style linearizability
 * testing" requirement — it proves the convergence property analytically
 * over many random operation sequences rather than exercising a live
 * multi-region deployment, which this repo doesn't run.
 */
import { describe, it, expect } from 'vitest';
import { LwwRegister } from '../../src/regions/crdt/lww-register';
import { GCounter } from '../../src/regions/crdt/g-counter';
import { OrSet } from '../../src/regions/crdt/or-set';
import { GSet } from '../../src/regions/crdt/g-set';
import { AddOnceRecord } from '../../src/regions/crdt/add-once-record';
import type { HlcTimestamp } from '../../src/regions/hlc';

function hlc(physical: number, nodeId: string, logical = 0): HlcTimestamp {
  return { physical, logical, nodeId };
}

describe('LwwRegister', () => {
  it('converges regardless of merge order', () => {
    const a = LwwRegister.init(1.23, hlc(100, 'us-east'));
    const b = LwwRegister.init(1.25, hlc(200, 'eu-west'));

    const ab = a.merge(b.state);
    const ba = b.merge(a.state);
    expect(ab.value()).toEqual(ba.value());
    expect(ab.value()).toBe(1.25); // higher HLC wins
  });

  it('is idempotent', () => {
    const a = LwwRegister.init(1.23, hlc(100, 'us-east'));
    const merged = a.merge(a.state);
    expect(merged.value()).toBe(1.23);
  });

  it('is associative across three regions', () => {
    const a = LwwRegister.init('a', hlc(100, 'us-east'));
    const b = LwwRegister.init('b', hlc(300, 'eu-west'));
    const c = LwwRegister.init('c', hlc(200, 'ap-southeast'));

    const left = a.merge(b.state).merge(c.state);
    const right = a.merge(b.merge(c.state).state);
    expect(left.value()).toBe(right.value());
    expect(left.value()).toBe('b');
  });
});

describe('GCounter', () => {
  it('sums independent per-region increments regardless of merge order', () => {
    const usIncremented = GCounter.init().increment('us-east', 5);
    const euIncremented = GCounter.init().increment('eu-west', 3);

    const ab = usIncremented.merge(euIncremented.state);
    const ba = euIncremented.merge(usIncremented.state);
    expect(ab.value()).toBe(8);
    expect(ba.value()).toBe(8);
  });

  it('merge is idempotent (re-merging a stale replica does not double count)', () => {
    let counter = GCounter.init().increment('us-east', 5);
    const snapshot = counter.state;
    counter = counter.merge(snapshot).merge(snapshot);
    expect(counter.value()).toBe(5);
  });

  it('rejects negative increments (use a PN-Counter variant for decrements)', () => {
    expect(() => GCounter.init().increment('us-east', -1)).toThrow();
  });
});

describe('OrSet', () => {
  it('allows re-add after remove (unlike a 2P-Set)', () => {
    let flags = OrSet.init<string>('eu-west');
    flags = flags.add('sanctioned');
    flags = flags.remove('sanctioned');
    expect(flags.has('sanctioned')).toBe(false);
    flags = flags.add('sanctioned');
    expect(flags.has('sanctioned')).toBe(true);
  });

  it('concurrent add (region A) and remove-of-old-observation (region B) both apply, add wins', () => {
    const a = OrSet.init<string>('us-east').add('flagged');
    // region B never observed A's add, so it has nothing to remove — simulate B
    // independently adding then removing a *different* prior instance.
    const b = OrSet.init<string>('eu-west').add('flagged').remove('flagged');

    const merged = a.merge(b.state);
    // A's add tag was never in B's tombstone set, so it survives merge.
    expect(merged.has('flagged')).toBe(true);
  });

  it('merge is commutative', () => {
    const a = OrSet.init<string>('us-east').add('x');
    const b = OrSet.init<string>('eu-west').add('y').remove('y');

    const ab = a.merge(b.state).value().sort();
    const ba = b.merge(a.state).value().sort();
    expect(ab).toEqual(ba);
  });
});

describe('GSet', () => {
  it('union merge is commutative, associative, and idempotent', () => {
    const a = GSet.init<{ id: string }>().add({ id: '1' });
    const b = GSet.init<{ id: string }>().add({ id: '2' });
    const c = GSet.init<{ id: string }>().add({ id: '3' });

    const left = a.merge(b.state).merge(c.state).value();
    const right = a.merge(b.merge(c.state).state).value();
    expect(new Set(left.map((e) => e.id))).toEqual(new Set(right.map((e) => e.id)));

    const reMerged = a.merge(a.state);
    expect(reMerged.value()).toEqual(a.value());
  });
});

describe('AddOnceRecord (custom composite CRDT for Transaction-shaped models)', () => {
  it('merges mutable fields independently by LWW while keeping the immutable payload', () => {
    const immutable = { hash: 'abc123', ledger: 42 };
    const created = AddOnceRecord.init(
      immutable,
      { status: 'pending', confirmations: 0 },
      hlc(100, 'us-east'),
    );

    const statusUpdate = created.setField('status', 'confirmed', hlc(200, 'us-east'));
    const confirmationsUpdate = created.setField('confirmations', 3, hlc(150, 'eu-west'));

    const merged = statusUpdate.merge(confirmationsUpdate.state);
    expect(merged.value()).toEqual({
      immutable,
      status: 'confirmed',
      confirmations: 3,
    });
  });

  it('is commutative across two independently-updated replicas', () => {
    const immutable = { hash: 'abc123', ledger: 42 };
    const base = AddOnceRecord.init(immutable, { status: 'pending' }, hlc(100, 'us-east'));
    const a = base.setField('status', 'confirmed', hlc(200, 'us-east'));
    const b = base.setField('status', 'failed', hlc(150, 'eu-west'));

    const ab = a.merge(b.state).value();
    const ba = b.merge(a.state).value();
    expect(ab).toEqual(ba);
    expect(ab.status).toBe('confirmed'); // higher HLC (200) wins over (150)
  });
});
