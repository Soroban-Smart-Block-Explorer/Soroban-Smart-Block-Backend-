import { Router, Request, Response } from 'express';
import { prismaRead as prisma } from '../db';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  optimizePortfolio,
  simulateDeposit,
  type RiskTolerance,
  type YieldOpportunityData,
} from '../indexer/yield-optimizer';

export const yieldRouter = Router();

type SortMode = 'apy' | 'tvl' | 'risk_adjusted';
const SORT_BY: Record<SortMode, Prisma.YieldOpportunityOrderByWithRelationInput> = {
  apy: { totalApy: 'desc' },
  // TVL is stored as a decimal string so Prisma can't sort it numerically;
  // the route layer pulls a wide page and re-sorts in memory.
  tvl: { totalApy: 'desc' },
  risk_adjusted: { riskScore: 'asc' },
};

// ---------------------------------------------------------------------------
// GET /opportunities — list all yield opportunities
// ---------------------------------------------------------------------------
yieldRouter.get('/opportunities', async (req: Request, res: Response) => {
  try {
    const querySchema = z.object({
      type: z.string().optional(),
      token: z.string().optional(),
      minApy: z.coerce.number().optional(),
      maxRisk: z.coerce.number().int().min(0).max(100).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
      offset: z.coerce.number().int().min(0).default(0),
    });
    const q = querySchema.parse(req.query);

    const where: Record<string, unknown> = {};
    if (q.type) where.type = q.type;
    if (q.minApy !== undefined) where.totalApy = { gte: q.minApy };
    if (q.maxRisk !== undefined) where.riskScore = { lte: q.maxRisk };

    let rows = await prisma.yieldOpportunity.findMany({
      where,
      orderBy: { totalApy: 'desc' },
      take: q.limit,
      skip: q.offset,
    });

    // Post-filter by token (Prisma Json columns can't easily filter on
    // any-of-string-array without raw SQL). Filter happens after taking so
    // a token filter may return fewer than `limit` rows; this is documented.
    if (q.token) {
      const needle = q.token.toUpperCase();
      rows = rows.filter((r) => {
        const arr = Array.isArray(r.tokens) ? r.tokens : [];
        return arr.some((t) => typeof t === 'string' && t.toUpperCase() === needle);
      });
    }

    res.json({
      opportunities: rows.map(serializeOpportunity),
      count: rows.length,
    });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ---------------------------------------------------------------------------
// GET /opportunities/:id — detail with latest history snapshot
// ---------------------------------------------------------------------------
yieldRouter.get('/opportunities/:id', async (req: Request, res: Response) => {
  try {
    const opp = await prisma.yieldOpportunity.findUnique({ where: { id: req.params.id } });
    if (!opp) {
      res.status(404).json({ error: 'opportunity not found' });
      return;
    }

    const latest = await prisma.yieldHistorySnapshot.findFirst({
      where: { opportunityId: opp.id },
      orderBy: { snapshotDate: 'desc' },
    });

    res.json({
      ...serializeOpportunity(opp),
      latestSnapshot: latest
        ? {
            snapshotDate: latest.snapshotDate,
            apy: latest.apy,
            baseApy: latest.baseApy,
            incentiveApy: latest.incentiveApy,
            tvl: latest.tvl,
          }
        : null,
    });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ---------------------------------------------------------------------------
// GET /opportunities/:id/history — APY history chart data
// ---------------------------------------------------------------------------
yieldRouter.get('/opportunities/:id/history', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      days: z.coerce.number().int().min(1).max(365).default(90),
    });
    const q = schema.parse(req.query);
    const since = new Date(Date.now() - q.days * 24 * 60 * 60 * 1000);

    const rows = await prisma.yieldHistorySnapshot.findMany({
      where: {
        opportunityId: req.params.id,
        snapshotDate: { gte: since },
      },
      orderBy: { snapshotDate: 'asc' },
    });

    const apySeries = rows.map((r) => r.apy);
    const trend = computeTrend(apySeries);

    res.json({
      opportunityId: req.params.id,
      snapshots: rows.map((r) => ({
        snapshotDate: r.snapshotDate,
        apy: r.apy,
        baseApy: r.baseApy,
        incentiveApy: r.incentiveApy,
        tvl: r.tvl,
      })),
      trend,
    });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ---------------------------------------------------------------------------
// GET /opportunities/:id/simulate — simulate returns for a deposit
// ---------------------------------------------------------------------------
yieldRouter.get('/opportunities/:id/simulate', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      deposit: z.string().min(1),
      periodDays: z.coerce.number().int().min(1).max(3650).default(30),
    });
    const q = schema.parse(req.query);

    const opp = await prisma.yieldOpportunity.findUnique({ where: { id: req.params.id } });
    if (!opp) {
      res.status(404).json({ error: 'opportunity not found' });
      return;
    }

    const feePct = (opp.depositFee ?? 0) + (opp.withdrawFee ?? 0);
    const sim = simulateDeposit(q.deposit, q.periodDays, opp.totalApy, feePct);

    res.json({
      opportunityId: opp.id,
      protocol: opp.contractAddress,
      pool: opp.name,
      ...sim,
    });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ---------------------------------------------------------------------------
// GET /leaderboard — top opportunities sorted by APY, TVL, or risk-adjusted
// ---------------------------------------------------------------------------
yieldRouter.get('/leaderboard', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      sort: z.enum(['apy', 'tvl', 'risk_adjusted']).default('apy'),
      limit: z.coerce.number().int().min(1).max(200).default(25),
    });
    const q = schema.parse(req.query);

    const orderBy = SORT_BY[q.sort as SortMode];
    const rows = await prisma.yieldOpportunity.findMany({
      // TVL is stored as a decimal string so Prisma can't sort it numerically;
      // we pull a wide page and re-sort by TVL in memory.
      orderBy: q.sort === 'tvl' ? { totalApy: 'desc' } : orderBy,
      take: q.sort === 'tvl' ? 500 : q.limit,
    });

    let sorted = rows;
    if (q.sort === 'tvl') {
      sorted = [...rows].sort((a, b) => parseAmount(b.tvl) - parseAmount(a.tvl)).slice(0, q.limit);
    }

    res.json({
      sort: q.sort,
      entries: sorted.map(serializeOpportunity),
      total: sorted.length,
    });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ---------------------------------------------------------------------------
// GET /compare?opportunities=A,B,C — side-by-side comparison
// ---------------------------------------------------------------------------
yieldRouter.get('/compare', async (req: Request, res: Response) => {
  try {
    const idsParam = String(req.query.opportunities ?? '');
    const ids = idsParam
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0) {
      res.status(400).json({ error: 'opportunities query param required (comma-separated ids)' });
      return;
    }

    const rows = await prisma.yieldOpportunity.findMany({
      where: { id: { in: ids } },
    });

    res.json({
      count: rows.length,
      opportunities: rows.map(serializeOpportunity),
    });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ---------------------------------------------------------------------------
// POST /optimize — risk-aware portfolio allocation
// ---------------------------------------------------------------------------
const optimizeBodySchema = z.object({
  amount: z.string().min(1),
  tokens: z.array(z.string()).optional(),
  riskTolerance: z.enum(['conservative', 'moderate', 'aggressive']).default('moderate'),
  minAPY: z.coerce.number().optional(),
  minTVL: z.coerce.number().optional(),
});

yieldRouter.post('/optimize', async (req: Request, res: Response) => {
  try {
    const body = optimizeBodySchema.parse(req.body);
    const rows = await prisma.yieldOpportunity.findMany({
      orderBy: { totalApy: 'desc' },
      take: 500,
    });

    const opportunities: YieldOpportunityData[] = rows.map((r) => ({
      contractAddress: r.contractAddress,
      name: r.name,
      type: r.type as YieldOpportunityData['type'],
      tokens: Array.isArray(r.tokens) ? (r.tokens as string[]) : [],
      baseApy: r.baseApy,
      incentiveApy: r.incentiveApy,
      tvl: r.tvl,
      lockupDays: r.lockupDays,
      minDeposit: r.minDeposit,
      depositFee: r.depositFee,
      withdrawFee: r.withdrawFee,
    }));

    const result = optimizePortfolio({
      amount: body.amount,
      tokens: body.tokens,
      riskTolerance: body.riskTolerance as RiskTolerance,
      minAPY: body.minAPY,
      minTVL: body.minTVL,
      opportunities,
    });

    res.json({
      ...result,
      requestedAmount: body.amount,
      riskTolerance: body.riskTolerance,
      candidateCount: opportunities.length,
    });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseAmount(s: string | undefined): number {
  if (!s) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function computeTrend(apySeries: number[]): 'rising' | 'falling' | 'flat' {
  if (apySeries.length < 2) return 'flat';
  const mid = Math.floor(apySeries.length / 2);
  const first = apySeries.slice(0, mid);
  const last = apySeries.slice(mid);
  const avg = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((s, v) => s + v, 0) / xs.length);
  const delta = avg(last) - avg(first);
  if (Math.abs(delta) < 0.5) return 'flat';
  return delta > 0 ? 'rising' : 'falling';
}

function serializeOpportunity(r: {
  id: string;
  contractAddress: string;
  name: string;
  type: string;
  tokens: unknown;
  baseApy: number;
  incentiveApy: number;
  totalApy: number;
  tvl: string;
  lockupDays: number;
  minDeposit: string;
  depositFee: number;
  withdrawFee: number;
  riskScore: number;
  riskLabel: string;
  lastObservedAt: Date;
}) {
  return {
    id: r.id,
    protocol: r.contractAddress,
    name: r.name,
    type: r.type,
    tokens: Array.isArray(r.tokens) ? r.tokens : [],
    baseApy: r.baseApy,
    incentiveApy: r.incentiveApy,
    totalApy: r.totalApy,
    tvl: r.tvl,
    lockupDays: r.lockupDays,
    minDeposit: r.minDeposit,
    depositFee: r.depositFee,
    withdrawFee: r.withdrawFee,
    risk: r.riskLabel,
    riskScore: r.riskScore,
    lastObservedAt: r.lastObservedAt,
  };
}
