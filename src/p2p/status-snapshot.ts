import { prismaRead } from '../db';
import { getMembershipView, getP2pConfig, getSelfPeerId } from './responsibility';

export interface P2pStatusSnapshot {
  enabled: boolean;
  network: string;
  selfPeerId: string | null;
  replicationFactor: number;
  rangeSize: number;
  activePeerCount: number;
  peers: Array<{
    peerId: string;
    multiaddrs: string[];
    lastSeenAt: string;
    reputationScore: number;
  }>;
  ranges: Array<{
    rangeId: string;
    startLedger: number;
    endLedger: number;
    ownerPeerIds: string[];
    lastIndexedLedger: number;
    lastClaimedAt: string;
  }>;
  recentChallenges: Array<{
    ledgerSequence: number;
    challengerPeerId: string;
    challengedPeerId: string;
    result: string;
    createdAt: string;
  }>;
  pendingReindexTasks: number;
}

/** Assembles the peer/range/challenge table backing GET /p2p/status. */
export async function getP2pStatusSnapshot(): Promise<P2pStatusSnapshot> {
  const cfg = getP2pConfig();
  const membership = getMembershipView();
  const now = Date.now();

  const [ranges, recentChallenges, pendingReindexTasks] = cfg.enabled
    ? await Promise.all([
        prismaRead.indexerRangeClaim.findMany({
          where: { network: cfg.network },
          orderBy: { startLedger: 'asc' },
          take: 200,
        }),
        prismaRead.verificationChallenge.findMany({
          where: { network: cfg.network },
          orderBy: { createdAt: 'desc' },
          take: 20,
        }),
        prismaRead.reindexTask.count({ where: { network: cfg.network, status: 'pending' } }),
      ])
    : [[], [], 0];

  return {
    enabled: cfg.enabled,
    network: cfg.network,
    selfPeerId: getSelfPeerId(),
    replicationFactor: cfg.replicationFactor,
    rangeSize: cfg.rangeSize,
    activePeerCount: membership.activePeerIds(now).length,
    peers: membership.all().map((p) => ({
      peerId: p.peerId,
      multiaddrs: p.multiaddrs,
      lastSeenAt: new Date(p.lastSeenAt).toISOString(),
      reputationScore: p.reputationScore,
    })),
    ranges: ranges.map((r) => ({
      rangeId: r.rangeId,
      startLedger: r.startLedger,
      endLedger: r.endLedger,
      ownerPeerIds: r.ownerPeerIds,
      lastIndexedLedger: r.lastIndexedLedger,
      lastClaimedAt: r.lastClaimedAt.toISOString(),
    })),
    recentChallenges: recentChallenges.map((c) => ({
      ledgerSequence: c.ledgerSequence,
      challengerPeerId: c.challengerPeerId,
      challengedPeerId: c.challengedPeerId,
      result: c.result,
      createdAt: c.createdAt.toISOString(),
    })),
    pendingReindexTasks,
  };
}
