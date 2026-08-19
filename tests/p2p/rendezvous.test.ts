import { describe, it, expect } from 'vitest';
import { isOwner, ownersFor, scoreFor } from '../../src/p2p/rendezvous';

describe('rendezvous hashing', () => {
  it('is deterministic for a fixed peer set and range', () => {
    const peers = ['peerA', 'peerB', 'peerC', 'peerD', 'peerE'];
    const a = ownersFor('testnet:0-10000', peers, 3);
    const b = ownersFor('testnet:0-10000', peers, 3);
    expect(a).toEqual(b);
    expect(a).toHaveLength(3);
  });

  it('returns distinct owners for distinct ranges (not always the same top-K)', () => {
    const peers = ['peerA', 'peerB', 'peerC', 'peerD', 'peerE', 'peerF', 'peerG'];
    const rangeIds = Array.from(
      { length: 20 },
      (_, i) => `testnet:${i * 10000}-${(i + 1) * 10000}`,
    );
    const ownerSets = rangeIds.map((id) => ownersFor(id, peers, 3).sort().join(','));
    const uniqueSets = new Set(ownerSets);
    // With 7 peers and K=3 across 20 ranges, we should see meaningfully more
    // than one distinct owner combination — otherwise the hash isn't
    // actually varying with the range id.
    expect(uniqueSets.size).toBeGreaterThan(1);
  });

  it('has the minimal-disruption property: adding a peer only reassigns a fraction of ranges', () => {
    const before = ['peerA', 'peerB', 'peerC', 'peerD', 'peerE'];
    const after = [...before, 'peerF'];
    const rangeIds = Array.from(
      { length: 200 },
      (_, i) => `testnet:${i * 10000}-${(i + 1) * 10000}`,
    );

    let changed = 0;
    for (const rangeId of rangeIds) {
      const beforeOwners = ownersFor(rangeId, before, 3).sort().join(',');
      const afterOwners = ownersFor(rangeId, after, 3).sort().join(',');
      if (beforeOwners !== afterOwners) changed++;
    }

    // Adding 1 peer to a pool of 5 (K=3) should reassign roughly K/N of
    // ranges, not all of them. Assert it's a strict minority.
    expect(changed).toBeLessThan(rangeIds.length * 0.6);
    expect(changed).toBeGreaterThan(0);
  });

  it('never returns more than K owners, and fewer if the peer pool is smaller than K', () => {
    expect(ownersFor('testnet:0-10000', ['peerA', 'peerB'], 3)).toHaveLength(2);
    expect(ownersFor('testnet:0-10000', [], 3)).toHaveLength(0);
    expect(ownersFor('testnet:0-10000', ['peerA'], 0)).toHaveLength(0);
  });

  it('deduplicates repeated peer ids in the active set', () => {
    const owners = ownersFor('testnet:0-10000', ['peerA', 'peerA', 'peerB'], 3);
    expect(owners).toHaveLength(2);
  });

  it('isOwner agrees with ownersFor', () => {
    const peers = ['peerA', 'peerB', 'peerC', 'peerD'];
    const owners = ownersFor('testnet:0-10000', peers, 2);
    for (const p of peers) {
      expect(isOwner(p, 'testnet:0-10000', peers, 2)).toBe(owners.includes(p));
    }
  });

  it('scoreFor is a deterministic function of (peerId, rangeId)', () => {
    const s1 = scoreFor('peerA', 'testnet:0-10000');
    const s2 = scoreFor('peerA', 'testnet:0-10000');
    const s3 = scoreFor('peerA', 'testnet:10000-20000');
    expect(s1).toBe(s2);
    expect(s1).not.toBe(s3);
  });
});
