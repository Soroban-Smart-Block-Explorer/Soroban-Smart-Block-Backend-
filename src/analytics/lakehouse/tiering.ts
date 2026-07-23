/**
 * Layer 3 — Tiered Data Lifecycle (Issue #551)
 *
 * Classifies every data partition into one of three tiers and decides when to
 * promote or demote it. Age is the baseline signal; access frequency overrides
 * it so that a "cold" partition under active query load is kept warm.
 *
 *   hot   → PostgreSQL       (default: age ≤ 7 days)
 *   warm  → ClickHouse OLAP  (default: 7 < age ≤ 90 days)
 *   cold  → S3 Iceberg       (default: age > 90 days, retained forever)
 *
 * Promotion (cold→warm / warm→hot) is triggered when recent access exceeds a
 * threshold; demotion follows the age policy once access falls quiet. The
 * planner in `federated-query.ts` reads a partition's current tier to route
 * subqueries to the right engine.
 */

export type Tier = 'hot' | 'warm' | 'cold';

export interface TierPolicy {
  hotMaxAgeDays: number;
  warmMaxAgeDays: number;
  /** Accesses in the trailing window that force a promotion. */
  promoteAccessThreshold: number;
  /** Trailing window for access counting, in ms. */
  accessWindowMs: number;
  dayMs: number;
}

export const DEFAULT_TIER_POLICY: TierPolicy = {
  hotMaxAgeDays: 7,
  warmMaxAgeDays: 90,
  promoteAccessThreshold: 25,
  accessWindowMs: 24 * 60 * 60 * 1000,
  dayMs: 24 * 60 * 60 * 1000,
};

export interface PartitionMeta {
  /** Stable id, e.g. `txn_events/2026-05`. */
  id: string;
  /** Age reference — the newest event time in the partition (ms). */
  newestEventTime: number;
  currentTier: Tier;
  /** Access timestamps (ms) within the trailing window. */
  recentAccesses: number[];
  rowCount: number;
  sizeBytes: number;
}

export interface TierDecision {
  partitionId: string;
  from: Tier;
  to: Tier;
  action: 'promote' | 'demote' | 'noop';
  reason: string;
}

/** Baseline tier implied purely by age. */
export function tierByAge(ageDays: number, policy: TierPolicy): Tier {
  if (ageDays <= policy.hotMaxAgeDays) return 'hot';
  if (ageDays <= policy.warmMaxAgeDays) return 'warm';
  return 'cold';
}

const RANK: Record<Tier, number> = { cold: 0, warm: 1, hot: 2 };

function warmerBy(tier: Tier, steps: number): Tier {
  const order: Tier[] = ['cold', 'warm', 'hot'];
  const idx = Math.min(order.length - 1, RANK[tier] + steps);
  return order[idx];
}

/**
 * Decide the target tier for one partition given `now`.
 *
 * Rules, in order:
 *   1. Compute the age-based baseline tier.
 *   2. If recent access ≥ threshold, promote one step above the baseline
 *      (bounded at hot) — hot data under load stays queryable at low latency.
 *   3. Otherwise settle to the baseline (demote quiet, aged partitions).
 */
export function decideTier(meta: PartitionMeta, now: number, policy: TierPolicy): TierDecision {
  const ageDays = (now - meta.newestEventTime) / policy.dayMs;
  const baseline = tierByAge(ageDays, policy);

  const windowStart = now - policy.accessWindowMs;
  const accesses = meta.recentAccesses.filter((t) => t >= windowStart).length;
  const hot = accesses >= policy.promoteAccessThreshold;

  const target = hot ? warmerBy(baseline, 1) : baseline;

  let action: TierDecision['action'] = 'noop';
  let reason: string;
  if (RANK[target] > RANK[meta.currentTier]) {
    action = 'promote';
    reason = hot
      ? `${accesses} accesses in trailing window ≥ ${policy.promoteAccessThreshold} — promote for low-latency reads`
      : `age ${ageDays.toFixed(1)}d implies ${target}`;
  } else if (RANK[target] < RANK[meta.currentTier]) {
    action = 'demote';
    reason = `age ${ageDays.toFixed(1)}d and only ${accesses} recent accesses — demote to ${target}`;
  } else {
    reason = `already ${target} (age ${ageDays.toFixed(1)}d, ${accesses} recent accesses)`;
  }

  return { partitionId: meta.id, from: meta.currentTier, to: target, action, reason };
}

/**
 * Lifecycle manager. Records accesses and, on `evaluate`, returns the set of
 * tier transitions to enact. Applying a decision updates the in-memory tier so
 * repeated evaluations are idempotent until age/access change.
 */
export class TierManager {
  private partitions = new Map<string, PartitionMeta>();

  constructor(private policy: TierPolicy = DEFAULT_TIER_POLICY) {}

  register(
    meta: Omit<PartitionMeta, 'recentAccesses' | 'currentTier'> & { currentTier?: Tier },
  ): void {
    this.partitions.set(meta.id, {
      ...meta,
      currentTier: meta.currentTier ?? 'hot',
      recentAccesses: [],
    });
  }

  /** Record an access at `ts`, trimming to the trailing window. */
  recordAccess(partitionId: string, ts: number): void {
    const p = this.partitions.get(partitionId);
    if (!p) return;
    const windowStart = ts - this.policy.accessWindowMs;
    p.recentAccesses = p.recentAccesses.filter((t) => t >= windowStart);
    p.recentAccesses.push(ts);
  }

  get(partitionId: string): PartitionMeta | undefined {
    return this.partitions.get(partitionId);
  }

  /** Which tier should serve reads for this partition right now. */
  tierOf(partitionId: string): Tier | undefined {
    return this.partitions.get(partitionId)?.currentTier;
  }

  /** Compute all pending transitions without mutating state. */
  evaluate(now: number): TierDecision[] {
    return [...this.partitions.values()]
      .map((p) => decideTier(p, now, this.policy))
      .filter((d) => d.action !== 'noop');
  }

  /** Apply a decision — updates the partition's current tier. */
  apply(decision: TierDecision): void {
    const p = this.partitions.get(decision.partitionId);
    if (p) p.currentTier = decision.to;
  }

  /** Evaluate and apply in one pass; returns the transitions enacted. */
  reconcile(now: number): TierDecision[] {
    const decisions = this.evaluate(now);
    decisions.forEach((d) => this.apply(d));
    return decisions;
  }

  all(): PartitionMeta[] {
    return [...this.partitions.values()];
  }
}
