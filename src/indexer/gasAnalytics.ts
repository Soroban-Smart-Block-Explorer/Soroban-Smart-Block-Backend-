/**
 * Gas Analytics Scheduler
 *
 * Computes average, median, and peak transaction fees (gas costs) bucketed
 * by hour, day, and week, then upserts the results into GasAnalyticsSnapshot.
 * Call `runGasAnalytics()` on a schedule (e.g. every hour via setInterval).
 */

import { prismaRead, prismaWrite } from '../db';

type Bucket = 'hour' | 'day' | 'week';

const BUCKET_MS: Record<Bucket, number> = {
  hour: 60 * 60 * 1000,
  day:  24 * 60 * 60 * 1000,
  week: 7  * 24 * 60 * 60 * 1000,
};

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

async function computeBucket(bucket: Bucket, bucketStart: Date): Promise<void> {
  const bucketEnd = new Date(bucketStart.getTime() + BUCKET_MS[bucket]);

  const rows = await prismaRead.transaction.findMany({
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

  const avgFee  = fees.reduce((a, b) => a + b, 0) / fees.length;
  const medianFee = median(fees);
  const peakFee = fees[fees.length - 1];
  const minFee  = fees[0];

  await prismaWrite.gasAnalyticsSnapshot.upsert({
    where: { bucket_bucketStart: { bucket, bucketStart } },
    create: { bucket, bucketStart, bucketEnd, avgFee, medianFee, peakFee, minFee, txCount: fees.length },
    update: { bucketEnd, avgFee, medianFee, peakFee, minFee, txCount: fees.length },
  });
}

/**
 * Run gas analytics for the most recent completed bucket of each granularity.
 */
export async function runGasAnalytics(): Promise<void> {
  const now = new Date();

  for (const bucket of ['hour', 'day', 'week'] as Bucket[]) {
    const ms = BUCKET_MS[bucket];
    // Align to the last completed bucket boundary
    const bucketStart = new Date(Math.floor(now.getTime() / ms) * ms - ms);
    await computeBucket(bucket, bucketStart);
  }
}

/**
 * Start a recurring gas analytics job.
 * @param intervalMs How often to run (default: every hour).
 */
export function startGasAnalyticsScheduler(intervalMs = BUCKET_MS.hour): NodeJS.Timeout {
  // Run once immediately, then on interval
  runGasAnalytics().catch((err) => console.error('[gasAnalytics] initial run failed:', err));
  return setInterval(() => {
    runGasAnalytics().catch((err) => console.error('[gasAnalytics] scheduled run failed:', err));
  }, intervalMs);
}
