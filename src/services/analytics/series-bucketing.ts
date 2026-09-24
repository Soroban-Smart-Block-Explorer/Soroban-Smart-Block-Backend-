/**
 * Time-series bucketing primitives.
 *
 * Shared, pure helpers used by the analytics series API (`src/api/series.ts`)
 * to turn irregular raw data points (pool snapshots, swap events, token price
 * history) into evenly spaced, sparkline-friendly series.
 *
 * Kept free of I/O so it can be unit-tested in isolation.
 */

export const BUCKET_INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d', '1w'] as const;

export type BucketInterval = (typeof BUCKET_INTERVALS)[number];

export const INTERVAL_MS: Record<BucketInterval, number> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
  '1w': 7 * 24 * 60 * 60_000,
};

export type SeriesAggregation = 'first' | 'last' | 'sum' | 'avg' | 'min' | 'max' | 'count';

export interface RawSeriesPoint {
  timestamp: Date;
  value: number | null;
}

export interface SeriesPoint {
  /** Bucket start, ISO-8601 (UTC). */
  t: string;
  /** Aggregated value for the bucket. */
  v: number;
}

export interface SeriesStats {
  points: number;
  first: number | null;
  last: number | null;
  min: number | null;
  max: number | null;
  /** Percent change between first and last point. `null` when undefined (first is 0). */
  changePct: number | null;
}

export interface BuiltSeries {
  points: SeriesPoint[];
  sparkline: number[];
  stats: SeriesStats;
}

export interface BucketOptions {
  bucketMs: number;
  aggregation: SeriesAggregation;
  /** Cap on returned points; the most recent points are kept. */
  limit?: number;
  /**
   * Fill empty buckets between the first and last data point so dashboards get
   * a continuous line. Volume/count-style aggregations fill with 0, value
   * aggregations carry the previous value forward.
   */
  fillGaps?: boolean;
}

/** Align a timestamp (ms since epoch) down to the start of its bucket. */
export function bucketStart(ms: number, bucketMs: number): number {
  return Math.floor(ms / bucketMs) * bucketMs;
}

/** Reduce a bucket's values to a single number. */
export function aggregateValues(values: number[], aggregation: SeriesAggregation): number {
  if (values.length === 0) return 0;
  switch (aggregation) {
    case 'sum':
      return values.reduce((a, b) => a + b, 0);
    case 'avg':
      return values.reduce((a, b) => a + b, 0) / values.length;
    case 'min':
      return Math.min(...values);
    case 'max':
      return Math.max(...values);
    case 'first':
      return values[0];
    case 'count':
      return values.length;
    case 'last':
    default:
      return values[values.length - 1];
  }
}

function isZeroFill(aggregation: SeriesAggregation): boolean {
  return aggregation === 'sum' || aggregation === 'count';
}

/**
 * Bucket raw points into a dense, ascending series.
 *
 * Null values are dropped (except for `count`, where each row counts one).
 */
export function bucketSeries(rows: RawSeriesPoint[], options: BucketOptions): BuiltSeries {
  const { bucketMs, aggregation, limit, fillGaps = true } = options;

  if (!Number.isFinite(bucketMs) || bucketMs <= 0) {
    throw new Error('bucketMs must be a positive number');
  }

  const valid = rows
    .filter((r) => r.timestamp instanceof Date && !Number.isNaN(r.timestamp.getTime()))
    .filter((r) => aggregation === 'count' || (r.value != null && Number.isFinite(r.value)))
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  const buckets = new Map<number, number[]>();
  for (const row of valid) {
    const key = bucketStart(row.timestamp.getTime(), bucketMs);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(row.value ?? 1);
    else buckets.set(key, [row.value ?? 1]);
  }

  let keys = Array.from(buckets.keys()).sort((a, b) => a - b);

  if (fillGaps && keys.length > 1) {
    const start = keys[0];
    const end = keys[keys.length - 1];
    const dense: number[] = [];
    for (let k = start; k <= end; k += bucketMs) dense.push(k);
    keys = dense;
  }

  let carry: number | null = null;
  let points: SeriesPoint[] = [];
  for (const key of keys) {
    const values = buckets.get(key);
    let value: number;
    if (values && values.length > 0) {
      value = aggregateValues(values, aggregation);
      carry = value;
    } else if (isZeroFill(aggregation)) {
      // Gap-filled bucket: zero for sums/counts, carry-forward for values.
      value = 0;
    } else if (carry != null) {
      value = carry;
    } else {
      value = 0;
    }
    points.push({ t: new Date(key).toISOString(), v: value });
  }

  if (limit != null && points.length > limit) {
    points = points.slice(points.length - limit);
  }

  return {
    points,
    sparkline: points.map((p) => p.v),
    stats: buildStats(points),
  };
}

/** Compute summary statistics for a bucketed series. */
export function buildStats(points: SeriesPoint[]): SeriesStats {
  if (points.length === 0) {
    return { points: 0, first: null, last: null, min: null, max: null, changePct: null };
  }
  const values = points.map((p) => p.v);
  const first = values[0];
  const last = values[values.length - 1];
  const changePct = first === 0 ? null : ((last - first) / Math.abs(first)) * 100;
  return {
    points: values.length,
    first,
    last,
    min: Math.min(...values),
    max: Math.max(...values),
    changePct,
  };
}

/** Extract just the values from a series for compact sparkline payloads. */
export function toSparkline(points: SeriesPoint[]): number[] {
  return points.map((p) => p.v);
}
