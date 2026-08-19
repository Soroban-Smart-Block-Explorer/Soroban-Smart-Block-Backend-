export interface ReputationInputs {
  challengesPassed: number;
  challengesFailed: number;
  /** 0-1, fraction of expected heartbeat windows the peer was seen in. */
  uptimeRatio: number;
  latencyMsEwma: number | null;
}

const LATENCY_FLOOR_MS = 50; // at/below this, latency score is 1
const LATENCY_CEIL_MS = 2000; // at/above this, latency score is 0

function latencyScore(latencyMsEwma: number | null): number {
  if (latencyMsEwma === null) return 0.5; // no data yet — neutral
  if (latencyMsEwma <= LATENCY_FLOOR_MS) return 1;
  if (latencyMsEwma >= LATENCY_CEIL_MS) return 0;
  return 1 - (latencyMsEwma - LATENCY_FLOOR_MS) / (LATENCY_CEIL_MS - LATENCY_FLOOR_MS);
}

/**
 * v1 reputation formula — simple and auditable by design (see
 * docs/P2P_INDEXER_DESIGN.md §4): weighted blend of challenge pass rate,
 * observed uptime, and query latency. This is a LOCAL, per-node opinion —
 * never globally agreed — so it only needs to be good enough to bias local
 * decisions (which replica to query first, which peers to prefer as
 * tiebreakers), not to be tamper-proof against a single reporter.
 */
export function computeReputationScore(inputs: ReputationInputs): number {
  const { challengesPassed, challengesFailed, uptimeRatio, latencyMsEwma } = inputs;
  const totalChallenges = challengesPassed + challengesFailed;
  const passRate = totalChallenges === 0 ? 1 : challengesPassed / totalChallenges;
  const uptime = Math.min(1, Math.max(0, uptimeRatio));
  const latency = latencyScore(latencyMsEwma);

  const score = 100 * (0.5 * passRate + 0.3 * uptime + 0.2 * latency);
  return Math.min(100, Math.max(0, score));
}

/**
 * Blend a remotely-gossiped opinion about a peer into our own running
 * average, decay-weighted so no single reporter can unilaterally swing a
 * score (basic Sybil resistance for the gossiped-reputation channel).
 */
export function blendReportedScore(
  localScore: number,
  reportedScore: number,
  reportWeight = 0.1,
): number {
  const w = Math.min(1, Math.max(0, reportWeight));
  return localScore * (1 - w) + reportedScore * w;
}
