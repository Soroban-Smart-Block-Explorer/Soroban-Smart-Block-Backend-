/**
 * Audit Scheduler
 *
 * Runs two independent cadences:
 *   DAILY  — contracts with TVL > $100 K (active protocols)
 *   WEEKLY — all other known contracts
 *
 * Uses incremental mode for daily runs (only re-score changed dimensions)
 * and full mode for weekly runs (complete recompute).
 *
 * Runs at startup with a 60-second delay, then on interval.
 * Both schedules are staggered across contracts (1 per 5 s) so the DB is
 * never hit with a burst.
 */

import { prismaRead } from '../db';
import { logger } from '../logger';
import { runAuditPipeline } from './audit-pipeline';

// ── Constants ─────────────────────────────────────────────────────────────────

const TVL_ACTIVE_THRESHOLD_USD = 100_000; // $100 K
const STAGGER_MS = 5_000; // 5 s between each contract in a batch
const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;
const WEEKLY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 60 * 1000; // wait 60 s after process start

// ── TVL helper ────────────────────────────────────────────────────────────────

async function getContractTvl(contractAddress: string): Promise<number> {
  // Primary: yield optimizer TVL string
  const yieldOpp = await prismaRead.yieldOpportunity.findFirst({
    where: { contractAddress },
    orderBy: { updatedAt: 'desc' },
    select: { tvl: true },
  });
  if (yieldOpp?.tvl) {
    const v = parseFloat(yieldOpp.tvl);
    if (!isNaN(v)) return v;
  }

  // Secondary: latest portfolio snapshot USD value
  const portfolio = await prismaRead.portfolioSnapshot.findFirst({
    where: { contractAddress },
    orderBy: { snapshotAt: 'desc' },
    select: { valueUsd: true },
  });
  return portfolio?.valueUsd ?? 0;
}

// ── Batch runner ──────────────────────────────────────────────────────────────

async function runBatch(addresses: string[], cadence: 'daily' | 'weekly'): Promise<void> {
  const trigger = cadence === 'daily' ? 'daily' : 'weekly';
  const mode = cadence === 'daily' ? 'incremental' : 'full';
  const anchor = process.env.AUDIT_ANCHOR_ENABLED === 'true';

  logger.info('Audit scheduler batch starting', {
    cadence,
    mode,
    count: addresses.length,
  });

  let processed = 0;
  const skipped = 0;
  let failed = 0;

  for (const addr of addresses) {
    try {
      await runAuditPipeline({ contractAddress: addr, trigger, mode, anchor });
      processed++;
    } catch (e) {
      logger.warn('Scheduled audit failed', { contractAddress: addr, error: String(e) });
      failed++;
    }

    // Stagger: pause between contracts regardless of success/failure
    await new Promise((r) => setTimeout(r, STAGGER_MS));
  }

  logger.info('Audit scheduler batch complete', {
    cadence,
    processed,
    skipped,
    failed,
    total: addresses.length,
  });
}

// ── Daily scheduler — active contracts (TVL > $100 K) ─────────────────────────

async function runDailySchedule(): Promise<void> {
  logger.info('Daily audit schedule firing');

  // Find all contracts that have at least one certificate (already bootstrapped)
  const certs = await prismaRead.auditCertificate.findMany({
    where: { status: 'published' },
    select: { contractAddress: true },
    distinct: ['contractAddress'],
  });

  // Filter down to active contracts by TVL
  const activeAddresses: string[] = [];
  for (const { contractAddress } of certs) {
    const tvl = await getContractTvl(contractAddress);
    if (tvl >= TVL_ACTIVE_THRESHOLD_USD) {
      activeAddresses.push(contractAddress);
    }
  }

  if (activeAddresses.length === 0) {
    logger.info('Daily audit: no active contracts above TVL threshold');
    return;
  }

  logger.info('Daily audit: active contracts identified', {
    count: activeAddresses.length,
    threshold: `$${TVL_ACTIVE_THRESHOLD_USD.toLocaleString()}`,
  });

  await runBatch(activeAddresses, 'daily');
}

// ── Weekly scheduler — all other known contracts ──────────────────────────────

async function runWeeklySchedule(): Promise<void> {
  logger.info('Weekly audit schedule firing');

  // All known contracts
  const allContracts = await prismaRead.contract.findMany({
    select: { address: true },
  });

  // Exclude those already covered by the daily schedule (TVL > threshold)
  const weeklyAddresses: string[] = [];
  for (const { address } of allContracts) {
    const tvl = await getContractTvl(address);
    if (tvl < TVL_ACTIVE_THRESHOLD_USD) {
      weeklyAddresses.push(address);
    }
  }

  if (weeklyAddresses.length === 0) {
    logger.info('Weekly audit: no contracts below TVL threshold');
    return;
  }

  logger.info('Weekly audit: contracts identified', {
    count: weeklyAddresses.length,
  });

  await runBatch(weeklyAddresses, 'weekly');
}

// ── Public: start both schedulers ────────────────────────────────────────────

export function startAuditScheduler(): void {
  // Delay initial runs so the server is fully warm before batch starts
  setTimeout(() => {
    // Run both on startup, then set intervals
    runDailySchedule().catch((e) =>
      logger.error('Daily audit schedule error', { error: String(e) }),
    );

    // Stagger the weekly run 10 s after the daily to avoid concurrent bursts
    setTimeout(() => {
      runWeeklySchedule().catch((e) =>
        logger.error('Weekly audit schedule error', { error: String(e) }),
      );
    }, 10_000);

    setInterval(() => {
      runDailySchedule().catch((e) =>
        logger.error('Daily audit schedule error', { error: String(e) }),
      );
    }, DAILY_INTERVAL_MS);

    setInterval(() => {
      runWeeklySchedule().catch((e) =>
        logger.error('Weekly audit schedule error', { error: String(e) }),
      );
    }, WEEKLY_INTERVAL_MS);
  }, STARTUP_DELAY_MS);

  logger.info('Audit scheduler started', {
    dailyIntervalHours: DAILY_INTERVAL_MS / 3600000,
    weeklyIntervalDays: WEEKLY_INTERVAL_MS / 86400000,
    tvlThreshold: `$${TVL_ACTIVE_THRESHOLD_USD.toLocaleString()}`,
    startupDelayS: STARTUP_DELAY_MS / 1000,
  });
}
