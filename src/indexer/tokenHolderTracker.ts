/**
 * Token Holder Tracker — indexes SEP-41 transfer events to maintain
 * real-time holder balances, percentages, and ranks.
 * Triggers whale alerts on large balance movements.
 */

import { prismaRead, prismaWrite } from '../db';

const WHALE_THRESHOLD_PCT = 0.01; // 1% of supply change triggers alert
const ACCUMULATION_THRESHOLD_PCT = 0.001; // 0.1% accumulation in 24h

export async function processTransferEvent(
  contractAddress: string,
  fromAddress: string | null,
  toAddress: string | null,
  amount: string,
  txHash: string,
): Promise<void> {
  const amountNum = Number(amount);
  if (!isNaN(amountNum) && amountNum > 0) {
    if (fromAddress && fromAddress !== '0'.repeat(56)) {
      await updateHolderBalance(contractAddress, fromAddress, -amountNum, txHash);
    }
    if (toAddress && toAddress !== '0'.repeat(56)) {
      await updateHolderBalance(contractAddress, toAddress, amountNum, txHash);
    }
    await recomputeConcentrationMetrics(contractAddress);
  }
}

async function updateHolderBalance(
  contractAddress: string,
  holderAddress: string,
  delta: number,
  txHash: string,
): Promise<void> {
  const existing = await prismaRead.tokenHolder.findUnique({
    where: { contractAddress_holderAddress: { contractAddress, holderAddress } },
  });

  const oldBalance = existing ? existing.balanceRaw : 0;
  const newBalance = Math.max(0, oldBalance + delta);

  if (newBalance === 0 && !existing) return;

  const allHolders = await prismaRead.tokenHolder.aggregate({
    where: { contractAddress },
    _sum: { balanceRaw: true },
  });
  const totalSupply = (allHolders._sum.balanceRaw ?? 0) + (newBalance - oldBalance);
  const percentage = totalSupply > 0 ? (newBalance / totalSupply) * 100 : 0;

  if (existing) {
    await prismaWrite.tokenHolder.update({
      where: { contractAddress_holderAddress: { contractAddress, holderAddress } },
      data: {
        balance: String(newBalance),
        balanceRaw: newBalance,
        percentage,
        lastUpdatedAt: new Date(),
      },
    });
  } else {
    await prismaWrite.tokenHolder.create({
      data: {
        contractAddress,
        holderAddress,
        balance: String(newBalance),
        balanceRaw: newBalance,
        percentage,
        firstSeenAt: new Date(),
        lastUpdatedAt: new Date(),
      },
    });
  }

  await checkAndEmitWhaleAlert(
    contractAddress,
    holderAddress,
    oldBalance,
    newBalance,
    totalSupply,
    txHash,
  );
}

async function checkAndEmitWhaleAlert(
  contractAddress: string,
  holderAddress: string,
  oldBalance: number,
  newBalance: number,
  totalSupply: number,
  txHash: string,
): Promise<void> {
  if (totalSupply === 0) return;

  const changePct = totalSupply > 0 ? Math.abs(newBalance - oldBalance) / totalSupply : 0;

  if (changePct >= WHALE_THRESHOLD_PCT) {
    await prismaWrite.whaleAlert.create({
      data: {
        contractAddress,
        holderAddress,
        alertType: 'large_transfer',
        oldBalance: String(oldBalance),
        newBalance: String(newBalance),
        changeAmt: String(Math.abs(newBalance - oldBalance)),
        changePct: Number((changePct * 100).toFixed(4)),
        txHash,
        detectedAt: new Date(),
      },
    });
  }

  // Check for accumulation pattern over 24h
  const yesterday = new Date(Date.now() - 86400e3);
  const recentAlerts = await prismaRead.whaleAlert.findMany({
    where: {
      contractAddress,
      holderAddress,
      alertType: 'accumulation',
      detectedAt: { gte: yesterday },
    },
    select: { changeAmt: true },
  });

  const accumulatedAmt = recentAlerts.reduce((s, a) => s + Number(a.changeAmt ?? 0), 0);
  const accumulatedPct = totalSupply > 0 ? accumulatedAmt / totalSupply : 0;

  if (accumulatedPct >= ACCUMULATION_THRESHOLD_PCT && newBalance > oldBalance) {
    await prismaWrite.whaleAlert.create({
      data: {
        contractAddress,
        holderAddress,
        alertType: 'accumulation',
        oldBalance: String(oldBalance),
        newBalance: String(newBalance),
        changeAmt: String(Math.abs(newBalance - oldBalance)),
        changePct: Number((changePct * 100).toFixed(4)),
        txHash,
        detectedAt: new Date(),
      },
    });
  }
}

async function recomputeConcentrationMetrics(contractAddress: string): Promise<void> {
  const holders = await prismaRead.tokenHolder.findMany({
    where: { contractAddress, balanceRaw: { gt: 0 } },
    orderBy: { balanceRaw: 'desc' },
    select: { balanceRaw: true, percentage: true },
  });

  if (holders.length === 0) return;

  const balances = holders.map((h) => h.balanceRaw);
  const total = balances.reduce((a, b) => a + b, 0);
  const shares = holders.map((h) => h.percentage / 100);

  let cumulative = 0;
  let nakamoto = balances.length;
  for (let i = 0; i < balances.length; i++) {
    cumulative += balances[i];
    if (cumulative / total > 0.5) {
      nakamoto = i + 1;
      break;
    }
  }

  const hhi = shares.reduce((s, p) => s + p * p, 0);

  const sortedAsc = [...balances].sort((a, b) => a - b);
  const n = sortedAsc.length;
  const sumB = sortedAsc.reduce((a, b) => a + b, 0);
  let giniNum = 0;
  for (let i = 0; i < n; i++) giniNum += (2 * (i + 1) - n - 1) * sortedAsc[i];
  const gini = sumB > 0 ? Math.abs(giniNum / (n * sumB)) : 0;

  const top10 = holders.slice(0, 10).reduce((s, h) => s + h.percentage, 0);
  const top100 = holders.slice(0, 100).reduce((s, h) => s + h.percentage, 0);

  await prismaWrite.tokenConcentrationMetrics.create({
    data: {
      contractAddress,
      nakamotoCoefficient: nakamoto,
      hhi: Number(hhi.toFixed(6)),
      giniCoefficient: Number(gini.toFixed(4)),
      top10Pct: Number(top10.toFixed(2)),
      top100Pct: Number(top100.toFixed(2)),
      totalHolders: holders.length,
      totalSupply: String(total),
      computedAt: new Date(),
    },
  });

  // Re-rank holders
  for (let i = 0; i < Math.min(holders.length, 10000); i++) {
    const h = holders[i];
    const existing = await prismaRead.tokenHolder.findFirst({
      where: { contractAddress, balanceRaw: h.balanceRaw },
      select: { contractAddress: true, holderAddress: true },
    });
    if (existing) {
      await prismaWrite.tokenHolder.update({
        where: {
          contractAddress_holderAddress: {
            contractAddress: existing.contractAddress,
            holderAddress: existing.holderAddress,
          },
        },
        data: { rank: i + 1 },
      });
    }
  }
}
