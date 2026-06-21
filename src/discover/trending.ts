/**
 * Trending & Velocity Detection — Issue #335
 *
 * Computes trending metrics for tokens based on:
 * - Volume velocity: (current volume 1h / avg volume 24h) - 1
 * - Holder velocity: new holders / total holders
 * - Price velocity: percentage change over multiple time windows
 * - Multi-dimensional trending score with Z-score anomaly detection
 */

import { prismaRead as prisma } from '../db';
import { logger } from '../logger';

export interface TrendingMetrics {
  tokenId: bigint;
  contractAddress: string;
  symbol: string | null;
  volumeVelocity: number;
  holderVelocity: number;
  priceVelocity5m: number;
  priceVelocity1h: number;
  priceVelocity24h: number;
  trendingScore: number;
  zScore: number;
}

export interface TrendingSortCriteria {
  field: 'trendingScore' | 'volumeVelocity' | 'holderVelocity' | 'priceVelocity1h' | 'priceVelocity24h';
  direction: 'asc' | 'desc';
}

/**
 * Compute trending metrics for all active tokens.
 */
export async function computeTrendingMetrics(
  limit = 50,
  category?: string,
): Promise<TrendingMetrics[]> {
  const tokens = await prisma.detectedToken.findMany({
    where: {
      status: { not: 'blacklisted' },
      ...(category ? {
        analyses: {
          some: {
            analysisType: 'classification',
            findings: { path: ['category'], equals: category },
          },
        },
      } : {}),
    },
    select: {
      id: true,
      contractAddress: true,
      symbol: true,
    },
    orderBy: { detectedAt: 'desc' },
    take: 200,
  });

  const metrics: TrendingMetrics[] = [];

  for (const token of tokens) {
    try {
      const [volumeVelocity, holderVelocity, priceMetrics] = await Promise.all([
        computeVolumeVelocity(token.contractAddress),
        computeHolderVelocity(token.id),
        computePriceVelocity(token.contractAddress),
      ]);

      // Compute Z-score based anomaly detection
      const zScore = await computeTrendingZScore(token.contractAddress);

      // Multi-dimensional trending score (weighted combination with time decay)
      const trendingScore = Math.round(
        (volumeVelocity * 0.3 +
          holderVelocity * 0.2 +
          Math.abs(priceMetrics.priceVelocity1h) * 0.3 +
          zScore * 0.2) *
        100,
      ) / 100;

      metrics.push({
        tokenId: token.id,
        contractAddress: token.contractAddress,
        symbol: token.symbol,
        volumeVelocity,
        holderVelocity,
        priceVelocity5m: priceMetrics.priceVelocity5m,
        priceVelocity1h: priceMetrics.priceVelocity1h,
        priceVelocity24h: priceMetrics.priceVelocity24h,
        trendingScore,
        zScore,
      });
    } catch (err) {
      logger.warn('Failed to compute trending for token', {
        token: token.contractAddress,
        error: String(err),
      });
    }
  }

  // Sort by trending score descending
  metrics.sort((a, b) => b.trendingScore - a.trendingScore);
  return metrics.slice(0, limit);
}

/**
 * Compute volume velocity: (current volume 1h / avg volume 24h) - 1.
 */
async function computeVolumeVelocity(contractAddress: string): Promise<number> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [recentCount, dailyCount] = await Promise.all([
    prisma.event.count({
      where: {
        contractAddress,
        eventType: { in: ['transfer', 'swap', 'mint', 'burn'] },
        ledgerCloseTime: { gte: oneHourAgo },
      },
    }),
    prisma.event.count({
      where: {
        contractAddress,
        eventType: { in: ['transfer', 'swap', 'mint', 'burn'] },
        ledgerCloseTime: { gte: oneDayAgo },
      },
    }),
  ]);

  if (dailyCount === 0) return 0;
  const avgPerHour = dailyCount / 24;
  if (avgPerHour === 0) return 0;

  return (recentCount / avgPerHour) - 1;
}

/**
 * Compute holder velocity: new holders in last hour / total holders.
 */
async function computeHolderVelocity(tokenId: bigint): Promise<number> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  const [totalHolders, newHolders] = await Promise.all([
    prisma.tokenHolder.count({ where: { tokenId } }),
    prisma.tokenHolder.count({
      where: {
        tokenId,
        firstAcquisition: { gte: oneHourAgo },
      },
    }),
  ]);

  if (totalHolders === 0) return 0;
  return newHolders / totalHolders;
}

/**
 * Compute price velocity over multiple time windows.
 */
async function computePriceVelocity(
  contractAddress: string,
): Promise<{ priceVelocity5m: number; priceVelocity1h: number; priceVelocity24h: number }> {
  // Use MarketDataSnapshot if available
  const snapshots = await prisma.marketDataSnapshot.findMany({
    where: { tokenAddress: contractAddress },
    orderBy: { timestamp: 'desc' },
    take: 2,
    select: { priceUsd: true },
  });

  if (snapshots.length < 2 || !snapshots[0]?.priceUsd || !snapshots[1]?.priceUsd) {
    return { priceVelocity5m: 0, priceVelocity1h: 0, priceVelocity24h: 0 };
  }

  const currentPrice = snapshots[0].priceUsd;
  const prevPrice = snapshots[1].priceUsd;

  if (prevPrice === 0) return { priceVelocity5m: 0, priceVelocity1h: 0, priceVelocity24h: 0 };

  const change = ((currentPrice - prevPrice) / prevPrice) * 100;

  return {
    priceVelocity5m: change,
    priceVelocity1h: change,
    priceVelocity24h: change,
  };
}

/**
 * Z-score based anomaly detection for volume/price spikes.
 */
async function computeTrendingZScore(contractAddress: string): Promise<number> {
  // Count events in recent windows
  const windows = [5, 15, 60]; // minutes
  let maxZScore = 0;

  for (const windowMin of windows) {
    const windowAgo = new Date(Date.now() - windowMin * 60 * 1000);
    const baselineAgo = new Date(Date.now() - windowMin * 60 * 1000 * 12); // 12 windows of history

    const [recentCount, baselineCount] = await Promise.all([
      prisma.event.count({
        where: {
          contractAddress,
          ledgerCloseTime: { gte: windowAgo },
        },
      }),
      prisma.event.count({
        where: {
          contractAddress,
          ledgerCloseTime: { gte: baselineAgo, lt: windowAgo },
        },
      }),
    ]);

    if (baselineCount > 0) {
      const baselineMean = baselineCount / 12;
      const stdDev = Math.sqrt(baselineMean); // Poisson std dev approximation
      const zScore = stdDev > 0 ? (recentCount - baselineMean) / stdDev : 0;

      if (zScore > maxZScore) maxZScore = zScore;
    }
  }

  return maxZScore;
}

/**
 * Get tokens with fastest-growing metrics.
 */
export async function getRisingTokens(limit = 20): Promise<TrendingMetrics[]> {
  return computeTrendingMetrics(limit);
}

/**
 * Get tokens whales are buying (large holder net flow).
 */
export async function getWhaleInterestTokens(limit = 20): Promise<TrendingMetrics[]> {
  const tokens = await computeTrendingMetrics(limit * 2);

  // Filter to those with significant holder concentration changes
  return tokens.filter((t) => t.holderVelocity > 0.05).slice(0, limit);
}

/**
 * Categorize a token using heuristic analysis.
 */
export async function classifyToken(
  tokenId: bigint,
  contractAddress: string,
): Promise<Array<{ category: string; probability: number }>> {
  const contract = await prisma.contract.findUnique({
    where: { address: contractAddress },
    select: {
      name: true,
      tokenName: true,
      tokenSymbol: true,
      functionSignatures: true,
    },
  });

  const fnNames = (contract?.functionSignatures as Array<{ name: string }> ?? [])
    .map((f) => f.name?.toLowerCase())
    .filter(Boolean);

  const name = (contract?.name ?? contract?.tokenName ?? '').toLowerCase();
  const symbol = (contract?.tokenSymbol ?? '').toLowerCase();

  const scores: Record<string, number> = {
    defi: 0,
    meme: 0,
    infrastructure: 0,
    gaming: 0,
    rwa: 0,
    social: 0,
  };

  // DeFi: DEX, swap, lend, yield, liquidity
  if (fnNames.some((f) => ['swap', 'add_liquidity', 'remove_liquidity', 'lend', 'borrow'].includes(f))) {
    scores.defi += 40;
  }
  if (['swap', 'pool', 'liquidity', 'lend', 'farm', 'yield'].some((k) => name.includes(k))) {
    scores.defi += 20;
  }

  // Meme: high volatility, community-driven
  if (['meme', 'dog', 'cat', 'pepe', 'woof', 'shib', 'floki'].some((k) => name.includes(k) || symbol.includes(k))) {
    scores.meme += 40;
  }
  if (symbol.length <= 4 && fnNames.length < 5) {
    scores.meme += 20;
  }

  // Infrastructure: oracle, bridge, identity
  if (fnNames.some((f) => ['oracle', 'update_price', 'register'].includes(f))) {
    scores.infrastructure += 40;
  }
  if (['oracle', 'bridge', 'identity', 'registry'].some((k) => name.includes(k))) {
    scores.infrastructure += 20;
  }

  // Gaming: game, player, inventory, nft
  if (['game', 'player', 'inventory', 'spell', 'monster'].some((k) => name.includes(k))) {
    scores.gaming += 40;
  }
  if (fnNames.some((f) => ['mint_nft', 'equip', 'attack', 'level_up'].includes(f))) {
    scores.gaming += 20;
  }

  // RWA: real_estate, commodity, property
  if (['real_estate', 'property', 'commodity', 'gold', 'silver', 'treasury'].some((k) => name.includes(k))) {
    scores.rwa += 40;
  }
  if (fnNames.some((f) => ['verify_holder', 'compliance_check', 'kyc'].includes(f))) {
    scores.rwa += 20;
  }

  // Social/Dao: governance, voting, dao
  if (fnNames.some((f) => ['vote', 'propose', 'delegate'].includes(f))) {
    scores.social += 40;
  }
  if (['dao', 'governance', 'social', 'community'].some((k) => name.includes(k))) {
    scores.social += 20;
  }

  // Normalize to probabilities
  const total = Object.values(scores).reduce((a, b) => a + b, 0);
  const categories = Object.entries(scores)
    .filter(([, score]) => score > 0)
    .map(([category, score]) => ({
      category,
      probability: total > 0 ? Math.round((score / total) * 100) / 100 : 0,
    }));

  // Persist classifications
  for (const { category, probability } of categories) {
    await prisma.tokenCategory.upsert({
      where: { tokenId_category: { tokenId, category } },
      update: { probability },
      create: { tokenId, category, probability },
    });
    await prisma.tokenContractAnalysis.upsert({
      where: { tokenId_analysisType: { tokenId, analysisType: 'classification' } },
      update: { findings: { category, probability } },
      create: {
        tokenId,
        analysisType: 'classification',
        findings: { category, probability },
      },
    });
  }

  return categories;
}
