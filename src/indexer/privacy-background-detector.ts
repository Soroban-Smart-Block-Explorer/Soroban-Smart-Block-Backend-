/* eslint-disable @typescript-eslint/no-explicit-any */

import { prismaRead, prismaWrite } from '../db';
import { processPrivacyDetection } from './privacy-detector';
import { scoreAndUpdatePrivacyTransaction } from './privacy-scorer';

async function scanRecentTransactions(limit = 200): Promise<number> {
  const txs = await prismaRead.transaction.findMany({
    where: {
      functionName: { not: null },
    },
    orderBy: { ledgerSequence: 'desc' },
    take: limit,
    select: {
      hash: true,
      functionName: true,
      sourceAccount: true,
      ledgerSequence: true,
      ledgerCloseTime: true,
      contractAddress: true,
      feeCharged: true,
    },
  });

  let detected = 0;

  for (const tx of txs) {
    const existing = await prismaRead.privacyTransaction.findUnique({
      where: { txHash: tx.hash },
    });
    if (existing) continue;

    try {
      const result = await processPrivacyDetection(
        tx.hash,
        tx.functionName,
        [],
        tx.sourceAccount,
        tx.ledgerSequence,
        tx.ledgerCloseTime,
        tx.contractAddress,
        tx.feeCharged,
      );

      if (result && result.protocols.length > 0) {
        await scoreAndUpdatePrivacyTransaction(
          tx.hash,
          result.protocols,
          result.guarantees,
          result.anonymitySetSize,
          tx.sourceAccount,
          result.contractAddresses,
        );
        detected++;
      }
    } catch (err) {
      console.error(`[privacy-detector] Error processing ${tx.hash}:`, err);
    }
  }

  return detected;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function runAnalyticsAggregation(period: string): Promise<void> {
  const now = new Date();
  let startDate: Date;

  switch (period) {
    case 'hour':
      startDate = new Date(now.getTime() - 60 * 60 * 1000);
      break;
    case 'day':
      startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      break;
    case 'week':
      startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    default:
      startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  }

  const privateTxs = await prismaRead.privacyTransaction.findMany({
    where: { timestamp: { gte: startDate } },
  });

  const totalTxCount = await prismaRead.transaction.count({
    where: { ledgerCloseTime: { gte: startDate } },
  });

  if (privateTxs.length === 0) return;

  const byProtocol: Record<string, number> = {};
  for (const tx of privateTxs) {
    for (const p of tx.protocols) {
      byProtocol[p] = (byProtocol[p] || 0) + 1;
    }
  }

  const scores = privateTxs.filter((t) => t.privacyScore !== null).map((t) => t.privacyScore!);
  const riskScores = privateTxs.filter((t) => t.riskScore !== null).map((t) => t.riskScore!);
  const anonSets = privateTxs
    .filter((t) => t.anonymitySetSize !== null)
    .map((t) => t.anonymitySetSize!);
  const totalVolume = privateTxs.reduce((acc, t) => acc + (Number(t.totalValue) || 0), 0);
  const uniqueUsers = new Set(privateTxs.flatMap((t) => t.participants)).size;
  const uniqueContracts = new Set(privateTxs.flatMap((t) => t.contractAddresses)).size;

  await prismaWrite.privacyAnalytics.create({
    data: {
      timestamp: now,
      period,
      totalPrivateTx: privateTxs.length,
      totalTx: totalTxCount,
      totalVolume: String(totalVolume),
      privacyShare: totalTxCount > 0 ? privateTxs.length / totalTxCount : 0,
      volumeShare:
        totalTxCount > 0
          ? privateTxs.filter((t) => t.totalValue !== null).length / totalTxCount
          : 0,
      byProtocol,
      avgAnonymitySet:
        anonSets.length > 0 ? anonSets.reduce((a, b) => a + b, 0) / anonSets.length : null,
      maxAnonymitySet: anonSets.length > 0 ? Math.max(...anonSets) : null,
      medianAnonymitySet: anonSets.length > 0 ? median(anonSets) : null,
      avgPrivacyScore: scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
      avgRiskScore:
        riskScores.length > 0 ? riskScores.reduce((a, b) => a + b, 0) / riskScores.length : null,
      uniqueUsers,
      uniqueContracts,
    },
  });

  for (const [protocol, count] of Object.entries(byProtocol)) {
    const protoTxs = privateTxs.filter((t) => t.protocols.includes(protocol as any));
    const protoAnonSets = protoTxs
      .filter((t) => t.anonymitySetSize !== null)
      .map((t) => t.anonymitySetSize!);
    const protoUsers = new Set(protoTxs.flatMap((t) => t.participants));

    await prismaWrite.privacyProtocolDetail.create({
      data: {
        protocol: protocol as any,
        timestamp: now,
        period,
        txCount: count,
        volume: String(protoTxs.reduce((a, t) => a + (Number(t.totalValue) || 0), 0)),
        uniqueUsers: protoUsers.size,
        uniqueContracts: new Set(protoTxs.flatMap((t) => t.contractAddresses)).size,
        avgAnonymitySet:
          protoAnonSets.length > 0
            ? protoAnonSets.reduce((a, b) => a + b, 0) / protoAnonSets.length
            : null,
      },
    });
  }
}

async function captureAnonymitySetSnapshots(): Promise<void> {
  const now = new Date();

  const privacyTxs = await prismaRead.privacyTransaction.findMany({
    where: { anonymitySetSize: { not: null } },
    orderBy: { timestamp: 'desc' },
    take: 1000,
  });

  const byProtocol: Record<string, number[]> = {};
  for (const tx of privacyTxs) {
    for (const p of tx.protocols) {
      const key = String(p);
      if (!byProtocol[key]) byProtocol[key] = [];
      if (tx.anonymitySetSize !== null) byProtocol[key].push(tx.anonymitySetSize);
    }
  }

  for (const [protocol, sets] of Object.entries(byProtocol)) {
    if (sets.length === 0) continue;
    const setSize = Math.max(...sets);

    const prTx = privacyTxs.find(
      (t) => t.protocols.includes(protocol as any) && t.anonymitySetSize !== null,
    );
    const effectiveSetSize = prTx?.effectiveAnonymitySet ?? null;

    await prismaWrite.anonymitySetSnapshot.create({
      data: {
        protocol: protocol as any,
        setSize,
        effectiveSetSize,
        timestamp: now,
      },
    });
  }
}

export async function runPrivacyDetection(): Promise<{
  detected: number;
  analytics: boolean;
  snapshots: boolean;
}> {
  const detected = await scanRecentTransactions(200);
  await runAnalyticsAggregation('hour');
  await runAnalyticsAggregation('day');
  await captureAnonymitySetSnapshots();
  return { detected, analytics: true, snapshots: true };
}

export function startPrivacyDetector(intervalMs = 5 * 60 * 1000): NodeJS.Timeout {
  runPrivacyDetection().catch((err) =>
    console.error('[privacy-detector] initial run failed:', err),
  );
  return setInterval(() => {
    runPrivacyDetection().catch((err) =>
      console.error('[privacy-detector] scheduled run failed:', err),
    );
  }, intervalMs);
}
