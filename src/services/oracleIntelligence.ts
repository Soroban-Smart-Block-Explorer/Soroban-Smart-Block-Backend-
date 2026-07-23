export type OracleKind = 'builtin' | 'custom' | 'bridge';

export interface OracleContractProfile {
  address?: string;
  name?: string;
  functionSignatures?: Array<{ name?: string } | string>;
  abi?: unknown;
}

export interface OracleSamplePoint {
  price: number;
  timestamp: number;
  deviationPct?: number;
}

export interface OracleReliabilityMetrics {
  updateFrequencyMs?: number;
  uptimePct?: number;
  latencyMs?: number;
  decentralizationScore?: number;
  historicalAccuracyPct?: number;
}

export interface OracleClassification {
  kind: OracleKind;
  name: string;
  evidence: string[];
}

export interface OracleReliabilityScore {
  compositeScore: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  breakdown: {
    freshness: number;
    uptime: number;
    latency: number;
    decentralization: number;
    accuracy: number;
  };
}

const ORACLE_NAME_HINTS = [/price/i, /oracle/i, /feed/i, /aggregat/i];
const BRIDGE_HINTS = [/bridge/i, /wormhole/i, /layerzero/i, /axelar/i];

export function classifyOracleContract(profile: OracleContractProfile): OracleClassification {
  const text = [profile.name, profile.address, profile.abi ? JSON.stringify(profile.abi) : '']
    .filter(Boolean)
    .join(' ');
  const evidence: string[] = [];

  if (profile.address && /CAAAAAAAAA.../.test(profile.address)) {
    evidence.push('Known built-in oracle address pattern');
  }

  const signatureNames = (profile.functionSignatures ?? [])
    .map((entry) => (typeof entry === 'string' ? entry : (entry.name ?? '')))
    .filter(Boolean)
    .join(' ');

  if (BRIDGE_HINTS.some((pattern) => pattern.test(text))) {
    return {
      kind: 'bridge',
      name: profile.name ?? 'bridge-oracle',
      evidence: [...evidence, 'Bridge-style oracle indicators found'],
    };
  }

  if (
    ORACLE_NAME_HINTS.some((pattern) => pattern.test(text)) ||
    /set_price|update_price|get_price|submit/i.test(signatureNames)
  ) {
    if (profile.address && /chainlink|band|pyth/i.test(text)) {
      evidence.push('Known oracle provider naming');
    }
    return {
      kind: 'builtin',
      name: profile.name ?? 'oracle',
      evidence: [...evidence, 'Oracle function signatures detected'],
    };
  }

  return {
    kind: 'custom',
    name: profile.name ?? 'custom-oracle',
    evidence: [...evidence, 'Custom contract pattern without known provider hints'],
  };
}

export function scoreOracleReliability(
  samples: OracleSamplePoint[],
  metrics: OracleReliabilityMetrics,
): OracleReliabilityScore {
  const latest = samples[samples.length - 1];
  const freshnessScore = latest && latest.timestamp > Date.now() - 60_000 ? 1 : 0.7;
  const uptimeScore = Math.max(0, Math.min(1, (metrics.uptimePct ?? 95) / 100));
  const latencyScore = Math.max(0, Math.min(1, 1 - (metrics.latencyMs ?? 250) / 1000));
  const decentralizationScore = Math.max(0, Math.min(1, metrics.decentralizationScore ?? 0.5));
  const accuracyScore = Math.max(0, Math.min(1, (metrics.historicalAccuracyPct ?? 95) / 100));

  const avgDeviation =
    samples.reduce((sum, sample) => sum + (sample.deviationPct ?? 0), 0) /
    Math.max(1, samples.length);
  const accuracyAdjusted = Math.max(0, Math.min(1, accuracyScore - avgDeviation / 100));

  const compositeScore = Number(
    (
      freshnessScore * 0.25 +
      uptimeScore * 0.2 +
      latencyScore * 0.15 +
      decentralizationScore * 0.2 +
      accuracyAdjusted * 0.2
    ).toFixed(3),
  );

  let grade: OracleReliabilityScore['grade'] = 'F';
  if (compositeScore >= 0.9) grade = 'A';
  else if (compositeScore >= 0.8) grade = 'B';
  else if (compositeScore >= 0.7) grade = 'C';
  else if (compositeScore >= 0.6) grade = 'D';

  return {
    compositeScore,
    grade,
    breakdown: {
      freshness: Number(freshnessScore.toFixed(3)),
      uptime: Number(uptimeScore.toFixed(3)),
      latency: Number(latencyScore.toFixed(3)),
      decentralization: Number(decentralizationScore.toFixed(3)),
      accuracy: Number(accuracyAdjusted.toFixed(3)),
    },
  };
}

export function detectOracleManipulation(
  samples: OracleSamplePoint[],
): Array<{ severity: string; reason: string }> {
  if (samples.length < 3) return [];

  const prices = samples.map((sample) => sample.price);
  const max = Math.max(...prices);
  const min = Math.min(...prices);
  const jump = max > 0 ? (max - min) / min : 0;
  const findings: Array<{ severity: string; reason: string }> = [];

  if (jump > 5) {
    findings.push({
      severity: 'high',
      reason: 'Price jumped sharply relative to the prior baseline',
    });
  }

  if (samples.some((sample) => (sample.deviationPct ?? 0) > 5)) {
    findings.push({ severity: 'medium', reason: 'Deviation exceeded the 5% alert threshold' });
  }

  return findings;
}
