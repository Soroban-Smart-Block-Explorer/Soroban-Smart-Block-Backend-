/**
 * src/lending/simulationEngine.ts
 *
 * Soroban Liquidation Command Center — Liquidation Simulation Engine
 *
 * Simulates price drop scenarios, computes cascading liquidations,
 * and models second-order effects across protocols.
 */

import { prismaRead, prismaWrite } from '../db';
import { computeHealthFactor, getTokenPrice, formatUsd, classifyRiskLevel } from './healthFactorEngine';
import type { RiskLevel } from '@prisma/client';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PriceChangeScenario {
  token: string;
  dropPercentage?: number;
  increasePercentage?: number;
}

export interface ProtocolFailure {
  protocolAddress: string;
}

export interface LiquidityShock {
  token: string;
  availableLiquidityDrop: number;
}

export interface SimulationOptions {
  includeSecondOrderEffects: boolean;
  maxCascadeDepth: number;
  includeLiquidationBonus: boolean;
}

export interface SimulationInput {
  scenario: {
    priceChanges: PriceChangeScenario[];
    protocolFailures: string[];
    liquidityShock?: LiquidityShock;
  };
  options: SimulationOptions;
}

export interface LiquidatedPosition {
  positionId: string;
  user: string;
  protocol: string;
  collateralToken: string;
  debtToken: string;
  collateralValue: string;
  debtValue: string;
  healthFactorBefore: number;
  healthFactorAfter: number;
  liquidated: boolean;
  cascadeDepth: number;
}

export interface SecondOrderEffect {
  protocol: string;
  newUtilizationRate: number;
  newAvgHealthFactor: number;
  newPositionsAtRisk: number;
}

export interface SimulationResult {
  summary: {
    positionsLiquidated: number;
    totalValueLiquidated: string;
    totalBadDebt: string;
    cascadeDepth: number;
    protocolsAffected: number;
    usersAffected: number;
  };
  liquidations: LiquidatedPosition[];
  secondOrderEffects: SecondOrderEffect[];
  systemicRiskScore: number;
}

// ── Simulation Engine ─────────────────────────────────────────────────────────

/**
 * Run a liquidation simulation based on a price drop scenario.
 */
export async function simulateLiquidation(input: SimulationInput): Promise<SimulationResult> {
  const startTime = Date.now();
  const { scenario, options } = input;

  // 1. Apply price changes in memory
  const priceShocks = new Map<string, number>();
  for (const change of scenario.priceChanges) {
    const multiplier = change.dropPercentage
      ? 1 - change.dropPercentage / 100
      : change.increasePercentage
        ? 1 + change.increasePercentage / 100
        : 1;
    priceShocks.set(change.token, multiplier);
  }

  // 2. Get all active positions
  const activePositions = await prismaRead.lendingPosition.findMany({
    where: {
      status: 'ACTIVE',
      ...(scenario.protocolFailures.length > 0
        ? { protocolAddress: { in: scenario.protocolFailures } }
        : {}),
    },
  });

  // 3. Simulate each position under the shock
  const liquidated: LiquidatedPosition[] = [];
  let totalValueLiquidated = 0;
  let totalBadDebt = 0;
  const affectedUsers = new Set<string>();
  let maxDepth = 0;

  for (const pos of activePositions) {
    // Get shocked prices
    const collMultiplier = priceShocks.get(pos.collateralToken) ?? 1;
    const debtMultiplier = priceShocks.get(pos.debtToken) ?? 1;

    const collateralPrice = await getTokenPrice(pos.collateralToken);
    const debtPrice = await getTokenPrice(pos.debtToken);

    const originalCollateralPrice = collateralPrice?.price ?? 0;
    const originalDebtPrice = debtPrice?.price ?? 0;

    const shockedCollateralPrice = originalCollateralPrice * collMultiplier;
    const shockedDebtPrice = originalDebtPrice * debtMultiplier;

    // Compute HF before shock
    const hfBefore = pos.healthFactor;

    // Compute HF after shock
    if (pos.debtAmount <= 0 || pos.collateralAmount <= 0) continue;

    const hfResult = computeHealthFactor({
      collateralAmount: Number(pos.collateralAmount),
      collateralPriceUsd: shockedCollateralPrice,
      collateralThreshold: pos.liquidationThreshold,
      debtAmount: Number(pos.debtAmount),
      debtPriceUsd: shockedDebtPrice || 1,
      protocolLtv: Number(pos.ltv),
    });

    const isLiquidated = hfResult.healthFactor < 1.0;

    if (isLiquidated) {
      const collateralValueUsd = Number(pos.collateralAmount) * shockedCollateralPrice;
      const debtValueUsd = Number(pos.debtAmount) * (shockedDebtPrice || 1);

      // Liquidation bonus (typically 5-15%)
      const bonus = options.includeLiquidationBonus ? 0.08 : 0;

      liquidated.push({
        positionId: pos.id,
        user: pos.userAddress,
        protocol: pos.protocolAddress,
        collateralToken: pos.collateralToken,
        debtToken: pos.debtToken,
        collateralValue: formatUsd(collateralValueUsd),
        debtValue: formatUsd(debtValueUsd),
        healthFactorBefore: Math.round(hfBefore * 100) / 100,
        healthFactorAfter: Math.round(hfResult.healthFactor * 100) / 100,
        liquidated: true,
        cascadeDepth: 1,
      });

      totalValueLiquidated += collateralValueUsd;
      totalBadDebt += Math.max(0, debtValueUsd - collateralValueUsd * (1 - bonus));
      affectedUsers.add(pos.userAddress);
    }
  }

  // 4. Model second-order effects if enabled
  let secondOrderEffects: SecondOrderEffect[] = [];
  let systemicRiskScore = 0;

  if (options.includeSecondOrderEffects) {
    secondOrderEffects = await computeSecondOrderEffects(liquidated, scenario.protocolFailures);

    // Compute systemic risk score based on:
    // - Percentage of positions liquidated
    // - Total value at risk vs ecosystem TVL
    // - Cross-protocol contagion
    const totalPositions = activePositions.length;
    const liquidationRatio = totalPositions > 0 ? liquidated.length / totalPositions : 0;
    const affectedProtocols = new Set(liquidated.map((l) => l.protocol)).size;
    const totalProtocols = new Set(activePositions.map((p) => p.protocolAddress)).size;

    systemicRiskScore = Math.round(
      Math.min(
        100,
        (liquidationRatio * 40 +
          (totalProtocols > 0 ? (affectedProtocols / totalProtocols) * 30 : 0) +
          (totalValueLiquidated > 1000000 ? 20 : totalValueLiquidated > 100000 ? 10 : 0) +
          (options.maxCascadeDepth > 3 ? 10 : 0)) *
          100,
      ),
    ) / 100;
  }

  const elapsed = Date.now() - startTime;

  // Save simulation run
  await prismaWrite.simulationRun.create({
    data: {
      name: `Simulation ${new Date().toISOString().slice(0, 16)}`,
      scenario: input as any,
      result: {
        summary: {
          positionsLiquidated: liquidated.length,
          totalValueLiquidated: formatUsd(totalValueLiquidated),
          totalBadDebt: formatUsd(totalBadDebt),
          cascadeDepth: maxDepth,
          protocolsAffected: new Set(liquidated.map((l) => l.protocol)).size,
          usersAffected: affectedUsers.size,
        },
        liquidations: liquidated,
        secondOrderEffects,
        systemicRiskScore,
      } as any,
      triggeredBy: 'api',
      duration: elapsed,
      completedAt: new Date(),
    },
  });

  return {
    summary: {
      positionsLiquidated: liquidated.length,
      totalValueLiquidated: formatUsd(totalValueLiquidated),
      totalBadDebt: formatUsd(totalBadDebt),
      cascadeDepth: maxDepth,
      protocolsAffected: new Set(liquidated.map((l) => l.protocol)).size,
      usersAffected: affectedUsers.size,
    },
    liquidations,
    secondOrderEffects,
    systemicRiskScore,
  };
}

// ── Cascading Collapse Simulator ──────────────────────────────────────────────

/**
 * Run a full cascade simulation with second-order effects.
 * Models:
 * - Price cascade: Large liquidation → price drop → more liquidations
 * - Liquidity cascade: Multiple liquidations drain protocol liquidity
 * - Contagion cascade: Protocol A liquidations affect Protocol B
 */
export async function runCascadeSimulation(
  initialShocks: PriceChangeScenario[],
  maxDepth: number = 5,
): Promise<SimulationResult> {
  const allLiquidations: LiquidatedPosition[] = [];
  const affectedProtocols = new Set<string>();
  const affectedUsers = new Set<string>();
  const cascadingPrices = new Map<string, number>(initialShocks.map((s) => [s.token, s.dropPercentage ?? 0]));

  let depth = 0;
  let currentShocks = [...initialShocks];

  // Cascade simulation loop: each iteration represents a cascade depth
  while (depth < maxDepth && currentShocks.length > 0) {
    const result = await simulateLiquidation({
      scenario: {
        priceChanges: currentShocks,
        protocolFailures: [],
      },
      options: {
        includeSecondOrderEffects: depth > 0,
        maxCascadeDepth: maxDepth,
        includeLiquidationBonus: true,
      },
    });

    allLiquidations.push(...result.liquidations.map((l) => ({ ...l, cascadeDepth: depth + 1 })));
    result.liquidations.forEach((l) => {
      affectedProtocols.add(l.protocol);
      affectedUsers.add(l.user);
    });

    // Amplify shock for next depth: large liquidations cause further price drops
    const additionalShocks: PriceChangeScenario[] = [];
    for (const liq of result.liquidations) {
      const existingShock = cascadingPrices.get(liq.collateralToken) ?? 0;
      const amplification = Math.min(5, result.liquidations.length * 0.1); // 0-5% additional drop
      cascadingPrices.set(liq.collateralToken, existingShock + amplification);
    }

    // Build next depth shocks
    currentShocks = Array.from(cascadingPrices.entries())
      .filter(([_, drop]) => drop < 100) // Limit total drop
      .map(([token, drop]) => ({ token, dropPercentage: drop }));

    depth++;

    // Stop if no more liquidations
    if (result.liquidations.length === 0) break;
  }

  const totalValue = allLiquidations.reduce((s, l) => {
    const val = parseFloat(l.collateralValue.replace(/[^0-9.]/g, ''));
    return s + (isNaN(val) ? 0 : val);
  }, 0);

  const secondOrderEffects = await computeSecondOrderEffects(allLiquidations, []);

  return {
    summary: {
      positionsLiquidated: allLiquidations.length,
      totalValueLiquidated: formatUsd(totalValue),
      totalBadDebt: formatUsd(totalValue * 0.15), // Estimated bad debt ratio
      cascadeDepth: depth,
      protocolsAffected: affectedProtocols.size,
      usersAffected: affectedUsers.size,
    },
    liquidations: allLiquidations,
    secondOrderEffects,
    systemicRiskScore: Math.min(100, Math.round((allLiquidations.length > 100 ? 85 : allLiquidations.length > 50 ? 70 : allLiquidations.length > 10 ? 55 : 30) * 100) / 100),
  };
}

// ── Second-Order Effects ──────────────────────────────────────────────────────

async function computeSecondOrderEffects(
  liquidations: LiquidatedPosition[],
  failedProtocols: string[],
): Promise<SecondOrderEffect[]> {
  const protocolMap = new Map<string, LiquidatedPosition[]>();
  for (const liq of liquidations) {
    const list = protocolMap.get(liq.protocol) ?? [];
    list.push(liq);
    protocolMap.set(liq.protocol, list);
  }

  const effects: SecondOrderEffect[] = [];

  for (const [protocol, liqs] of protocolMap) {
    const metrics = await prismaRead.protocolRiskMetrics.findUnique({
      where: { protocolAddress: protocol },
    });

    const positions = await prismaRead.lendingPosition.findMany({
      where: { protocolAddress: protocol, status: 'ACTIVE' },
    });

    if (positions.length === 0) continue;

    // Simulate new utilization rate after liquidations
    const removedDebt = liqs.reduce((s, l) => {
      const val = parseFloat(l.debtValue.replace(/[^0-9.]/g, ''));
      return s + (isNaN(val) ? 0 : val);
    }, 0);

    const currentUtilization = metrics?.utilizationRate ?? 0.5;
    const newUtilization = Math.min(1, currentUtilization * (1 + removedDebt / 1000000));

    // New average health factor
    const remainingPositions = positions.filter((p) => !liqs.some((l) => l.positionId === p.id));
    const newAvgHf =
      remainingPositions.length > 0
        ? remainingPositions.reduce((s, p) => s + p.healthFactor, 0) / remainingPositions.length
        : 1.5;

    const newAtRisk = remainingPositions.filter(
      (p) => p.riskLevel === 'HIGH' || p.riskLevel === 'CRITICAL' || p.riskLevel === 'ELEVATED',
    ).length;

    effects.push({
      protocol,
      newUtilizationRate: Math.round(newUtilization * 100) / 100,
      newAvgHealthFactor: Math.round(newAvgHf * 100) / 100,
      newPositionsAtRisk: newAtRisk,
    });
  }

  // Include failed protocols
  for (const fp of failedProtocols) {
    if (!protocolMap.has(fp)) {
      effects.push({
        protocol: fp,
        newUtilizationRate: 0.95,
        newAvgHealthFactor: 0.8,
        newPositionsAtRisk: 999,
      });
    }
  }

  return effects;
}

// ── Liquidator Opportunity Detection ──────────────────────────────────────────

export interface LiquidationOpportunity {
  positionId: string;
  protocol: string;
  collateralToken: string;
  debtToken: string;
  collateralValue: string;
  debtValue: string;
  liquidationBonus: number;
  estimatedProfit: number;
  gasEstimate: number;
  netProfit: number;
  healthFactor: number;
}

/**
 * Find profitable liquidation opportunities.
 */
export async function findLiquidationOpportunities(
  minProfitUsd: number = 0,
  maxResults: number = 50,
): Promise<LiquidationOpportunity[]> {
  const criticalPositions = await prismaRead.lendingPosition.findMany({
    where: {
      status: 'ACTIVE',
      riskLevel: { in: ['CRITICAL', 'HIGH'] },
    },
    orderBy: { healthFactor: 'asc' },
    take: 200,
  });

  const opportunities: LiquidationOpportunity[] = [];

  for (const pos of criticalPositions) {
    // Liquidation bonus: typically 5-12.5% for over-collateralized loans
    const bonusPct =
      pos.riskLevel === 'CRITICAL' ? 0.125 : pos.riskLevel === 'HIGH' ? 0.1 : 0.05;

    const collateralValueUsd = Number(pos.collateralAmount) * (pos.collateralUsd ?? 0);
    const debtValueUsd = Number(pos.debtAmount) * (pos.debtUsd ?? 0);
    const bonusAmount = debtValueUsd * bonusPct;
    const gasEstimate = 5; // Estimated gas in USD
    const netProfit = bonusAmount - gasEstimate;

    if (netProfit >= minProfitUsd) {
      opportunities.push({
        positionId: pos.id,
        protocol: pos.protocolAddress,
        collateralToken: pos.collateralToken,
        debtToken: pos.debtToken,
        collateralValue: formatUsd(collateralValueUsd),
        debtValue: formatUsd(debtValueUsd),
        liquidationBonus: Math.round(bonusPct * 10000) / 100,
        estimatedProfit: Math.round(bonusAmount * 100) / 100,
        gasEstimate,
        netProfit: Math.round(netProfit * 100) / 100,
        healthFactor: pos.healthFactor,
      });
    }
  }

  return opportunities.sort((a, b) => b.netProfit - a.netProfit).slice(0, maxResults);
}
