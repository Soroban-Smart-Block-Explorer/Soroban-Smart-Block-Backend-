import { prismaRead as prisma } from '../db';

export interface SpikeAlert {
  contractAddress: string;
  currentCount: number;
  baseline: number;
  stdDev: number;
  zScore: number;
  windowMinutes: number;
  detectedAt: Date;
}

/**
 * Compute mean and standard deviation from an array of numbers.
 */
function stats(values: number[]): { mean: number; stdDev: number } {
  if (values.length === 0) return { mean: 0, stdDev: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return { mean, stdDev: Math.sqrt(variance) };
}

/**
 * Detect transaction volume spikes per contract.
 *
 * Algorithm:
 *  - Count txs per contract in the current window (last `windowMinutes`).
 *  - Build a historical baseline using `historyWindows` prior windows of the same size.
 *  - Flag a spike when z-score > `zThreshold` (default 3σ).
 *
 * @param windowMinutes  Size of the current observation window (default 5 min).
 * @param historyWindows Number of prior windows used to build the baseline (default 12).
 * @param zThreshold     Z-score threshold to trigger an alert (default 3.0).
 */
export async function detectSpikes(
  windowMinutes = 5,
  historyWindows = 12,
  zThreshold = 3.0,
): Promise<SpikeAlert[]> {
  const now = new Date();
  const windowMs = windowMinutes * 60 * 1000;
  const windowStart = new Date(now.getTime() - windowMs);

  // Current window: count txs per contract
  const currentCounts = await prisma.transaction.groupBy({
    by: ['contractAddress'],
    where: {
      contractAddress: { not: null },
      ledgerCloseTime: { gte: windowStart },
    },
    _count: { id: true },
  });

  if (currentCounts.length === 0) return [];

  const alerts: SpikeAlert[] = [];

  for (const row of currentCounts) {
    const contract = row.contractAddress!;
    const currentCount = row._count.id;

    // Build historical baseline: historyWindows prior windows
    const historicalCounts: number[] = [];
    for (let i = 1; i <= historyWindows; i++) {
      const hEnd = new Date(windowStart.getTime() - (i - 1) * windowMs);
      const hStart = new Date(hEnd.getTime() - windowMs);
      const result = await prisma.transaction.count({
        where: {
          contractAddress: contract,
          ledgerCloseTime: { gte: hStart, lt: hEnd },
        },
      });
      historicalCounts.push(result);
    }

    const { mean, stdDev } = stats(historicalCounts);

    // Avoid division by zero; skip if baseline is flat-zero
    if (stdDev === 0 && mean === 0) continue;

    const effectiveStdDev = stdDev === 0 ? 1 : stdDev;
    const zScore = (currentCount - mean) / effectiveStdDev;

    if (zScore >= zThreshold) {
      alerts.push({
        contractAddress: contract,
        currentCount,
        baseline: mean,
        stdDev,
        zScore,
        windowMinutes,
        detectedAt: now,
      });
    }
  }

  return alerts.sort((a, b) => b.zScore - a.zScore);
}
