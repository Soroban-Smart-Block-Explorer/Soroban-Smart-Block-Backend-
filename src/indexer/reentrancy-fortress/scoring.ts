/**
 * Soroban Reentrancy Fortress — Risk Scoring Engine
 *
 * Computes contract risk scores (0-100) based on detected findings.
 * Methodology: base score from severity × value multiplier × likelihood factor.
 * Issue #307
 */

import {
  type ReentrancyFinding,
  type RiskScore,
  type ContractRiskFactors,
  type ReentrancyType,
  type ReentrancySeverity,
} from './types';

// ── Severity Base Scores ──────────────────────────────────────────────────────

const SEVERITY_BASE: Record<ReentrancySeverity, number> = {
  LOW: 15,
  MEDIUM: 30,
  HIGH: 50,
  CRITICAL: 75,
};

// ── Value Multiplier ──────────────────────────────────────────────────────────

/**
 * Compute value-at-risk multiplier.
 * > $100K = 2x, > $1M = 3x, otherwise 1x
 */
function computeValueMultiplier(usdValueAtRisk?: number): number {
  if (usdValueAtRisk == null || usdValueAtRisk === 0) return 1.0;
  if (usdValueAtRisk >= 1_000_000) return 3.0;
  if (usdValueAtRisk >= 100_000) return 2.0;
  return 1.0;
}

// ── Likelihood Factor ─────────────────────────────────────────────────────────

function computeLikelihoodFactor(likelihood: string): number {
  switch (likelihood) {
    case 'confirmed':
      return 1.0;
    case 'theoretical':
      return 0.5;
    default:
      return 0.5;
  }
}

// ── Individual Finding Score ──────────────────────────────────────────────────

/**
 * Score a single reentrancy finding:
 * base * value_multiplier * likelihood_factor
 */
export function scoreFinding(finding: ReentrancyFinding): number {
  const base = SEVERITY_BASE[finding.severity];
  const valueMult = computeValueMultiplier(finding.usdValueAtRisk);
  const likelihood = computeLikelihoodFactor(finding.likelihood);
  return Math.round(base * valueMult * likelihood);
}

// ── Contract Risk Factors ─────────────────────────────────────────────────────

export function computeRiskFactors(
  findings: ReentrancyFinding[],
  maxCallDepth: number,
): ContractRiskFactors {    const severityCounts: Record<ReentrancySeverity, number> = {
    LOW: 0,
    MEDIUM: 0,
    HIGH: 0,
    CRITICAL: 0,
  };

  const typeCounts: Record<ReentrancyType, number> = {
    SIMPLE: 0,
    CROSS_CONTRACT: 0,
    MULTI_STEP: 0,
    READ_ONLY: 0,
    CROSS_FUNCTION: 0,
    DESTRUCTIVE: 0,
  };

  let totalValueAtRiskUsd = 0;
  let totalCycleLength = 0;
  let confirmedAttackCount = 0;

  const now = Date.now();
  const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
  let findingsInLast30Days = 0;

  for (const f of findings) {
    severityCounts[f.severity]++;
    typeCounts[f.reentrancyType]++;
    totalValueAtRiskUsd += f.usdValueAtRisk ?? 0;
    totalCycleLength += f.loopPath.length;

    if (f.likelihood === 'confirmed') {
      confirmedAttackCount++;
    }

    if (f.detectedAt >= thirtyDaysAgo) {
      findingsInLast30Days++;
    }
  }

  const avgCycleLength = findings.length > 0 ? totalCycleLength / findings.length : 0;

  return {
    totalFindings: findings.length,
    criticalFindings: severityCounts.CRITICAL,
    highFindings: severityCounts.HIGH,
    mediumFindings: severityCounts.MEDIUM,
    simpleReentrancyCount: typeCounts.SIMPLE,
    crossContractCount: typeCounts.CROSS_CONTRACT,
    multiStepCount: typeCounts.MULTI_STEP,
    readOnlyCount: typeCounts.READ_ONLY,
    crossFunctionCount: typeCounts.CROSS_FUNCTION,
    destructiveCount: typeCounts.DESTRUCTIVE,
    avgCycleLength,
    maxCallDepth,
    totalValueAtRiskUsd,
    findingsInLast30Days,
    confirmedAttackCount,
  };
}

// ── Aggregate Risk Score (0-100) ──────────────────────────────────────────────

/**
 * Compute the aggregate contract risk score from all findings.
 * Uses weighted severity scores, capped at 100.
 *
 * Scoring model:
 * - Each critical finding: +25 points
 * - Each high finding: +12 points
 * - Each medium finding: +6 points
 * - Each low finding: +2 points
 * - Confirmed attacks: bonus 15 points each
 * - Value at risk > $1M: +10 bonus
 * - Recent findings (<30 days): +5 bonus
 */
export function computeRiskScore(
  contractAddress: string,
  findings: ReentrancyFinding[],
  previousScore?: number,
  maxCallDepth: number = 0,
): RiskScore {
  const factors = computeRiskFactors(findings, maxCallDepth);

  // Base score from severity-weighted findings
  let rawScore =
    factors.criticalFindings * 25 +
    factors.highFindings * 12 +
    factors.mediumFindings * 6;

  // Confirmed attack bonus
  rawScore += factors.confirmedAttackCount * 15;

  // High value at risk bonus
  if (factors.totalValueAtRiskUsd > 1_000_000) {
    rawScore += 10;
  } else if (factors.totalValueAtRiskUsd > 100_000) {
    rawScore += 5;
  }

  // Recent findings bonus
  if (factors.findingsInLast30Days > 0) {
    rawScore += Math.min(5, factors.findingsInLast30Days);
  }

  // Cap at 100
  const riskScore = Math.min(100, Math.round(rawScore));

  // Determine severity label
  let overallSeverity: ReentrancySeverity;
  if (riskScore >= 75) overallSeverity = 'CRITICAL';
  else if (riskScore >= 50) overallSeverity = 'HIGH';
  else if (riskScore >= 25) overallSeverity = 'MEDIUM';
  else overallSeverity = 'LOW';

  return {
    contractAddress,
    riskScore,
    previousScore,
    totalFindings: factors.totalFindings,
    criticalFindings: factors.criticalFindings,
    highFindings: factors.highFindings,
    mediumFindings: factors.mediumFindings,
    riskFactors: factors,
    lastAnalyzed: new Date(),
    severity: overallSeverity,
  };
}

/**
 * Determine risk level label from score.
 */
export function getRiskLevel(
  score: number,
): 'safe' | 'low_risk' | 'medium_risk' | 'high_risk' | 'critical' {
  if (score >= 75) return 'critical';
  if (score >= 50) return 'high_risk';
  if (score >= 25) return 'medium_risk';
  if (score > 0) return 'low_risk';
  return 'safe';
}
