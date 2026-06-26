import { prismaRead as prisma } from '../db';

const MEMORY_THRESHOLD_PCT = 85; // Warn at 85% of max
const MAX_MEMORY_BYTES = 100 * 1024 * 1024; // 100 MB network limit

/**
 * Record resource usage for a contract transaction.
 */
export async function recordContractResources(
  contractAddress: string,
  transactionHash: string,
  ledgerSequence: number,
  ledgerCloseTime: Date,
  memoryUsageBytes: number,
  cpuInstructions: number,
  storageFootprint: number,
): Promise<void> {
  const { prismaWrite } = await import('../db');
  await prismaWrite.contractResourceMetric.upsert({
    where: { contractAddress_transactionHash: { contractAddress, transactionHash } },
    update: {},
    create: {
      contractAddress,
      transactionHash,
      ledgerSequence,
      ledgerCloseTime,
      memoryUsageBytes,
      cpuInstructions,
      storageFootprint,
    },
  });
}

/**
 * Analyze contract resource trajectory and detect memory leak patterns.
 * Returns warning if memory usage is climbing toward network limits.
 */
export async function analyzeResourceTrend(contractAddress: string): Promise<{
  trend: 'stable' | 'climbing' | 'critical';
  currentUsageBytes: number;
  usagePct: number;
  recentTxCount: number;
  avgMemoryGrowthPerTx: number;
  warning?: string;
}> {
  const recentMetrics = await prisma.contractResourceMetric.findMany({
    where: { contractAddress },
    orderBy: { ledgerSequence: 'desc' },
    take: 20,
  });

  if (recentMetrics.length < 2) {
    return {
      trend: 'stable',
      currentUsageBytes: recentMetrics[0]?.memoryUsageBytes ?? 0,
      usagePct: 0,
      recentTxCount: recentMetrics.length,
      avgMemoryGrowthPerTx: 0,
    };
  }

  const current = recentMetrics[0].memoryUsageBytes;
  const oldest = recentMetrics[recentMetrics.length - 1].memoryUsageBytes;
  const growth = current - oldest;
  const avgGrowth = growth / (recentMetrics.length - 1);
  const usagePct = (current / MAX_MEMORY_BYTES) * 100;

  let trend: 'stable' | 'climbing' | 'critical' = 'stable';
  let warning: string | undefined;

  if (usagePct > 95) {
    trend = 'critical';
    warning = `CRITICAL: Contract memory at ${usagePct.toFixed(1)}% of network limit`;
  } else if (usagePct > MEMORY_THRESHOLD_PCT && avgGrowth > 0) {
    trend = 'climbing';
    warning = `WARNING: Contract memory at ${usagePct.toFixed(1)}% and growing ${avgGrowth.toFixed(0)} bytes/tx`;
  }

  return {
    trend,
    currentUsageBytes: current,
    usagePct,
    recentTxCount: recentMetrics.length,
    avgMemoryGrowthPerTx: avgGrowth,
    warning,
  };
}
