/**
 * AML Transaction Monitoring
 *
 * Detects suspicious ramp patterns and writes RampAmlFlag records:
 *
 *   structuring       – multiple sub-$1k transactions that sum to > $3k/day
 *   rapid_in_out      – buy then sell within 10 minutes
 *   high_risk_jurisdiction – transaction from a high-risk but not blocked country
 *   large_single      – single transaction > $50k (Travel Rule threshold)
 *   velocity          – > 5 orders in a 1-hour window
 */

import { prismaWrite, prismaRead } from '../../db';
import { logger } from '../../logger';

const HIGH_RISK_JURISDICTIONS = new Set([
  'PK', 'TR', 'GH', 'UG', 'TZ', 'PA', 'JM', 'NI', 'NG', 'HT',
]);

// ── Flag creation ─────────────────────────────────────────────────────────────

export async function raiseFlagIfNeeded(opts: {
  userId: string;
  orderId: string;
  fiatAmountUsd: number;
  direction: 'buy' | 'sell';
  userCountry?: string;
}): Promise<void> {
  const checks = await Promise.allSettled([
    checkStructuring(opts.userId, opts.orderId, opts.fiatAmountUsd),
    checkRapidInOut(opts.userId, opts.orderId, opts.direction),
    checkHighRiskJurisdiction(opts.userId, opts.orderId, opts.userCountry),
    checkLargeSingleTransaction(opts.userId, opts.orderId, opts.fiatAmountUsd),
    checkVelocity(opts.userId, opts.orderId),
  ]);

  for (const result of checks) {
    if (result.status === 'rejected') {
      logger.warn('[ramp-aml] check error', { error: String(result.reason) });
    }
  }
}

// ── Individual checks ─────────────────────────────────────────────────────────

async function checkStructuring(
  userId: string,
  orderId: string,
  fiatAmountUsd: number,
): Promise<void> {
  if (fiatAmountUsd >= 1_000) return; // Only flag sub-$1k orders

  const since = new Date(Date.now() - 24 * 60 * 60 * 1_000);
  const todayOrders = await prismaRead.rampOrder.findMany({
    where: {
      userId,
      fiatAmount: { lt: 1_000 },
      createdAt: { gte: since },
      status: { in: ['completed', 'processing', 'pending'] },
    },
    select: { fiatAmount: true },
  });

  const totalToday = todayOrders.reduce((s, o) => s + o.fiatAmount, 0) + fiatAmountUsd;
  if (totalToday > 3_000) {
    await createFlag({
      userId,
      orderId,
      flagType: 'structuring',
      severity: 'high',
      description: `Possible structuring: ${todayOrders.length + 1} sub-$1,000 transactions totalling $${totalToday.toFixed(2)} in 24h`,
      metadata: { totalToday, transactionCount: todayOrders.length + 1 },
    });
  }
}

async function checkRapidInOut(
  userId: string,
  orderId: string,
  direction: 'buy' | 'sell',
): Promise<void> {
  if (direction !== 'sell') return;

  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1_000);
  const recentBuy = await prismaRead.rampOrder.findFirst({
    where: {
      userId,
      direction: 'buy',
      createdAt: { gte: tenMinutesAgo },
      status: { in: ['completed', 'processing'] },
    },
  });

  if (recentBuy) {
    await createFlag({
      userId,
      orderId,
      flagType: 'rapid_in_out',
      severity: 'medium',
      description: 'Sell order placed within 10 minutes of a buy order (rapid in/out pattern)',
      metadata: { buyOrderId: recentBuy.id },
    });
  }
}

async function checkHighRiskJurisdiction(
  userId: string,
  orderId: string,
  userCountry?: string,
): Promise<void> {
  if (!userCountry) return;
  if (!HIGH_RISK_JURISDICTIONS.has(userCountry.toUpperCase())) return;

  await createFlag({
    userId,
    orderId,
    flagType: 'high_risk_jurisdiction',
    severity: 'medium',
    description: `Transaction from FATF-monitored jurisdiction: ${userCountry}`,
    metadata: { country: userCountry },
  });
}

async function checkLargeSingleTransaction(
  userId: string,
  orderId: string,
  fiatAmountUsd: number,
): Promise<void> {
  if (fiatAmountUsd < 50_000) return;

  await createFlag({
    userId,
    orderId,
    flagType: 'large_single',
    severity: fiatAmountUsd >= 100_000 ? 'critical' : 'high',
    description: `Large single transaction: $${fiatAmountUsd.toFixed(2)} — Travel Rule compliance required`,
    metadata: { fiatAmountUsd },
  });
}

async function checkVelocity(userId: string, orderId: string): Promise<void> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1_000);
  const recentCount = await prismaRead.rampOrder.count({
    where: {
      userId,
      createdAt: { gte: oneHourAgo },
    },
  });

  if (recentCount >= 5) {
    await createFlag({
      userId,
      orderId,
      flagType: 'velocity',
      severity: 'medium',
      description: `High transaction velocity: ${recentCount + 1} orders in the last hour`,
      metadata: { recentCount: recentCount + 1, windowHours: 1 },
    });
  }
}

// ── Flag writer ───────────────────────────────────────────────────────────────

async function createFlag(opts: {
  userId: string;
  orderId: string;
  flagType: string;
  severity: string;
  description: string;
  metadata: Record<string, unknown>;
}): Promise<void> {
  try {
    await prismaWrite.rampAmlFlag.create({
      data: {
        userId: opts.userId,
        orderId: opts.orderId,
        flagType: opts.flagType,
        severity: opts.severity,
        description: opts.description,
        metadata: opts.metadata,
      },
    });
    logger.warn('[ramp-aml] flag raised', {
      userId: opts.userId,
      orderId: opts.orderId,
      flagType: opts.flagType,
      severity: opts.severity,
    });
  } catch (err) {
    logger.error('[ramp-aml] failed to create flag', { error: String(err) });
  }
}

// ── Flag resolution ───────────────────────────────────────────────────────────

export async function resolveFlag(flagId: string, resolvedBy: string): Promise<void> {
  await prismaWrite.rampAmlFlag.update({
    where: { id: flagId },
    data: { resolved: true, resolvedBy, resolvedAt: new Date() },
  });
}

export async function listFlags(opts: {
  userId?: string;
  resolved?: boolean;
  limit?: number;
  offset?: number;
}) {
  return prismaRead.rampAmlFlag.findMany({
    where: {
      ...(opts.userId ? { userId: opts.userId } : {}),
      ...(opts.resolved !== undefined ? { resolved: opts.resolved } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: opts.limit ?? 20,
    skip: opts.offset ?? 0,
  });
}
