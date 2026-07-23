/**
 * Protocol 26 State Extension Analytical Engine
 *
 * Parses and analyzes the updated state extension functions:
 * - extend_to: Sets the exact ledger sequence to extend state to
 * - min_extension: Minimum ledger extension allowed
 * - max_extension: Maximum ledger extension allowed
 *
 * Tracks how tightly contracts clamp their state extension limits against
 * maximum network parameters, providing insights into rent top-up equity.
 */

import { xdr, scValToNative } from '@stellar/stellar-sdk';
import { prismaRead as prisma } from '../db';

export interface StateExtensionParams {
  extend_to?: bigint;
  min_extension?: bigint;
  max_extension?: bigint;
}

export interface StateExtensionAnalysis {
  contractAddress: string;
  transactionHash: string;
  ledgerSequence: number;
  ledgerCloseTime: Date;

  // Raw parameters extracted from the function call
  params: StateExtensionParams;

  // Derived metrics
  extensionRange: {
    min: bigint;
    max: bigint;
    spread: bigint;
    spreadPercent: number;
  };

  // Clamping analysis against network parameters
  clampingAnalysis: {
    networkMaxExtension: bigint;
    contractMaxExtension: bigint;
    clampingRatio: number; // contractMax / networkMax
    isClamped: boolean;
    clampingTightness: 'loose' | 'moderate' | 'tight' | 'extreme';
  };

  // Equity analysis
  equityMetrics: {
    rentTopUpAmount: bigint;
    topUpPerLedger: number;
    fairnessScore: number; // 0-100, higher = more equitable
    complianceStatus: 'compliant' | 'warning' | 'violation';
  };

  // Historical context
  historicalContext: {
    previousExtensionLedger?: number;
    extensionFrequency: 'frequent' | 'moderate' | 'rare';
    averageExtensionSize?: string;
  };
}

export interface StateExtensionMetrics {
  totalExtensionCalls: number;
  contractsUsingExtension: number;
  averageClampingRatio: number;
  tightClampingCount: number;
  violationCount: number;
  equityScoreDistribution: {
    excellent: number; // 80-100
    good: number; // 60-79
    fair: number; // 40-59
    poor: number; // 20-39
    critical: number; // 0-19
  };
}

// Network parameters for Protocol 26 (configurable)
const PROTOCOL_26_PARAMS = {
  MAX_EXTENSION_LEDGERS: BigInt(315360000), // ~10 years in ledgers
  MIN_EXTENSION_LEDGERS: BigInt(1),
  FAIR_EXTENSION_THRESHOLD: BigInt(52560000), // ~1.67 years
  EQUITY_CHECK_INTERVAL: 100, // check every N ledgers
};

/**
 * Extract state extension parameters from a contract function call.
 * Handles extend_to, min_extension, and max_extension functions.
 */
export function extractStateExtensionParams(
  functionName: string,
  rawArgs: xdr.ScVal[],
): StateExtensionParams | null {
  if (!['extend_to', 'min_extension', 'max_extension'].includes(functionName)) {
    return null;
  }

  const params: StateExtensionParams = {};

  try {
    // extend_to(ledger_seq: u32) → sets exact extension target
    if (functionName === 'extend_to' && rawArgs.length >= 1) {
      const val = scValToNative(rawArgs[0]);
      params.extend_to = BigInt(val as number | string);
    }

    // min_extension(ledgers: u32) → minimum extension allowed
    if (functionName === 'min_extension' && rawArgs.length >= 1) {
      const val = scValToNative(rawArgs[0]);
      params.min_extension = BigInt(val as number | string);
    }

    // max_extension(ledgers: u32) → maximum extension allowed
    if (functionName === 'max_extension' && rawArgs.length >= 1) {
      const val = scValToNative(rawArgs[0]);
      params.max_extension = BigInt(val as number | string);
    }

    return Object.keys(params).length > 0 ? params : null;
  } catch {
    return null;
  }
}

/**
 * Analyze extension range: min_extension to max_extension spread.
 */
function analyzeExtensionRange(params: StateExtensionParams): {
  min: bigint;
  max: bigint;
  spread: bigint;
  spreadPercent: number;
} {
  const min = params.min_extension ?? BigInt(0);
  const max = params.max_extension ?? PROTOCOL_26_PARAMS.MAX_EXTENSION_LEDGERS;
  const spread = max - min;
  const spreadPercent = max > 0 ? Number((spread * BigInt(100)) / max) : 0;

  return { min, max, spread, spreadPercent };
}

/**
 * Analyze how tightly the contract clamps against network max.
 */
function analyzeClampingBehavior(
  params: StateExtensionParams,
  networkMax: bigint = PROTOCOL_26_PARAMS.MAX_EXTENSION_LEDGERS,
): {
  networkMaxExtension: bigint;
  contractMaxExtension: bigint;
  clampingRatio: number;
  isClamped: boolean;
  clampingTightness: 'loose' | 'moderate' | 'tight' | 'extreme';
} {
  const contractMax = params.max_extension ?? networkMax;
  const isClamped = contractMax < networkMax;
  const clampingRatio = Number((contractMax * BigInt(100)) / networkMax) / 100;

  let clampingTightness: 'loose' | 'moderate' | 'tight' | 'extreme';
  if (!isClamped) {
    clampingTightness = 'loose';
  } else if (clampingRatio > 0.75) {
    clampingTightness = 'moderate';
  } else if (clampingRatio > 0.25) {
    clampingTightness = 'tight';
  } else {
    clampingTightness = 'extreme';
  }

  return {
    networkMaxExtension: networkMax,
    contractMaxExtension: contractMax,
    clampingRatio,
    isClamped,
    clampingTightness,
  };
}

/**
 * Calculate equity metrics: fairness of rent top-ups.
 */
function calculateEquityMetrics(
  params: StateExtensionParams,
  ledgerSequence: number,
): {
  rentTopUpAmount: bigint;
  topUpPerLedger: number;
  fairnessScore: number;
  complianceStatus: 'compliant' | 'warning' | 'violation';
} {
  const extend_to = params.extend_to ?? BigInt(ledgerSequence);
  const max_ext = params.max_extension ?? PROTOCOL_26_PARAMS.MAX_EXTENSION_LEDGERS;

  // Rent top-up is the extension amount
  const rentTopUpAmount = extend_to - BigInt(ledgerSequence);

  // Top-up per ledger (normalized)
  const topUpPerLedger = rentTopUpAmount > 0 ? Number(rentTopUpAmount) / Number(max_ext) : 0;

  // Fairness score: how close to the fair threshold
  const fairThreshold = PROTOCOL_26_PARAMS.FAIR_EXTENSION_THRESHOLD;
  let fairnessScore = 0;

  if (rentTopUpAmount >= fairThreshold) {
    fairnessScore = 100; // Excellent: extends well beyond fair threshold
  } else if (rentTopUpAmount >= fairThreshold / BigInt(2)) {
    fairnessScore = 75; // Good: extends to half the fair threshold
  } else if (rentTopUpAmount >= fairThreshold / BigInt(4)) {
    fairnessScore = 50; // Fair: extends to quarter threshold
  } else if (rentTopUpAmount > BigInt(0)) {
    fairnessScore = 25; // Poor: minimal extension
  } else {
    fairnessScore = 0; // Critical: no extension
  }

  // Compliance status based on clamping and fairness
  let complianceStatus: 'compliant' | 'warning' | 'violation';
  if (fairnessScore >= 75 && max_ext >= fairThreshold / BigInt(2)) {
    complianceStatus = 'compliant';
  } else if (fairnessScore >= 50 || max_ext >= fairThreshold / BigInt(4)) {
    complianceStatus = 'warning';
  } else {
    complianceStatus = 'violation';
  }

  return {
    rentTopUpAmount,
    topUpPerLedger,
    fairnessScore,
    complianceStatus,
  };
}

/**
 * Analyze historical extension patterns for a contract.
 */
async function analyzeHistoricalContext(
  contractAddress: string,
  currentLedger: number,
): Promise<{
  previousExtensionLedger?: number;
  extensionFrequency: 'frequent' | 'moderate' | 'rare';
  averageExtensionSize?: string;
}> {
  try {
    // Query recent extension transactions for this contract
    const recentExtensions = await prisma.transaction.findMany({
      where: {
        contractAddress,
        functionName: { in: ['extend_to', 'min_extension', 'max_extension'] },
        ledgerSequence: { gte: currentLedger - 1000000 }, // Last ~3 months
      },
      orderBy: { ledgerSequence: 'desc' },
      take: 10,
      select: { ledgerSequence: true, functionArgs: true },
    });

    if (recentExtensions.length === 0) {
      return {
        extensionFrequency: 'rare',
      };
    }

    const previousExtensionLedger = recentExtensions[0]?.ledgerSequence;

    // Calculate average extension size
    let totalExtension = BigInt(0);
    let validCount = 0;

    for (const tx of recentExtensions) {
      if (tx.functionArgs && typeof tx.functionArgs === 'object') {
        const args = tx.functionArgs as Record<string, unknown>;
        const extend_to = args.extend_to;
        if (extend_to) {
          totalExtension += BigInt(extend_to as string | number) - BigInt(tx.ledgerSequence);
          validCount++;
        }
      }
    }

    const averageExtensionSize =
      validCount > 0 ? (totalExtension / BigInt(validCount)).toString() : undefined;

    // Determine frequency based on gap between extensions
    const ledgerGap = currentLedger - (previousExtensionLedger ?? currentLedger);
    let extensionFrequency: 'frequent' | 'moderate' | 'rare';

    if (ledgerGap < 100000) {
      extensionFrequency = 'frequent'; // < ~1 month
    } else if (ledgerGap < 500000) {
      extensionFrequency = 'moderate'; // < ~5 months
    } else {
      extensionFrequency = 'rare';
    }

    return {
      previousExtensionLedger,
      extensionFrequency,
      averageExtensionSize,
    };
  } catch {
    return { extensionFrequency: 'rare' };
  }
}

/**
 * Perform comprehensive analysis of a state extension transaction.
 */
export async function analyzeStateExtension(
  contractAddress: string,
  transactionHash: string,
  functionName: string,
  rawArgs: xdr.ScVal[],
  ledgerSequence: number,
  ledgerCloseTime: Date,
): Promise<StateExtensionAnalysis | null> {
  const startMs = Date.now();
  try {
    const params = extractStateExtensionParams(functionName, rawArgs);
    if (!params) return null;

    const extensionRange = analyzeExtensionRange(params);
    const clampingAnalysis = analyzeClampingBehavior(params);
    const equityMetrics = calculateEquityMetrics(params, ledgerSequence);
    const historicalContext = await analyzeHistoricalContext(contractAddress, ledgerSequence);

    const durationMs = Date.now() - startMs;
    if (durationMs > 500) {
      console.warn(
        '[analyzeStateExtension] slow execution: %dms for %s',
        durationMs,
        contractAddress,
      );
    }

    return {
      contractAddress,
      transactionHash,
      ledgerSequence,
      ledgerCloseTime,
      params,
      extensionRange,
      clampingAnalysis,
      equityMetrics,
      historicalContext,
    };
  } catch (error) {
    console.error(
      '[analyzeStateExtension] error after %dms for %s:',
      Date.now() - startMs,
      contractAddress,
      error,
    );
    return null;
  }
}

/**
 * Store analysis results in the database.
 */
export async function storeStateExtensionAnalysis(analysis: StateExtensionAnalysis): Promise<void> {
  try {
    // Create or update a record in a new table (to be added to schema)
    // For now, we'll store in the Transaction's functionArgs as enriched metadata
    await prisma.transaction.update({
      where: { hash: analysis.transactionHash },
      data: {
        functionArgs: JSON.parse(
          JSON.stringify({
            ...analysis.params,
            _analysis: {
              extensionRange: {
                min: analysis.extensionRange.min.toString(),
                max: analysis.extensionRange.max.toString(),
                spread: analysis.extensionRange.spread.toString(),
                spreadPercent: analysis.extensionRange.spreadPercent,
              },
              clampingAnalysis: {
                networkMaxExtension: analysis.clampingAnalysis.networkMaxExtension.toString(),
                contractMaxExtension: analysis.clampingAnalysis.contractMaxExtension.toString(),
                clampingRatio: analysis.clampingAnalysis.clampingRatio,
                isClamped: analysis.clampingAnalysis.isClamped,
                clampingTightness: analysis.clampingAnalysis.clampingTightness,
              },
              equityMetrics: {
                rentTopUpAmount: analysis.equityMetrics.rentTopUpAmount.toString(),
                topUpPerLedger: analysis.equityMetrics.topUpPerLedger,
                fairnessScore: analysis.equityMetrics.fairnessScore,
                complianceStatus: analysis.equityMetrics.complianceStatus,
              },
              historicalContext: analysis.historicalContext,
            },
          }),
        ),
      },
    });
  } catch (error) {
    console.error('Failed to store state extension analysis:', error);
  }
}

/**
 * Generate aggregate metrics across all contracts.
 */
export async function generateStateExtensionMetrics(
  ledgerRangeStart: number,
  ledgerRangeEnd: number,
): Promise<StateExtensionMetrics> {
  try {
    const extensions = await prisma.transaction.findMany({
      where: {
        functionName: { in: ['extend_to', 'min_extension', 'max_extension'] },
        ledgerSequence: { gte: ledgerRangeStart, lte: ledgerRangeEnd },
      },
      select: {
        contractAddress: true,
        functionArgs: true,
      },
    });

    const uniqueContracts = new Set(extensions.map((e) => e.contractAddress).filter(Boolean));
    const equityScores: number[] = [];
    let tightClampingCount = 0;
    let violationCount = 0;

    for (const ext of extensions) {
      if (ext.functionArgs && typeof ext.functionArgs === 'object') {
        const args = ext.functionArgs as Record<string, unknown>;
        const analysis = args._analysis as Record<string, unknown> | undefined;

        if (analysis?.equityMetrics) {
          const metrics = analysis.equityMetrics as Record<string, unknown>;
          const score = metrics.fairnessScore as number;
          equityScores.push(score);

          if (metrics.complianceStatus === 'violation') {
            violationCount++;
          }
        }

        if (analysis?.clampingAnalysis) {
          const clamping = analysis.clampingAnalysis as Record<string, unknown>;
          if (clamping.clampingTightness === 'tight' || clamping.clampingTightness === 'extreme') {
            tightClampingCount++;
          }
        }
      }
    }

    // Calculate equity score distribution
    const distribution = {
      excellent: equityScores.filter((s) => s >= 80).length,
      good: equityScores.filter((s) => s >= 60 && s < 80).length,
      fair: equityScores.filter((s) => s >= 40 && s < 60).length,
      poor: equityScores.filter((s) => s >= 20 && s < 40).length,
      critical: equityScores.filter((s) => s < 20).length,
    };

    const averageClampingRatio =
      extensions.length > 0
        ? extensions.reduce((sum, ext) => {
            if (ext.functionArgs && typeof ext.functionArgs === 'object') {
              const args = ext.functionArgs as Record<string, unknown>;
              const analysis = args._analysis as Record<string, unknown> | undefined;
              if (analysis?.clampingAnalysis) {
                const clamping = analysis.clampingAnalysis as Record<string, unknown>;
                return sum + (clamping.clampingRatio as number);
              }
            }
            return sum;
          }, 0) / extensions.length
        : 0;

    return {
      totalExtensionCalls: extensions.length,
      contractsUsingExtension: uniqueContracts.size,
      averageClampingRatio,
      tightClampingCount,
      violationCount,
      equityScoreDistribution: distribution,
    };
  } catch (error) {
    console.error('Failed to generate state extension metrics:', error);
    return {
      totalExtensionCalls: 0,
      contractsUsingExtension: 0,
      averageClampingRatio: 0,
      tightClampingCount: 0,
      violationCount: 0,
      equityScoreDistribution: {
        excellent: 0,
        good: 0,
        fair: 0,
        poor: 0,
        critical: 0,
      },
    };
  }
}

/**
 * Identify contracts with concerning extension patterns.
 */
export async function identifyProblematicContracts(
  threshold: 'tight' | 'extreme' = 'extreme',
): Promise<
  Array<{
    contractAddress: string;
    violationCount: number;
    averageFairnessScore: number;
    clampingTightness: string;
  }>
> {
  try {
    const problematic = await prisma.transaction.groupBy({
      by: ['contractAddress'],
      where: {
        functionName: { in: ['extend_to', 'min_extension', 'max_extension'] },
      },
      _count: true,
    });

    const results = [];

    for (const item of problematic) {
      if (!item.contractAddress) continue;

      const txs = await prisma.transaction.findMany({
        where: { contractAddress: item.contractAddress },
        select: { functionArgs: true },
        take: 100,
      });

      let violationCount = 0;
      let totalScore = 0;
      let scoreCount = 0;
      let tightestClamping = 'loose';

      for (const tx of txs) {
        if (tx.functionArgs && typeof tx.functionArgs === 'object') {
          const args = tx.functionArgs as Record<string, unknown>;
          const analysis = args._analysis as Record<string, unknown> | undefined;

          if (analysis?.equityMetrics) {
            const metrics = analysis.equityMetrics as Record<string, unknown>;
            if (metrics.complianceStatus === 'violation') {
              violationCount++;
            }
            totalScore += (metrics.fairnessScore as number) || 0;
            scoreCount++;
          }

          if (analysis?.clampingAnalysis) {
            const clamping = analysis.clampingAnalysis as Record<string, unknown>;
            const tightness = clamping.clampingTightness as string;
            if (
              (threshold === 'extreme' && tightness === 'extreme') ||
              (threshold === 'tight' && (tightness === 'tight' || tightness === 'extreme'))
            ) {
              tightestClamping = tightness;
            }
          }
        }
      }

      if (violationCount > 0 || tightestClamping !== 'loose') {
        results.push({
          contractAddress: item.contractAddress,
          violationCount,
          averageFairnessScore: scoreCount > 0 ? totalScore / scoreCount : 0,
          clampingTightness: tightestClamping,
        });
      }
    }

    return results.sort((a, b) => b.violationCount - a.violationCount);
  } catch (error) {
    console.error('Failed to identify problematic contracts:', error);
    return [];
  }
}
