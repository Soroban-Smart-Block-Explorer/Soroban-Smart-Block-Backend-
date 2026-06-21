/**
 * src/lending/oracleMonitor.ts
 *
 * Soroban Liquidation Command Center — Price Oracle Monitor
 *
 * Tracks all price oracles used by lending protocols,
 * monitors staleness, deviations, and health scores.
 */

import { prismaRead, prismaWrite } from '../db';
import { logger } from '../logger';
import { updatePriceCache } from './healthFactorEngine';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OracleHealthStatus {
  oracleAddress: string;
  oracleType: string;
  tokenAddress: string;
  tokenSymbol: string | null;
  lastPrice: number;
  lastUpdateTime: Date;
  deviationSinceLastUpdate: number | null;
  protocolCount: number;
  healthScore: number;
  stale: boolean;
}

export interface OracleAlert {
  oracleAddress: string;
  tokenSymbol: string | null;
  alertType: 'stale_data' | 'high_deviation' | 'protocol_dependency_increase';
  severity: 'info' | 'warning' | 'critical';
  message: string;
}

// ── Oracle Health Computation ─────────────────────────────────────────────────

const STALE_THRESHOLD_MS = 3600_000; // 1 hour
const MAX_DEVIATION_PCT = 5; // 5% max deviation before flagging

/**
 * Compute health score for an oracle.
 * Score 0-100, higher = healthier.
 */
function computeOracleHealthScore(oracle: {
  lastUpdateTime: Date;
  deviationSinceLastUpdate: number | null;
  protocolCount: number;
}): { healthScore: number; stale: boolean } {
  const now = Date.now();
  const lastUpdateAge = now - oracle.lastUpdateTime.getTime();

  // Staleness score (0-40 points)
  const stalenessScore = lastUpdateAge < STALE_THRESHOLD_MS
    ? 40
    : Math.max(0, 40 - (lastUpdateAge - STALE_THRESHOLD_MS) / (STALE_THRESHOLD_MS / 40));

  // Deviation score (0-40 points)
  const deviation = oracle.deviationSinceLastUpdate ?? 0;
  const deviationScore = deviation <= MAX_DEVIATION_PCT
    ? 40 - (deviation / MAX_DEVIATION_PCT) * 20
    : Math.max(0, 20 - (deviation - MAX_DEVIATION_PCT) * 5);

  // Protocol adoption score (0-20 points)
  const adoptionScore = Math.min(20, oracle.protocolCount * 2);

  const healthScore = Math.round(stalenessScore + deviationScore + adoptionScore);
  const stale = lastUpdateAge > STALE_THRESHOLD_MS;

  return { healthScore, stale };
}

/**
 * Update oracle health status in the database.
 */
export async function updateOracleHealth(oracleAddress: string): Promise<OracleHealthStatus> {
  const oracle = await prismaRead.priceOracle.findUnique({
    where: { oracleAddress },
  });

  if (!oracle) {
    throw new Error(`Oracle not found: ${oracleAddress}`);
  }

  const { healthScore, stale } = computeOracleHealthScore(oracle);

  // Count protocols using this oracle
  const protocolCount = await prismaRead.lendingPosition.groupBy({
    by: ['protocolAddress'],
    where: {
      OR: [
        { collateralToken: oracle.tokenAddress },
        { debtToken: oracle.tokenAddress },
      ],
    },
  });

  await prismaWrite.priceOracle.update({
    where: { oracleAddress },
    data: {
      healthScore,
      stale,
      protocolCount: protocolCount.length,
    },
  });

  return {
    oracleAddress,
    oracleType: oracle.oracleType,
    tokenAddress: oracle.tokenAddress,
    tokenSymbol: oracle.tokenSymbol,
    lastPrice: oracle.lastPrice,
    lastUpdateTime: oracle.lastUpdateTime,
    deviationSinceLastUpdate: oracle.deviationSinceLastUpdate,
    protocolCount: protocolCount.length,
    healthScore,
    stale,
  };
}

/**
 * Update all oracle health statuses.
 */
export async function updateAllOracleHealth(): Promise<OracleHealthStatus[]> {
  const oracles = await prismaRead.priceOracle.findMany();
  const results = await Promise.all(
    oracles.map((o) => updateOracleHealth(o.oracleAddress)),
  );
  return results;
}

/**
 * Get oracle dashboard with all health statuses.
 */
export async function getOracleDashboard(): Promise<{
  oracles: OracleHealthStatus[];
  summary: {
    total: number;
    healthy: number;
    stale: number;
    avgHealthScore: number;
    alerts: string[];
  };
}> {
  const oracles = await prismaRead.priceOracle.findMany();
  const healthStatuses = await Promise.all(
    oracles.map((o) => updateOracleHealth(o.oracleAddress)),
  );

  const staleOracles = healthStatuses.filter((o) => o.stale);
  const avgScore =
    healthStatuses.length > 0
      ? Math.round(healthStatuses.reduce((s, o) => s + o.healthScore, 0) / healthStatuses.length)
      : 0;

  const alerts: string[] = [];
  for (const oracle of healthStatuses) {
    if (oracle.stale) {
      alerts.push(`Oracle ${oracle.oracleAddress.slice(0, 8)} is stale (last update: ${oracle.lastUpdateTime.toISOString()})`);
    }
    if ((oracle.deviationSinceLastUpdate ?? 0) > MAX_DEVIATION_PCT) {
      alerts.push(`Oracle ${oracle.oracleAddress.slice(0, 8)} has high deviation: ${oracle.deviationSinceLastUpdate?.toFixed(2)}%`);
    }
  }

  return {
    oracles: healthStatuses,
    summary: {
      total: healthStatuses.length,
      healthy: healthStatuses.length - staleOracles.length,
      stale: staleOracles.length,
      avgHealthScore: avgScore,
      alerts,
    },
  };
}

/**
 * Record a price update from an oracle.
 */
export async function recordPriceUpdate(
  oracleAddress: string,
  price: number,
  deviation: number | null = null,
): Promise<void> {
  const oracle = await prismaRead.priceOracle.findUnique({
    where: { oracleAddress },
  });

  if (!oracle) {
    logger.warn('Price update for unknown oracle', { oracleAddress });
    return;
  }

  const previousPrice = oracle.lastPrice;
  const deviationPct = previousPrice > 0
    ? Math.abs((price - previousPrice) / previousPrice) * 100
    : 0;

  await prismaWrite.priceOracle.update({
    where: { oracleAddress },
    data: {
      lastPrice: price,
      lastUpdateTime: new Date(),
      deviationSinceLastUpdate: deviation ?? deviationPct,
      stale: false,
    },
  });

  // Update price cache for health factor engine
  updatePriceCache(oracle.tokenAddress, price);
}

/**
 * Register a new price oracle.
 */
export async function registerOracle(input: {
  oracleAddress: string;
  oracleType: string;
  tokenAddress: string;
  tokenSymbol?: string;
  lastPrice: number;
}): Promise<void> {
  await prismaWrite.priceOracle.upsert({
    where: { oracleAddress: input.oracleAddress },
    create: {
      oracleAddress: input.oracleAddress,
      oracleType: input.oracleType,
      tokenAddress: input.tokenAddress,
      tokenSymbol: input.tokenSymbol ?? null,
      lastPrice: input.lastPrice,
      lastUpdateTime: new Date(),
    },
    update: {
      lastPrice: input.lastPrice,
      lastUpdateTime: new Date(),
    },
  });
}
