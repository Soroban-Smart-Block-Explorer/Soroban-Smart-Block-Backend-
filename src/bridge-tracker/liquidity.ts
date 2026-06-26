import { prismaWrite as prisma, prismaRead } from '../db';
import { logger } from '../logger';
import { ActivityTrend, FeeComparison, VolumeStats } from './types';

export async function getVolumeByProtocol(): Promise<VolumeStats[]> {
  const results = await prismaRead.bridgeTransaction.groupBy({
    by: ['protocol'],
    _sum: { amount: true },
    _count: { id: true },
    _avg: { bridgeFee: true },
    where: { status: 'completed' },
  });

  return results.map((r) => ({
    protocol: r.protocol,
    chain: '',
    asset: '',
    totalVolume: r._sum.amount?.toString() ?? '0',
    totalCount: r._count.id,
    averageAmount: r._sum.amount ? (Number(r._sum.amount) / r._count.id).toFixed(2) : '0',
    fee: r._avg.bridgeFee?.toString() ?? '0',
  }));
}

export async function getVolumeByChain(): Promise<VolumeStats[]> {
  const results = await prismaRead.bridgeTransaction.groupBy({
    by: ['sourceChain', 'destinationChain'],
    _sum: { amount: true },
    _count: { id: true },
    where: { status: 'completed' },
  });

  return results.map((r) => ({
    protocol: 'all',
    chain: `${r.sourceChain}→${r.destinationChain}`,
    asset: '',
    totalVolume: r._sum.amount?.toString() ?? '0',
    totalCount: r._count.id,
    averageAmount: r._sum.amount ? (Number(r._sum.amount) / r._count.id).toFixed(2) : '0',
    fee: '0',
  }));
}

export async function getVolumeByAsset(): Promise<VolumeStats[]> {
  const results = await prismaRead.bridgeTransaction.groupBy({
    by: ['asset', 'protocol'],
    _sum: { amount: true },
    _count: { id: true },
    where: { status: 'completed' },
  });

  return results.map((r) => ({
    protocol: r.protocol,
    chain: '',
    asset: r.asset,
    totalVolume: r._sum.amount?.toString() ?? '0',
    totalCount: r._count.id,
    averageAmount: r._sum.amount ? (Number(r._sum.amount) / r._count.id).toFixed(2) : '0',
    fee: '0',
  }));
}

export async function getActivityTrends(
  period: 'daily' | 'weekly' | 'monthly' = 'daily',
  days = 30,
): Promise<ActivityTrend[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const transactions = await prismaRead.bridgeTransaction.findMany({
    where: {
      status: 'completed',
      createdAt: { gte: since },
    },
    select: { amount: true, protocol: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  const buckets = new Map<string, { volume: number; count: number; protocols: Set<string> }>();

  for (const tx of transactions) {
    const date = tx.createdAt;
    let key: string;
    if (period === 'daily') {
      key = date.toISOString().split('T')[0];
    } else if (period === 'weekly') {
      const weekStart = new Date(date);
      weekStart.setDate(weekStart.getDate() - weekStart.getDay());
      key = weekStart.toISOString().split('T')[0];
    } else {
      key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    }

    if (!buckets.has(key)) {
      buckets.set(key, { volume: 0, count: 0, protocols: new Set() });
    }
    const bucket = buckets.get(key)!;
    bucket.volume += Number(tx.amount);
    bucket.count++;
    bucket.protocols.add(tx.protocol);
  }

  return Array.from(buckets.entries())
    .map(([date, data]) => ({
      period,
      date,
      volume: data.volume.toFixed(2),
      count: data.count,
      protocol: Array.from(data.protocols).join(','),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export async function getFeeComparison(): Promise<FeeComparison[]> {
  const results = await prismaRead.bridgeTransaction.groupBy({
    by: ['protocol'],
    _sum: { bridgeFee: true },
    _avg: { bridgeFee: true },
    _count: { id: true },
    where: {
      status: 'completed',
      bridgeFee: { not: null },
    },
  });

  const comparisons: FeeComparison[] = [];
  for (const r of results) {
    const fees = await prismaRead.bridgeTransaction.findMany({
      where: { protocol: r.protocol, bridgeFee: { not: null }, status: 'completed' },
      select: { bridgeFee: true },
    });
    const feeValues = fees
      .map((f) => Number(f.bridgeFee))
      .filter((f) => !isNaN(f))
      .sort((a, b) => a - b);

    comparisons.push({
      protocol: r.protocol,
      averageFee: r._avg.bridgeFee?.toString() ?? '0',
      medianFee:
        feeValues.length > 0 ? feeValues[Math.floor(feeValues.length / 2)].toString() : '0',
      minFee: feeValues.length > 0 ? feeValues[0].toString() : '0',
      maxFee: feeValues.length > 0 ? feeValues[feeValues.length - 1].toString() : '0',
      totalFees: r._sum.bridgeFee?.toString() ?? '0',
      transactionCount: r._count.id,
    });
  }

  return comparisons.sort((a, b) => Number(b.totalFees) - Number(a.totalFees));
}

export async function aggregateVolumeSnapshot(): Promise<void> {
  try {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(today);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const completions = await prismaRead.bridgeTransaction.findMany({
      where: {
        status: 'completed',
        createdAt: { gte: monthStart },
      },
      select: { protocol: true, sourceChain: true, asset: true, amount: true, createdAt: true },
    });

    const periods = [
      { period: 'daily', start: today },
      { period: 'weekly', start: weekStart },
      { period: 'monthly', start: monthStart },
    ];

    for (const { period, start } of periods) {
      const filtered = completions.filter((t) => t.createdAt >= start);
      const aggregated = new Map<string, { volume: number; count: number }>();

      for (const tx of filtered) {
        const key = `${tx.protocol}:${tx.sourceChain}:${tx.asset}`;
        const existing = aggregated.get(key) || { volume: 0, count: 0 };
        existing.volume += Number(tx.amount);
        existing.count++;
        aggregated.set(key, existing);
      }

      for (const [key, data] of aggregated) {
        const [protocol, chain, asset] = key.split(':');
        await prisma.bridgeVolume.upsert({
          where: {
            protocol_chain_asset_period_periodStart: {
              protocol,
              chain,
              asset,
              period,
              periodStart: start,
            },
          },
          update: { volume: data.volume, count: data.count },
          create: {
            protocol,
            chain,
            asset,
            volume: data.volume,
            count: data.count,
            period,
            periodStart: start,
          },
        });
      }
    }
  } catch (err) {
    logger.error('Volume snapshot aggregation failed', { error: String(err) });
  }
}
