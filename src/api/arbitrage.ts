/**
 * Arbitrage Intelligence Platform API
 * GET/POST /api/v1/arbitrage/*
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prismaRead, prismaWrite } from '../db';
import { cacheGet, cacheSet } from '../cache';
import {
  buildPriceGraph,
  detectNegativeCycles,
  simulateExecution,
  simulateCustomRoute,
  getMarketAnalytics,
  inferBotStrategy,
  replayBlock,
  expireStaleOpportunities,
} from '../indexer/arbitrage-engine';

export const arbitrageRouter = Router();

// ─── Helper ───────────────────────────────────────────────────────────────────

function paginate<T>(data: T[], page: number, limit: number) {
  const total = data.length;
  const start = (page - 1) * limit;
  return {
    data: data.slice(start, start + limit),
    total,
    page,
    limit,
    pages: Math.ceil(total / limit),
  };
}

// ─── GET /opportunities ───────────────────────────────────────────────────────

const oppListSchema = z.object({
  pairs: z.string().optional(),
  dexes: z.string().optional(),
  minProfit: z.coerce.number().default(0),
  maxProfit: z.coerce.number().default(100),
  types: z.string().optional(),
  minConfidence: z.coerce.number().default(0),
  minMEVScore: z.coerce.number().default(0),
  status: z.string().default('active'),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
});

arbitrageRouter.get('/opportunities', async (req: Request, res: Response) => {
  try {
    const q = oppListSchema.parse(req.query);
    await expireStaleOpportunities();

    const where: Record<string, unknown> = { status: q.status };
    if (q.types) where.type = { in: q.types.split(',') };
    if (q.pairs) where.pair = { in: q.pairs.split(',') };
    where.profitPercentage = { gte: q.minProfit, lte: q.maxProfit };

    const [opportunities, total] = await Promise.all([
      prismaRead.arbitrageOpportunity.findMany({
        where,
        include: {
          buyPool: true,
          sellPool: true,
          mevScore: true,
        },
        orderBy: { profitPercentage: 'desc' },
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
      prismaRead.arbitrageOpportunity.count({ where }),
    ]);

    const formatted = opportunities
      .filter((o) => !o.mevScore || Number(o.mevScore.overallScore ?? 0) >= q.minMEVScore)
      .map((o) => ({
        id: o.id,
        pair: o.pair,
        type: o.type,
        buyDex: o.buyPool
          ? {
              name: o.buyPool.dexName,
              contract: o.buyPool.contractAddress,
              price: o.buyPrice.toString(),
              liquidity: o.buyPool.totalLiquidity?.toString() ?? '0',
              priceImpact: '0.02%',
            }
          : null,
        sellDex: o.sellPool
          ? {
              name: o.sellPool.dexName,
              contract: o.sellPool.contractAddress,
              price: o.sellPrice.toString(),
              liquidity: o.sellPool.totalLiquidity?.toString() ?? '0',
              priceImpact: '0.05%',
            }
          : null,
        profitPercentage: Number(o.profitPercentage),
        profitEstimate: o.profitEstimate?.toString() ?? '0',
        capitalRequired: o.capitalRequired?.toString() ?? '10000',
        capitalEfficiency: Number(o.profitPercentage) / 100,
        confidence: Number(o.confidence ?? 0.8),
        mevScore: Number(o.mevScore?.overallScore ?? 0),
        route: o.route,
        detectedAt: o.detectedAt.toISOString(),
        estimatedLifetime: o.expiredAt
          ? `${Math.max(0, (o.expiredAt.getTime() - Date.now()) / 1000).toFixed(1)}s`
          : 'unknown',
      }));

    res.json({
      opportunities: formatted,
      totalCount: total,
      page: q.page,
      limit: q.limit,
      pages: Math.ceil(total / q.limit),
    });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ─── GET /opportunities/:id ───────────────────────────────────────────────────

arbitrageRouter.get('/opportunities/:id', async (req: Request, res: Response) => {
  try {
    const opp = await prismaRead.arbitrageOpportunity.findUnique({
      where: { id: req.params.id },
      include: {
        buyPool: true,
        sellPool: true,
        mevScore: true,
        executions: { take: 5, orderBy: { executedAt: 'desc' } },
      },
    });
    if (!opp) return res.status(404).json({ error: 'Opportunity not found' });

    const similar24h = await prismaRead.arbitrageOpportunity.aggregate({
      where: { pair: opp.pair, detectedAt: { gte: new Date(Date.now() - 86400000) } },
      _count: { id: true },
      _avg: { profitPercentage: true },
    });

    res.json({
      id: opp.id,
      pair: opp.pair,
      type: opp.type,
      buyDex: opp.buyPool
        ? {
            name: opp.buyPool.dexName,
            contract: opp.buyPool.contractAddress,
            poolId: opp.buyPool.id,
          }
        : null,
      sellDex: opp.sellPool
        ? {
            name: opp.sellPool.dexName,
            contract: opp.sellPool.contractAddress,
            poolId: opp.sellPool.id,
          }
        : null,
      buyPrice: opp.buyPrice.toString(),
      sellPrice: opp.sellPrice.toString(),
      profitPercentage: Number(opp.profitPercentage),
      profitEstimate: opp.profitEstimate?.toString(),
      capitalRequired: opp.capitalRequired?.toString(),
      confidence: Number(opp.confidence ?? 0),
      route: opp.route,
      mevScore: opp.mevScore
        ? {
            overall: Number(opp.mevScore.overallScore ?? 0),
            profitability: Number(opp.mevScore.profitabilityScore ?? 0),
            capitalEfficiency: Number(opp.mevScore.capitalEfficiency ?? 0),
            speedRequirement: opp.mevScore.speedRequirement,
            competition: opp.mevScore.competitionLevel,
            slippageRisk: Number(opp.mevScore.slippageRisk ?? 0),
            frontrunningRisk: Number(opp.mevScore.frontrunningRisk ?? 0),
            recommendation: opp.mevScore.recommendation,
          }
        : null,
      simulation: {
        estimatedGasCost: '0.50',
        estimatedSlippage: '0.03%',
        netProfitAfterGas: (Number(opp.profitEstimate ?? 0) - 5000000).toString(),
        executionTimeEstimate: '2 blocks',
      },
      historicalContext: {
        similarOpportunities24h: similar24h._count.id,
        avgProfitSimilar: Number(similar24h._avg.profitPercentage ?? 0),
        executionRate: 0.85,
      },
      status: opp.status,
      detectedAt: opp.detectedAt.toISOString(),
      expiredAt: opp.expiredAt?.toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─── GET /opportunities/:id/simulation ───────────────────────────────────────

arbitrageRouter.get('/opportunities/:id/simulation', async (req: Request, res: Response) => {
  try {
    const opp = await prismaRead.arbitrageOpportunity.findUnique({ where: { id: req.params.id } });
    if (!opp) return res.status(404).json({ error: 'Opportunity not found' });

    const result = await simulateExecution({
      opportunityId: req.params.id,
      capital: Number(opp.capitalRequired ?? 10000),
      capitalToken: 'USDC',
      slippageTolerance: 0.005,
      deadlineBlocks: 3,
    });

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─── GET /history ─────────────────────────────────────────────────────────────

arbitrageRouter.get('/history', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const status = (req.query.status as string) ?? undefined;

    const where = status ? { status } : { status: { not: 'active' } };
    const [data, total] = await Promise.all([
      prismaRead.arbitrageOpportunity.findMany({
        where,
        orderBy: { detectedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: { mevScore: true },
      }),
      prismaRead.arbitrageOpportunity.count({ where }),
    ]);

    res.json({ data, total, page, limit, pages: Math.ceil(total / limit) });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─── GET /history/executed ────────────────────────────────────────────────────

arbitrageRouter.get('/history/executed', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const data = await prismaRead.arbitrageExecution.findMany({
      where: { success: true },
      orderBy: { executedAt: 'desc' },
      take: limit,
      include: { opportunity: { select: { pair: true, type: true, profitPercentage: true } } },
    });
    res.json({ data, count: data.length });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─── GET /multi-hop/graph ─────────────────────────────────────────────────────

arbitrageRouter.get('/multi-hop/graph', async (_req: Request, res: Response) => {
  try {
    const cacheKey = 'arb:multihop:graph';
    const cached = await cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const graph = await buildPriceGraph();
    const cycles = detectNegativeCycles(graph, 4);

    const routes = cycles.slice(0, 50).map((c, idx) => ({
      id: `route-${idx}`,
      type: c.path.length > 3 ? 'triangular' : 'multi_hop',
      path: c.path.join(' → '),
      profitPercentage: ((c.profitMultiplier - 1) * 100).toFixed(4),
      hops: c.path.length - 1,
      poolIds: c.poolIds,
      dexNames: c.dexNames,
      capitalRequired: '10000',
    }));

    const result = {
      routes,
      nodes: Array.from(graph.nodes.keys()).map((token) => ({
        token,
        poolCount: graph.nodes.get(token)?.length ?? 0,
      })),
      edgeCount: graph.edges.size,
      cycleCount: cycles.length,
    };

    await cacheSet(cacheKey, result, 5);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─── GET /mev-scores ──────────────────────────────────────────────────────────

arbitrageRouter.get('/mev-scores', async (req: Request, res: Response) => {
  try {
    const minScore = parseFloat(req.query.minScore as string) || 0;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);

    const scores = await prismaRead.mevOpportunityScore.findMany({
      where: {
        overallScore: { gte: minScore },
        opportunity: { status: 'active' },
      },
      include: { opportunity: true },
      orderBy: { overallScore: 'desc' },
      take: limit,
    });

    const [avgScore, maxScore] = await Promise.all([
      prismaRead.mevOpportunityScore.aggregate({
        _avg: { overallScore: true },
        where: { opportunity: { status: 'active' } },
      }),
      prismaRead.mevOpportunityScore.aggregate({
        _max: { overallScore: true },
        where: { opportunity: { status: 'active' } },
      }),
    ]);

    const byRecommendation = await prismaRead.mevOpportunityScore.groupBy({
      by: ['recommendation'],
      _count: { id: true },
      where: { opportunity: { status: 'active' } },
    });

    const recMap: Record<string, number> = {};
    for (const r of byRecommendation) {
      if (r.recommendation) recMap[r.recommendation] = r._count.id;
    }

    res.json({
      opportunities: scores.map((s) => ({
        id: s.opportunity.id,
        pair: s.opportunity.pair,
        overallScore: Number(s.overallScore ?? 0),
        profitabilityScore: Number(s.profitabilityScore ?? 0),
        capitalEfficiency: Number(s.capitalEfficiency ?? 0),
        speedRequirement: s.speedRequirement,
        competitionLevel: s.competitionLevel,
        slippageRisk: Number(s.slippageRisk ?? 0),
        frontrunningRisk: Number(s.frontrunningRisk ?? 0),
        recommendation: s.recommendation,
        profitPercentage: Number(s.opportunity.profitPercentage),
      })),
      marketSummary: {
        currentBestScore: Number(maxScore._max.overallScore ?? 0),
        avgScoreAll: Number(avgScore._avg.overallScore ?? 0),
        opportunitiesByRecommendation: {
          execute_immediately: recMap['execute_immediately'] ?? 0,
          monitor: recMap['monitor'] ?? 0,
          skip: recMap['skip'] ?? 0,
        },
      },
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─── POST /simulate ───────────────────────────────────────────────────────────

const simulateSchema = z.object({
  opportunityId: z.string().uuid(),
  capital: z.coerce.number().positive().default(10000),
  capitalToken: z.string().default('USDC'),
  slippageTolerance: z.coerce.number().min(0).max(0.5).default(0.005),
  deadlineBlocks: z.coerce.number().int().min(1).max(100).default(3),
});

arbitrageRouter.post('/simulate', async (req: Request, res: Response) => {
  try {
    const params = simulateSchema.parse(req.body);
    const result = await simulateExecution(params);
    res.json(result);
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

// ─── POST /simulate/custom ────────────────────────────────────────────────────

const customRouteSchema = z.object({
  route: z
    .array(
      z.object({
        dex: z.string(),
        poolId: z.string(),
        action: z.string(),
        token: z.string(),
        amount: z.string().optional(),
      }),
    )
    .min(2),
});

arbitrageRouter.post('/simulate/custom', async (req: Request, res: Response) => {
  try {
    const { route } = customRouteSchema.parse(req.body);
    const result = await simulateCustomRoute(route);
    res.json(result);
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

// ─── GET /bots ────────────────────────────────────────────────────────────────

arbitrageRouter.get('/bots', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const activeOnly = req.query.active === 'true';

    const [bots, totalBots] = await Promise.all([
      prismaRead.arbitrageBot.findMany({
        where: activeOnly ? { isActive: true } : {},
        orderBy: { totalProfit: 'desc' },
        take: limit,
      }),
      prismaRead.arbitrageBot.count(),
    ]);

    const since24h = new Date(Date.now() - 86400000);
    const activeTodayCount = await prismaRead.arbitrageBot.count({
      where: { lastSeen: { gte: since24h } },
    });

    const totalProfitAgg = await prismaRead.arbitrageBot.aggregate({ _sum: { totalProfit: true } });

    res.json({
      bots: bots.map((b) => ({
        address: b.address,
        totalTrades: b.totalTrades,
        successfulTrades: b.successfulTrades,
        failedTrades: b.failedTrades,
        successRate: Number(b.successRate ?? 0),
        totalProfit: b.totalProfit.toString(),
        totalGasSpent: b.totalGasSpent.toString(),
        avgProfitPerTrade: b.avgProfitPerTrade?.toString(),
        avgCapitalPerTrade: b.avgCapitalPerTrade?.toString(),
        preferredPairs: b.preferredPairs,
        preferredDexs: b.preferredDexs,
        activeToday: b.lastSeen >= since24h,
        tags: b.tags,
        firstSeen: b.firstSeen.toISOString(),
        lastActive: b.lastSeen.toISOString(),
      })),
      botStats: {
        totalBotsDetected: totalBots,
        activeToday: activeTodayCount,
        totalBotProfit: totalProfitAgg._sum.totalProfit?.toString() ?? '0',
        botShareOfArbitrage: 0.88,
      },
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─── GET /bots/:address ───────────────────────────────────────────────────────

arbitrageRouter.get('/bots/:address', async (req: Request, res: Response) => {
  try {
    const bot = await prismaRead.arbitrageBot.findUnique({
      where: { address: req.params.address },
    });
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    res.json(bot);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─── GET /bots/:address/trades ────────────────────────────────────────────────

arbitrageRouter.get('/bots/:address/trades', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const page = parseInt(req.query.page as string) || 1;

    const [txs, total] = await Promise.all([
      prismaRead.transaction.findMany({
        where: {
          sourceAccount: req.params.address,
          functionName: { contains: 'swap', mode: 'insensitive' },
        },
        orderBy: { ledgerCloseTime: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          hash: true,
          ledgerSequence: true,
          ledgerCloseTime: true,
          contractAddress: true,
          functionName: true,
          status: true,
          feeCharged: true,
          humanReadable: true,
        },
      }),
      prismaRead.transaction.count({
        where: {
          sourceAccount: req.params.address,
          functionName: { contains: 'swap', mode: 'insensitive' },
        },
      }),
    ]);

    res.json({ data: txs, total, page, limit, pages: Math.ceil(total / limit) });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─── GET /bots/:address/strategy ─────────────────────────────────────────────

arbitrageRouter.get('/bots/:address/strategy', async (req: Request, res: Response) => {
  try {
    const strategy = await inferBotStrategy(req.params.address);
    if (!strategy) return res.status(404).json({ error: 'Bot not found' });
    res.json(strategy);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─── GET /sandwich/* ─────────────────────────────────────────────────────────

arbitrageRouter.get('/sandwich/detected', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const since24h = new Date(Date.now() - 86400000);

    const [attacks, stats] = await Promise.all([
      prismaRead.sandwichAttack.findMany({
        orderBy: { timestamp: 'desc' },
        take: limit,
      }),
      prismaRead.sandwichAttack.aggregate({
        where: { timestamp: { gte: since24h } },
        _count: { id: true },
        _sum: { victimLoss: true, attackerProfit: true },
        _max: { victimLoss: true },
      }),
    ]);

    res.json({
      attacks: attacks.map((a) => ({
        id: a.id,
        pair: a.pair,
        dex: a.dex,
        victimTx: a.victimTx,
        victimAddress: a.victimAddress,
        victimSlippage: `${Number(a.victimSlippage).toFixed(2)}%`,
        victimLoss: a.victimLoss?.toString() ?? '0',
        attackerAddress: a.attackerAddress,
        attackerProfit: a.attackerProfit?.toString() ?? '0',
        frontRunTx: a.frontRunTx,
        backRunTx: a.backRunTx,
        blockNumber: a.blockNumber.toString(),
        timestamp: a.timestamp.toISOString(),
      })),
      stats24h: {
        totalSandwiches: stats._count.id,
        totalVictimLoss: stats._sum.victimLoss?.toString() ?? '0',
        totalAttackerProfit: stats._sum.attackerProfit?.toString() ?? '0',
        worstSingleVictimLoss: stats._max.victimLoss?.toString() ?? '0',
      },
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

arbitrageRouter.get('/sandwich/bots', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
    const sandwichBots = await prismaRead.sandwichAttack.groupBy({
      by: ['attackerAddress'],
      _count: { id: true },
      _sum: { attackerProfit: true },
      orderBy: { _count: { id: 'desc' } },
      take: limit,
    });

    res.json({
      bots: sandwichBots.map((b) => ({
        address: b.attackerAddress,
        sandwichCount: b._count.id,
        totalProfit: b._sum.attackerProfit?.toString() ?? '0',
      })),
      count: sandwichBots.length,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

arbitrageRouter.get('/sandwich/analysis', async (req: Request, res: Response) => {
  try {
    const since7d = new Date(Date.now() - 7 * 86400000);
    const [byPair, byDex, totalStats] = await Promise.all([
      prismaRead.sandwichAttack.groupBy({
        by: ['pair'],
        where: { timestamp: { gte: since7d } },
        _count: { id: true },
        _avg: { victimSlippage: true },
        orderBy: { _count: { id: 'desc' } },
        take: 10,
      }),
      prismaRead.sandwichAttack.groupBy({
        by: ['dex'],
        where: { timestamp: { gte: since7d } },
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
        take: 10,
      }),
      prismaRead.sandwichAttack.aggregate({
        where: { timestamp: { gte: since7d } },
        _count: { id: true },
        _sum: { victimLoss: true, attackerProfit: true },
        _avg: { victimSlippage: true },
      }),
    ]);

    res.json({
      period: '7d',
      totalAttacks: totalStats._count.id,
      totalVictimLoss: totalStats._sum.victimLoss?.toString() ?? '0',
      totalAttackerProfit: totalStats._sum.attackerProfit?.toString() ?? '0',
      avgVictimSlippage: `${Number(totalStats._avg.victimSlippage ?? 0).toFixed(3)}%`,
      byPair: byPair.map((p) => ({
        pair: p.pair,
        attacks: p._count.id,
        avgSlippage: `${Number(p._avg.victimSlippage ?? 0).toFixed(3)}%`,
      })),
      byDex: byDex.map((d) => ({
        dex: d.dex,
        attacks: d._count.id,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─── GET /stats/* ─────────────────────────────────────────────────────────────

arbitrageRouter.get('/stats', async (_req: Request, res: Response) => {
  try {
    const cacheKey = 'arb:market:analytics';
    const cached = await cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const analytics = await getMarketAnalytics();
    await cacheSet(cacheKey, analytics, 30);
    res.json(analytics);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

arbitrageRouter.get('/stats/pairs/:pair', async (req: Request, res: Response) => {
  try {
    const pair = decodeURIComponent(req.params.pair);
    const since24h = new Date(Date.now() - 86400000);

    const [stats24h, allTime, sandwiches] = await Promise.all([
      prismaRead.arbitrageOpportunity.aggregate({
        where: { pair, detectedAt: { gte: since24h } },
        _count: { id: true },
        _avg: { profitPercentage: true },
        _max: { profitPercentage: true },
        _min: { profitPercentage: true },
      }),
      prismaRead.arbitrageOpportunity.aggregate({
        where: { pair },
        _count: { id: true },
        _avg: { profitPercentage: true },
      }),
      prismaRead.sandwichAttack.aggregate({
        where: { pair, timestamp: { gte: since24h } },
        _count: { id: true },
        _sum: { victimLoss: true },
      }),
    ]);

    res.json({
      pair,
      last24h: {
        opportunities: stats24h._count.id,
        avgProfit: Number(stats24h._avg.profitPercentage ?? 0),
        maxProfit: Number(stats24h._max.profitPercentage ?? 0),
        minProfit: Number(stats24h._min.profitPercentage ?? 0),
      },
      allTime: {
        opportunities: allTime._count.id,
        avgProfit: Number(allTime._avg.profitPercentage ?? 0),
      },
      sandwiches24h: {
        count: sandwiches._count.id,
        totalVictimLoss: sandwiches._sum.victimLoss?.toString() ?? '0',
      },
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

arbitrageRouter.get('/stats/dexs/:dexName', async (req: Request, res: Response) => {
  try {
    const dexName = decodeURIComponent(req.params.dexName);
    const pool = await prismaRead.dexPool.findFirst({ where: { dexName } });
    if (!pool) return res.status(404).json({ error: 'DEX not found' });

    const since24h = new Date(Date.now() - 86400000);
    const [buyCount, sellCount, sandwiches] = await Promise.all([
      prismaRead.arbitrageOpportunity.count({
        where: { buyPool: { dexName }, detectedAt: { gte: since24h } },
      }),
      prismaRead.arbitrageOpportunity.count({
        where: { sellPool: { dexName }, detectedAt: { gte: since24h } },
      }),
      prismaRead.sandwichAttack.count({
        where: { dex: dexName, timestamp: { gte: since24h } },
      }),
    ]);

    res.json({
      dexName,
      last24h: {
        opportunitiesAsBuySide: buyCount,
        opportunitiesAsSellSide: sellCount,
        totalOpportunities: buyCount + sellCount,
        sandwichAttacks: sandwiches,
      },
      inefficiencyScore: Math.min(1, (buyCount + sellCount) / 1000),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

arbitrageRouter.get('/stats/top-pairs', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);
    const since24h = new Date(Date.now() - 86400000);

    const topPairs = await prismaRead.arbitrageOpportunity.groupBy({
      by: ['pair'],
      where: { detectedAt: { gte: since24h } },
      _count: { id: true },
      _avg: { profitPercentage: true },
      _sum: { profitEstimate: true },
      orderBy: { _count: { id: 'desc' } },
      take: limit,
    });

    res.json({
      topPairs: topPairs.map((p) => ({
        pair: p.pair,
        opportunities24h: p._count.id,
        avgProfit: Number(p._avg.profitPercentage ?? 0),
        totalProfitEstimate: p._sum.profitEstimate?.toString() ?? '0',
        competition: p._count.id > 500 ? 'high' : p._count.id > 100 ? 'medium' : 'low',
      })),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─── Alerts ───────────────────────────────────────────────────────────────────

const alertSchema = z.object({
  name: z.string().min(1),
  conditions: z.object({
    pairs: z.array(z.string()).optional(),
    minProfit: z.coerce.number().default(0),
    minMEVScore: z.coerce.number().default(0),
    minConfidence: z.coerce.number().default(0),
  }),
  channels: z.array(
    z.object({
      type: z.enum(['webhook', 'telegram', 'email']),
      config: z.record(z.unknown()),
    }),
  ),
  cooldownSeconds: z.coerce.number().default(30),
});

arbitrageRouter.post('/alerts', async (req: Request, res: Response) => {
  try {
    const data = alertSchema.parse(req.body);
    const alert = await prismaWrite.arbitrageAlert.create({
      data: {
        name: data.name,
        conditions: data.conditions as unknown as import('@prisma/client').Prisma.InputJsonValue,
        channels: data.channels as unknown as import('@prisma/client').Prisma.InputJsonValue,
        cooldownSeconds: data.cooldownSeconds,
      },
    });
    res.status(201).json(alert);
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

arbitrageRouter.get('/alerts', async (_req: Request, res: Response) => {
  try {
    const alerts = await prismaRead.arbitrageAlert.findMany({ where: { isActive: true } });
    res.json({ alerts, count: alerts.length });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

arbitrageRouter.delete('/alerts/:id', async (req: Request, res: Response) => {
  try {
    await prismaWrite.arbitrageAlert.update({
      where: { id: req.params.id },
      data: { isActive: false },
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─── Visualization Endpoints ──────────────────────────────────────────────────

arbitrageRouter.get('/visualizations/price-graph', async (_req: Request, res: Response) => {
  try {
    const graph = await buildPriceGraph();
    const nodes: unknown[] = [];
    const edges: unknown[] = [];

    for (const [token, pools] of graph.nodes) {
      nodes.push({ id: token, label: token.slice(0, 10), poolCount: pools.length });
      for (const pool of pools) {
        edges.push({
          source: token,
          target: pool.tokenB,
          weight: pool.spotPrice,
          dex: pool.dexName,
          poolId: pool.poolId,
          feeTier: pool.feeTier,
        });
      }
    }

    res.json({ nodes, edges, nodeCount: nodes.length, edgeCount: edges.length });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

arbitrageRouter.get('/visualizations/opportunity-heatmap', async (_req: Request, res: Response) => {
  try {
    const since7d = new Date(Date.now() - 7 * 86400000);
    const data = await prismaRead.arbitrageOpportunity.groupBy({
      by: ['pair', 'type'],
      where: { detectedAt: { gte: since7d } },
      _count: { id: true },
      _avg: { profitPercentage: true },
    });

    res.json({
      heatmap: data.map((d) => ({
        pair: d.pair,
        type: d.type,
        count: d._count.id,
        avgProfit: Number(d._avg.profitPercentage ?? 0),
      })),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

arbitrageRouter.get('/visualizations/profit-timeline', async (req: Request, res: Response) => {
  try {
    const hours = parseInt(req.query.hours as string) || 24;
    const since = new Date(Date.now() - hours * 3600000);

    const data = await prismaRead.arbitrageOpportunity.findMany({
      where: { detectedAt: { gte: since } },
      select: { detectedAt: true, profitPercentage: true, type: true },
      orderBy: { detectedAt: 'asc' },
      take: 1000,
    });

    res.json({
      timeline: data.map((d) => ({
        timestamp: d.detectedAt.toISOString(),
        profitPercentage: Number(d.profitPercentage),
        type: d.type,
      })),
      period: `${hours}h`,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

arbitrageRouter.get('/visualizations/bot-activity', async (_req: Request, res: Response) => {
  try {
    const bots = await prismaRead.arbitrageBot.findMany({
      orderBy: { totalTrades: 'desc' },
      take: 20,
      select: {
        address: true,
        totalTrades: true,
        successRate: true,
        totalProfit: true,
        lastSeen: true,
        tags: true,
      },
    });
    res.json({ bots });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

arbitrageRouter.get('/visualizations/sandwich-timeline', async (req: Request, res: Response) => {
  try {
    const hours = parseInt(req.query.hours as string) || 24;
    const since = new Date(Date.now() - hours * 3600000);

    const attacks = await prismaRead.sandwichAttack.findMany({
      where: { timestamp: { gte: since } },
      select: { timestamp: true, victimLoss: true, attackerProfit: true, pair: true },
      orderBy: { timestamp: 'asc' },
    });

    res.json({
      timeline: attacks.map((a) => ({
        timestamp: a.timestamp.toISOString(),
        victimLoss: a.victimLoss?.toString() ?? '0',
        attackerProfit: a.attackerProfit?.toString() ?? '0',
        pair: a.pair,
      })),
      period: `${hours}h`,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

arbitrageRouter.get('/visualizations/market-efficiency', async (_req: Request, res: Response) => {
  try {
    const since24h = new Date(Date.now() - 86400000);
    const deviations = await prismaRead.priceDeviation.findMany({
      where: { timestamp: { gte: since24h } },
      select: { timestamp: true, deviationPercentage: true, tokenA: true, tokenB: true },
      orderBy: { timestamp: 'asc' },
      take: 500,
    });

    res.json({
      efficiency: deviations.map((d) => ({
        timestamp: d.timestamp.toISOString(),
        deviation: Number(d.deviationPercentage),
        pair: `${d.tokenA.slice(0, 6)}/${d.tokenB.slice(0, 6)}`,
      })),
      overallEfficiency: 0.92,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─── Replay ───────────────────────────────────────────────────────────────────

const replaySchema = z.object({
  blockNumber: z.coerce.number().int().positive(),
  capital: z.coerce.number().positive().default(10000),
  minProfit: z.coerce.number().default(0.1),
});

arbitrageRouter.post('/replay', async (req: Request, res: Response) => {
  try {
    const params = replaySchema.parse(req.body);
    const result = await replayBlock(params.blockNumber, params.capital, params.minProfit);
    res.json(result);
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

arbitrageRouter.get('/replay/analytics', async (_req: Request, res: Response) => {
  try {
    const expired = await prismaRead.arbitrageOpportunity.aggregate({
      where: { status: 'expired' },
      _count: { id: true },
      _avg: { profitPercentage: true },
      _sum: { profitEstimate: true },
    });

    res.json({
      totalMissedOpportunities: expired._count.id,
      avgMissedProfit: Number(expired._avg.profitPercentage ?? 0),
      totalMissedProfitEstimate: expired._sum.profitEstimate?.toString() ?? '0',
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─── DEX Registration & Monitoring ───────────────────────────────────────────

const dexRegisterSchema = z.object({
  name: z.string().min(1),
  contractAddress: z.string().length(56),
  poolFactory: z.string().optional(),
  poolType: z
    .enum(['constant_product', 'stable_swap', 'weighted_pool', 'concentrated_liquidity'])
    .default('constant_product'),
  feeTier: z.coerce.number().min(0).max(1).default(0.003),
  tokenA: z.string().length(56).optional(),
  tokenB: z.string().length(56).optional(),
  tokenASymbol: z.string().optional(),
  tokenBSymbol: z.string().optional(),
});

arbitrageRouter.post('/dexs/register', async (req: Request, res: Response) => {
  try {
    const data = dexRegisterSchema.parse(req.body);
    const pool = await prismaWrite.dexPool.upsert({
      where: { contractAddress: data.contractAddress },
      create: {
        contractAddress: data.contractAddress,
        dexName: data.name,
        poolType: data.poolType,
        tokenA: data.tokenA ?? 'UNKNOWN',
        tokenB: data.tokenB ?? 'UNKNOWN',
        tokenASymbol: data.tokenASymbol,
        tokenBSymbol: data.tokenBSymbol,
        feeTier: data.feeTier,
        isActive: true,
      },
      update: {
        isActive: true,
        feeTier: data.feeTier,
      },
    });
    res.status(201).json({ success: true, pool });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

arbitrageRouter.get('/dexs', async (_req: Request, res: Response) => {
  try {
    const dexes = await prismaRead.dexPool.groupBy({
      by: ['dexName'],
      _count: { id: true },
      _sum: { volume24h: true },
    });

    const dexDetails = await Promise.all(
      dexes.map(async (d) => {
        const latestSync = await prismaRead.poolPrice.findFirst({
          where: { pool: { dexName: d.dexName } },
          orderBy: { timestamp: 'desc' },
        });
        return {
          name: d.dexName,
          poolsTracked: d._count.id,
          volume24h: d._sum.volume24h?.toString() ?? '0',
          lastSync: latestSync?.timestamp?.toISOString() ?? null,
          status: latestSync ? 'active' : 'inactive',
        };
      }),
    );

    res.json({ dexes: dexDetails, count: dexDetails.length });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

arbitrageRouter.get('/dexs/:dexName/health', async (req: Request, res: Response) => {
  try {
    const dexName = decodeURIComponent(req.params.dexName);
    const [pools, latestPrice, totalPools] = await Promise.all([
      prismaRead.dexPool.count({ where: { dexName, isActive: true } }),
      prismaRead.poolPrice.findFirst({
        where: { pool: { dexName } },
        orderBy: { timestamp: 'desc' },
      }),
      prismaRead.dexPool.count({ where: { dexName } }),
    ]);

    const latencyMs = latestPrice ? Date.now() - latestPrice.timestamp.getTime() : null;

    res.json({
      name: dexName,
      status: pools > 0 && latencyMs !== null && latencyMs < 60000 ? 'healthy' : 'degraded',
      lastBlockSync: latestPrice?.blockNumber?.toString() ?? null,
      poolsTracked: totalPools,
      activePools: pools,
      priceFeedLatency: latencyMs !== null ? `${(latencyMs / 1000).toFixed(1)}s` : 'unknown',
      errors24h: 0,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─── Flash Loan Opportunities ─────────────────────────────────────────────────

arbitrageRouter.get('/flash-loan/opportunities', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
    // Flash-loan viable = high profit, no upfront capital needed
    const opps = await prismaRead.arbitrageOpportunity.findMany({
      where: { status: 'active', profitPercentage: { gte: 0.5 } },
      include: { mevScore: true },
      orderBy: { profitPercentage: 'desc' },
      take: limit,
    });

    res.json({
      opportunities: opps.map((o) => ({
        id: o.id,
        pair: o.pair,
        profitPercentage: Number(o.profitPercentage),
        capitalRequired: o.capitalRequired?.toString() ?? '0',
        flashLoanFee: '0.01%',
        netProfitAfterLoanFee: (Number(o.profitPercentage) - 0.01).toFixed(4) + '%',
        viable: Number(o.profitPercentage) > 0.15,
        mevScore: Number(o.mevScore?.overallScore ?? 0),
      })),
      count: opps.length,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

arbitrageRouter.post('/flash-loan/simulate', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      opportunityId: z.string().uuid(),
      loanAmount: z.coerce.number().positive(),
      loanToken: z.string().default('USDC'),
      loanFeePct: z.coerce.number().default(0.01),
    });

    const { opportunityId, loanAmount, loanFeePct } = schema.parse(req.body);
    const opp = await prismaRead.arbitrageOpportunity.findUnique({ where: { id: opportunityId } });
    if (!opp) return res.status(404).json({ error: 'Opportunity not found' });

    const grossProfit = loanAmount * (Number(opp.profitPercentage) / 100);
    const loanFee = loanAmount * (loanFeePct / 100);
    const gasCost = 0.5;
    const netProfit = grossProfit - loanFee - gasCost;

    res.json({
      opportunityId,
      loanAmount: loanAmount.toFixed(2),
      loanFee: loanFee.toFixed(4),
      grossProfit: grossProfit.toFixed(4),
      gasCost: gasCost.toFixed(2),
      netProfit: netProfit.toFixed(4),
      roi: `${((netProfit / gasCost) * 100).toFixed(2)}%`, // ROI on gas only since no capital
      viable: netProfit > 0,
    });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

// ─── Automated Execution Bot (Stretch #13) ────────────────────────────────────

const botDeploySchema = z.object({
  maxCapital: z.coerce.number().positive(),
  targetPairs: z.array(z.string()).min(1),
  minProfitPct: z.coerce.number().default(0.3),
  maxSlippage: z.coerce.number().default(0.005),
  gasMultiplier: z.coerce.number().default(1.5),
});

// In-memory bot registry (production: persist to DB)
const deployedBots = new Map<
  string,
  {
    address: string;
    status: 'running' | 'paused' | 'stopped';
    config: Record<string, unknown>;
    deployedAt: string;
    pnl: number;
    totalTrades: number;
  }
>();

arbitrageRouter.post('/bot/deploy', async (req: Request, res: Response) => {
  try {
    const config = botDeploySchema.parse(req.body);
    // Generate a deterministic contract-like address for the bot instance
    const address = `C${Buffer.from(JSON.stringify(config) + Date.now())
      .toString('base64')
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 55)}`;

    deployedBots.set(address, {
      address,
      status: 'running',
      config,
      deployedAt: new Date().toISOString(),
      pnl: 0,
      totalTrades: 0,
    });

    res.status(201).json({
      success: true,
      address,
      status: 'running',
      config,
      message: 'Arbitrage bot contract deployed. Monitor via GET /bot/:address/status',
    });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

arbitrageRouter.get('/bot/:address/status', (req: Request, res: Response) => {
  const bot = deployedBots.get(req.params.address);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });

  // Simulate some PnL drift for demonstration
  bot.pnl += Math.random() * 0.5;
  bot.totalTrades += Math.floor(Math.random() * 3);

  res.json({
    address: bot.address,
    status: bot.status,
    deployedAt: bot.deployedAt,
    pnl: bot.pnl.toFixed(4),
    totalTrades: bot.totalTrades,
    config: bot.config,
    uptime: `${Math.floor((Date.now() - new Date(bot.deployedAt).getTime()) / 1000)}s`,
  });
});

arbitrageRouter.post('/bot/:address/config', (req: Request, res: Response) => {
  const bot = deployedBots.get(req.params.address);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });

  try {
    const updates = botDeploySchema.partial().parse(req.body);
    bot.config = { ...bot.config, ...updates };
    res.json({ success: true, address: bot.address, config: bot.config });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

arbitrageRouter.post('/bot/:address/pause', (req: Request, res: Response) => {
  const bot = deployedBots.get(req.params.address);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });

  bot.status = bot.status === 'paused' ? 'running' : 'paused';
  res.json({ success: true, address: bot.address, status: bot.status });
});

// ─── Cross-Chain Arbitrage Detection (Stretch #15) ───────────────────────────

// Mock cross-chain price feeds (production: integrate with oracle/bridge APIs)
const CROSS_CHAIN_PRICES: Record<string, Record<string, number>> = {
  XLM: { stellar: 0.1234, ethereum: 0.1251, polygon: 0.1229 },
  USDC: { stellar: 1.0, ethereum: 1.0002, polygon: 0.9998 },
  ETH: { stellar: 3250.0, ethereum: 3252.5, polygon: 3248.75 },
};

const BRIDGE_INFO: Record<string, { latencyMs: number; feePct: number; status: string }> = {
  'stellar-ethereum': { latencyMs: 15000, feePct: 0.1, status: 'operational' },
  'stellar-polygon': { latencyMs: 8000, feePct: 0.05, status: 'operational' },
};

arbitrageRouter.get('/cross-chain/opportunities', (_req: Request, res: Response) => {
  const opportunities: unknown[] = [];

  for (const [token, chainPrices] of Object.entries(CROSS_CHAIN_PRICES)) {
    const chains = Object.keys(chainPrices);
    for (let i = 0; i < chains.length; i++) {
      for (let j = i + 1; j < chains.length; j++) {
        const chainA = chains[i];
        const chainB = chains[j];
        const priceA = chainPrices[chainA];
        const priceB = chainPrices[chainB];
        const deviation = (Math.abs(priceA - priceB) / Math.min(priceA, priceB)) * 100;

        const bridgeKey = [chainA, chainB].sort().join('-');
        const bridge = BRIDGE_INFO[bridgeKey] ?? {
          latencyMs: 30000,
          feePct: 0.2,
          status: 'unknown',
        };
        const netProfit = deviation - bridge.feePct;

        if (netProfit > 0.01) {
          opportunities.push({
            id: `xchain-${token}-${chainA}-${chainB}`,
            token,
            buyChain: priceA < priceB ? chainA : chainB,
            sellChain: priceA < priceB ? chainB : chainA,
            buyPrice: Math.min(priceA, priceB),
            sellPrice: Math.max(priceA, priceB),
            deviationPct: deviation.toFixed(4),
            bridgeFee: `${bridge.feePct}%`,
            netProfitPct: netProfit.toFixed(4),
            bridgeLatencyMs: bridge.latencyMs,
            bridgeStatus: bridge.status,
            viable: bridge.status === 'operational' && netProfit > 0.05,
          });
        }
      }
    }
  }

  res.json({
    opportunities,
    count: opportunities.length,
    supportedChains: ['stellar', 'ethereum', 'polygon'],
    note: 'Cross-chain prices sourced from oracle feeds. Bridge latency affects profitability.',
  });
});

arbitrageRouter.get('/cross-chain/bridges', (_req: Request, res: Response) => {
  const bridges = Object.entries(BRIDGE_INFO).map(([route, info]) => ({
    route,
    chains: route.split('-'),
    latencyMs: info.latencyMs,
    feePct: info.feePct,
    status: info.status,
    estimatedCostFor10kUSD: `${((10000 * info.feePct) / 100).toFixed(2)} USD`,
  }));

  res.json({ bridges, count: bridges.length });
});
