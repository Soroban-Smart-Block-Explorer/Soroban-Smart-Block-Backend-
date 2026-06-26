/**
 * Fee Aggregator — background jobs
 *
 * Produces ProtocolRevenue and YieldSnapshot rows from raw FeeEvent data.
 * Runs on a schedule: hourly for HOUR period, daily at midnight for DAY/WEEK/MONTH.
 */

import { prismaRead, prismaWrite } from '../db';
import type { RevenuePeriod } from '@prisma/client';
import {
  computeLpApr,
  computeStakingApr,
  detectAnomalies,
} from './fee-classifier';
import { logger } from '../logger';

// ---------------------------------------------------------------------------
// Period helpers
// ---------------------------------------------------------------------------

const PERIOD_MS: Record<RevenuePeriod, number> = {
  HOUR:  60 * 60 * 1000,
  DAY:   24 * 60 * 60 * 1000,
  WEEK:  7 * 24 * 60 * 60 * 1000,
  MONTH: 30 * 24 * 60 * 60 * 1000,
};

const PERIODS_PER_YEAR: Record<RevenuePeriod, number> = {
  HOUR:  8760,
  DAY:   365,
  WEEK:  52,
  MONTH: 12,
};

function alignedBucketStart(period: RevenuePeriod): Date {
  const ms = PERIOD_MS[period];
  const now = Date.now();
  return new Date(Math.floor(now / ms) * ms - ms);
}

// ---------------------------------------------------------------------------
// Aggregate fee events for a contract+period bucket
// ---------------------------------------------------------------------------

async function aggregateForContract(
  contractAddress: string,
  period: RevenuePeriod,
  bucketStart: Date,
): Promise<void> {
  const bucketEnd = new Date(bucketStart.getTime() + PERIOD_MS[period]);

  const events = await prismaRead.feeEvent.findMany({
    where: {
      contractAddress,
      timestamp: { gte: bucketStart, lt: bucketEnd },
    },
  });

  if (events.length === 0) return;

  const sum = (types: string[]) =>
    events
      .filter((e) => types.includes(e.feeType))
      .reduce((s, e) => s + Number(e.amount), 0)
      .toString();

  const destSum = (dests: string[]) =>
    events
      .filter((e) => dests.includes(e.destination))
      .reduce((s, e) => s + Number(e.amount), 0)
      .toString();

  const totalFees = events.reduce((s, e) => s + Number(e.amount), 0).toString();
  const usdTotal = events.reduce((s, e) => s + (e.usdValue ?? 0), 0);
  const uniqueSenders = new Set(events.map((e) => e.sender).filter(Boolean)).size;
  const feeToken = events[0]?.token ?? 'XLM';

  // Best-effort lookup for protocol name
  const profile = await prismaRead.protocolProfile.findUnique({
    where: { contractAddress },
    select: { protocolName: true },
  });

  await prismaWrite.protocolRevenue.upsert({
    where: {
      // compound unique: we use a raw approach since Prisma doesn't support multi-field
      // unique on non-@@unique fields. We find-or-create manually.
      id: `${contractAddress}_${period}_${bucketStart.getTime()}`,
    },
    create: {
      id: `${contractAddress}_${period}_${bucketStart.getTime()}`,
      contractAddress,
      protocolName: profile?.protocolName,
      period,
      timestamp: bucketStart,
      totalFees,
      swapFees: sum(['SWAP']),
      withdrawFees: sum(['WITHDRAWAL']),
      performanceFees: sum(['PERFORMANCE']),
      protocolFees: sum(['PROTOCOL']),
      liquidationFees: sum(['LIQUIDATION']),
      interestSpread: sum(['INTEREST_SPREAD']),
      flashLoanFees: sum(['FLASH_LOAN']),
      referralFees: sum(['REFERRAL']),
      lpRewards: destSum(['LP_REWARDS']),
      treasuryAmount: destSum(['TREASURY']),
      burnedAmount: destSum(['BUYBACK_BURN']),
      stakerRewards: destSum(['STAKER_REWARDS']),
      insuranceFund: destSum(['INSURANCE_FUND']),
      ecosystemFund: destSum(['ECOSYSTEM_FUND']),
      teamVesting: destSum(['TEAM_VESTING']),
      feeToken,
      usdValue: usdTotal || null,
      txCount: events.length,
      uniqueUsers: uniqueSenders || null,
    },
    update: {
      protocolName: profile?.protocolName,
      totalFees,
      swapFees: sum(['SWAP']),
      withdrawFees: sum(['WITHDRAWAL']),
      performanceFees: sum(['PERFORMANCE']),
      protocolFees: sum(['PROTOCOL']),
      liquidationFees: sum(['LIQUIDATION']),
      interestSpread: sum(['INTEREST_SPREAD']),
      flashLoanFees: sum(['FLASH_LOAN']),
      referralFees: sum(['REFERRAL']),
      lpRewards: destSum(['LP_REWARDS']),
      treasuryAmount: destSum(['TREASURY']),
      burnedAmount: destSum(['BUYBACK_BURN']),
      stakerRewards: destSum(['STAKER_REWARDS']),
      insuranceFund: destSum(['INSURANCE_FUND']),
      ecosystemFund: destSum(['ECOSYSTEM_FUND']),
      teamVesting: destSum(['TEAM_VESTING']),
      feeToken,
      usdValue: usdTotal || null,
      txCount: events.length,
      uniqueUsers: uniqueSenders || null,
    },
  });
}

// ---------------------------------------------------------------------------
// Yield snapshot computation
// ---------------------------------------------------------------------------

async function computeYieldSnapshot(contractAddress: string): Promise<void> {
  const now = new Date();

  const revForWindow = async (days: number) => {
    const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const rows = await prismaRead.protocolRevenue.findMany({
      where: { contractAddress, period: 'DAY', timestamp: { gte: since } },
    });
    return rows.reduce(
      (acc, r) => ({
        lp: acc.lp + Number(r.lpRewards ?? 0),
        staker: acc.staker + Number(r.stakerRewards ?? 0),
      }),
      { lp: 0, staker: 0 },
    );
  };

  const profile = await prismaRead.protocolProfile.findUnique({
    where: { contractAddress },
  });
  const tvl = Number(profile?.tvl ?? 0);
  const stakedValue = tvl * 0.5; // fallback: assume 50% staked when no separate data

  const [w1, w7, w30] = await Promise.all([
    revForWindow(1),
    revForWindow(7),
    revForWindow(30),
  ]);

  const lpApr1d   = computeLpApr(w1.lp,   tvl, 365);
  const lpApr7d   = computeLpApr(w7.lp / 7, tvl, 365);
  const lpApr30d  = computeLpApr(w30.lp / 30, tvl, 365);
  const stApr1d   = computeStakingApr(w1.staker,   stakedValue, 365);
  const stApr7d   = computeStakingApr(w7.staker / 7, stakedValue, 365);
  const stApr30d  = computeStakingApr(w30.staker / 30, stakedValue, 365);
  const totalRev  = w30.lp + w30.staker;
  const revenueShare = tvl > 0 && totalRev > 0 ? (totalRev / tvl) * 100 : null;

  await prismaWrite.yieldSnapshot.create({
    data: {
      contractAddress,
      protocolName: profile?.protocolName,
      timestamp: now,
      lpApr1d:   isFinite(lpApr1d)  ? lpApr1d  : null,
      lpApr7d:   isFinite(lpApr7d)  ? lpApr7d  : null,
      lpApr30d:  isFinite(lpApr30d) ? lpApr30d : null,
      stakingApr1d:  isFinite(stApr1d)  ? stApr1d  : null,
      stakingApr7d:  isFinite(stApr7d)  ? stApr7d  : null,
      stakingApr30d: isFinite(stApr30d) ? stApr30d : null,
      totalValueLocked: profile?.tvl ?? null,
      stakedValue: stakedValue > 0 ? stakedValue.toString() : null,
      revenueShare,
    },
  });
}

// ---------------------------------------------------------------------------
// Main scheduler entry-points
// ---------------------------------------------------------------------------

export async function runHourlyAggregation(): Promise<void> {
  const bucketStart = alignedBucketStart('HOUR');

  const contracts = await prismaRead.feeEvent.findMany({
    select: { contractAddress: true },
    distinct: ['contractAddress'],
    where: {
      timestamp: {
        gte: bucketStart,
        lt: new Date(bucketStart.getTime() + PERIOD_MS.HOUR),
      },
    },
  });

  for (const { contractAddress } of contracts) {
    await aggregateForContract(contractAddress, 'HOUR', bucketStart);
  }

  logger.info(`[fee-aggregator] hourly: processed ${contracts.length} contracts`);
}

export async function runDailyAggregation(): Promise<void> {
  const dayStart = alignedBucketStart('DAY');

  const contracts = await prismaRead.feeEvent.findMany({
    select: { contractAddress: true },
    distinct: ['contractAddress'],
    where: {
      timestamp: {
        gte: dayStart,
        lt: new Date(dayStart.getTime() + PERIOD_MS.DAY),
      },
    },
  });

  for (const { contractAddress } of contracts) {
    await aggregateForContract(contractAddress, 'DAY', dayStart);
    await computeYieldSnapshot(contractAddress);
    await detectAnomalies(contractAddress);
  }

  logger.info(`[fee-aggregator] daily: processed ${contracts.length} contracts`);
}

// ---------------------------------------------------------------------------
// Scheduler startup
// ---------------------------------------------------------------------------

let hourlyTimer: ReturnType<typeof setInterval> | null = null;
let dailyTimer: ReturnType<typeof setInterval> | null = null;

export function startFeeAggregator(): void {
  // Run immediately on startup, then on schedule
  runHourlyAggregation().catch((e) =>
    logger.error('[fee-aggregator] hourly error:', e),
  );

  hourlyTimer = setInterval(() => {
    runHourlyAggregation().catch((e) =>
      logger.error('[fee-aggregator] hourly error:', e),
    );
  }, PERIOD_MS.HOUR);

  // Daily at midnight aligned intervals
  const msUntilMidnight = () => {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setUTCHours(0, 0, 0, 0);
    midnight.setUTCDate(midnight.getUTCDate() + 1);
    return midnight.getTime() - now.getTime();
  };

  setTimeout(() => {
    runDailyAggregation().catch((e) =>
      logger.error('[fee-aggregator] daily error:', e),
    );
    dailyTimer = setInterval(() => {
      runDailyAggregation().catch((e) =>
        logger.error('[fee-aggregator] daily error:', e),
      );
    }, PERIOD_MS.DAY);
  }, msUntilMidnight());

  logger.info('[fee-aggregator] started');
}

export function stopFeeAggregator(): void {
  if (hourlyTimer) clearInterval(hourlyTimer);
  if (dailyTimer) clearInterval(dailyTimer);
}

// ---------------------------------------------------------------------------
// ARIMA-style linear trend predictor (lightweight, no ML dependency)
// ---------------------------------------------------------------------------

export function predictRevenue(
  history: number[],
  forecastDays: number,
): { dates: string[]; revenue: number[]; lower: number[]; upper: number[] } {
  if (history.length < 2) {
    const flat = Array(forecastDays).fill(history[0] ?? 0);
    const now = new Date();
    const dates = Array.from({ length: forecastDays }, (_, i) => {
      const d = new Date(now.getTime() + (i + 1) * 24 * 60 * 60 * 1000);
      return d.toISOString().slice(0, 10);
    });
    return { dates, revenue: flat, lower: flat, upper: flat };
  }

  // Simple linear regression
  const n = history.length;
  const xMean = (n - 1) / 2;
  const yMean = history.reduce((s, v) => s + v, 0) / n;
  let ssXY = 0;
  let ssXX = 0;
  for (let i = 0; i < n; i++) {
    ssXY += (i - xMean) * (history[i] - yMean);
    ssXX += (i - xMean) ** 2;
  }
  const slope = ssXX === 0 ? 0 : ssXY / ssXX;
  const intercept = yMean - slope * xMean;

  // Standard error for confidence interval
  const residuals = history.map((v, i) => v - (intercept + slope * i));
  const mse = residuals.reduce((s, r) => s + r * r, 0) / Math.max(n - 2, 1);
  const se = Math.sqrt(mse);
  const zScore = 1.96; // 95% CI

  const now = new Date();
  const dates: string[] = [];
  const revenue: number[] = [];
  const lower: number[] = [];
  const upper: number[] = [];

  for (let i = 0; i < forecastDays; i++) {
    const x = n + i;
    const predicted = Math.max(0, intercept + slope * x);
    const margin = zScore * se * Math.sqrt(1 + 1 / n + ((x - xMean) ** 2) / ssXX);
    const d = new Date(now.getTime() + (i + 1) * 24 * 60 * 60 * 1000);
    dates.push(d.toISOString().slice(0, 10));
    revenue.push(parseFloat(predicted.toFixed(4)));
    lower.push(parseFloat(Math.max(0, predicted - margin).toFixed(4)));
    upper.push(parseFloat((predicted + margin).toFixed(4)));
  }

  return { dates, revenue, lower, upper };
}
