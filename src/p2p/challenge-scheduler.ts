import { prismaWrite as prisma } from '../db';
import { logger } from '../logger';
import { computeLocalIndexHash } from './resolve-location';
import { enqueueReindex } from './reindex-queue';
import { getP2pConfig, getSelfPeerId, ownersOf } from './responsibility';
import type { ChallengeResultKind } from './types';

export type ChallengeTransport = (
  peerId: string,
  ledgerSeq: number,
) => Promise<{ indexHash: string } | null>;

let transport: ChallengeTransport | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

export function setChallengeTransport(fn: ChallengeTransport): void {
  transport = fn;
}

/** Called by the ESM challenge-protocol handler when answering an inbound request. */
export async function answerChallenge(ledgerSeq: number): Promise<string | null> {
  return computeLocalIndexHash(ledgerSeq);
}

async function recordPeerOutcome(peerId: string, passed: boolean, network: string): Promise<void> {
  await prisma.peerNode.upsert({
    where: { id: peerId },
    update: passed
      ? { challengesPassed: { increment: 1 }, lastSeenAt: new Date() }
      : { challengesFailed: { increment: 1 }, lastSeenAt: new Date() },
    create: {
      id: peerId,
      network,
      multiaddrs: [],
      challengesPassed: passed ? 1 : 0,
      challengesFailed: passed ? 0 : 1,
    },
  });
}

/**
 * One challenge-response round (design doc §1.2/§6.2): pick a random ledger
 * this node owns, ask a random co-owner to independently compute its index
 * hash, compare. On mismatch, break the tie with a 3rd co-owner (majority of
 * the range's K replicas wins) rather than assuming either side is at fault.
 */
export async function runChallengeRound(): Promise<void> {
  const cfg = getP2pConfig();
  const self = getSelfPeerId();
  if (!cfg.enabled || !self || !transport) return;

  const owned = await prisma.indexerRangeClaim.findMany({
    where: { network: cfg.network, ownerPeerIds: { has: self }, lastIndexedLedger: { gt: 0 } },
    take: 50,
  });
  if (owned.length === 0) return;

  const range = owned[Math.floor(Math.random() * owned.length)];
  const ledgerSeq = Math.floor(
    Math.random() * (range.lastIndexedLedger - range.startLedger + 1) + range.startLedger,
  );

  const coOwners = ownersOf(ledgerSeq).filter((p) => p !== self);
  if (coOwners.length === 0) return;
  const challenged = coOwners[Math.floor(Math.random() * coOwners.length)];

  const [myHash, theirs] = await Promise.all([
    computeLocalIndexHash(ledgerSeq),
    transport(challenged, ledgerSeq),
  ]);
  if (!myHash || !theirs) return;

  if (myHash === theirs.indexHash) {
    await recordPeerOutcome(challenged, true, cfg.network);
    await prisma.verificationChallenge.create({
      data: {
        network: cfg.network,
        ledgerSequence: ledgerSeq,
        challengerPeerId: self,
        challengedPeerId: challenged,
        challengerHash: myHash,
        challengedHash: theirs.indexHash,
        result: 'match',
      },
    });
    return;
  }

  // Mismatch — break the tie with a third replica rather than assuming who's wrong.
  const tiebreakerCandidates = coOwners.filter((p) => p !== challenged);
  const tiebreaker = tiebreakerCandidates[
    Math.floor(Math.random() * tiebreakerCandidates.length)
  ] as string | undefined;
  const tiebreakerResponse = tiebreaker ? await transport(tiebreaker, ledgerSeq) : null;

  let result: ChallengeResultKind = 'mismatch';
  let faultyPeerId: string | null = null;

  if (tiebreakerResponse) {
    result = 'tiebreak_resolved';
    if (tiebreakerResponse.indexHash === myHash) {
      faultyPeerId = challenged; // 2-of-3 (self + tiebreaker) agree, `challenged` is the outlier
    } else if (tiebreakerResponse.indexHash === theirs.indexHash) {
      // 2-of-3 agree the other way — treat self as the outlier for this ledger and re-verify locally.
      faultyPeerId = self;
    }
    // else: three-way disagreement — no majority, flag for re-index without penalizing anyone yet.
  }

  if (faultyPeerId) {
    await recordPeerOutcome(faultyPeerId, false, cfg.network);
    if (faultyPeerId !== self) {
      await recordPeerOutcome(challenged === faultyPeerId ? self : challenged, true, cfg.network);
    }
  }

  await prisma.verificationChallenge.create({
    data: {
      network: cfg.network,
      ledgerSequence: ledgerSeq,
      challengerPeerId: self,
      challengedPeerId: challenged,
      challengerHash: myHash,
      challengedHash: theirs.indexHash,
      tiebreakerPeerId: tiebreaker ?? null,
      tiebreakerHash: tiebreakerResponse?.indexHash ?? null,
      result,
    },
  });

  await enqueueReindex(cfg.network, ledgerSeq, 'challenge_mismatch', faultyPeerId ?? challenged);
  logger.warn('[p2p:challenge] mismatch detected', {
    network: cfg.network,
    ledgerSeq,
    challenged,
    tiebreaker,
    faultyPeerId,
  });
}

export function startChallengeScheduler(): void {
  const cfg = getP2pConfig();
  if (!cfg.enabled || timer) return;
  const jitter = () => cfg.challengeIntervalMs * (0.75 + Math.random() * 0.5);
  const tick = () => {
    runChallengeRound()
      .catch((err) => logger.error('[p2p:challenge] round failed', { error: String(err) }))
      .finally(() => {
        timer = setTimeout(tick, jitter());
      });
  };
  timer = setTimeout(tick, jitter());
}

export function stopChallengeScheduler(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
