import { prisma } from '../db';
import { Severity, SEVERITY_MULTIPLIER } from './severity';

export interface PropagationResult {
  vulnerableContract: string;
  directAffected: string[];
  affectedByDepth: Record<string, string[]>;
  analysisDepth: number;
}

export interface PersistPropagationInput {
  advisoryId: string;
  result: PropagationResult;
}

export async function loadAffectedPoolsTvl(addresses: string[]): Promise<number[]> {
  if (addresses.length === 0) return [];

  const pools = await prisma.dexPool.findMany({
    where: { address: { in: addresses } },
    select: { tvlUsd: true },
  });

  return pools.map((p) => Number(p.tvlUsd));
}

function computeTotalValueAtRisk(
  severity: string,
  tvlValues: number[],
  affectedCount: number,
): number {
  const multiplier = SEVERITY_MULTIPLIER[severity as Severity] ?? 0;
  if (tvlValues.length === 0) {
    return affectedCount * multiplier;
  }
  const avgTvl = tvlValues.reduce((a, b) => a + b, 0) / tvlValues.length;
  return affectedCount * multiplier * avgTvl;
}

export async function persistPropagation(
  input: PersistPropagationInput,
): Promise<void> {
  const advisory = await prisma.vulnerabilityAdvisory.findUnique({
    where: { id: input.advisoryId },
    select: { severity: true },
  });

  if (!advisory) {
    throw new Error(`Advisory ${input.advisoryId} not found`);
  }

  const allAffected = input.result.directAffected.concat(
    ...Object.values(input.result.affectedByDepth).flat(),
  );

  const tvlPerAffected = await loadAffectedPoolsTvl(allAffected);
  const totalValueAtRisk = computeTotalValueAtRisk(
    advisory.severity,
    tvlPerAffected,
    input.result.directAffected.length,
  );

  await prisma.propagationAnalysis.create({
    data: {
      advisoryId: input.advisoryId,
      vulnerableContract: input.result.vulnerableContract,
      directAffected: input.result.directAffected,
      affectedByDepth: input.result.affectedByDepth,
      totalValueAtRisk,
      analysisDepth: input.result.analysisDepth,
    },
  });
}
