import { MevType, Prisma } from '@prisma/client';
import { prismaWrite, prismaRead } from '../db';

export interface MevClassification {
  txHash: string;
  ledgerSeq: number;
  timestamp: Date;
  mevType: MevType;
  victimAddress?: string;
  attackerAddress?: string;
  protocolAddress?: string;
  tokenIn?: string;
  tokenOut?: string;
  amountIn?: string;
  amountOut?: string;
  profitAmount?: string;
  profitUsd?: number;
  lossAmount?: string;
  lossUsd?: number;
  txOrder?: Prisma.InputJsonValue;
  confidence: number;
  details?: Prisma.InputJsonValue;
}

/** Classify a single transaction and persist it as a MevEvent. */
export async function classifyAndStore(c: MevClassification) {
  // Upsert victim if present
  if (c.victimAddress) {
    await prismaWrite.mevVictim.upsert({
      where: { address: c.victimAddress },
      create: {
        address: c.victimAddress,
        totalLossUsd: c.lossUsd ?? 0,
        incidentCount: 1,
        firstIncidentAt: c.timestamp,
        lastIncidentAt: c.timestamp,
      },
      update: {
        totalLossUsd: { increment: c.lossUsd ?? 0 },
        incidentCount: { increment: 1 },
        lastIncidentAt: c.timestamp,
      },
    });
  }

  // Upsert attacker if present
  if (c.attackerAddress) {
    await prismaWrite.mevAttacker.upsert({
      where: { address: c.attackerAddress },
      create: {
        address: c.attackerAddress,
        totalProfitUsd: c.profitUsd ?? 0,
        attackCount: 1,
        favoriteType: c.mevType,
        firstSeen: c.timestamp,
        lastAttackAt: c.timestamp,
      },
      update: {
        totalProfitUsd: { increment: c.profitUsd ?? 0 },
        attackCount: { increment: 1 },
        lastAttackAt: c.timestamp,
      },
    });
  }

  return prismaWrite.mevEvent.upsert({
    where: { txHash: c.txHash },
    create: {
      txHash: c.txHash,
      ledgerSeq: c.ledgerSeq,
      timestamp: c.timestamp,
      mevType: c.mevType,
      victimAddress: c.victimAddress,
      attackerAddress: c.attackerAddress,
      protocolAddress: c.protocolAddress,
      tokenIn: c.tokenIn,
      tokenOut: c.tokenOut,
      amountIn: c.amountIn,
      amountOut: c.amountOut,
      profitAmount: c.profitAmount,
      profitUsd: c.profitUsd,
      lossAmount: c.lossAmount,
      lossUsd: c.lossUsd,
      txOrder: c.txOrder ?? Prisma.JsonNull,
      confidence: c.confidence,
      details: c.details ?? Prisma.JsonNull,
    },
    update: {},
  });
}

/** Detect MEV patterns in a ledger's events and transactions. */
export async function classifyLedger(ledgerSeq: number): Promise<MevClassification[]> {
  const transactions = await prismaRead.transaction.findMany({
    where: { ledgerSequence: ledgerSeq },
    include: { events: true },
    orderBy: { id: 'asc' },
  });

  const results: MevClassification[] = [];

  // Sandwich detection: look for same-contract swap triplets where
  // the outer two txs are from the same account and bracket a victim tx.
  const swapTxs = transactions.filter(
    (tx) =>
      tx.functionName === 'swap' ||
      tx.functionName?.includes('swap') ||
      tx.humanReadable?.toLowerCase().includes('swap'),
  );

  const byContract = new Map<string, typeof swapTxs>();
  for (const tx of swapTxs) {
    if (!tx.contractAddress) continue;
    const list = byContract.get(tx.contractAddress) ?? [];
    list.push(tx);
    byContract.set(tx.contractAddress, list);
  }

  for (const [contractAddress, txList] of byContract) {
    if (txList.length < 3) continue;

    for (let i = 0; i + 2 < txList.length; i++) {
      const front = txList[i];
      const victim = txList[i + 1];
      const back = txList[i + 2];

      if (
        front.sourceAccount === back.sourceAccount &&
        front.sourceAccount !== victim.sourceAccount
      ) {
        results.push({
          txHash: victim.hash,
          ledgerSeq,
          timestamp: victim.ledgerCloseTime,
          mevType: 'sandwich',
          victimAddress: victim.sourceAccount,
          attackerAddress: front.sourceAccount,
          protocolAddress: contractAddress,
          confidence: 0.85,
          txOrder: [
            { txHash: front.hash, position: 0, action: 'front_run' },
            { txHash: victim.hash, position: 1, action: 'victim' },
            { txHash: back.hash, position: 2, action: 'back_run' },
          ] as unknown as Prisma.InputJsonValue,
          details: { frontTx: front.hash, backTx: back.hash } as unknown as Prisma.InputJsonValue,
        });
      }
    }
  }

  // Flash loan detection
  const flashTxs = transactions.filter((tx) => tx.flashLoanAlert);
  for (const tx of flashTxs) {
    results.push({
      txHash: tx.hash,
      ledgerSeq,
      timestamp: tx.ledgerCloseTime,
      mevType: 'flash_loan_attack',
      attackerAddress: tx.sourceAccount,
      protocolAddress: tx.contractAddress ?? undefined,
      confidence: 0.9,
    });
  }

  return results;
}

export interface MevOverview {
  totalEvents: number;
  totalProfitUsd: number;
  totalLossUsd: number;
  byType: Record<string, number>;
  topAttackers: { address: string; totalProfitUsd: number; attackCount: number }[];
  topVictims: { address: string; totalLossUsd: number; incidentCount: number }[];
  recentEvents: {
    id: string;
    txHash: string;
    mevType: string;
    confidence: number;
    createdAt: Date;
  }[];
}

export async function getMevOverview(): Promise<MevOverview> {
  const [totalEvents, profitAgg, lossAgg, byTypeRaw, topAttackers, topVictims, recentEvents] =
    await Promise.all([
      prismaRead.mevEvent.count(),
      prismaRead.mevEvent.aggregate({ _sum: { profitUsd: true } }),
      prismaRead.mevEvent.aggregate({ _sum: { lossUsd: true } }),
      prismaRead.mevEvent.groupBy({ by: ['mevType'], _count: { id: true } }),
      prismaRead.mevAttacker.findMany({
        orderBy: { totalProfitUsd: 'desc' },
        take: 5,
        select: { address: true, totalProfitUsd: true, attackCount: true },
      }),
      prismaRead.mevVictim.findMany({
        orderBy: { totalLossUsd: 'desc' },
        take: 5,
        select: { address: true, totalLossUsd: true, incidentCount: true },
      }),
      prismaRead.mevEvent.findMany({
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, txHash: true, mevType: true, confidence: true, createdAt: true },
      }),
    ]);

  const byType: Record<string, number> = {};
  for (const row of byTypeRaw) {
    byType[row.mevType] = row._count.id;
  }

  return {
    totalEvents,
    totalProfitUsd: profitAgg._sum.profitUsd ?? 0,
    totalLossUsd: lossAgg._sum.lossUsd ?? 0,
    byType,
    topAttackers,
    topVictims,
    recentEvents,
  };
}

export interface MevStats {
  overview: MevOverview;
  avgConfidence: number;
  totalAttackers: number;
  totalVictims: number;
  sandwichCount: number;
  flashLoanCount: number;
  arbitrageCount: number;
}

export async function getMevStatistics(): Promise<MevStats> {
  const [overview, avgConf, totalAttackers, totalVictims, sandwichCount, flashLoanCount, arbCount] =
    await Promise.all([
      getMevOverview(),
      prismaRead.mevEvent.aggregate({ _avg: { confidence: true } }),
      prismaRead.mevAttacker.count(),
      prismaRead.mevVictim.count(),
      prismaRead.mevEvent.count({ where: { mevType: 'sandwich' } }),
      prismaRead.mevEvent.count({ where: { mevType: 'flash_loan_attack' } }),
      prismaRead.mevEvent.count({
        where: { mevType: { in: ['cross_dex_arbitrage', 'cex_dex_arbitrage'] } },
      }),
    ]);

  return {
    overview,
    avgConfidence: avgConf._avg.confidence ?? 0,
    totalAttackers,
    totalVictims,
    sandwichCount,
    flashLoanCount,
    arbitrageCount: arbCount,
  };
}
