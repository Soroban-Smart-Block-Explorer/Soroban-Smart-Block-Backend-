/**
 * Gas Analytics Scheduler
 *
 * Computes average, median, and peak transaction fees (gas costs) bucketed
 * by hour, day, and week, then upserts the results into GasAnalyticsSnapshot.
 * Scheduled via node-cron for better timing precision, backpressure handling,
 * and error isolation.
 *
 * Uses dependency injection for better testability.
 */

import type { PrismaClient } from '@prisma/client';
import { scheduler } from '../scheduler/cron-scheduler';
import type { Logger } from '../services/container';
import { container } from '../services/container';

type Bucket = 'hour' | 'day' | 'week';

const BUCKET_MS: Record<Bucket, number> = {
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
};

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Class-based gas analytics processor for better testability and DI support.
 */
export class GasAnalyticsProcessor {
  private gasAnalyticsJobId: string | null = null;

  constructor(
    private prismaRead: PrismaClient,
    private prismaWrite: PrismaClient,
    private logger: Logger,
  ) {}

  /**
   * Compute metrics for a single bucket.
   */
  private async computeBucket(bucket: Bucket, bucketStart: Date): Promise<void> {
    const bucketEnd = new Date(bucketStart.getTime() + BUCKET_MS[bucket]);

    const rows = await this.prismaRead.transaction.findMany({
      where: {
        ledgerCloseTime: { gte: bucketStart, lt: bucketEnd },
        feeCharged: { not: null },
      },
      select: { feeCharged: true },
    });

    if (rows.length === 0) return;

    const fees = rows
      .map((r) => Number(r.feeCharged))
      .filter((f) => Number.isFinite(f) && f > 0)
      .sort((a, b) => a - b);

    if (fees.length === 0) return;

    const avgFee = fees.reduce((a, b) => a + b, 0) / fees.length;
    const medianFee = median(fees);
    const peakFee = fees[fees.length - 1];
    const minFee = fees[0];

    await this.prismaWrite.gasAnalyticsSnapshot.upsert({
      where: { bucket_bucketStart: { bucket, bucketStart } },
      create: {
        bucket,
        bucketStart,
        bucketEnd,
        avgFee,
        medianFee,
        peakFee,
        minFee,
        txCount: fees.length,
      },
      update: { bucketEnd, avgFee, medianFee, peakFee, minFee, txCount: fees.length },
    });
  }

  /**
   * Run gas analytics for the most recent completed bucket of each granularity.
   */
  async run(): Promise<void> {
    const now = new Date();

    for (const bucket of ['hour', 'day', 'week'] as Bucket[]) {
      const ms = BUCKET_MS[bucket];
      // Align to the last completed bucket boundary
      const bucketStart = new Date(Math.floor(now.getTime() / ms) * ms - ms);
      await this.computeBucket(bucket, bucketStart);
    }
  }

  /**
   * Start a recurring gas analytics job.
   */
  startScheduler(options: GasAnalyticsSchedulerOptions = {}): void {
    const {
      cronExpression = '0 * * * *', // Every hour at :00 minutes
      runOnStart = true,
    } = options;

    this.gasAnalyticsJobId = 'gas-analytics';

    // Run immediately if requested
    if (runOnStart) {
      this.run().catch((err) => this.logger.error('[gasAnalytics] initial run failed:', err));
    }

    // Register the recurring job
    scheduler.register({
      id: this.gasAnalyticsJobId,
      taskName: 'Gas Analytics Computation',
      cronExpression,
      execute: () => this.run(),
      maxDuration: 30_000, // 30s timeout per execution
      retryOnFailure: true,
      retryDelayMs: 5000,
    });
  }

  /**
   * Stop the gas analytics scheduler.
   */
  stopScheduler(): void {
    if (this.gasAnalyticsJobId) {
      scheduler.stop(this.gasAnalyticsJobId);
    }
  }
}

/**
 * Interface for scheduling options.
 */
export interface GasAnalyticsSchedulerOptions {
  cronExpression?: string;
  runOnStart?: boolean;
}

// ────────────────────────────────────────────────────────────────────────────
// Singleton instance for backward compatibility
// ────────────────────────────────────────────────────────────────────────────

const gasAnalyticsProcessor = new GasAnalyticsProcessor(
  container.getPrismaRead(),
  container.getPrismaWrite(),
  container.getLogger(),
);

/**
 * Run gas analytics (for backward compatibility).
 * @deprecated Use GasAnalyticsProcessor class instead
 */
export async function runGasAnalytics(): Promise<void> {
  return gasAnalyticsProcessor.run();
}

/**
 * Start a recurring gas analytics job (for backward compatibility).
 * @deprecated Use GasAnalyticsProcessor class instead
 */
export function startGasAnalyticsScheduler(options: GasAnalyticsSchedulerOptions = {}): void {
  gasAnalyticsProcessor.startScheduler(options);
}

/**
 * Stop the gas analytics scheduler (for backward compatibility).
 * @deprecated Use GasAnalyticsProcessor class instead
 */
export function stopGasAnalyticsScheduler(): void {
  gasAnalyticsProcessor.stopScheduler();
}

/**
 * Stop the gas analytics scheduler.
 */
export function stopGasAnalyticsScheduler(): void {
  if (gasAnalyticsJobId) {
    scheduler.stop(gasAnalyticsJobId);
  }
}
