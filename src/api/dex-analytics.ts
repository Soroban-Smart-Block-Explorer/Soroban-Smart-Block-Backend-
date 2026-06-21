/**
 * Phase 5 — Institutional DEX Analytics API.
 *
 * Pool listings (sortable by TVL/volume/APR), pool detail + composition,
 * historical TVL/volume/APR series, slippage curves, liquidity depth,
 * impermanent-loss curves, and live arbitrage opportunities.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prismaRead as prisma } from '../db';
import {
  defaultCurveSizes,
  impermanentLossPct,
  impermanentLossSeverity,
  liquidityDepth,
  simulateSwap,
  slippageCurve,
  toHuman,
} from '../indexer/dex/pool-math';

export const dexAnalyticsRouter = Router();

function reservesHuman(pool: {
  reserveA: string;
  reserveB: string;
  tokenADecimals: number;
  tokenBDecimals: number;
}) {
  return {
    a: toHuman(BigInt(pool.reserveA), pool.tokenADecimals),
    b: toHuman(BigInt(pool.reserveB), pool.tokenBDecimals),
  };
}

// ── GET /pools — list, sortable by TVL / volume / APR ───────────────────────
const listSchema = z.object({
  sort: z.enum(['tvl', 'volume', 'apr', 'volume7d', 'volume30d']).default('tvl'),
  order: z.enum(['asc', 'desc']).default('desc'),
  protocol: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const SORT_FIELD = {
  tvl: 'tvlUsd',
  volume: 'volume24hUsd',
  volume7d: 'volume7dUsd',
  volume30d: 'volume30dUsd',
  apr: 'aprPct',
} as const;

dexAnalyticsRouter.get('/pools', async (req: Request, res: Response) => {
  try {
    const q = listSchema.parse(req.query);
    const pools = await prisma.dexPool.findMany({
      where: q.protocol ? { protocol: q.protocol } : undefined,
      orderBy: { [SORT_FIELD[q.sort]]: q.order },
      take: q.limit,
      skip: q.offset,
    });
    const total = await prisma.dexPool.count({ where: q.protocol ? { protocol: q.protocol } : undefined });
    res.json({
      data: pools.map((p) => ({
        poolAddress: p.poolAddress,
        protocol: p.protocol,
        poolType: p.poolType,
        tokenA: p.tokenA,
        tokenB: p.tokenB,
        tokenASymbol: p.tokenASymbol,
        tokenBSymbol: p.tokenBSymbol,
        feeBps: p.feeBps,
        tvlUsd: p.tvlUsd,
        volume24hUsd: p.volume24hUsd,
        volume7dUsd: p.volume7dUsd,
        volume30dUsd: p.volume30dUsd,
        fees24hUsd: p.fees24hUsd,
        aprPct: p.aprPct,
        ilRiskScore: p.ilRiskScore,
      })),
      total,
      limit: q.limit,
      offset: q.offset,
    });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ── GET /pools/:address — detail + composition ──────────────────────────────
dexAnalyticsRouter.get('/pools/:address', async (req: Request, res: Response) => {
  try {
    const pool = await prisma.dexPool.findUnique({ where: { poolAddress: req.params.address } });
    if (!pool) return res.status(404).json({ error: 'Pool not found' });
    const { a, b } = reservesHuman(pool);
    const valueA = pool.priceAUsd != null ? a * pool.priceAUsd : null;
    const valueB = pool.priceBUsd != null ? b * pool.priceBUsd : null;
    const totalValue = (valueA ?? 0) + (valueB ?? 0);

    res.json({
      poolAddress: pool.poolAddress,
      protocol: pool.protocol,
      poolType: pool.poolType,
      feeBps: pool.feeBps,
      tokens: {
        a: { address: pool.tokenA, symbol: pool.tokenASymbol, decimals: pool.tokenADecimals, reserve: a, priceUsd: pool.priceAUsd },
        b: { address: pool.tokenB, symbol: pool.tokenBSymbol, decimals: pool.tokenBDecimals, reserve: b, priceUsd: pool.priceBUsd },
      },
      composition:
        totalValue > 0
          ? {
              a: { valueUsd: valueA, pct: valueA != null ? (valueA / totalValue) * 100 : null },
              b: { valueUsd: valueB, pct: valueB != null ? (valueB / totalValue) * 100 : null },
            }
          : null,
      metrics: {
        tvlUsd: pool.tvlUsd,
        volume1hUsd: pool.volume1hUsd,
        volume24hUsd: pool.volume24hUsd,
        volume7dUsd: pool.volume7dUsd,
        volume30dUsd: pool.volume30dUsd,
        fees24hUsd: pool.fees24hUsd,
        aprPct: pool.aprPct,
        ilRiskScore: pool.ilRiskScore,
      },
      lastSyncedAt: pool.lastSyncedAt,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /pools/:address/history — TVL/volume/APR over time ───────────────────
const historySchema = z.object({
  window: z.enum(['24h', '7d', '30d', 'all']).default('7d'),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

dexAnalyticsRouter.get('/pools/:address/history', async (req: Request, res: Response) => {
  try {
    const q = historySchema.parse(req.query);
    const windowMs: Record<string, number | null> = {
      '24h': 86_400_000,
      '7d': 7 * 86_400_000,
      '30d': 30 * 86_400_000,
      all: null,
    };
    const ms = windowMs[q.window];
    const snapshots = await prisma.poolSnapshot.findMany({
      where: {
        poolAddress: req.params.address,
        ...(ms ? { snapshotAt: { gte: new Date(Date.now() - ms) } } : {}),
      },
      orderBy: { snapshotAt: 'desc' },
      take: q.limit,
      select: { snapshotAt: true, tvlUsd: true, volume24hUsd: true, fees24hUsd: true, aprPct: true, priceAUsd: true, priceBUsd: true },
    });
    res.json({ data: snapshots.reverse(), count: snapshots.length });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ── GET /pools/:address/slippage — slippage curve / single trade ─────────────
const slippageSchema = z.object({
  side: z.enum(['a', 'b']).default('a'),
  amountIn: z.coerce.number().positive().optional(),
});

dexAnalyticsRouter.get('/pools/:address/slippage', async (req: Request, res: Response) => {
  try {
    const q = slippageSchema.parse(req.query);
    const pool = await prisma.dexPool.findUnique({ where: { poolAddress: req.params.address } });
    if (!pool) return res.status(404).json({ error: 'Pool not found' });
    const { a, b } = reservesHuman(pool);
    const [reserveIn, reserveOut] = q.side === 'a' ? [a, b] : [b, a];
    if (reserveIn <= 0 || reserveOut <= 0) return res.status(409).json({ error: 'Pool has no liquidity' });

    if (q.amountIn != null) {
      return res.json({ side: q.side, ...simulateSwap(q.amountIn, reserveIn, reserveOut, pool.feeBps) });
    }
    const sizes = defaultCurveSizes(reserveIn);
    res.json({ side: q.side, feeBps: pool.feeBps, curve: slippageCurve(reserveIn, reserveOut, pool.feeBps, sizes) });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ── GET /pools/:address/depth — liquidity depth at price-impact levels ───────
dexAnalyticsRouter.get('/pools/:address/depth', async (req: Request, res: Response) => {
  try {
    const pool = await prisma.dexPool.findUnique({ where: { poolAddress: req.params.address } });
    if (!pool) return res.status(404).json({ error: 'Pool not found' });
    const { a, b } = reservesHuman(pool);
    res.json({
      a: liquidityDepth(a, undefined, pool.priceAUsd ?? undefined),
      b: liquidityDepth(b, undefined, pool.priceBUsd ?? undefined),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /pools/:address/impermanent-loss?priceRatio= ─────────────────────────
const ilSchema = z.object({ priceRatio: z.coerce.number().positive().optional() });

dexAnalyticsRouter.get('/pools/:address/impermanent-loss', async (req: Request, res: Response) => {
  try {
    const q = ilSchema.parse(req.query);
    if (q.priceRatio != null) {
      const pct = impermanentLossPct(q.priceRatio);
      return res.json({ priceRatio: q.priceRatio, impermanentLossPct: pct, severity: impermanentLossSeverity(pct) });
    }
    // Default curve across common price moves.
    const ratios = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 5];
    res.json({
      curve: ratios.map((r) => ({ priceRatio: r, impermanentLossPct: impermanentLossPct(r), severity: impermanentLossSeverity(impermanentLossPct(r)) })),
    });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ── GET /arbitrage — live opportunities ──────────────────────────────────────
const arbSchema = z.object({
  status: z.enum(['open', 'closed', 'all']).default('open'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

dexAnalyticsRouter.get('/arbitrage', async (req: Request, res: Response) => {
  try {
    const q = arbSchema.parse(req.query);
    const opportunities = await prisma.arbitrageOpportunity.findMany({
      where: q.status === 'all' ? undefined : { status: q.status },
      orderBy: { estProfitUsd: 'desc' },
      take: q.limit,
    });
    res.json({ data: opportunities, count: opportunities.length });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ── GET /stats — engine summary ──────────────────────────────────────────────
dexAnalyticsRouter.get('/stats', async (_req: Request, res: Response) => {
  try {
    const [poolCount, byProtocol, openArbs, agg] = await Promise.all([
      prisma.dexPool.count(),
      prisma.dexPool.groupBy({ by: ['protocol'], _count: { _all: true } }),
      prisma.arbitrageOpportunity.count({ where: { status: 'open' } }),
      prisma.dexPool.aggregate({ _sum: { tvlUsd: true, volume24hUsd: true } }),
    ]);
    res.json({
      pools: poolCount,
      protocols: byProtocol.map((p) => ({ protocol: p.protocol, pools: p._count._all })),
      openArbitrageOpportunities: openArbs,
      totalTvlUsd: agg._sum.tvlUsd ?? 0,
      totalVolume24hUsd: agg._sum.volume24hUsd ?? 0,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});
