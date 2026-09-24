/**
 * Time-series analytics API for DEX pools and tokens.
 *
 * Unifies the pool snapshot, swap-event and token price-history feeds into
 * queryable, bucketed series so pool/token dashboards can render charts and
 * sparklines without post-processing raw rows.
 *
 * Endpoints:
 *   GET /series/pools/:address      — bucketed pool metrics (volume, TVL, fees, APR, price, trades)
 *   GET /series/tokens/:address     — bucketed token metrics (price, volume, market cap, …)
 *   GET /series/top/pools           — top pools by metric, with optional sparklines
 *   GET /series/top/tokens          — top tokens by metric, with optional sparklines
 *
 * @swagger
 * tags:
 *   name: Analytics Series
 *   description: Bucketed time-series for DEX pools and tokens
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prismaRead as prisma } from '../db';
import { asyncHandler } from '../middleware/asyncHandler';
import {
  BUCKET_INTERVALS,
  INTERVAL_MS,
  bucketSeries,
  type BucketInterval,
  type RawSeriesPoint,
  type SeriesAggregation,
  type SeriesStats,
} from '../services/analytics/series-bucketing';

export const seriesRouter = Router();

// ── Shared query schema ───────────────────────────────────────────────────────

const WINDOW_KEYS = ['1h', '24h', '7d', '30d', '90d', 'all'] as const;
type WindowKey = (typeof WINDOW_KEYS)[number];

const WINDOW_MS: Record<WindowKey, number | null> = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
  '90d': 90 * 86_400_000,
  all: null,
};

const seriesQuerySchema = z.object({
  interval: z.enum(BUCKET_INTERVALS).default('1h'),
  window: z.enum(WINDOW_KEYS).default('7d'),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
  /** `false` disables gap-filling empty buckets. */
  fill: z.enum(['true', 'false']).default('true'),
  /** `sparkline` omits per-point objects, returning just the compact value array. */
  format: z.enum(['full', 'sparkline']).default('full'),
});

type SeriesQuery = z.infer<typeof seriesQuerySchema>;

interface ResolvedRange {
  from: Date;
  to: Date;
}

function resolveRange(q: SeriesQuery): ResolvedRange {
  const to = q.to ?? new Date();
  if (q.from) return { from: q.from, to };
  const ms = WINDOW_MS[q.window];
  return { from: ms == null ? new Date(0) : new Date(to.getTime() - ms), to };
}

// ── Metric definitions ────────────────────────────────────────────────────────

interface MetricSpec<Row> {
  aggregation: SeriesAggregation;
  unit: 'usd' | 'pct' | 'ratio' | 'count' | 'xlm';
  extract: (row: Partial<Row>) => number | null;
}

interface PoolSnapshotRow {
  createdAt: Date;
  tvlUsd: number | null;
  volume24hUsd: number | null;
  fees24hUsd: number | null;
  aprPct: number | null;
  priceAUsd: number | null;
  priceBUsd: number | null;
}

interface PoolSwapRow {
  ledgerCloseTime: Date;
}

interface TokenHistoryRow {
  timestamp: Date;
  priceUsd: Prisma.Decimal;
  priceXlm: Prisma.Decimal;
  volume24hUsd: Prisma.Decimal | null;
  marketCapUsd: Prisma.Decimal | null;
  confidence: number;
}

const SNAPSHOT_METRICS: Record<string, MetricSpec<PoolSnapshotRow>> = {
  tvl: { aggregation: 'last', unit: 'usd', extract: (r) => r.tvlUsd ?? null },
  volume: { aggregation: 'last', unit: 'usd', extract: (r) => r.volume24hUsd ?? null },
  fees: { aggregation: 'last', unit: 'usd', extract: (r) => r.fees24hUsd ?? null },
  apr: { aggregation: 'last', unit: 'pct', extract: (r) => r.aprPct ?? null },
  priceA: { aggregation: 'last', unit: 'usd', extract: (r) => r.priceAUsd ?? null },
  priceB: { aggregation: 'last', unit: 'usd', extract: (r) => r.priceBUsd ?? null },
};

const SWAP_METRICS: Record<string, MetricSpec<PoolSwapRow>> = {
  trades: { aggregation: 'count', unit: 'count', extract: () => 1 },
};

const TOKEN_METRICS: Record<string, MetricSpec<TokenHistoryRow>> = {
  price: { aggregation: 'last', unit: 'usd', extract: (r) => toNum(r.priceUsd) },
  priceXlm: { aggregation: 'last', unit: 'xlm', extract: (r) => toNum(r.priceXlm) },
  volume: { aggregation: 'avg', unit: 'usd', extract: (r) => toNum(r.volume24hUsd) },
  marketCap: { aggregation: 'last', unit: 'usd', extract: (r) => toNum(r.marketCapUsd) },
  confidence: { aggregation: 'avg', unit: 'ratio', extract: (r) => r.confidence ?? null },
};

const POOL_METRIC_KEYS = Object.keys(SNAPSHOT_METRICS).concat(Object.keys(SWAP_METRICS));
const TOKEN_METRIC_KEYS = Object.keys(TOKEN_METRICS);

function toNum(value: Prisma.Decimal | null | undefined): number | null {
  return value == null ? null : Number(value);
}

/** Thrown for caller errors (bad query params) so they surface as HTTP 400. */
class BadRequestError extends Error {}

interface MetricPayload {
  unit: string;
  aggregation: SeriesAggregation;
  interval: BucketInterval;
  points?: Array<{ t: string; v: number }>;
  sparkline: number[];
  stats: SeriesStats;
}

function seriesPayload<Row>(
  rows: Row[],
  spec: MetricSpec<Row>,
  getTimestamp: (row: Row) => Date,
  bucketMs: number,
  q: SeriesQuery,
): MetricPayload {
  const raw: RawSeriesPoint[] = rows.map((row) => ({
    timestamp: getTimestamp(row),
    value: spec.extract(row),
  }));
  const built = bucketSeries(raw, {
    bucketMs,
    aggregation: spec.aggregation,
    limit: q.limit,
    fillGaps: q.fill !== 'false',
  });
  return {
    unit: spec.unit,
    aggregation: spec.aggregation,
    interval: q.interval,
    ...(q.format === 'sparkline' ? {} : { points: built.points }),
    sparkline: built.sparkline,
    stats: built.stats,
  };
}

function parseMetrics(raw: string | undefined, allowed: string[], fallback: string[]): string[] {
  if (!raw) return fallback;
  const requested = raw
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  if (requested.length === 0) return fallback;
  const unknown = requested.filter((m) => !allowed.includes(m));
  if (unknown.length > 0) {
    throw new BadRequestError(
      `Unknown metric(s): ${unknown.join(', ')}. Allowed: ${allowed.join(', ')}`,
    );
  }
  return Array.from(new Set(requested));
}

const SELECTION_LIMIT = 20_000;

// ── GET /series/pools/:address ────────────────────────────────────────────────
const poolSeriesSchema = seriesQuerySchema.extend({ metrics: z.string().optional() });

seriesRouter.get(
  '/pools/:address',
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const q = poolSeriesSchema.parse(req.query);
      const metrics = parseMetrics(q.metrics, POOL_METRIC_KEYS, ['volume', 'tvl', 'priceA']);
      const { from, to } = resolveRange(q);
      const bucketMs = INTERVAL_MS[q.interval];
      const take = Math.min(q.limit * 8 + 50, SELECTION_LIMIT);

      const snapshotMetrics = metrics.filter((m) => m in SNAPSHOT_METRICS);
      const swapMetrics = metrics.filter((m) => m in SWAP_METRICS);

      const [snapshots, swaps] = await Promise.all([
        snapshotMetrics.length > 0
          ? prisma.poolSnapshot.findMany({
              where: { poolAddress: req.params.address, createdAt: { gte: from, lte: to } },
              orderBy: { createdAt: 'asc' },
              take,
              select: {
                createdAt: true,
                tvlUsd: true,
                volume24hUsd: true,
                fees24hUsd: true,
                aprPct: true,
                priceAUsd: true,
                priceBUsd: true,
              },
            })
          : Promise.resolve([] as PoolSnapshotRow[]),
        swapMetrics.length > 0
          ? prisma.poolSwap.findMany({
              where: {
                poolAddress: req.params.address,
                ledgerCloseTime: { gte: from, lte: to },
              },
              orderBy: { ledgerCloseTime: 'asc' },
              take,
              select: { ledgerCloseTime: true },
            })
          : Promise.resolve([] as PoolSwapRow[]),
      ]);

      const pool = await prisma.dexPool.findUnique({
        where: { poolAddress: req.params.address },
        select: {
          poolAddress: true,
          protocol: true,
          dexName: true,
          tokenA: true,
          tokenB: true,
          tokenASymbol: true,
          tokenBSymbol: true,
          isActive: true,
        },
      });
      if (!pool) return res.status(404).json({ error: 'Pool not found' });

      const data: Record<string, MetricPayload> = {};
      for (const metric of metrics) {
        if (metric in SNAPSHOT_METRICS) {
          data[metric] = seriesPayload(
            snapshots,
            SNAPSHOT_METRICS[metric],
            (r) => r.createdAt,
            bucketMs,
            q,
          );
        } else {
          data[metric] = seriesPayload(
            swaps,
            SWAP_METRICS[metric],
            (r) => r.ledgerCloseTime,
            bucketMs,
            q,
          );
        }
      }

      res.json({
        poolAddress: pool.poolAddress,
        protocol: pool.protocol,
        dexName: pool.dexName,
        tokenA: pool.tokenA,
        tokenB: pool.tokenB,
        tokenASymbol: pool.tokenASymbol,
        tokenBSymbol: pool.tokenBSymbol,
        interval: q.interval,
        window: q.window,
        from: from.toISOString(),
        to: to.toISOString(),
        series: data,
        updatedAt: new Date().toISOString(),
      });
    } catch (e) {
      respondWithError(res, e);
    }
  }),
);

// ── GET /series/tokens/:address ───────────────────────────────────────────────
const tokenSeriesSchema = seriesQuerySchema.extend({ metrics: z.string().optional() });

seriesRouter.get(
  '/tokens/:address',
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const q = tokenSeriesSchema.parse(req.query);
      const metrics = parseMetrics(q.metrics, TOKEN_METRIC_KEYS, ['price', 'volume', 'marketCap']);
      const { from, to } = resolveRange(q);
      const bucketMs = INTERVAL_MS[q.interval];
      const take = Math.min(q.limit * 8 + 50, SELECTION_LIMIT);

      const [rows, snapshot] = await Promise.all([
        prisma.tokenPriceHistory.findMany({
          where: { tokenAddress: req.params.address, timestamp: { gte: from, lte: to } },
          orderBy: { timestamp: 'asc' },
          take,
          select: {
            timestamp: true,
            priceUsd: true,
            priceXlm: true,
            volume24hUsd: true,
            marketCapUsd: true,
            confidence: true,
          },
        }),
        prisma.tokenPrice.findUnique({
          where: { tokenAddress: req.params.address },
          select: {
            priceUsd: true,
            volume24hUsd: true,
            marketCapUsd: true,
            liquidityUsd: true,
            priceChange1h: true,
            priceChange24h: true,
            priceChange7d: true,
            confidence: true,
            source: true,
          },
        }),
      ]);

      if (!snapshot && rows.length === 0) {
        return res.status(404).json({ error: 'Token not found' });
      }

      const data: Record<string, MetricPayload> = {};
      for (const metric of metrics) {
        data[metric] = seriesPayload(rows, TOKEN_METRICS[metric], (r) => r.timestamp, bucketMs, q);
      }

      res.json({
        tokenAddress: req.params.address,
        interval: q.interval,
        window: q.window,
        from: from.toISOString(),
        to: to.toISOString(),
        series: data,
        updatedAt: new Date().toISOString(),
      });
    } catch (e) {
      respondWithError(res, e);
    }
  }),
);

// ── GET /series/top/pools ─────────────────────────────────────────────────────
const TOP_POOL_METRICS: Record<string, keyof typeof SNAPSHOT_METRICS> = {
  tvl: 'tvl',
  volume: 'volume',
  fees: 'fees',
  apr: 'apr',
};

const topPoolsSchema = seriesQuerySchema.extend({
  metric: z.enum(['tvl', 'volume', 'fees', 'apr']).default('volume'),
  order: z.enum(['asc', 'desc']).default('desc'),
  protocol: z.string().optional(),
  sparkline: z.enum(['true', 'false']).default('true'),
});

seriesRouter.get(
  '/top/pools',
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const q = topPoolsSchema.parse(req.query);
      const limit = Math.min(q.limit, 50);
      const { from, to } = resolveRange(q);
      const bucketMs = INTERVAL_MS[q.interval];
      const specMetric = TOP_POOL_METRICS[q.metric];
      const spec = SNAPSHOT_METRICS[specMetric];

      const pools = await prisma.dexPool.findMany({
        where: { isActive: true, ...(q.protocol ? { protocol: q.protocol } : {}) },
        orderBy: { [ORDER_FIELD[specMetric]]: q.order } as Prisma.DexPoolOrderByWithRelationInput,
        take: limit,
        select: {
          poolAddress: true,
          protocol: true,
          dexName: true,
          tokenASymbol: true,
          tokenBSymbol: true,
          tvlUsd: true,
          volume24hUsd: true,
          fees24hUsd: true,
          aprPct: true,
        },
      });

      let sparklineByPool = new Map<string, MetricPayload>();
      if (q.sparkline === 'true' && pools.length > 0) {
        const rows = await prisma.poolSnapshot.findMany({
          where: {
            poolAddress: { in: pools.map((p) => p.poolAddress) },
            createdAt: { gte: from, lte: to },
          },
          orderBy: { createdAt: 'asc' },
          select: {
            poolAddress: true,
            createdAt: true,
            tvlUsd: true,
            volume24hUsd: true,
            fees24hUsd: true,
            aprPct: true,
            priceAUsd: true,
            priceBUsd: true,
          },
        });
        const grouped = new Map<string, PoolSnapshotRow[]>();
        for (const row of rows) {
          const list = grouped.get(row.poolAddress);
          if (list) list.push(row);
          else grouped.set(row.poolAddress, [row]);
        }
        sparklineByPool = new Map(
          pools.map((p) => [
            p.poolAddress,
            seriesPayload(grouped.get(p.poolAddress) ?? [], spec, (r) => r.createdAt, bucketMs, q),
          ]),
        );
      }

      res.json({
        metric: q.metric,
        interval: q.interval,
        window: q.window,
        from: from.toISOString(),
        to: to.toISOString(),
        data: pools.map((p, idx) => {
          const spark = sparklineByPool.get(p.poolAddress);
          return {
            rank: idx + 1,
            poolAddress: p.poolAddress,
            protocol: p.protocol,
            dexName: p.dexName,
            tokenASymbol: p.tokenASymbol,
            tokenBSymbol: p.tokenBSymbol,
            value: spec.extract(p),
            sparkline: spark?.sparkline ?? [],
            changePct: spark?.stats.changePct ?? null,
          };
        }),
        count: pools.length,
      });
    } catch (e) {
      respondWithError(res, e);
    }
  }),
);

// ── GET /series/top/tokens ────────────────────────────────────────────────────
const TOP_TOKEN_FIELDS = {
  volume: 'volume24hUsd',
  marketCap: 'marketCapUsd',
  price: 'priceUsd',
  priceChange: 'priceChange24h',
} as const;

const TOP_TOKEN_HISTORY_SPEC: Record<keyof typeof TOP_TOKEN_FIELDS, MetricSpec<TokenHistoryRow>> = {
  volume: { aggregation: 'avg', unit: 'usd', extract: (r) => toNum(r.volume24hUsd) },
  marketCap: { aggregation: 'last', unit: 'usd', extract: (r) => toNum(r.marketCapUsd) },
  price: { aggregation: 'last', unit: 'usd', extract: (r) => Number(r.priceUsd) },
  priceChange: { aggregation: 'last', unit: 'usd', extract: (r) => Number(r.priceUsd) },
};

const topTokensSchema = seriesQuerySchema.extend({
  metric: z.enum(['volume', 'marketCap', 'price', 'priceChange']).default('volume'),
  sparkline: z.enum(['true', 'false']).default('true'),
});

seriesRouter.get(
  '/top/tokens',
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const q = topTokensSchema.parse(req.query);
      const limit = Math.min(q.limit, 50);
      const { from, to } = resolveRange(q);
      const bucketMs = INTERVAL_MS[q.interval];
      const field = TOP_TOKEN_FIELDS[q.metric];

      const prices = await prisma.tokenPrice.findMany({
        where: q.metric === 'priceChange' ? { priceChange24h: { not: null } } : undefined,
        orderBy: { [field]: 'desc' } as Prisma.TokenPriceOrderByWithRelationInput,
        take: limit,
        select: {
          tokenAddress: true,
          priceUsd: true,
          volume24hUsd: true,
          marketCapUsd: true,
          priceChange24h: true,
          priceChange1h: true,
          priceChange7d: true,
        },
      });

      const addresses = prices.map((p) => p.tokenAddress);
      const [contracts, tokens] = await Promise.all([
        prisma.contract.findMany({
          where: { address: { in: addresses } },
          select: { address: true, tokenSymbol: true, tokenName: true },
        }),
        prisma.token.findMany({
          where: { address: { in: addresses } },
          select: { address: true, symbol: true, name: true },
        }),
      ]);
      const contractMap = new Map(contracts.map((c) => [c.address, c]));
      const tokenMap = new Map(tokens.map((t) => [t.address, t]));

      let sparklineByToken = new Map<string, MetricPayload>();
      if (q.sparkline === 'true' && addresses.length > 0) {
        const rows = await prisma.tokenPriceHistory.findMany({
          where: { tokenAddress: { in: addresses }, timestamp: { gte: from, lte: to } },
          orderBy: { timestamp: 'asc' },
          select: {
            tokenAddress: true,
            timestamp: true,
            priceUsd: true,
            priceXlm: true,
            volume24hUsd: true,
            marketCapUsd: true,
            confidence: true,
          },
        });
        const grouped = new Map<string, TokenHistoryRow[]>();
        for (const row of rows) {
          const list = grouped.get(row.tokenAddress);
          if (list) list.push(row);
          else grouped.set(row.tokenAddress, [row]);
        }
        const spec = TOP_TOKEN_HISTORY_SPEC[q.metric];
        sparklineByToken = new Map(
          addresses.map((address) => [
            address,
            seriesPayload(grouped.get(address) ?? [], spec, (r) => r.timestamp, bucketMs, q),
          ]),
        );
      }

      const valueFor = (p: (typeof prices)[number]): number | null => {
        switch (q.metric) {
          case 'volume':
            return Number(p.volume24hUsd ?? 0);
          case 'marketCap':
            return Number(p.marketCapUsd ?? 0);
          case 'price':
            return Number(p.priceUsd);
          case 'priceChange':
            return p.priceChange24h;
        }
      };

      res.json({
        metric: q.metric,
        interval: q.interval,
        window: q.window,
        from: from.toISOString(),
        to: to.toISOString(),
        data: prices.map((p, idx) => {
          const contract = contractMap.get(p.tokenAddress);
          const token = tokenMap.get(p.tokenAddress);
          const spark = sparklineByToken.get(p.tokenAddress);
          return {
            rank: idx + 1,
            tokenAddress: p.tokenAddress,
            symbol: contract?.tokenSymbol ?? token?.symbol ?? null,
            name: contract?.tokenName ?? token?.name ?? null,
            value: valueFor(p),
            priceUsd: Number(p.priceUsd),
            volume24hUsd: Number(p.volume24hUsd ?? 0),
            marketCapUsd: Number(p.marketCapUsd ?? 0),
            priceChange24h: p.priceChange24h,
            priceChange1h: p.priceChange1h,
            priceChange7d: p.priceChange7d,
            sparkline: spark?.sparkline ?? [],
            changePct: spark?.stats.changePct ?? null,
          };
        }),
        count: prices.length,
      });
    } catch (e) {
      respondWithError(res, e);
    }
  }),
);

// ── GET /series — capability discovery ────────────────────────────────────────
seriesRouter.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({
      intervals: BUCKET_INTERVALS,
      windows: WINDOW_KEYS,
      poolMetrics: POOL_METRIC_KEYS,
      tokenMetrics: TOKEN_METRIC_KEYS,
      endpoints: [
        'GET /series/pools/:address',
        'GET /series/tokens/:address',
        'GET /series/top/pools',
        'GET /series/top/tokens',
      ],
    });
  }),
);

// ── Helpers ───────────────────────────────────────────────────────────────────

const ORDER_FIELD: Record<string, string> = {
  tvl: 'tvlUsd',
  volume: 'volume24hUsd',
  fees: 'fees24hUsd',
  apr: 'aprPct',
};

function respondWithError(res: Response, e: unknown): void {
  if (e instanceof z.ZodError) {
    res.status(400).json({ error: 'Invalid query parameters', issues: e.issues });
    return;
  }
  if (e instanceof BadRequestError) {
    res.status(400).json({ error: e.message });
    return;
  }
  res.status(500).json({ error: String(e) });
}
