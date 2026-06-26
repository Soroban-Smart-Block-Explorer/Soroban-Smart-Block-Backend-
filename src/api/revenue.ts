/**
 * Revenue Analytics API — Fee Intelligence Platform
 *
 * Mounts at /api/v1/revenue
 *
 * Core endpoints (Must-Have):
 *   GET  /contracts/:address
 *   GET  /contracts/:address/history
 *   GET  /contracts/:address/breakdown
 *   GET  /contracts/:address/yields
 *   GET  /leaderboard
 *   GET  /network
 *   GET  /compare
 *   GET  /events
 *   GET  /alerts
 *   GET  /discover
 *
 * Advanced endpoints (Should-Have):
 *   POST /predict/:address
 *   GET  /portfolio/:userAddress
 *   GET  /fee-structures
 *   POST /fee-structures/:address
 *   GET  /export
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prismaRead, prismaWrite } from '../db';
import {
  discoverFeeContracts,
  computeApy,
} from '../indexer/fee-classifier';
import { predictRevenue } from '../indexer/fee-aggregator';

export const revenueRouter = Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function periodParam(raw: unknown): 'HOUR' | 'DAY' | 'WEEK' | 'MONTH' {
  const map: Record<string, 'HOUR' | 'DAY' | 'WEEK' | 'MONTH'> = {
    hour: 'HOUR', day: 'DAY', week: 'WEEK', month: 'MONTH',
  };
  return map[String(raw ?? 'day').toLowerCase()] ?? 'DAY';
}

function serializeRevenue(r: {
  id: string;
  contractAddress: string;
  protocolName: string | null;
  period: string;
  timestamp: Date;
  totalFees: unknown;
  swapFees: unknown;
  withdrawFees: unknown;
  performanceFees: unknown;
  protocolFees: unknown;
  liquidationFees: unknown;
  interestSpread: unknown;
  flashLoanFees: unknown;
  referralFees: unknown;
  lpRewards: unknown;
  treasuryAmount: unknown;
  burnedAmount: unknown;
  stakerRewards: unknown;
  insuranceFund: unknown;
  ecosystemFund: unknown;
  teamVesting: unknown;
  feeToken: string;
  usdValue: number | null;
  txCount: number;
  uniqueUsers: number | null;
}) {
  return {
    id: r.id,
    contractAddress: r.contractAddress,
    protocolName: r.protocolName,
    period: r.period,
    timestamp: r.timestamp,
    totalFees: toNum(r.totalFees),
    feeBreakdown: {
      swap: toNum(r.swapFees),
      withdrawal: toNum(r.withdrawFees),
      performance: toNum(r.performanceFees),
      protocol: toNum(r.protocolFees),
      liquidation: toNum(r.liquidationFees),
      interestSpread: toNum(r.interestSpread),
      flashLoan: toNum(r.flashLoanFees),
      referral: toNum(r.referralFees),
    },
    distribution: {
      lpRewards: toNum(r.lpRewards),
      treasury: toNum(r.treasuryAmount),
      buybackBurn: toNum(r.burnedAmount),
      stakerRewards: toNum(r.stakerRewards),
      insuranceFund: toNum(r.insuranceFund),
      ecosystemFund: toNum(r.ecosystemFund),
      teamVesting: toNum(r.teamVesting),
    },
    feeToken: r.feeToken,
    usdValue: r.usdValue,
    txCount: r.txCount,
    uniqueUsers: r.uniqueUsers,
  };
}

// ---------------------------------------------------------------------------
// 1. GET /contracts/:address — full revenue profile
// ---------------------------------------------------------------------------

revenueRouter.get('/contracts/:address', async (req: Request, res: Response) => {
  try {
    const { address } = req.params;

    const [profile, latest, totalAgg] = await Promise.all([
      prismaRead.protocolProfile.findUnique({ where: { contractAddress: address } }),
      prismaRead.protocolRevenue.findFirst({
        where: { contractAddress: address, period: 'DAY' },
        orderBy: { timestamp: 'desc' },
      }),
      prismaRead.protocolRevenue.aggregate({
        where: { contractAddress: address, period: 'DAY' },
        _sum: { totalFees: true, usdValue: true },
        _count: { id: true },
      }),
    ]);

    if (!latest && !profile) {
      res.status(404).json({ error: 'contract not found' });
      return;
    }

    res.json({
      contractAddress: address,
      profile: profile ?? null,
      latestDayRevenue: latest ? serializeRevenue(latest) : null,
      allTime: {
        totalFees: toNum(totalAgg._sum.totalFees),
        usdValue: totalAgg._sum.usdValue ?? 0,
        dayCount: totalAgg._count.id,
      },
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------------------------------------------------------------------------
// 2. GET /contracts/:address/history
// ---------------------------------------------------------------------------

revenueRouter.get('/contracts/:address/history', async (req: Request, res: Response) => {
  try {
    const { address } = req.params;
    const schema = z.object({
      days: z.coerce.number().int().min(1).max(365).default(30),
      period: z.string().optional(),
    });
    const q = schema.parse(req.query);
    const since = new Date(Date.now() - q.days * 24 * 60 * 60 * 1000);

    const rows = await prismaRead.protocolRevenue.findMany({
      where: {
        contractAddress: address,
        period: periodParam(q.period),
        timestamp: { gte: since },
      },
      orderBy: { timestamp: 'asc' },
    });

    res.json({
      contractAddress: address,
      period: periodParam(q.period),
      days: q.days,
      history: rows.map(serializeRevenue),
    });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ---------------------------------------------------------------------------
// 3. GET /contracts/:address/breakdown
// ---------------------------------------------------------------------------

revenueRouter.get('/contracts/:address/breakdown', async (req: Request, res: Response) => {
  try {
    const { address } = req.params;
    const schema = z.object({ period: z.string().optional() });
    const q = schema.parse(req.query);

    const latest = await prismaRead.protocolRevenue.findFirst({
      where: { contractAddress: address, period: periodParam(q.period) },
      orderBy: { timestamp: 'desc' },
    });

    if (!latest) {
      res.status(404).json({ error: 'no revenue data found' });
      return;
    }

    const total = toNum(latest.totalFees);
    const pct = (v: unknown) => (total > 0 ? ((toNum(v) / total) * 100).toFixed(2) : '0');

    res.json({
      contractAddress: address,
      period: periodParam(q.period),
      timestamp: latest.timestamp,
      totalFees: total,
      feeTypeBreakdown: {
        swap:           { amount: toNum(latest.swapFees),        pct: pct(latest.swapFees) },
        withdrawal:     { amount: toNum(latest.withdrawFees),    pct: pct(latest.withdrawFees) },
        performance:    { amount: toNum(latest.performanceFees), pct: pct(latest.performanceFees) },
        protocol:       { amount: toNum(latest.protocolFees),    pct: pct(latest.protocolFees) },
        liquidation:    { amount: toNum(latest.liquidationFees), pct: pct(latest.liquidationFees) },
        interestSpread: { amount: toNum(latest.interestSpread),  pct: pct(latest.interestSpread) },
        flashLoan:      { amount: toNum(latest.flashLoanFees),   pct: pct(latest.flashLoanFees) },
        referral:       { amount: toNum(latest.referralFees),    pct: pct(latest.referralFees) },
      },
      destinationBreakdown: {
        lpRewards:    { amount: toNum(latest.lpRewards),      pct: pct(latest.lpRewards) },
        treasury:     { amount: toNum(latest.treasuryAmount), pct: pct(latest.treasuryAmount) },
        buybackBurn:  { amount: toNum(latest.burnedAmount),   pct: pct(latest.burnedAmount) },
        stakerRewards:{ amount: toNum(latest.stakerRewards),  pct: pct(latest.stakerRewards) },
        insuranceFund:{ amount: toNum(latest.insuranceFund),  pct: pct(latest.insuranceFund) },
        ecosystemFund:{ amount: toNum(latest.ecosystemFund),  pct: pct(latest.ecosystemFund) },
        teamVesting:  { amount: toNum(latest.teamVesting),    pct: pct(latest.teamVesting) },
      },
    });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ---------------------------------------------------------------------------
// 4. GET /contracts/:address/yields
// ---------------------------------------------------------------------------

revenueRouter.get('/contracts/:address/yields', async (req: Request, res: Response) => {
  try {
    const { address } = req.params;

    const snapshot = await prismaRead.yieldSnapshot.findFirst({
      where: { contractAddress: address },
      orderBy: { timestamp: 'desc' },
    });

    if (!snapshot) {
      res.status(404).json({ error: 'no yield data found' });
      return;
    }

    res.json({
      contractAddress: address,
      protocolName: snapshot.protocolName,
      timestamp: snapshot.timestamp,
      lp: {
        apr1d: snapshot.lpApr1d,
        apr7d: snapshot.lpApr7d,
        apr30d: snapshot.lpApr30d,
        apy30d: snapshot.lpApr30d != null ? computeApy(snapshot.lpApr30d) : null,
      },
      staking: {
        apr1d: snapshot.stakingApr1d,
        apr7d: snapshot.stakingApr7d,
        apr30d: snapshot.stakingApr30d,
        apy30d: snapshot.stakingApr30d != null ? computeApy(snapshot.stakingApr30d) : null,
      },
      tvl: snapshot.totalValueLocked,
      stakedValue: snapshot.stakedValue,
      revenueShare: snapshot.revenueShare,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------------------------------------------------------------------------
// 5. GET /leaderboard
// ---------------------------------------------------------------------------

revenueRouter.get('/leaderboard', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      period: z.enum(['24h', '7d', '30d']).default('24h'),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    });
    const q = schema.parse(req.query);

    const days = q.period === '24h' ? 1 : q.period === '7d' ? 7 : 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const agg = await prismaRead.protocolRevenue.groupBy({
      by: ['contractAddress', 'protocolName'],
      where: { timestamp: { gte: since }, period: 'DAY' },
      _sum: { totalFees: true, usdValue: true },
      _count: { id: true },
      orderBy: { _sum: { totalFees: 'desc' } },
      take: q.limit,
    });

    res.json({
      period: q.period,
      leaderboard: agg.map((r, i) => ({
        rank: i + 1,
        contractAddress: r.contractAddress,
        protocolName: r.protocolName,
        totalFees: toNum(r._sum.totalFees),
        usdValue: r._sum.usdValue ?? 0,
        txCount: r._count.id,
      })),
    });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ---------------------------------------------------------------------------
// 6. GET /network — aggregate Soroban protocol revenue
// ---------------------------------------------------------------------------

revenueRouter.get('/network', async (_req: Request, res: Response) => {
  try {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const since7d  = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [agg24h, agg7d, agg30d, protocolCount] = await Promise.all([
      prismaRead.protocolRevenue.aggregate({
        where: { period: 'DAY', timestamp: { gte: since24h } },
        _sum: { totalFees: true, usdValue: true },
        _count: { id: true },
      }),
      prismaRead.protocolRevenue.aggregate({
        where: { period: 'DAY', timestamp: { gte: since7d } },
        _sum: { totalFees: true, usdValue: true },
      }),
      prismaRead.protocolRevenue.aggregate({
        where: { period: 'DAY', timestamp: { gte: since30d } },
        _sum: { totalFees: true, usdValue: true },
      }),
      prismaRead.protocolRevenue.findMany({
        select: { contractAddress: true },
        distinct: ['contractAddress'],
      }),
    ]);

    res.json({
      network: 'soroban',
      revenue: {
        '24h': { totalFees: toNum(agg24h._sum.totalFees), usdValue: agg24h._sum.usdValue ?? 0 },
        '7d':  { totalFees: toNum(agg7d._sum.totalFees),  usdValue: agg7d._sum.usdValue ?? 0 },
        '30d': { totalFees: toNum(agg30d._sum.totalFees), usdValue: agg30d._sum.usdValue ?? 0 },
      },
      activeProtocols: protocolCount.length,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------------------------------------------------------------------------
// 7. GET /compare — cross-protocol fee comparison
// ---------------------------------------------------------------------------

revenueRouter.get('/compare', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      category: z.string().optional(),
      metric: z.enum(['fee_percentage', 'total_revenue', 'usd_value']).default('total_revenue'),
      limit: z.coerce.number().int().min(1).max(100).default(20),
    });
    const q = schema.parse(req.query);

    const profileWhere = q.category ? { category: q.category } : {};
    const profiles = await prismaRead.protocolProfile.findMany({
      where: profileWhere,
      take: 200,
    });
    const addresses = profiles.map((p) => p.contractAddress);

    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const agg = await prismaRead.protocolRevenue.groupBy({
      by: ['contractAddress'],
      where: { contractAddress: { in: addresses }, period: 'DAY', timestamp: { gte: since7d } },
      _sum: { totalFees: true, usdValue: true },
      _avg: { usdValue: true },
      orderBy: { _sum: { totalFees: 'desc' } },
      take: q.limit,
    });

    const profileMap = new Map(profiles.map((p) => [p.contractAddress, p]));

    res.json({
      category: q.category ?? 'all',
      metric: q.metric,
      window: '7d',
      protocols: agg.map((r) => {
        const p = profileMap.get(r.contractAddress);
        return {
          contractAddress: r.contractAddress,
          protocolName: p?.protocolName ?? null,
          category: p?.category ?? null,
          totalFees7d: toNum(r._sum.totalFees),
          usdValue7d: r._sum.usdValue ?? 0,
          avgFeePercent: p?.avgFeePercent ?? null,
          tvl: p?.tvl ?? null,
        };
      }),
    });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ---------------------------------------------------------------------------
// 8. GET /events — raw fee events
// ---------------------------------------------------------------------------

revenueRouter.get('/events', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      contract: z.string().optional(),
      type: z.string().optional(),
      destination: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(500).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    });
    const q = schema.parse(req.query);

    const where: Record<string, unknown> = {};
    if (q.contract) where.contractAddress = q.contract;
    if (q.type) where.feeType = q.type.toUpperCase();
    if (q.destination) where.destination = q.destination.toUpperCase();
    if (q.from || q.to) {
      where.timestamp = {
        ...(q.from ? { gte: new Date(q.from) } : {}),
        ...(q.to ? { lte: new Date(q.to) } : {}),
      };
    }

    const [events, total] = await Promise.all([
      prismaRead.feeEvent.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        take: q.limit,
        skip: q.offset,
      }),
      prismaRead.feeEvent.count({ where }),
    ]);

    res.json({ data: events, total, limit: q.limit, offset: q.offset });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ---------------------------------------------------------------------------
// 9. GET /alerts — revenue anomaly alerts
// ---------------------------------------------------------------------------

revenueRouter.get('/alerts', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      contract: z.string().optional(),
      severity: z.string().optional(),
      acknowledged: z.coerce.boolean().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    });
    const q = schema.parse(req.query);

    const where: Record<string, unknown> = {};
    if (q.contract) where.contractAddress = q.contract;
    if (q.severity) where.severity = q.severity;
    if (q.acknowledged !== undefined) where.acknowledged = q.acknowledged;

    const [alerts, total] = await Promise.all([
      prismaRead.revenueAlert.findMany({
        where,
        orderBy: { detectedAt: 'desc' },
        take: q.limit,
      }),
      prismaRead.revenueAlert.count({ where }),
    ]);

    res.json({ data: alerts, total });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// PATCH /alerts/:id/acknowledge
revenueRouter.patch('/alerts/:id/acknowledge', async (req: Request, res: Response) => {
  try {
    const alert = await prismaWrite.revenueAlert.update({
      where: { id: req.params.id },
      data: { acknowledged: true },
    });
    res.json(alert);
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ---------------------------------------------------------------------------
// 10. GET /discover — newly detected fee-collecting contracts
// ---------------------------------------------------------------------------

revenueRouter.get('/discover', async (_req: Request, res: Response) => {
  try {
    const newContracts = await discoverFeeContracts();
    res.json({
      discovered: newContracts.length,
      contracts: newContracts,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------------------------------------------------------------------------
// 11. POST /predict/:address — predictive revenue model (Should-Have)
// ---------------------------------------------------------------------------

revenueRouter.post('/predict/:address', async (req: Request, res: Response) => {
  try {
    const bodySchema = z.object({
      forecastDays: z.coerce.number().int().min(1).max(90).default(30),
      model: z.enum(['linear', 'arima']).default('arima'),
    });
    const body = bodySchema.parse(req.body);

    const { address } = req.params;
    const history = await prismaRead.protocolRevenue.findMany({
      where: { contractAddress: address, period: 'DAY' },
      orderBy: { timestamp: 'asc' },
      take: 90,
    });

    if (history.length < 3) {
      res.status(422).json({ error: 'insufficient history for prediction (need ≥3 days)' });
      return;
    }

    const values = history.map((r) => toNum(r.totalFees));
    const { dates, revenue, lower, upper } = predictRevenue(values, body.forecastDays);

    res.json({
      contractAddress: address,
      model: body.model,
      features: ['historical_revenue'],
      forecastDays: body.forecastDays,
      prediction: {
        dates,
        revenue,
        confidenceIntervals: { lower, upper },
      },
    });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ---------------------------------------------------------------------------
// 12. GET /portfolio/:userAddress — aggregate yields for a user (Should-Have)
// ---------------------------------------------------------------------------

revenueRouter.get('/portfolio/:userAddress', async (req: Request, res: Response) => {
  try {
    const { userAddress } = req.params;
    const schema = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });
    const q = schema.parse(req.query);
    const since = new Date(Date.now() - q.days * 24 * 60 * 60 * 1000);

    // Find all fee events where this user is the sender (earned fees returned to them)
    const events = await prismaRead.feeEvent.findMany({
      where: { sender: userAddress, timestamp: { gte: since } },
      orderBy: { timestamp: 'asc' },
    });

    const byProtocol = new Map<string, { earned: number; usd: number }>();
    let totalUsd = 0;

    for (const e of events) {
      const key = e.contractAddress;
      const entry = byProtocol.get(key) ?? { earned: 0, usd: 0 };
      entry.earned += toNum(e.amount);
      entry.usd += e.usdValue ?? 0;
      totalUsd += e.usdValue ?? 0;
      byProtocol.set(key, entry);
    }

    // Enrich with protocol names and yield snapshots
    const addresses = Array.from(byProtocol.keys());
    const [profiles, snapshots] = await Promise.all([
      prismaRead.protocolProfile.findMany({ where: { contractAddress: { in: addresses } } }),
      prismaRead.yieldSnapshot.findMany({
        where: { contractAddress: { in: addresses } },
        orderBy: { timestamp: 'desc' },
        distinct: ['contractAddress'],
      }),
    ]);

    const profileMap = new Map(profiles.map((p) => [p.contractAddress, p]));
    const snapshotMap = new Map(snapshots.map((s) => [s.contractAddress, s]));

    const byProtocolArr = Array.from(byProtocol.entries())
      .map(([addr, { earned, usd }]) => {
        const p = profileMap.get(addr);
        const s = snapshotMap.get(addr);
        return {
          contractAddress: addr,
          protocolName: p?.protocolName ?? null,
          category: p?.category ?? null,
          earned,
          earnedUsd: usd,
          share: totalUsd > 0 ? parseFloat(((usd / totalUsd) * 100).toFixed(2)) : 0,
          currentApr30d: s?.lpApr30d ?? null,
          currentApy30d: s?.lpApr30d != null ? computeApy(s.lpApr30d) : null,
        };
      })
      .sort((a, b) => b.earnedUsd - a.earnedUsd);

    res.json({
      userAddress,
      days: q.days,
      totalEarned: `${totalUsd.toFixed(2)} USD`,
      byProtocol: byProtocolArr,
    });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ---------------------------------------------------------------------------
// 13. GET /fee-structures — all known fee schedules (Should-Have)
// ---------------------------------------------------------------------------

revenueRouter.get('/fee-structures', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      category: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    });
    const q = schema.parse(req.query);

    const where = q.category ? { category: q.category } : {};
    const profiles = await prismaRead.protocolProfile.findMany({
      where,
      take: q.limit,
      orderBy: { lastUpdatedAt: 'desc' },
    });

    res.json({
      count: profiles.length,
      feeStructures: profiles.map((p) => ({
        contractAddress: p.contractAddress,
        protocolName: p.protocolName,
        category: p.category,
        avgFeePercent: p.avgFeePercent,
        feeStructure: p.feeStructure,
        tvl: p.tvl,
        lastUpdatedAt: p.lastUpdatedAt,
      })),
    });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// POST /fee-structures/:address — register or update fee structure
revenueRouter.post('/fee-structures/:address', async (req: Request, res: Response) => {
  try {
    const bodySchema = z.object({
      protocolName: z.string().min(1),
      category: z.enum(['dex', 'lending', 'vault', 'derivatives', 'launchpad']),
      avgFeePercent: z.number().optional(),
      feeStructure: z.record(z.unknown()).optional(),
      logoUrl: z.string().url().optional(),
      website: z.string().url().optional(),
      twitter: z.string().optional(),
      discord: z.string().optional(),
    });
    const body = bodySchema.parse(req.body);
    const { address } = req.params;

    const profile = await prismaWrite.protocolProfile.upsert({
      where: { contractAddress: address },
      create: {
        contractAddress: address,
        protocolName: body.protocolName,
        category: body.category,
        avgFeePercent: body.avgFeePercent,
        feeStructure: (body.feeStructure ?? null) as never,
        logoUrl: body.logoUrl,
        website: body.website,
        twitter: body.twitter,
        discord: body.discord,
      },
      update: {
        protocolName: body.protocolName,
        category: body.category,
        avgFeePercent: body.avgFeePercent,
        feeStructure: body.feeStructure as never,
        logoUrl: body.logoUrl,
        website: body.website,
        twitter: body.twitter,
        discord: body.discord,
      },
    });

    res.status(201).json(profile);
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ---------------------------------------------------------------------------
// 14. GET /export — CSV/JSON revenue export (Should-Have)
// ---------------------------------------------------------------------------

revenueRouter.get('/export', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      format: z.enum(['csv', 'json']).default('json'),
      contract: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      period: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(10000).default(1000),
    });
    const q = schema.parse(req.query);

    const where: Record<string, unknown> = {};
    if (q.contract) where.contractAddress = q.contract;
    if (q.period) where.period = periodParam(q.period);
    if (q.from || q.to) {
      where.timestamp = {
        ...(q.from ? { gte: new Date(q.from) } : {}),
        ...(q.to ? { lte: new Date(q.to) } : {}),
      };
    }

    const rows = await prismaRead.protocolRevenue.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      take: q.limit,
    });

    if (q.format === 'csv') {
      const header = [
        'contractAddress', 'protocolName', 'period', 'timestamp',
        'totalFees', 'swapFees', 'withdrawFees', 'performanceFees',
        'protocolFees', 'liquidationFees', 'interestSpread', 'flashLoanFees',
        'referralFees', 'lpRewards', 'treasuryAmount', 'burnedAmount',
        'stakerRewards', 'insuranceFund', 'ecosystemFund', 'teamVesting',
        'feeToken', 'usdValue', 'txCount', 'uniqueUsers',
      ].join(',');

      const lines = rows.map((r) =>
        [
          r.contractAddress, r.protocolName ?? '', r.period, r.timestamp.toISOString(),
          r.totalFees, r.swapFees ?? '', r.withdrawFees ?? '', r.performanceFees ?? '',
          r.protocolFees ?? '', r.liquidationFees ?? '', r.interestSpread ?? '',
          r.flashLoanFees ?? '', r.referralFees ?? '', r.lpRewards ?? '',
          r.treasuryAmount ?? '', r.burnedAmount ?? '', r.stakerRewards ?? '',
          r.insuranceFund ?? '', r.ecosystemFund ?? '', r.teamVesting ?? '',
          r.feeToken, r.usdValue ?? '', r.txCount, r.uniqueUsers ?? '',
        ].join(','),
      );

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="revenue_export.csv"');
      res.send([header, ...lines].join('\n'));
      return;
    }

    res.json({ count: rows.length, data: rows.map(serializeRevenue) });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});
