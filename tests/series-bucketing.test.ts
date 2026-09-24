import { describe, it, expect } from 'vitest';
import {
  bucketStart,
  aggregateValues,
  bucketSeries,
  buildStats,
  toSparkline,
} from '../src/services/analytics/series-bucketing';

describe('bucketStart', () => {
  it('aligns timestamps down to the bucket boundary', () => {
    expect(bucketStart(3_700_000, 3_600_000)).toBe(3_600_000);
    expect(bucketStart(3_600_000, 3_600_000)).toBe(3_600_000);
    expect(bucketStart(3_599_999, 3_600_000)).toBe(0);
  });
});

describe('aggregateValues', () => {
  it('reduces a bucket according to the aggregation', () => {
    const values = [2, 4, 8];
    expect(aggregateValues(values, 'sum')).toBe(14);
    expect(aggregateValues(values, 'avg')).toBeCloseTo(14 / 3);
    expect(aggregateValues(values, 'min')).toBe(2);
    expect(aggregateValues(values, 'max')).toBe(8);
    expect(aggregateValues(values, 'first')).toBe(2);
    expect(aggregateValues(values, 'last')).toBe(8);
    expect(aggregateValues(values, 'count')).toBe(3);
  });

  it('returns 0 for empty buckets', () => {
    expect(aggregateValues([], 'sum')).toBe(0);
  });
});

describe('bucketSeries', () => {
  const hour = 3_600_000;
  const t0 = new Date('2026-01-01T00:00:00.000Z');
  const at = (h: number) => new Date(t0.getTime() + h * hour);

  it('groups values into hourly buckets', () => {
    const series = bucketSeries(
      [
        { timestamp: at(0), value: 2 },
        { timestamp: at(0.5), value: 4 },
        { timestamp: at(1), value: 6 },
      ],
      { bucketMs: hour, aggregation: 'sum', fillGaps: false },
    );

    expect(series.points.map((p) => p.v)).toEqual([6, 6]);
    expect(series.points[0].t).toBe('2026-01-01T00:00:00.000Z');
    expect(series.sparkline).toEqual([6, 6]);
  });

  it('fills gaps with zero for sum/count aggregations', () => {
    const series = bucketSeries(
      [
        { timestamp: at(0), value: 10 },
        { timestamp: at(2), value: 30 },
      ],
      { bucketMs: hour, aggregation: 'sum' },
    );

    expect(series.sparkline).toEqual([10, 0, 30]);
  });

  it('carries the previous value forward for value aggregations', () => {
    const series = bucketSeries(
      [
        { timestamp: at(0), value: 10 },
        { timestamp: at(2), value: 30 },
      ],
      { bucketMs: hour, aggregation: 'last' },
    );

    expect(series.sparkline).toEqual([10, 10, 30]);
  });

  it('counts one per row for the count aggregation', () => {
    const series = bucketSeries(
      [{ timestamp: at(0) }, { timestamp: at(0.2) }, { timestamp: at(2) }],
      { bucketMs: hour, aggregation: 'count' },
    );

    expect(series.sparkline).toEqual([2, 0, 1]);
  });

  it('sorts unsorted input and drops null values', () => {
    const series = bucketSeries(
      [
        { timestamp: at(1), value: 5 },
        { timestamp: at(0), value: 1 },
        { timestamp: at(0.1), value: null },
      ],
      { bucketMs: hour, aggregation: 'sum', fillGaps: false },
    );

    expect(series.sparkline).toEqual([1, 5]);
  });

  it('caps the series to the most recent points when limited', () => {
    const rows = [0, 1, 2, 3, 4].map((h) => ({ timestamp: at(h), value: h }));
    const series = bucketSeries(rows, { bucketMs: hour, aggregation: 'last', limit: 3 });
    expect(series.sparkline).toEqual([2, 3, 4]);
  });

  it('returns an empty series for no rows', () => {
    const series = bucketSeries([], { bucketMs: hour, aggregation: 'last' });
    expect(series.points).toEqual([]);
    expect(series.sparkline).toEqual([]);
    expect(series.stats.points).toBe(0);
    expect(series.stats.changePct).toBeNull();
  });

  it('rejects a non-positive bucket size', () => {
    expect(() => bucketSeries([], { bucketMs: 0, aggregation: 'last' })).toThrow();
  });
});

describe('buildStats', () => {
  it('computes min/max/first/last and percent change', () => {
    const stats = buildStats([
      { t: '2026-01-01T00:00:00.000Z', v: 10 },
      { t: '2026-01-01T01:00:00.000Z', v: 30 },
    ]);
    expect(stats).toEqual({
      points: 2,
      first: 10,
      last: 30,
      min: 10,
      max: 30,
      changePct: 200,
    });
  });

  it('returns null change when the series starts at zero', () => {
    const stats = buildStats([
      { t: 'a', v: 0 },
      { t: 'b', v: 5 },
    ]);
    expect(stats.changePct).toBeNull();
  });
});

describe('toSparkline', () => {
  it('extracts the values from points', () => {
    expect(
      toSparkline([
        { t: 'a', v: 1 },
        { t: 'b', v: 2 },
      ]),
    ).toEqual([1, 2]);
  });
});
