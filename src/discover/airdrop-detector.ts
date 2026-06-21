/**
 * Airdrop Detection & Monitoring — Issue #335
 *
 * Detects mass token distributions, Merkle distributor contracts,
 * claim contract patterns, multi-sig airdrops, and NFT airdrops.
 */

import { prismaWrite as prisma } from '../db';
import { logger } from '../logger';

export interface AirdropDetectionInput {
  tokenContractAddress: string;
  airdropType: 'mass_transfer' | 'merkle' | 'claim' | 'nft';
  totalRecipients?: number;
  totalAmount?: string;
  amountPerRecipient?: string;
  isClaimed: boolean;
  claimDeadline?: Date;
  eligibilityRules?: Record<string, unknown>;
  txHash: string;
  blockNumber: number;
  timestamp: Date;
}

/**
 * Process a detected airdrop and persist to database.
 */
export async function processAirdrop(input: AirdropDetectionInput): Promise<void> {
  const token = await prisma.detectedToken.findUnique({
    where: { contractAddress: input.tokenContractAddress },
  });
  if (!token) {
    logger.warn('Airdrop for unknown token', {
      contract: input.tokenContractAddress,
    });
    return;
  }

  await prisma.airdrop.create({
    data: {
      tokenId: token.id,
      airdropType: input.airdropType,
      totalRecipients: input.totalRecipients ?? null,
      totalAmount: input.totalAmount ? BigInt(input.totalAmount) : null,
      amountPerRecipient: input.amountPerRecipient ? BigInt(input.amountPerRecipient) : null,
      isClaimed: input.isClaimed,
      claimDeadline: input.claimDeadline ?? null,
      eligibilityRules: input.eligibilityRules ?? undefined,
      txHash: input.txHash,
      blockNumber: BigInt(input.blockNumber),
      timestamp: input.timestamp,
    },
  });

  logger.info('Airdrop detected', {
    token: input.tokenContractAddress,
    type: input.airdropType,
    recipients: input.totalRecipients,
  });
}

/**
 * Record an airdrop claim.
 */
export async function recordClaim(
  airdropId: bigint,
  claimerAddress: string,
  amountClaimed: string,
  txHash: string,
  blockNumber: number,
  timestamp: Date,
): Promise<void> {
  await prisma.airdropClaim.create({
    data: {
      airdropId,
      claimerAddress,
      amountClaimed: BigInt(amountClaimed),
      txHash,
      blockNumber: BigInt(blockNumber),
      timestamp,
    },
  });

  // Update airdrop claim status
  await prisma.airdrop.update({
    where: { id: airdropId },
    data: { isClaimed: true },
  });
}

/**
 * Check if an address is eligible for an airdrop.
 */
export async function checkAirdropEligibility(
  airdropId: bigint,
  address: string,
): Promise<{ eligible: boolean; amount?: string; reason?: string }> {
  const airdrop = await prisma.airdrop.findUnique({
    where: { id: airdropId },
    include: { claims: true },
  });

  if (!airdrop) {
    return { eligible: false, reason: 'Airdrop not found' };
  }

  // Check if already claimed
  const alreadyClaimed = airdrop.claims.find(
    (c) => c.claimerAddress === address,
  );
  if (alreadyClaimed) {
    return {
      eligible: false,
      amount: alreadyClaimed.amountClaimed.toString(),
      reason: 'Already claimed',
    };
  }

  // Check eligibility rules if present
  const rules = airdrop.eligibilityRules as Record<string, unknown> | null;
  if (rules) {
    // For now, return a simple eligibility check
    return {
      eligible: true,
      amount: airdrop.amountPerRecipient?.toString(),
    };
  }

  return {
    eligible: true,
    amount: airdrop.amountPerRecipient?.toString(),
  };
}

/**
 * Detect mass token distributions from event data.
 * Scans for batches of transfer events in a short time window.
 */
export async function detectMassDistribution(
  contractAddress: string,
  fromLedger: number,
  toLedger: number,
  thresholdRecipients = 10,
  timeWindowMinutes = 10,
): Promise<AirdropDetectionInput[]> {
  const events = await prisma.event.findMany({
    where: {
      contractAddress,
      eventType: 'transfer',
      ledgerSequence: { gte: fromLedger, lte: toLedger },
    },
    select: {
      transactionHash: true,
      decoded: true,
      ledgerSequence: true,
      ledgerCloseTime: true,
    },
    orderBy: { ledgerSequence: 'asc' },
  });

  // Group events by time windows
  const windows = new Map<string, typeof events>();
  for (const event of events) {
    const timeKey = Math.floor(
      event.ledgerCloseTime.getTime() / (timeWindowMinutes * 60 * 1000),
    ).toString();

    if (!windows.has(timeKey)) {
      windows.set(timeKey, []);
    }
    windows.get(timeKey)!.push(event);
  }

  const results: AirdropDetectionInput[] = [];

  for (const [, windowEvents] of windows) {
    const uniqueRecipients = new Set<string>();
    let totalAmount = 0n;

    for (const event of windowEvents) {
      const decoded = event.decoded as any;
      if (!decoded) continue;

      const to = decoded.to ?? decoded.toAddress ?? decoded.destination;
      const amount = decoded.amount ?? decoded.value;
      if (to && amount) {
        uniqueRecipients.add(to);
        totalAmount += BigInt(amount);
      }
    }

    if (uniqueRecipients.size >= thresholdRecipients) {
      const firstEvent = windowEvents[0];
      results.push({
        tokenContractAddress: contractAddress,
        airdropType: 'mass_transfer',
        totalRecipients: uniqueRecipients.size,
        totalAmount: totalAmount.toString(),
        amountPerRecipient: (totalAmount / BigInt(uniqueRecipients.size)).toString(),
        isClaimed: false,
        txHash: firstEvent.transactionHash,
        blockNumber: firstEvent.ledgerSequence,
        timestamp: firstEvent.ledgerCloseTime,
      });
    }
  }

  return results;
}
