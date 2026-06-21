import { prismaRead, prismaWrite } from '../db';
import { classifyRisk } from './emergency-indexer';
import { logger } from '../logger';

const WINDOW_30D = 30 * 86400_000;
const WINDOW_90D = 90 * 86400_000;

/** Compute and upsert health score for one contract */
export async function computeHealthScore(contractAddress: string): Promise<void> {
  const now = Date.now();
  const since30d = new Date(now - WINDOW_30D);
  const since90d = new Date(now - WINDOW_90D);

  const [pauses30d, pauses90d, recovery, pauserAnalysis, incidents, contract] = await Promise.all([
    prismaRead.pauseEvent.findMany({
      where: { contractAddress, eventType: 'pause', timestamp: { gte: since30d } },
      select: { timestamp: true, durationSeconds: true },
    }),
    prismaRead.pauseEvent.count({
      where: { contractAddress, eventType: 'pause', timestamp: { gte: since90d } },
    }),
    prismaRead.recoveryAnalysis.findUnique({ where: { contractAddress } }),
    prismaRead.pauserAnalysis.findUnique({ where: { contractAddress } }),
    prismaRead.incidentReport.findMany({
      where: { contractAddress },
      select: { severity: true, description: true },
    }),
    prismaRead.contract.findUnique({ where: { address: contractAddress }, select: { name: true } }),
  ]);

  const totalDowntime30d = pauses30d.reduce((sum, p) => sum + Number(p.durationSeconds ?? 0), 0);
  const avgPauseDuration30d = pauses30d.length
    ? Math.round(totalDowntime30d / pauses30d.length)
    : null;
  const lastPauseDate = pauses30d[0]?.timestamp ?? null;

  // Reliability (40%): fewer pauses = higher score
  const reliabilityScore = Math.max(0, 100 - pauses30d.length * 10);

  // Recovery Preparedness (30%)
  const recovScore = Number(recovery?.recoveryRobustnessScore ?? 0);

  // Decentralization (20%)
  let decScore = 0;
  if (pauserAnalysis) {
    const days = pauserAnalysis.timelockDelaySeconds
      ? Number(pauserAnalysis.timelockDelaySeconds) / 86400
      : undefined;
    const { computeDecentralizationScore } = await import('./emergency-indexer');
    decScore = computeDecentralizationScore(
      pauserAnalysis.pauserType,
      pauserAnalysis.threshold ?? undefined,
      pauserAnalysis.totalSigners ?? undefined,
      days,
    );
  }

  // Transparency (10%): incidents with descriptions = transparent
  const transparencyScore =
    incidents.length > 0
      ? Math.round((incidents.filter((i) => i.description).length / incidents.length) * 100)
      : 50;

  const healthScore = Math.round(
    reliabilityScore * 0.4 + recovScore * 0.3 + decScore * 0.2 + transparencyScore * 0.1,
  );

  await prismaWrite.protocolHealthScore.upsert({
    where: { contractAddress },
    create: {
      contractAddress,
      protocolName: contract?.name ?? null,
      totalPauses30d: pauses30d.length,
      totalPauses90d: pauses90d,
      avgPauseDuration30d,
      totalDowntime30d,
      lastPauseDate,
      recoveryScore: recovScore,
      decentralizationScore: decScore,
      healthScore,
      riskLevel: classifyRisk(healthScore),
      computedAt: new Date(),
    },
    update: {
      protocolName: contract?.name ?? null,
      totalPauses30d: pauses30d.length,
      totalPauses90d: pauses90d,
      avgPauseDuration30d,
      totalDowntime30d,
      lastPauseDate,
      recoveryScore: recovScore,
      decentralizationScore: decScore,
      healthScore,
      riskLevel: classifyRisk(healthScore),
      computedAt: new Date(),
    },
  });
}

/** Recompute health for all tracked contracts */
export async function refreshAllHealthScores(): Promise<void> {
  const contracts = await prismaRead.emergencyState.findMany({
    select: { contractAddress: true },
  });
  for (const { contractAddress } of contracts) {
    await computeHealthScore(contractAddress).catch((err) =>
      logger.warn('Health score computation failed', { contractAddress, error: String(err) }),
    );
  }
}

export async function startHealthScoreScheduler(): Promise<void> {
  const INTERVAL_MS = 5 * 60_000; // every 5 min
  await refreshAllHealthScores();
  setInterval(refreshAllHealthScores, INTERVAL_MS);
  logger.info('Health score scheduler started');
}
