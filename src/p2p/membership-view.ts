import type { NetworkName, PeerRecord } from './types';

/**
 * In-process, eventually-consistent view of which peers are currently alive
 * in this node's network swarm. Fed by gossiped heartbeats (see
 * esm/protocols/membership-gossip.mts) via recordHeartbeat(); never itself
 * touches libp2p types, so it's safe to import from CJS code.
 */
export class MembershipView {
  private readonly peers = new Map<string, PeerRecord>();

  constructor(
    private readonly network: NetworkName,
    private readonly ttlMs: number,
  ) {}

  recordHeartbeat(peerId: string, multiaddrs: string[], timestamp: number): void {
    const existing = this.peers.get(peerId);
    this.peers.set(peerId, {
      peerId,
      network: this.network,
      multiaddrs,
      lastSeenAt: timestamp,
      reputationScore: existing?.reputationScore ?? 50,
    });
  }

  updateReputation(peerId: string, reputationScore: number): void {
    const existing = this.peers.get(peerId);
    if (!existing) return;
    existing.reputationScore = reputationScore;
  }

  /** Drop peers not heard from within ttlMs of `now`. Call periodically. */
  sweepStale(now: number): string[] {
    const removed: string[] = [];
    for (const [peerId, record] of this.peers) {
      if (now - record.lastSeenAt > this.ttlMs) {
        this.peers.delete(peerId);
        removed.push(peerId);
      }
    }
    return removed;
  }

  activePeerIds(now: number): string[] {
    return Array.from(this.peers.values())
      .filter((p) => now - p.lastSeenAt <= this.ttlMs)
      .map((p) => p.peerId);
  }

  get(peerId: string): PeerRecord | undefined {
    return this.peers.get(peerId);
  }

  all(): PeerRecord[] {
    return Array.from(this.peers.values());
  }

  size(): number {
    return this.peers.size;
  }
}
