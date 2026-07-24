import { describe, it, expect } from 'vitest';
import { MembershipView } from '../../src/p2p/membership-view';

describe('MembershipView', () => {
  it('reports a peer active immediately after a heartbeat', () => {
    const view = new MembershipView('testnet', 30_000);
    view.recordHeartbeat('peerA', ['/ip4/1.2.3.4/tcp/4001'], 1000);
    expect(view.activePeerIds(1000)).toEqual(['peerA']);
  });

  it('drops a peer from activePeerIds once its heartbeat is older than the TTL', () => {
    const view = new MembershipView('testnet', 30_000);
    view.recordHeartbeat('peerA', [], 1000);
    expect(view.activePeerIds(1000 + 30_000)).toEqual(['peerA']); // exactly at TTL boundary: still active
    expect(view.activePeerIds(1000 + 30_001)).toEqual([]); // past TTL: stale
  });

  it('sweepStale removes and returns peers past TTL, leaving fresh ones', () => {
    const view = new MembershipView('testnet', 10_000);
    view.recordHeartbeat('stale', [], 0);
    view.recordHeartbeat('fresh', [], 20_000);
    const removed = view.sweepStale(20_000);
    expect(removed).toEqual(['stale']);
    expect(view.all().map((p) => p.peerId)).toEqual(['fresh']);
  });

  it('a later heartbeat refreshes lastSeenAt without duplicating the peer', () => {
    const view = new MembershipView('testnet', 10_000);
    view.recordHeartbeat('peerA', ['/addr1'], 0);
    view.recordHeartbeat('peerA', ['/addr2'], 5000);
    expect(view.size()).toBe(1);
    expect(view.get('peerA')?.multiaddrs).toEqual(['/addr2']);
    expect(view.get('peerA')?.lastSeenAt).toBe(5000);
  });

  it('preserves reputationScore across heartbeats and updateReputation changes it', () => {
    const view = new MembershipView('testnet', 10_000);
    view.recordHeartbeat('peerA', [], 0);
    expect(view.get('peerA')?.reputationScore).toBe(50);
    view.updateReputation('peerA', 90);
    view.recordHeartbeat('peerA', [], 5000); // re-heartbeat should not reset reputation
    expect(view.get('peerA')?.reputationScore).toBe(90);
  });

  it('updateReputation on an unknown peer is a no-op, not a crash', () => {
    const view = new MembershipView('testnet', 10_000);
    expect(() => view.updateReputation('unknown', 10)).not.toThrow();
  });
});
