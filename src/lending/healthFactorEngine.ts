/**
 * src/lending/healthFactorEngine.ts
 *
 * Soroban Liquidation Command Center — Health Factor Engine
 *
 * Computes and tracks position health across all lending protocols.
 * Health Factor = Σ(collateral_i * price_i * threshold_i) / Σ(debt_j * price_j)
 */

import { prismaRead, prismaWrite } from '../db';
import type { RiskLevel } from '@prisma/client';
import { config } from '../config';

// ── Risk Level Thresholds ─────────────────────────────────────────────────────

export interface RiskLevelConfig {
  level: RiskLevel;
  minHf: number;
  maxHf: number;
  color: string;
  label: string;
  action: string;
}

export const RISK_LEVELS: RiskLevelConfig[] = [
  { level: 'SAFE', minHf: 2.0, maxHf: Infinity, color: '#22c55e', label: 'Safe', action: 'No action needed' },
  { level: 'MODERATE', minHf: 1.5, maxHf: 2.0, color: '#eab308', label: 'Moderate', action: 'Monitor' },
  { level: 'ELEVATED', minHf: 1.2, maxHf: 1.5, color: '#f97316', label: 'Elevated', action: 'Consider adding collateral' },
  { level: 'HIGH', minHf: 1.05, maxHf: 1.2, color: '#ef4444', label: 'High', action: 'Add collateral or repay debt' },
  { level: 'CRITICAL', minHf: 1.0, maxHf: 1.05, color: '#dc2626', label: 'Critical', action: 'Immediate action required' },
  { level: 'LIQUIDATED', minHf: -Infinity, maxHf: 1.0, color: '#000000', label: 'Liquidated', action: 'Position has been liquidated' },
];

export interface PositionHealthData {
  collateralAmount: number;
  collateralPriceUsd: number;
  collateralThreshold: number;
  debtAmount: number;
  debtPriceUsd: number;
  protocolLtv: number;
}

export interface HealthFactorResult {
  healthFactor: number;
  ltv: number;
  riskLevel: RiskLevel;
  liquidationPrice: number | null;
  distanceToLiquidation: number;
  maxSafeCollateralDrop: string;
}

// ── Health Factor Calculation ─────────────────────────────────────────────────

/**
 * Compute health factor for a lending position.
 *
 * HF = Σ(collateral_i × price_i × threshold_i) / Σ(debt_j × price_j)
 *
 * @param data Position health data including collateral, debt, prices, and thresholds
 * @returns Computed health factor, LTV ratio, risk level, and liquidation metrics
 */
export function computeHealthFactor(data: PositionHealthData): HealthFactorResult {
  const { collateralAmount, collateralPriceUsd, collateralThreshold, debtAmount, debtPriceUsd } = data;

  // Guard against division by zero
  if (debtAmount <= 0 || debtPriceUsd <= 0) {
    return {
      healthFactor: Infinity,
      ltv: 0,
      riskLevel: 'SAFE',
      liquidationPrice: null,
      distanceToLiquidation: 100,
      maxSafeCollateralDrop: '100%',
    };
  }

  const collateralValue = collateralAmount * collateralPriceUsd;
  const debtValue = debtAmount * debtPriceUsd;
  const weightedCollateral = collateralAmount * collateralPriceUsd * collateralThreshold;

  // LTV = debtValue / collateralValue
  const ltv = collateralValue > 0 ? (debtValue / collateralValue) * 100 : 0;

  // Health Factor
  const healthFactor = weightedCollateral > 0 ? weightedCollateral / debtValue : 0;

  // Liquidation Price: price at which HF = 1.0
  // HF = (collateralAmount * liquidationPrice * threshold) / debtValue = 1.0
  // liquidationPrice = debtValue / (collateralAmount * threshold)
  const liquidationPrice =
    collateralAmount > 0 && collateralThreshold > 0
      ? debtValue / (collateralAmount * collateralThreshold)
      : null;

  // Distance to Liquidation: percentage drop in collateral price needed
  // collateralPrice * (1 - drop) * threshold * collateralAmount = debtValue
  // drop = 1 - debtValue / (collateralPrice * threshold * collateralAmount)
  const distanceToLiquidation =
    liquidationPrice !== null && collateralPriceUsd > 0
      ? Math.max(0, (1 - liquidationPrice / collateralPriceUsd) * 100)
      : 100;

  // Risk Level
  const riskLevel = classifyRiskLevel(healthFactor);

  // Max safe collateral drop (human-readable)
  const maxSafeCollateralDrop = `${distanceToLiquidation.toFixed(1)}%`;

  return {
    healthFactor,
    ltv: Math.round(ltv * 100) / 100,
    riskLevel,
    liquidationPrice,
    distanceToLiquidation: Math.round(distanceToLiquidation * 100) / 100,
    maxSafeCollateralDrop,
  };
}

/**
 * Classify risk level based on health factor.
 */
export function classifyRiskLevel(healthFactor: number): RiskLevel {
  if (healthFactor >= 2.0) return 'SAFE';
  if (healthFactor >= 1.5) return 'MODERATE';
  if (healthFactor >= 1.2) return 'ELEVATED';
  if (healthFactor >= 1.05) return 'HIGH';
  if (healthFactor >= 1.0) return 'CRITICAL';
  return 'LIQUIDATED';
}

/**
 * Get risk level configuration for a given risk level.
 */
export function getRiskLevelConfig(level: RiskLevel): RiskLevelConfig {
  return RISK_LEVELS.find((r) => r.level === level) ?? RISK_LEVELS[0];
}

// ── In-Memory Price Cache ─────────────────────────────────────────────────────

interface PriceEntry {
  price: number;
  timestamp: number;
  threshold: number;
}

const priceCache = new Map<string, PriceEntry>();
const PRICE_CACHE_TTL = 60_000; // 1 minute

/**
 * Get the current price for a token from the cache or oracle.
 */
export async function getTokenPrice(tokenAddress: string): Promise<PriceEntry | null> {
  const cached = priceCache.get(tokenAddress);
  if (cached && Date.now() - cached.timestamp < PRICE_CACHE_TTL) {
    return cached;
  }

  try {
    // Try to get price from PriceOracle table
    const oracle = await prismaRead.priceOracle.findFirst({
      where: { tokenAddress },
      orderBy: { lastUpdateTime: 'desc' },
    });

    if (oracle) {
      const entry: PriceEntry = {
        price: oracle.lastPrice,
        timestamp: Date.now(),
        threshold: 0.8, // Default liquidation threshold
      };
      priceCache.set(tokenAddress, entry);
      return entry;
    }

    // Fallback: try PortfolioSnapshot
    const snapshot = await prismaRead.portfolioSnapshot.findFirst({
      where: { contractAddress: tokenAddress },
      orderBy: { snapshotAt: 'desc' },
    });

    if (snapshot && snapshot.priceUsd) {
      const entry: PriceEntry = {
        price: snapshot.priceUsd,
        timestamp: Date.now(),
        threshold: 0.8,
      };
      priceCache.set(tokenAddress, entry);
      return entry;
    }

    return null;
  } catch {
    return cached ?? null;
  }
}

/**
 * Update the price cache with a new price.
 */
export function updatePriceCache(
  tokenAddress: string,
  price: number,
  threshold: number = 0.8,
): void {
  priceCache.set(tokenAddress, { price, timestamp: Date.now(), threshold });
}

// ── Position Operations ──────────────────────────────────────────────────────

export interface CreatePositionInput {
  protocolAddress: string;
  userAddress: string;
  collateralToken: string;
  debtToken: string;
  collateralAmount: number;
  debtAmount: number;
  liquidationThreshold: number;
}

/**
 * Create or update a lending position with health factor computation.
 */
export async function upsertPosition(input: CreatePositionInput): Promise<any> {
  const { protocolAddress, userAddress, collateralToken, debtToken, liquidationThreshold } = input;

  // Get prices
  const collateralPrice = await getTokenPrice(collateralToken);
  const debtPrice = await getTokenPrice(debtToken);

  const collateralPriceUsd = collateralPrice?.price ?? 0;
  const debtPriceUsd = debtPrice?.price ?? 0;

  // Compute health factor
  const hfResult = computeHealthFactor({
    collateralAmount: input.collateralAmount,
    collateralPriceUsd,
    collateralThreshold: liquidationThreshold,
    debtAmount: input.debtAmount,
    debtPriceUsd,
    protocolLtv: input.debtAmount > 0 ? (input.debtAmount / input.collateralAmount) * 100 : 0,
  });

  const collateralUsd = input.collateralAmount * collateralPriceUsd;
  const debtUsd = input.debtAmount * debtPriceUsd;

  const position = await prismaWrite.lendingPosition.upsert({
    where: {
      protocolAddress_userAddress_collateralToken_debtToken: {
        protocolAddress,
        userAddress,
        collateralToken,
        debtToken,
      },
    },
    create: {
      protocolAddress,
      userAddress,
      collateralToken,
      debtToken,
      collateralAmount: input.collateralAmount,
      debtAmount: input.debtAmount,
      collateralUsd,
      debtUsd,
      healthFactor: hfResult.healthFactor,
      ltv: hfResult.ltv,
      liquidationPrice: hfResult.liquidationPrice,
      liquidationThreshold,
      riskLevel: hfResult.riskLevel,
      openedAt: new Date(),
      status: input.debtAmount > 0 ? 'ACTIVE' : 'CLOSED',
      totalBorrowed: input.debtAmount,
      totalRepaid: 0,
      totalLiquidated: 0,
      liquidationCount: 0,
    },
    update: {
      collateralAmount: input.collateralAmount,
      debtAmount: input.debtAmount,
      collateralUsd,
      debtUsd,
      healthFactor: hfResult.healthFactor,
      ltv: hfResult.ltv,
      liquidationPrice: hfResult.liquidationPrice,
      riskLevel: hfResult.riskLevel,
      status: input.debtAmount > 0 ? 'ACTIVE' : 'CLOSED',
    },
  });

  return position;
}

/**
 * Batch update all positions for a protocol on price change.
 * Performance target: update 10,000 positions in <1 second.
 */
export async function batchUpdatePositions(protocolAddress: string): Promise<number> {
  const positions = await prismaRead.lendingPosition.findMany({
    where: { protocolAddress, status: 'ACTIVE' },
  });

  const updates = positions.map(async (pos) => {
    const collateralPrice = await getTokenPrice(pos.collateralToken);
    const debtPrice = await getTokenPrice(pos.debtToken);

    const collateralPriceUsd = collateralPrice?.price ?? 0;
    const debtPriceUsd = debtPrice?.price ?? 0;

    const hfResult = computeHealthFactor({
      collateralAmount: Number(pos.collateralAmount),
      collateralPriceUsd,
      collateralThreshold: pos.liquidationThreshold,
      debtAmount: Number(pos.debtAmount),
      debtPriceUsd,
      protocolLtv: Number(pos.ltv),
    });

    await prismaWrite.lendingPosition.update({
      where: { id: pos.id },
      data: {
        healthFactor: hfResult.healthFactor,
        ltv: hfResult.ltv,
        liquidationPrice: hfResult.liquidationPrice,
        riskLevel: hfResult.riskLevel,
        collateralUsd: Number(pos.collateralAmount) * collateralPriceUsd,
        debtUsd: Number(pos.debtAmount) * debtPriceUsd,
      },
    });

    // Record history snapshot
    await prismaWrite.lendingPositionHistory.create({
      data: {
        positionId: pos.id,
        healthFactor: hfResult.healthFactor,
        collateralUsd: Number(pos.collateralAmount) * collateralPriceUsd,
        debtUsd: Number(pos.debtAmount) * debtPriceUsd,
        snapshotTime: new Date(),
      },
    });

    return hfResult;
  });

  const results = await Promise.all(updates);
  return results.length;
}

/**
 * Record a position event.
 */
export async function recordPositionEvent(input: {
  positionId: string;
  eventType: string;
  txHash: string;
  token: string;
  amount: number;
  usdValue?: number;
  healthFactorBefore?: number;
  healthFactorAfter?: number;
}): Promise<void> {
  await prismaWrite.positionEvent.create({
    data: {
      positionId: input.positionId,
      eventType: input.eventType,
      txHash: input.txHash,
      token: input.token,
      amount: input.amount,
      usdValue: input.usdValue ?? null,
      healthFactorBefore: input.healthFactorBefore ?? null,
      healthFactorAfter: input.healthFactorAfter ?? null,
      timestamp: new Date(),
    },
  });
}

/**
 * Update protocol risk metrics aggregate.
 */
export async function updateProtocolRiskMetrics(protocolAddress: string): Promise<void> {
  const positions = await prismaRead.lendingPosition.findMany({
    where: { protocolAddress, status: 'ACTIVE' },
  });

  const totalPositions = positions.length;
  if (totalPositions === 0) return;

  const totalValueLocked = positions.reduce((s, p) => s + Number(p.collateralAmount) * (p.collateralUsd ?? 0), 0);
  const totalBorrowed = positions.reduce((s, p) => s + Number(p.debtAmount) * (p.debtUsd ?? 0), 0);
  const availableLiquidity = totalValueLocked - totalBorrowed;

  const avgHealthFactor =
    positions.reduce((s, p) => s + p.healthFactor, 0) / totalPositions;

  const positionsAtRisk = positions.filter(
    (p) => p.riskLevel === 'HIGH' || p.riskLevel === 'ELEVATED',
  ).length;

  const positionsCritical = positions.filter(
    (p) => p.riskLevel === 'CRITICAL',
  ).length;

  // Weighted average health factor (by debt size)
  const totalDebt = positions.reduce((s, p) => s + Number(p.debtAmount), 0);
  const weightedAvgHealthFactor =
    totalDebt > 0
      ? positions.reduce((s, p) => s + p.healthFactor * (Number(p.debtAmount) / totalDebt), 0)
      : avgHealthFactor;

  // 24h liquidation stats
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentLiquidations = await prismaRead.liquidationEvent.findMany({
    where: {
      protocolAddress,
      timestamp: { gte: since },
    },
  });

  const liquidation24h = recentLiquidations.length;
  const liquidationVolume24h = recentLiquidations.reduce(
    (s, l) => s + Number(l.debtCovered),
    0,
  );

  await prismaWrite.protocolRiskMetrics.upsert({
    where: { protocolAddress },
    create: {
      protocolAddress,
      totalValueLocked,
      totalBorrowed,
      availableLiquidity,
      utilizationRate: totalValueLocked > 0 ? totalBorrowed / totalValueLocked : 0,
      avgHealthFactor,
      weightedAvgHealthFactor,
      positionsAtRisk,
      positionsCritical,
      badDebt: 0,
      liquidation24h,
      liquidationVolume24h,
    },
    update: {
      totalValueLocked,
      totalBorrowed,
      availableLiquidity,
      utilizationRate: totalValueLocked > 0 ? totalBorrowed / totalValueLocked : 0,
      avgHealthFactor,
      weightedAvgHealthFactor,
      positionsAtRisk,
      positionsCritical,
      liquidation24h,
      liquidationVolume24h,
    },
  });
}

/**
 * Get all positions for a user, aggregated across protocols.
 */
export async function getUserPositions(userAddress: string) {
  const positions = await prismaRead.lendingPosition.findMany({
    where: { userAddress },
    include: {
      events: { orderBy: { timestamp: 'desc' }, take: 10 },
      alerts: { orderBy: { createdAt: 'desc' }, take: 5 },
    },
    orderBy: { healthFactor: 'asc' },
  });

  return positions;
}

/**
 * Get portfolio risk aggregated across all protocols for a user.
 */
export async function getUserPortfolioRisk(userAddress: string) {
  const positions = await prismaRead.lendingPosition.findMany({
    where: { userAddress, status: 'ACTIVE' },
  });

  if (positions.length === 0) {
    return null;
  }

  const totalCollateral = positions.reduce((s, p) => s + Number(p.collateralAmount) * (p.collateralUsd ?? 0), 0);
  const totalDebt = positions.reduce((s, p) => s + Number(p.debtAmount) * (p.debtUsd ?? 0), 0);

  // Portfolio health factor: weighted by debt
  let portfolioHf = Infinity;
  if (totalDebt > 0) {
    const weightedSum = positions.reduce(
      (s, p) => s + p.healthFactor * (Number(p.debtAmount) * (p.debtUsd ?? 0)),
      0,
    );
    portfolioHf = weightedSum / totalDebt;
  }

  const worstPosition = positions.reduce(
    (worst, p) => (p.healthFactor < worst.healthFactor ? p : worst),
    positions[0],
  );

  // Diversification score: more positions across different protocols = better
  const uniqueProtocols = new Set(positions.map((p) => p.protocolAddress)).size;
  const diversificationScore = Math.min(100, positions.length * 15 + uniqueProtocols * 10);

  // Generate recommendations
  const recommendations: string[] = [];
  for (const pos of positions) {
    if (pos.riskLevel === 'HIGH' || pos.riskLevel === 'CRITICAL') {
      const addAmount = (Number(pos.debtAmount) * 0.1).toFixed(2);
      recommendations.push(
        `Add ~${addAmount} collateral to ${pos.collateralToken} position (health factor: ${pos.healthFactor.toFixed(2)})`,
      );
    }
    if (pos.riskLevel === 'ELEVATED') {
      recommendations.push(
        `Monitor ${pos.collateralToken}/${pos.debtToken} position — consider adding collateral`,
      );
    }
  }

  if (recommendations.length === 0) {
    recommendations.push('Portfolio is healthy — no actions recommended');
  }

  return {
    totalCollateral: formatUsd(totalCollateral),
    totalDebt: formatUsd(totalDebt),
    portfolioHealthFactor: Math.round(portfolioHf * 100) / 100,
    portfolioRiskLevel: classifyRiskLevel(portfolioHf),
    worstPosition: {
      protocol: worstPosition.protocolAddress,
      healthFactor: worstPosition.healthFactor,
      collateralToken: worstPosition.collateralToken,
      debtToken: worstPosition.debtToken,
    },
    diversificationScore,
    recommendations,
  };
}

// ── Helper ─────────────────────────────────────────────────────────────────────

export function formatUsd(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B USD`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M USD`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K USD`;
  return `${value.toFixed(2)} USD`;
}
