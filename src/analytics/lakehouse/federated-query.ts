/**
 * Layer 3 — Federated Query Planner (Issue #551)
 *
 * A Trino/Presto-style planner that answers a single time-ranged analytics
 * request by transparently fanning out to whichever tiers hold the relevant
 * data — hot (PostgreSQL), warm (ClickHouse), cold (S3 Iceberg) — and merging
 * the partial results. Callers never rehydrate cold storage: cold partitions
 * are queried in place via the Iceberg/Trino connector.
 *
 * The planner:
 *   1. Splits the requested [from, to] range into per-tier sub-ranges using the
 *      TierManager's current classification of each partition.
 *   2. Emits one `SubQuery` per tier that has overlapping data, tagged with the
 *      engine that should run it.
 *   3. Merges partial rows back together, re-aggregating group keys that span
 *      tier boundaries so a 5-minute bucket split across hot+warm sums cleanly.
 */

import type { Tier, TierManager } from './tiering';

export interface TimeRange {
  from: number;
  to: number;
}

export interface FederatedRequest {
  /** Logical dataset, e.g. `txn_events`. */
  dataset: string;
  range: TimeRange;
  groupBy: string[];
  measures: Array<{ as: string; fn: 'sum' | 'count' | 'avg' | 'min' | 'max'; column?: string }>;
}

export type Engine = 'postgres' | 'clickhouse' | 'iceberg-trino';

export interface SubQuery {
  tier: Tier;
  engine: Engine;
  range: TimeRange;
  partitionIds: string[];
}

export interface FederatedPlan {
  request: FederatedRequest;
  subQueries: SubQuery[];
  /** True when the plan reads cold storage without any rehydration step. */
  coldQueriedInPlace: boolean;
}

const ENGINE_FOR_TIER: Record<Tier, Engine> = {
  hot: 'postgres',
  warm: 'clickhouse',
  cold: 'iceberg-trino',
};

/** A partition and the time span it covers, from the catalog. */
export interface PartitionSpan {
  id: string;
  from: number;
  to: number;
}

/**
 * Build a federated plan. `spans` is the catalog of partitions for the dataset;
 * `tiers` provides each partition's current tier (from the TierManager).
 */
export function planFederatedQuery(
  request: FederatedRequest,
  spans: PartitionSpan[],
  tiers: Pick<TierManager, 'tierOf'>,
): FederatedPlan {
  const byTier = new Map<Tier, { ids: string[]; from: number; to: number }>();

  for (const span of spans) {
    // Overlap test against the requested range.
    if (span.to < request.range.from || span.from > request.range.to) continue;
    const tier = tiers.tierOf(span.id) ?? 'cold';
    const overlapFrom = Math.max(span.from, request.range.from);
    const overlapTo = Math.min(span.to, request.range.to);

    const acc = byTier.get(tier);
    if (!acc) {
      byTier.set(tier, { ids: [span.id], from: overlapFrom, to: overlapTo });
    } else {
      acc.ids.push(span.id);
      acc.from = Math.min(acc.from, overlapFrom);
      acc.to = Math.max(acc.to, overlapTo);
    }
  }

  const order: Tier[] = ['hot', 'warm', 'cold'];
  const subQueries: SubQuery[] = order
    .filter((t) => byTier.has(t))
    .map((tier) => {
      const acc = byTier.get(tier)!;
      return {
        tier,
        engine: ENGINE_FOR_TIER[tier],
        range: { from: acc.from, to: acc.to },
        partitionIds: acc.ids.sort(),
      };
    });

  return {
    request,
    subQueries,
    coldQueriedInPlace: subQueries.some((s) => s.tier === 'cold'),
  };
}

/**
 * Merge partial result sets from each tier into a single result, re-applying
 * the aggregation so group keys that appear in more than one tier are combined.
 *
 * `avg` is merged correctly by carrying an implicit count: a per-tier avg is
 * weighted by that tier's row count when a `count` measure is present; if no
 * count measure exists, avgs are combined by simple arithmetic mean (documented
 * limitation — include a count measure for exact cross-tier averages).
 */
export function mergeFederatedResults(
  request: FederatedRequest,
  partials: Record<string, string | number>[][],
): Record<string, string | number>[] {
  const countMeasure = request.measures.find((m) => m.fn === 'count');
  const groups = new Map<string, Record<string, string | number>>();
  const weights = new Map<string, number[]>(); // per-group weights for avg merge

  for (const partial of partials) {
    for (const row of partial) {
      const gkey = request.groupBy.map((c) => String(row[c])).join('\u0001');
      const existing = groups.get(gkey);
      const weight = countMeasure ? Number(row[countMeasure.as]) || 0 : 1;

      if (!existing) {
        groups.set(gkey, { ...row });
        weights.set(gkey, [weight]);
        continue;
      }

      const w = weights.get(gkey)!;
      for (const m of request.measures) {
        const a = Number(existing[m.as]) || 0;
        const b = Number(row[m.as]) || 0;
        switch (m.fn) {
          case 'sum':
          case 'count':
            existing[m.as] = a + b;
            break;
          case 'min':
            existing[m.as] = Math.min(a, b);
            break;
          case 'max':
            existing[m.as] = Math.max(a, b);
            break;
          case 'avg': {
            const totalW = w.reduce((x, y) => x + y, 0);
            existing[m.as] = (a * totalW + b * weight) / (totalW + weight || 1);
            break;
          }
        }
      }
      w.push(weight);
    }
  }

  return [...groups.values()];
}
