/**
 * GET  /api/v1/token-holders/:address/holders      — paginated holder list with balances
 * GET  /api/v1/token-holders/:address/concentration — Nakamoto, HHI, Gini coefficients
 * GET  /api/v1/token-holders/:address/behavior      — cohort retention, diamond/paper hands
 * GET  /api/v1/token-holders/:address/whale-alerts  — recent whale movement alerts
 * GET  /api/v1/token-holders/:address/top-holders   — top N holders ranked by balance
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prismaRead } from '../db';
import { asyncHandler } from '../middleware/asyncHandler';

export const tokenHoldersRouter = Router();

// ── Helpers ──────────────────────────────────────────────────────────────────

function giniCoefficient(sortedBalances: number[]): number {
  if (sortedBalances.length === 0) return 0;
  const n = sortedBalances.length;
  const sum = sortedBalances.reduce((a, b) => a + b, 0);
  if (sum === 0) return 0;
  let numerator = 0;
  for (let i = 0; i < n; i++) {
    numerator += (2 * (i + 1) - n - 1) * sortedBalances[i];
  }
  return Math.abs(numerator / (n * sum));
}

function herfindahlIndex(shares: number[]): number {
  return shares.reduce((s, p) => s + p * p, 0);
}

function nakamotoCoefficient(sortedDescBalances: number[], total: number): number {
  let cumulative = 0;
  for (let i = 0; i < sortedDescBalances.length; i++) {
    cumulative += sortedDescBalances[i];
    if (cumulative / total > 0.5) return i + 1;
  }
  return sortedDescBalances.length;
}

// ── GET /:address/holders ─────────────────────────────────────────────────────

tokenHoldersRouter.get(
  '/:address/holders',
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    const schema = z.object({
      limit: z.coerce.number().min(1).max(1000).default(100),
      offset: z.coerce.number().min(0).default(0),
      minBalance: z.coerce.number().optional(),
    });
    const { limit, offset, minBalance } = schema.parse(req.query);

    const where = {
      contractAddress: address,
      ...(minBalance !== undefined ? { balanceRaw: { gte: minBalance } } : {}),
    };

    const [holders, total] = await Promise.all([
      prismaRead.tokenHolder.findMany({
        where,
        orderBy: { balanceRaw: 'desc' },
        take: limit,
        skip: offset,
      }),
      prismaRead.tokenHolder.count({ where }),
    ]);

    res.json({
      contract: address,
      total,
      offset,
      limit,
      holders: holders.map((h) => ({
        address: h.holderAddress,
        balance: h.balance,
        percentage: Number(h.percentage.toFixed(4)),
        rank: h.rank,
        firstSeenAt: h.firstSeenAt,
        lastUpdatedAt: h.lastUpdatedAt,
      })),
    });
  }),
);

// ── GET /:address/top-holders ─────────────────────────────────────────────────

tokenHoldersRouter.get(
  '/:address/top-holders',
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    const { n } = z.object({ n: z.coerce.number().min(1).max(1000).default(100) }).parse(req.query);

    const holders = await prismaRead.tokenHolder.findMany({
      where: { contractAddress: address },
      orderBy: { balanceRaw: 'desc' },
      take: n,
    });

    const totalHolders = await prismaRead.tokenHolder.count({
      where: { contractAddress: address },
    });

    const top10Pct = holders.slice(0, 10).reduce((s, h) => s + h.percentage, 0);
    const top100Pct = holders.slice(0, 100).reduce((s, h) => s + h.percentage, 0);

    res.json({
      contract: address,
      totalHolders,
      top10ConcentrationPct: Number(top10Pct.toFixed(2)),
      top100ConcentrationPct: Number(top100Pct.toFixed(2)),
      holders: holders.map((h, i) => ({
        rank: i + 1,
        address: h.holderAddress,
        balance: h.balance,
        percentage: Number(h.percentage.toFixed(4)),
      })),
    });
  }),
);

// ── GET /:address/concentration ───────────────────────────────────────────────

tokenHoldersRouter.get(
  '/:address/concentration',
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;

    const latest = await prismaRead.tokenConcentrationMetrics.findFirst({
      where: { contractAddress: address },
      orderBy: { computedAt: 'desc' },
    });

    if (latest) {
      return res.json({
        contract: address,
        computedAt: latest.computedAt,
        totalHolders: latest.totalHolders,
        totalSupply: latest.totalSupply,
        nakamotoCoefficient: latest.nakamotoCoefficient,
        hhi: latest.hhi,
        giniCoefficient: latest.giniCoefficient,
        top10Pct: latest.top10Pct,
        top100Pct: latest.top100Pct,
        cached: true,
      });
    }

    // Compute on-the-fly if not cached
    const holders = await prismaRead.tokenHolder.findMany({
      where: { contractAddress: address },
      orderBy: { balanceRaw: 'desc' },
      select: { balanceRaw: true, percentage: true },
    });

    if (holders.length === 0) {
      return res.status(404).json({ error: 'No holder data found for this contract' });
    }

    const balances = holders.map((h) => h.balanceRaw);
    const balancesAsc = [...balances].sort((a, b) => a - b);
    const total = balances.reduce((a, b) => a + b, 0);
    const shares = holders.map((h) => h.percentage / 100);

    const top10 = holders.slice(0, 10).reduce((s, h) => s + h.percentage, 0);
    const top100 = holders.slice(0, 100).reduce((s, h) => s + h.percentage, 0);

    const metrics = {
      nakamotoCoefficient: nakamotoCoefficient(balances, total),
      hhi: Number(herfindahlIndex(shares).toFixed(6)),
      giniCoefficient: Number(giniCoefficient(balancesAsc).toFixed(4)),
      top10Pct: Number(top10.toFixed(2)),
      top100Pct: Number(top100.toFixed(2)),
      totalHolders: holders.length,
    };

    res.json({
      contract: address,
      computedAt: new Date(),
      totalSupply: String(total),
      ...metrics,
      cached: false,
    });
  }),
);

// ── GET /:address/behavior ────────────────────────────────────────────────────

tokenHoldersRouter.get(
  '/:address/behavior',
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;

    const cohorts = await prismaRead.holderCohort.findMany({
      where: { contractAddress: address },
      orderBy: { cohortStart: 'desc' },
      take: 12,
    });

    const holders = await prismaRead.tokenHolder.findMany({
      where: { contractAddress: address },
      select: { balanceRaw: true, firstSeenAt: true, lastUpdatedAt: true },
    });

    const now = Date.now();
    let diamondHands = 0;
    let paperHands = 0;
    const holdTimesMs: number[] = [];

    for (const h of holders) {
      const holdMs = now - h.firstSeenAt.getTime();
      holdTimesMs.push(holdMs);
      if (holdMs > 90 * 86400e3) {
        diamondHands++;
      } else if (holdMs < 7 * 86400e3) {
        paperHands++;
      }
    }

    const avgHoldDays =
      holdTimesMs.length > 0
        ? Number((holdTimesMs.reduce((a, b) => a + b, 0) / holdTimesMs.length / 86400e3).toFixed(1))
        : 0;

    const holdersByJoinMonth: Record<string, number> = {};
    for (const h of holders) {
      const month = h.firstSeenAt.toISOString().slice(0, 7);
      holdersByJoinMonth[month] = (holdersByJoinMonth[month] ?? 0) + 1;
    }

    res.json({
      contract: address,
      totalHolders: holders.length,
      classification: {
        diamondHands,
        paperHands,
        neutral: holders.length - diamondHands - paperHands,
        diamondHandsPct:
          holders.length > 0 ? Number(((diamondHands / holders.length) * 100).toFixed(1)) : 0,
        paperHandsPct:
          holders.length > 0 ? Number(((paperHands / holders.length) * 100).toFixed(1)) : 0,
      },
      avgHoldTimeDays: avgHoldDays,
      holderGrowthByMonth: Object.entries(holdersByJoinMonth)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, count]) => ({ month, newHolders: count })),
      cohortRetention: cohorts.map((c) => ({
        cohortPeriod: c.cohortPeriod,
        cohortStart: c.cohortStart,
        initialHolders: c.initialHolders,
        retainedAt30d: c.retainedAt30d,
        retainedAt60d: c.retainedAt60d,
        retainedAt90d: c.retainedAt90d,
        retention30dPct:
          c.retainedAt30d && c.initialHolders > 0
            ? Number(((c.retainedAt30d / c.initialHolders) * 100).toFixed(1))
            : null,
        retention90dPct:
          c.retainedAt90d && c.initialHolders > 0
            ? Number(((c.retainedAt90d / c.initialHolders) * 100).toFixed(1))
            : null,
        avgHoldTimeDays: c.avgHoldTime,
      })),
    });
  }),
);

// ── GET /:address/whale-alerts ────────────────────────────────────────────────

tokenHoldersRouter.get(
  '/:address/whale-alerts',
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    const schema = z.object({
      limit: z.coerce.number().min(1).max(200).default(50),
      alertType: z.string().optional(),
      since: z.string().optional(),
    });
    const { limit, alertType, since } = schema.parse(req.query);

    const alerts = await prismaRead.whaleAlert.findMany({
      where: {
        contractAddress: address,
        ...(alertType ? { alertType } : {}),
        ...(since ? { detectedAt: { gte: new Date(since) } } : {}),
      },
      orderBy: { detectedAt: 'desc' },
      take: limit,
    });

    res.json({
      contract: address,
      count: alerts.length,
      alerts: alerts.map((a) => ({
        id: a.id,
        holder: a.holderAddress,
        alertType: a.alertType,
        oldBalance: a.oldBalance,
        newBalance: a.newBalance,
        changeAmt: a.changeAmt,
        changePct: a.changePct,
        txHash: a.txHash,
        detectedAt: a.detectedAt,
      })),
    });
  }),
);
