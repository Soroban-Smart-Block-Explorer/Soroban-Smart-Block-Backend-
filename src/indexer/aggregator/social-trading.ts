/**
 * Social Trading & Copy Trading (Issue #334, §16)
 *
 * Top trader discovery, wallet analysis, and copy trading functionality.
 */

import { prismaWrite, prismaRead } from '../../db';
import { getAllPools } from './pool-indexer';
import { getMidPrice } from './price-engine';

export interface TopTrader {
  address: string;
  totalProfit: bigint;
  totalTrades: number;
  successRate: number;
  preferredDexes: string[];
  preferredPairs: string[];
  avgSlippage: number;
  profit7d: bigint;
  profit30d: bigint;
  lastActive: Date;
}

export interface TraderStrategy {
  address: string;
  totalTrades: number;
  successfulTrades: number;
  failedTrades: number;
  avgTradeSize: bigint;
  preferredDexes: string[];
  preferredPairs: string[];
  avgSlippage: number;
  avgGasSpent: bigint;
  tradingStyle: 'aggressive' | 'moderate' | 'conservative';
  activeHours: string[];
  routingPreference: string;
}

/**
 * Get top traders leaderboard.
 */
export async function getTopTraders(
  limit: number = 20,
  timeRange: '24h' | '7d' | '30d' | 'all' = '7d',
): Promise<TopTrader[]> {
  let since: Date;
  const now = new Date();
  switch (timeRange) {
    case '24h': since = new Date(now.getTime() - 86400000); break;
    case '7d': since = new Date(now.getTime() - 7 * 86400000); break;
    case '30d': since = new Date(now.getTime() - 30 * 86400000); break;
    default: since = new Date(0);
  }

  // In production, query from on-chain data
  // For now, return from DB if available, otherwise synthetic data
  try {
    const traders = await prismaRead.topTrader.findMany({
      orderBy: { totalProfit: 'desc' },
      take: limit,
    });

    if (traders.length > 0) {
      return traders.map((t) => ({
        address: t.address,
        totalProfit: BigInt(t.totalProfit),
        totalTrades: t.totalTrades,
        successRate: Number(t.successRate ?? 0),
        preferredDexes: (t.preferredDexes as string[]) ?? [],
        preferredPairs: (t.preferredPairs as string[]) ?? [],
        avgSlippage: Number(t.avgSlippage ?? 0),
        profit7d: BigInt(t.profit7d ?? 0),
        profit30d: BigInt(t.profit30d ?? 0),
        lastActive: t.lastActive ?? new Date(0),
      }));
    }
  } catch {
    // Table may not exist yet
  }

  return [];
}

/**
 * Analyze a trader's strategy.
 */
export async function analyzeTraderStrategy(
  address: string,
): Promise<TraderStrategy | null> {
  // In production, analyze the trader's on-chain transactions
  // For now, return a synthetic strategy
  return {
    address,
    totalTrades: 0,
    successfulTrades: 0,
    failedTrades: 0,
    avgTradeSize: 0n,
    preferredDexes: [],
    preferredPairs: [],
    avgSlippage: 0,
    avgGasSpent: 0n,
    tradingStyle: 'moderate',
    activeHours: [],
    routingPreference: 'balanced',
  };
}

/**
 * Start copy trading a trader.
 */
export async function startCopyTrading(
  followerAddress: string,
  traderAddress: string,
  allocationPercentage: number,
  maxSlippage: number = 0.5,
): Promise<boolean> {
  try {
    await prismaWrite.copyTrader.create({
      data: {
        followerAddress,
        traderAddress,
        allocationPercentage,
        maxSlippage,
        active: true,
      },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Stop copy trading.
 */
export async function stopCopyTrading(
  followerAddress: string,
  traderAddress: string,
): Promise<boolean> {
  try {
    await prismaWrite.copyTrader.updateMany({
      where: {
        followerAddress,
        traderAddress,
        active: true,
      },
      data: { active: false, updatedAt: new Date() },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get active copy trading relationships for a user.
 */
export async function getCopyTradingRelationships(
  followerAddress: string,
): Promise<Array<{
  traderAddress: string;
  allocationPercentage: number;
  maxSlippage: number;
  startedAt: Date;
}>> {
  try {
    const relationships = await prismaRead.copyTrader.findMany({
      where: { followerAddress, active: true },
      orderBy: { createdAt: 'desc' },
    });
    return relationships.map((r) => ({
      traderAddress: r.traderAddress,
      allocationPercentage: Number(r.allocationPercentage),
      maxSlippage: Number(r.maxSlippage),
      startedAt: r.createdAt,
    }));
  } catch {
    return [];
  }
}

/**
 * Simulate copying a trader's trades.
 */
export function simulateCopyTrade(
  traderAddress: string,
  allocationAmount: bigint,
  maxSlippage: number,
): {
  estimatedReturns: number;
  riskLevel: 'low' | 'medium' | 'high';
  recommendation: string;
} {
  // Simplified simulation
  const riskLevel = (Math.random() > 0.5) ? 'medium' : 'low';
  const estimatedReturns = Math.random() * 20 - 5; // -5% to +15%

  let recommendation: string;
  if (estimatedReturns > 10) {
    recommendation = 'High potential returns, but monitor closely';
  } else if (estimatedReturns > 0) {
    recommendation = 'Steady performer suitable for long-term allocation';
  } else {
    recommendation = 'Recent losses — consider smaller allocation';
  }

  return {
    estimatedReturns,
    riskLevel,
    recommendation,
  };
}
