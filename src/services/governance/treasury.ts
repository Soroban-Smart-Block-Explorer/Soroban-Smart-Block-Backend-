/**
 * src/services/governance/treasury.ts
 *
 * DAO treasury logic (docs/governance-framework.md §7): payout stream math,
 * inflow/outflow analytics, runway estimation, and the reputation-weighted
 * voting power blend. Pure functions over injected rows — no Prisma imports —
 * so everything is unit-testable and reusable by the indexer.
 *
 * Amounts follow the repo convention: i128-safe integer strings at rest,
 * bigint in memory.
 */
import { toBigInt } from './types';

// ── Payout streams ────────────────────────────────────────────────────────────

export interface StreamData {
  amountPerPeriod: string;
  periodSeconds: number;
  startAt: Date;
  endAt?: Date | null;
  claimed: string;
  status: string; // active | paused | completed | cancelled
}

/**
 * Total vested (claimable-to-date) amount of a stream at `now`, using whole
 * elapsed periods (payments unlock at each period boundary, no pro-rating —
 * matches how the on-chain claim payload will be built).
 */
export function vestedAmount(stream: StreamData, now: Date): bigint {
  if (now < stream.startAt) return 0n;
  const cutoff = stream.endAt && now > stream.endAt ? stream.endAt : now;
  const elapsedSeconds = Math.floor((cutoff.getTime() - stream.startAt.getTime()) / 1000);
  if (elapsedSeconds < 0) return 0n;
  const periods = BigInt(Math.floor(elapsedSeconds / stream.periodSeconds));
  return periods * toBigInt(stream.amountPerPeriod);
}

/** Amount claimable right now = vested − already claimed (never negative). */
export function claimableAmount(stream: StreamData, now: Date): bigint {
  if (stream.status !== 'active') return 0n;
  const claimable = vestedAmount(stream, now) - toBigInt(stream.claimed);
  return claimable > 0n ? claimable : 0n;
}

/** Committed-but-unvested liability of a stream (for runway math). */
export function outstandingCommitment(stream: StreamData, now: Date): bigint {
  if (stream.status !== 'active') return 0n;
  if (!stream.endAt) {
    // Open-ended stream: report one year of forward commitments.
    const oneYearPeriods = BigInt(Math.floor((365 * 24 * 3600) / stream.periodSeconds));
    return oneYearPeriods * toBigInt(stream.amountPerPeriod);
  }
  const totalSeconds = Math.floor((stream.endAt.getTime() - stream.startAt.getTime()) / 1000);
  const totalPeriods = BigInt(Math.floor(totalSeconds / stream.periodSeconds));
  const total = totalPeriods * toBigInt(stream.amountPerPeriod);
  const remaining = total - vestedAmount(stream, now);
  return remaining > 0n ? remaining : 0n;
}

// ── Flow analytics ────────────────────────────────────────────────────────────

export interface FlowRow {
  direction: string; // inflow | outflow
  assetCode: string;
  amount: string;
  category?: string | null;
  timestamp: Date;
}

export interface FlowBucket {
  bucketStart: string; // ISO date (UTC day)
  inflow: string;
  outflow: string;
  net: string;
}

/** Group transactions into UTC-day buckets per asset-agnostic totals. */
export function bucketFlows(rows: FlowRow[], days: number, now: Date): FlowBucket[] {
  const buckets = new Map<string, { inflow: bigint; outflow: bigint }>();
  const start = new Date(now.getTime() - days * 24 * 3600 * 1000);
  for (const row of rows) {
    if (row.timestamp < start || row.timestamp > now) continue;
    const key = row.timestamp.toISOString().slice(0, 10);
    const bucket = buckets.get(key) ?? { inflow: 0n, outflow: 0n };
    const amount = toBigInt(row.amount);
    if (row.direction === 'inflow') bucket.inflow += amount;
    else if (row.direction === 'outflow') bucket.outflow += amount;
    buckets.set(key, bucket);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucketStart, { inflow, outflow }]) => ({
      bucketStart,
      inflow: inflow.toString(),
      outflow: outflow.toString(),
      net: (inflow - outflow).toString(),
    }));
}

/** Outflow totals per category (grants, ops, ...), for allocation charts. */
export function categoryBreakdown(rows: FlowRow[]): Array<{ category: string; outflow: string }> {
  const totals = new Map<string, bigint>();
  for (const row of rows) {
    if (row.direction !== 'outflow') continue;
    const key = row.category ?? 'uncategorized';
    totals.set(key, (totals.get(key) ?? 0n) + toBigInt(row.amount));
  }
  return [...totals.entries()]
    .sort(([, a], [, b]) => (b > a ? 1 : b < a ? -1 : 0))
    .map(([category, outflow]) => ({ category, outflow: outflow.toString() }));
}

/**
 * Runway in days: liquid balance ÷ trailing-window daily net burn.
 * Returns null when there is no net burn (treasury is growing or flat) —
 * "infinite runway" is the caller's presentational decision.
 */
export function runwayDays(params: {
  liquidBalance: bigint;
  rows: FlowRow[];
  windowDays: number;
  now: Date;
}): number | null {
  const { liquidBalance, rows, windowDays, now } = params;
  const start = new Date(now.getTime() - windowDays * 24 * 3600 * 1000);
  let inflow = 0n;
  let outflow = 0n;
  for (const row of rows) {
    if (row.timestamp < start || row.timestamp > now) continue;
    if (row.direction === 'inflow') inflow += toBigInt(row.amount);
    else if (row.direction === 'outflow') outflow += toBigInt(row.amount);
  }
  const netBurn = outflow - inflow;
  if (netBurn <= 0n) return null;
  // days = liquid / (netBurn / windowDays); ×1000 to keep 3 decimals of precision.
  const days = (liquidBalance * BigInt(windowDays) * 1000n) / netBurn;
  return Number(days) / 1000;
}

// ── Reputation-weighted voting power (docs §7) ────────────────────────────────

/**
 * Blend token power with a reputation score for treasury proposals:
 *   power = tokenPower × (1 − w) + reputationShare × totalPower × w
 * where reputationShare = score/100 and totalPower keeps the blend in token
 * units. weight (w) comes from TreasuryAccount.reputationWeight ∈ [0, 1].
 * Fixed-point (1e6) arithmetic so the result stays a bigint.
 */
export function blendReputationPower(params: {
  tokenPower: bigint;
  reputationScore: number; // 0..100
  totalPower: bigint;
  weight: number; // 0..1
}): bigint {
  const { tokenPower, reputationScore, totalPower } = params;
  const weight = Math.min(1, Math.max(0, params.weight));
  if (weight === 0) return tokenPower;
  const SCALE = 1_000_000n;
  const w = BigInt(Math.round(weight * 1_000_000));
  const score = BigInt(Math.round(Math.min(100, Math.max(0, reputationScore)) * 10_000)); // /1e6 = share
  const tokenPart = (tokenPower * (SCALE - w)) / SCALE;
  const reputationPart = (totalPower * score * w) / (SCALE * SCALE);
  return tokenPart + reputationPart;
}

// ── Asset typing (5+ supported kinds, docs §7) ────────────────────────────────

export const TREASURY_ASSET_TYPES = ['native', 'sep41', 'governance', 'lp', 'wrapped'] as const;
export type TreasuryAssetType = (typeof TREASURY_ASSET_TYPES)[number];

export function isTreasuryAssetType(value: string): value is TreasuryAssetType {
  return (TREASURY_ASSET_TYPES as readonly string[]).includes(value);
}
