/**
 * src/lending/backgroundMonitor.ts
 *
 * Soroban Liquidation Command Center — Background Health Monitor
 *
 * Processes each new block for price updates affecting positions.
 * Supports batch, incremental, and event-driven position updates.
 * Performance target: update 10,000 positions in <1 second.
 */

import { prismaRead, prismaWrite } from '../db';
import { batchUpdatePositions, updateProtocolRiskMetrics, getTokenPrice, computeHealthFactor, classifyRiskLevel } from './healthFactorEngine';
import { logger } from '../logger';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface HealthMonitorConfig {
  batchSize: number;
  pollIntervalMs: number;
  priceChangeThreshold: number; // Minimum % change to trigger update
  maxRetries: number;
}

const DEFAULT_CONFIG: HealthMonitorConfig = {
  batchSize: 1000,
  pollIntervalMs: 30_000, // 30 seconds
  priceChangeThreshold: 0.5, // 0.5% price change threshold
  maxRetries: 3,
};

let monitorInterval: ReturnType<typeof setInterval> | null = null;
let isRunning = false;

// ── Price Change Detection ────────────────────────────────────────────────────

interface PriceChange {
  tokenAddress: string;
  oldPrice: number;
  newPrice: number;
  changePct: number;
}

const previousPrices = new Map<string, number>();

/**
 * Detect token price changes by checking oracle prices.
 */
async function detectPriceChanges(): Promise<PriceChange[]> {
  const changes: PriceChange[] = [];

  try {
    const oracles = await prismaRead.priceOracle.findMany({
      where: { stale: false },
    });

    for (const oracle of oracles) {
      const previous = previousPrices.get(oracle.tokenAddress) ?? oracle.lastPrice;
      const changePct =
        previous > 0 ? Math.abs((oracle.lastPrice - previous) / previous) * 100 : 0;

      if (changePct >= DEFAULT_CONFIG.priceChangeThreshold) {
        changes.push({
          tokenAddress: oracle.tokenAddress,
          oldPrice: previous,
          newPrice: oracle.lastPrice,
          changePct: Math.round(changePct * 100) / 100,
        });
      }

      previousPrices.set(oracle.tokenAddress, oracle.lastPrice);
    }
  } catch (err) {
    logger.error('Failed to detect price changes', { error: String(err) });
  }

  return changes;
}

// ── Alert Generation ──────────────────────────────────────────────────────────

/**
 * Generate alerts for positions that enter critical risk levels.
 */
async function generateAlerts(): Promise<number> {
  try {
    const criticalPositions = await prismaRead.lendingPosition.findMany({
      where: {
        status: 'ACTIVE',
        riskLevel: { in: ['CRITICAL', 'HIGH', 'ELEVATED'] },
      },
      take: 500,
    });

    let alertCount = 0;

    for (const pos of criticalPositions) {
      const existingAlert = await prismaRead.liquidationAlert.findFirst({
        where: {
          positionId: pos.id,
          alertType: `risk_level_${pos.riskLevel}`,
          createdAt: { gte: new Date(Date.now() - 3600_000) }, // Within last hour
        },
      });

      if (!existingAlert) {
        await prismaWrite.liquidationAlert.create({
          data: {
            positionId: pos.id,
            alertType: `risk_level_${pos.riskLevel}`,
            severity: pos.riskLevel === 'CRITICAL' ? 'critical' : pos.riskLevel === 'HIGH' ? 'high' : 'medium',
            message: `Position ${pos.id.slice(0, 8)} entered ${pos.riskLevel} range (HF: ${pos.healthFactor.toFixed(2)})`,
            healthFactor: pos.healthFactor,
            metadata: {
              collateralToken: pos.collateralToken,
              debtToken: pos.debtToken,
              protocolAddress: pos.protocolAddress,
              userAddress: pos.userAddress,
            },
          },
        });
        alertCount++;
      }
    }

    return alertCount;
  } catch (err) {
    logger.error('Failed to generate alerts', { error: String(err) });
    return 0;
  }
}

// ── Liquidation Detection from Events ─────────────────────────────────────────

/**
 * Detect liquidation events from transaction logs and position state changes.
 */
async function detectLiquidations(): Promise<number> {
  try {
    // Find positions that have crossed below HF=1.0 since last check
    const recentlyLiquidated = await prismaRead.lendingPosition.findMany({
      where: {
        status: 'ACTIVE',
        riskLevel: 'LIQUIDATED',
        lastUpdatedAt: {
          gte: new Date(Date.now() - DEFAULT_CONFIG.pollIntervalMs * 2),
        },
      },
    });

    for (const pos of recentlyLiquidated) {
      // Create a liquidation event record if one doesn't exist
      const existingEvent = await prismaRead.liquidationEvent.findFirst({
        where: { positionId: pos.id, timestamp: { gte: new Date(Date.now() - 3600_000) } },
      });

      if (!existingEvent) {
        await prismaWrite.liquidationEvent.create({
          data: {
            txHash: `auto_${Date.now()}_${pos.id.slice(0, 8)}`,
            protocolAddress: pos.protocolAddress,
            positionId: pos.id,
            userAddress: pos.userAddress,
            liquidator: 'unknown',
            collateralToken: pos.collateralToken,
            debtToken: pos.debtToken,
            collateralSeized: pos.collateralAmount,
            debtCovered: pos.debtAmount,
            collateralUsd: pos.collateralUsd,
            debtUsd: pos.debtUsd,
            bonus: 0.08,
            healthFactorAtEvent: pos.healthFactor,
            timestamp: new Date(),
          },
        });

        // Create critical alert
        await prismaWrite.liquidationAlert.create({
          data: {
            positionId: pos.id,
            alertType: 'liquidation_detected',
            severity: 'critical',
            message: `Position ${pos.id.slice(0, 8)} has been liquidated (HF: ${pos.healthFactor.toFixed(2)})`,
            healthFactor: pos.healthFactor,
            metadata: {
              collateralToken: pos.collateralToken,
              debtToken: pos.debtToken,
              userAddress: pos.userAddress,
              protocolAddress: pos.protocolAddress,
            },
          },
        });

        // Update position counts
        await prismaWrite.lendingPosition.update({
          where: { id: pos.id },
          data: {
            status: 'LIQUIDATED',
            liquidationCount: { increment: 1 },
            totalLiquidated: { increment: Number(pos.debtAmount) },
          },
        });
      }
    }

    return recentlyLiquidated.length;
  } catch (err) {
    logger.error('Failed to detect liquidations', { error: String(err) });
    return 0;
  }
}

// ── Main Monitor Loop ─────────────────────────────────────────────────────────

/**
 * Main health monitor tick: detect price changes, update positions, generate alerts.
 */
async function monitorTick(): Promise<void> {
  try {
    // 1. Detect price changes
    const priceChanges = await detectPriceChanges();

    if (priceChanges.length === 0) {
      return; // No significant price changes
    }

    logger.info('Health monitor: detected price changes', {
      count: priceChanges.length,
      changes: priceChanges.slice(0, 5).map((c) => ({
        token: c.tokenAddress.slice(0, 8),
        change: `${c.changePct}%`,
      })),
    });

    // 2. Get affected protocol addresses
    const affectedTokens = new Set(priceChanges.map((c) => c.tokenAddress));

    const affectedPositions = await prismaRead.lendingPosition.findMany({
      where: {
        status: 'ACTIVE',
        OR: [
          { collateralToken: { in: Array.from(affectedTokens) } },
          { debtToken: { in: Array.from(affectedTokens) } },
        ],
      },
      select: { protocolAddress: true },
      distinct: ['protocolAddress'],
    });

    // 3. Batch update positions per protocol
    const updatePromises = affectedPositions.map((p) => batchUpdatePositions(p.protocolAddress));
    const updateCounts = await Promise.all(updatePromises);
    const totalUpdated = updateCounts.reduce((s, c) => s + c, 0);

    // 4. Update protocol risk metrics
    await Promise.all(
      affectedPositions.map((p) => updateProtocolRiskMetrics(p.protocolAddress)),
    );

    // 5. Generate alerts for critical positions
    const alertCount = await generateAlerts();

    // 6. Detect new liquidations
    const liqCount = await detectLiquidations();

    if (totalUpdated > 0 || alertCount > 0 || liqCount > 0) {
      logger.info('Health monitor tick complete', {
        priceChanges: priceChanges.length,
        positionsUpdated: totalUpdated,
        protocolsAffected: affectedPositions.length,
        alertsGenerated: alertCount,
        liquidationsDetected: liqCount,
      });
    }
  } catch (err) {
    logger.error('Health monitor tick failed', { error: String(err) });
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

/**
 * Start the background health monitor.
 */
export function startHealthMonitor(config: Partial<HealthMonitorConfig> = {}): void {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };

  if (monitorInterval) {
    clearInterval(monitorInterval);
  }

  isRunning = true;
  monitorInterval = setInterval(monitorTick, finalConfig.pollIntervalMs);

  // Run an immediate tick
  monitorTick().catch((err) =>
    logger.error('Initial health monitor tick failed', { error: String(err) }),
  );

  logger.info('Health monitor started', {
    pollIntervalMs: finalConfig.pollIntervalMs,
    priceChangeThreshold: finalConfig.priceChangeThreshold,
  });
}

/**
 * Stop the background health monitor.
 */
export function stopHealthMonitor(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
  isRunning = false;
  logger.info('Health monitor stopped');
}

/**
 * Check if the health monitor is running.
 */
export function isMonitorRunning(): boolean {
  return isRunning;
}

/**
 * Force an immediate monitor tick (useful for testing).
 */
export async function forceMonitorTick(): Promise<{
  priceChanges: number;
  positionsUpdated: number;
  alertsGenerated: number;
  liquidationsDetected: number;
}> {
  const initialChanges = await detectPriceChanges();
  await monitorTick();
  return {
    priceChanges: initialChanges.length,
    positionsUpdated: 0,
    alertsGenerated: 0,
    liquidationsDetected: 0,
  };
}
