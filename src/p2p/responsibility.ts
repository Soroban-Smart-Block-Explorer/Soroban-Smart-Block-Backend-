import { prismaWrite as prisma } from '../db';
import { logger } from '../logger';
import { loadP2pConfig } from './config';
import { MembershipView } from './membership-view';
import { ownersFor } from './rendezvous';
import { rangeBoundsForLedger } from './range';

/**
 * CJS-safe façade sitting between the plain indexer loop (src/indexer/indexer.ts)
 * and the P2P subsystem. Owns the in-process MembershipView and this node's
 * PeerId. Never imports libp2p — the ESM node-factory pushes heartbeats/self-id
 * into this module via the callbacks wired in src/p2p/index.ts, and the CJS
 * indexer only ever calls the plain functions below.
 */

const p2pConfig = loadP2pConfig();
const membershipView = new MembershipView(
  p2pConfig.network,
  p2pConfig.heartbeatIntervalMs * p2pConfig.heartbeatMissedIntervalsBeforeStale,
);

let selfPeerId: string | null = null;

export function setSelfPeerId(peerId: string): void {
  selfPeerId = peerId;
  membershipView.recordHeartbeat(peerId, [], Date.now());
}

export function getSelfPeerId(): string | null {
  return selfPeerId;
}

export function getMembershipView(): MembershipView {
  return membershipView;
}

export function recordPeerHeartbeat(peerId: string, multiaddrs: string[], timestamp: number): void {
  membershipView.recordHeartbeat(peerId, multiaddrs, timestamp);
}

/** Active peer set including self (self is always "active" from its own point of view). */
function activePeerIdsIncludingSelf(now: number): string[] {
  const active = membershipView.activePeerIds(now);
  if (selfPeerId && !active.includes(selfPeerId)) active.push(selfPeerId);
  return active;
}

export function ownersOf(ledgerSeq: number, now: number = Date.now()): string[] {
  const bounds = rangeBoundsForLedger(p2pConfig.network, ledgerSeq, p2pConfig.rangeSize);
  return ownersFor(bounds.rangeId, activePeerIdsIncludingSelf(now), p2pConfig.replicationFactor);
}

export function amIResponsibleFor(ledgerSeq: number, now: number = Date.now()): boolean {
  if (!p2pConfig.enabled) return true; // single-node mode: always responsible (today's behavior)
  if (!selfPeerId) return false; // p2p node hasn't finished starting yet
  return ownersOf(ledgerSeq, now).includes(selfPeerId);
}

export function isP2pEnabled(): boolean {
  return p2pConfig.enabled;
}

export function getP2pConfig() {
  return p2pConfig;
}

// ── Per-range indexing cursor (replaces the singleton IndexerState row in P2P mode) ──

export async function getRangeCursor(ledgerSeq: number): Promise<number> {
  const bounds = rangeBoundsForLedger(p2pConfig.network, ledgerSeq, p2pConfig.rangeSize);
  const claim = await prisma.indexerRangeClaim.upsert({
    where: { rangeId: bounds.rangeId },
    update: {},
    create: {
      rangeId: bounds.rangeId,
      network: bounds.network,
      startLedger: bounds.startLedger,
      endLedger: bounds.endLedger,
      lastIndexedLedger: Math.max(bounds.startLedger - 1, 0),
      ownerPeerIds: ownersOf(ledgerSeq),
    },
  });
  return claim.lastIndexedLedger;
}

export async function setRangeCursor(ledgerSeq: number, indexedThrough: number): Promise<void> {
  const bounds = rangeBoundsForLedger(p2pConfig.network, ledgerSeq, p2pConfig.rangeSize);
  await prisma.indexerRangeClaim.upsert({
    where: { rangeId: bounds.rangeId },
    update: {
      lastIndexedLedger: indexedThrough,
      ownerPeerIds: ownersOf(ledgerSeq),
      lastClaimedAt: new Date(),
    },
    create: {
      rangeId: bounds.rangeId,
      network: bounds.network,
      startLedger: bounds.startLedger,
      endLedger: bounds.endLedger,
      lastIndexedLedger: indexedThrough,
      ownerPeerIds: ownersOf(ledgerSeq),
    },
  });
}

/** Periodically recompute+persist ownerPeerIds for ranges this node currently owns (dashboard/debug aid). */
export async function refreshOwnedRangeClaims(now: number = Date.now()): Promise<void> {
  if (!selfPeerId) return;
  const owned = await prisma.indexerRangeClaim.findMany({
    where: { network: p2pConfig.network, ownerPeerIds: { has: selfPeerId } },
  });
  for (const range of owned) {
    const owners = ownersFor(
      range.rangeId,
      activePeerIdsIncludingSelf(now),
      p2pConfig.replicationFactor,
    );
    if (!owners.includes(selfPeerId)) {
      logger.info('[p2p:responsibility] no longer own range', { rangeId: range.rangeId });
    }
    await prisma.indexerRangeClaim.update({
      where: { rangeId: range.rangeId },
      data: { ownerPeerIds: owners, lastClaimedAt: new Date() },
    });
  }
}
