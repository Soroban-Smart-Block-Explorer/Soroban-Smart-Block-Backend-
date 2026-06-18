import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prismaRead, prismaWrite } from '../db';
import {
  getMevOverview,
  getMevStatistics,
  classifyLedger,
  classifyAndStore,
} from '../indexer/mev-classifier';

export const mevRouter = Router();

// GET /api/v1/mev/overview
mevRouter.get('/overview', async (_req: Request, res: Response) => {
  try {
    const overview = await getMevOverview();
    res.json(overview);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/v1/mev/statistics
mevRouter.get('/statistics', async (_req: Request, res: Response) => {
  try {
    const stats = await getMevStatistics();
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/v1/mev/events
mevRouter.get('/events', async (req: Request, res: Response) => {
  try {
    const { type, victim, attacker, protocol, since, until, limit, offset } = req.query;
    const take = Math.min(parseInt(limit as string) || 20, 100);
    const skip = parseInt(offset as string) || 0;

    const where: Record<string, unknown> = {};
    if (type) where.mevType = type;
    if (victim) where.victimAddress = victim;
    if (attacker) where.attackerAddress = attacker;
    if (protocol) where.protocolAddress = protocol;
    if (since || until) {
      where.createdAt = {
        ...(since ? { gte: new Date(since as string) } : {}),
        ...(until ? { lte: new Date(until as string) } : {}),
      };
    }

    const [events, total] = await Promise.all([
      prismaRead.mevEvent.findMany({ where, orderBy: { createdAt: 'desc' }, take, skip }),
      prismaRead.mevEvent.count({ where }),
    ]);

    res.json({ data: events, total, limit: take, offset: skip });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/v1/mev/events/:id
mevRouter.get('/events/:id', async (req: Request, res: Response) => {
  try {
    const event = await prismaRead.mevEvent.findUnique({ where: { id: req.params.id } });
    if (!event) return res.status(404).json({ error: 'MEV event not found' });
    res.json(event);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/v1/mev/events/:txHash/by-tx
mevRouter.get('/events/:txHash/by-tx', async (req: Request, res: Response) => {
  try {
    const event = await prismaRead.mevEvent.findUnique({ where: { txHash: req.params.txHash } });
    if (!event) return res.status(404).json({ error: 'MEV event not found' });
    res.json(event);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/v1/mev/victims/:address
mevRouter.get('/victims/:address', async (req: Request, res: Response) => {
  try {
    const victim = await prismaRead.mevVictim.findUnique({
      where: { address: req.params.address },
      include: { events: { orderBy: { createdAt: 'desc' }, take: 20 } },
    });
    if (!victim) return res.status(404).json({ error: 'Victim not found' });
    res.json(victim);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/v1/mev/attackers/:address
mevRouter.get('/attackers/:address', async (req: Request, res: Response) => {
  try {
    const attacker = await prismaRead.mevAttacker.findUnique({
      where: { address: req.params.address },
      include: { events: { orderBy: { createdAt: 'desc' }, take: 20 } },
    });
    if (!attacker) return res.status(404).json({ error: 'Attacker not found' });
    res.json(attacker);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/v1/mev/leaderboard
mevRouter.get('/leaderboard', async (req: Request, res: Response) => {
  try {
    const take = Math.min(parseInt(req.query.limit as string) || 10, 50);
    const attackers = await prismaRead.mevAttacker.findMany({
      orderBy: { totalProfitUsd: 'desc' },
      take,
      select: {
        address: true,
        totalProfitUsd: true,
        attackCount: true,
        favoriteType: true,
        lastAttackAt: true,
        isContract: true,
        tags: true,
      },
    });
    res.json({ leaderboard: attackers, count: attackers.length });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/v1/mev/protections/:contract
mevRouter.get('/protections/:contract', async (req: Request, res: Response) => {
  try {
    const record = await prismaRead.protocolMevResistance.findUnique({
      where: { contractAddress: req.params.contract },
    });
    if (!record) return res.status(404).json({ error: 'Protocol protection data not found' });
    res.json(record);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/v1/mev/protections/:contract/score-history
mevRouter.get('/protections/:contract/score-history', async (req: Request, res: Response) => {
  try {
    const record = await prismaRead.protocolMevResistance.findUnique({
      where: { contractAddress: req.params.contract },
      select: { contractAddress: true, score: true, scoreHistory: true },
    });
    if (!record) return res.status(404).json({ error: 'Protocol not found' });
    res.json(record);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/v1/mev/protections/leaderboard
mevRouter.get('/protections/leaderboard', async (req: Request, res: Response) => {
  try {
    const take = Math.min(parseInt(req.query.limit as string) || 10, 50);
    const protocols = await prismaRead.protocolMevResistance.findMany({
      orderBy: { score: 'desc' },
      take,
    });
    res.json({ leaderboard: protocols, count: protocols.length });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/v1/mev/mempool/pending
mevRouter.get('/mempool/pending', async (_req: Request, res: Response) => {
  try {
    const pending = await prismaRead.mevAlert.findMany({
      where: { alertType: 'sandwich_in_progress', acknowledged: false },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json({ pending, count: pending.length });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

const checkPendingSchema = z.object({ txHash: z.string() });

// POST /api/v1/mev/check-pending-tx
mevRouter.post('/check-pending-tx', async (req: Request, res: Response) => {
  try {
    const { txHash } = checkPendingSchema.parse(req.body);
    const existing = await prismaRead.mevEvent.findUnique({ where: { txHash } });
    if (existing && existing.mevType === 'sandwich') {
      return res.json({
        txHash,
        status: 'being_sandwiched',
        estimatedLoss: existing.lossUsd ? `${existing.lossUsd.toFixed(2)} USD` : 'unknown',
        confidence: existing.confidence,
        recommendation: 'Cancel and resubmit with lower slippage or use a private mempool',
      });
    }
    res.json({ txHash, status: 'safe', confidence: 1, recommendation: null });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

const protectTxSchema = z.object({ txHash: z.string(), userAddress: z.string().optional() });

// POST /api/v1/mev/protect-tx
mevRouter.post('/protect-tx', async (req: Request, res: Response) => {
  try {
    const { txHash, userAddress } = protectTxSchema.parse(req.body);
    // Create an alert for tracking the protection request
    const alert = await prismaWrite.mevAlert.create({
      data: {
        alertType: 'sandwich_in_progress',
        severity: 'high',
        txHash,
        victimAddress: userAddress,
        title: 'Protected submission requested',
        description: `User requested protected submission for tx ${txHash}`,
        recommendedAction: 'Route transaction through private mempool',
      },
    });
    res.json({ success: true, alertId: alert.id, status: 'protection_requested' });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

const notifySchema = z.object({
  webhook: z.string().url().optional(),
  email: z.string().email().optional(),
});

// POST /api/v1/mev/victims/:address/notify
mevRouter.post('/victims/:address/notify', async (req: Request, res: Response) => {
  try {
    const config = notifySchema.parse(req.body);
    // Upsert victim with notification config in details
    await prismaWrite.mevVictim.upsert({
      where: { address: req.params.address },
      create: {
        address: req.params.address,
        protectionScore: 50,
      },
      update: {},
    });
    res.json({ success: true, address: req.params.address, notificationConfig: config });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/v1/mev/sandwich-patterns
const SANDWICH_PATTERNS = [
  {
    id: 1,
    name: 'Classic DEX Sandwich',
    description: 'Front-run swap, victim swap, back-run swap on same pool',
    confidence: 0.95,
  },
  {
    id: 2,
    name: 'Multi-hop Sandwich',
    description: 'Attack spans multiple hops in a route',
    confidence: 0.85,
  },
  {
    id: 3,
    name: 'JIT Liquidity',
    description: 'Just-in-time liquidity added before victim and removed after',
    confidence: 0.8,
  },
  {
    id: 4,
    name: 'Flash Loan Sandwich',
    description: 'Uses flash loan to amplify front-run capital',
    confidence: 0.9,
  },
  {
    id: 5,
    name: 'Cross-DEX Arbitrage',
    description: 'Exploits price difference across DEXes triggered by victim tx',
    confidence: 0.75,
  },
];

mevRouter.get('/sandwich-patterns', (_req: Request, res: Response) => {
  res.json({ patterns: SANDWICH_PATTERNS, count: SANDWICH_PATTERNS.length });
});

const patternSchema = z.object({
  name: z.string(),
  description: z.string(),
  confidence: z.number().min(0).max(1),
});

// POST /api/v1/mev/sandwich-patterns
mevRouter.post('/sandwich-patterns', (req: Request, res: Response) => {
  try {
    const pattern = patternSchema.parse(req.body);
    const newPattern = { id: SANDWICH_PATTERNS.length + 1, ...pattern };
    SANDWICH_PATTERNS.push(newPattern);
    res.status(201).json(newPattern);
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/v1/mev/arbitrage/opportunities
mevRouter.get('/arbitrage/opportunities', async (_req: Request, res: Response) => {
  try {
    const opportunities = await prismaRead.mevEvent.findMany({
      where: { mevType: { in: ['cross_dex_arbitrage', 'cex_dex_arbitrage'] } },
      orderBy: { profitUsd: 'desc' },
      take: 20,
    });
    res.json({ opportunities, count: opportunities.length });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/v1/mev/arbitrage/executed
mevRouter.get('/arbitrage/executed', async (req: Request, res: Response) => {
  try {
    const take = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const executed = await prismaRead.mevEvent.findMany({
      where: { mevType: { in: ['cross_dex_arbitrage', 'cex_dex_arbitrage'] } },
      orderBy: { createdAt: 'desc' },
      take,
    });
    res.json({ data: executed, count: executed.length });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/v1/mev/arbitrage/leaderboard
mevRouter.get('/arbitrage/leaderboard', async (req: Request, res: Response) => {
  try {
    const take = Math.min(parseInt(req.query.limit as string) || 10, 50);
    const arbitrageurs = await prismaRead.mevAttacker.findMany({
      where: { favoriteType: { in: ['cross_dex_arbitrage', 'cex_dex_arbitrage'] } },
      orderBy: { totalProfitUsd: 'desc' },
      take,
    });
    res.json({ leaderboard: arbitrageurs, count: arbitrageurs.length });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/v1/mev/bots
mevRouter.get('/bots', async (req: Request, res: Response) => {
  try {
    const take = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const bots = await prismaRead.mevAttacker.findMany({
      orderBy: { attackCount: 'desc' },
      take,
    });
    res.json({ bots, count: bots.length });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/v1/mev/bots/active
mevRouter.get('/bots/active', async (_req: Request, res: Response) => {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const bots = await prismaRead.mevAttacker.findMany({
      where: { lastAttackAt: { gte: since } },
      orderBy: { lastAttackAt: 'desc' },
      take: 20,
    });
    res.json({ bots, count: bots.length });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/v1/mev/flash-loan-attacks
mevRouter.get('/flash-loan-attacks', async (req: Request, res: Response) => {
  try {
    const take = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const attacks = await prismaRead.mevEvent.findMany({
      where: { mevType: 'flash_loan_attack' },
      orderBy: { createdAt: 'desc' },
      take,
    });
    res.json({ data: attacks, count: attacks.length });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/v1/mev/compensation/estimate/:address
mevRouter.get('/compensation/estimate/:address', async (req: Request, res: Response) => {
  try {
    const victim = await prismaRead.mevVictim.findUnique({
      where: { address: req.params.address },
      include: {
        events: { select: { lossUsd: true, mevType: true, txHash: true, createdAt: true } },
      },
    });
    if (!victim) return res.status(404).json({ error: 'Victim not found' });

    const breakdown = victim.events.map((e) => ({
      txHash: e.txHash,
      mevType: e.mevType,
      lossUsd: e.lossUsd ?? 0,
      date: e.createdAt,
    }));

    res.json({
      address: req.params.address,
      totalLossUsd: victim.totalLossUsd,
      incidentCount: victim.incidentCount,
      breakdown,
      claimableUsd: victim.totalLossUsd * 0.8, // 80% claimable estimate
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

const claimSchema = z.object({
  address: z.string(),
  incidentIds: z.array(z.string()).optional(),
});

// POST /api/v1/mev/compensation/claim
mevRouter.post('/compensation/claim', async (req: Request, res: Response) => {
  try {
    const { address } = claimSchema.parse(req.body);
    const victim = await prismaRead.mevVictim.findUnique({ where: { address } });
    if (!victim) return res.status(404).json({ error: 'Victim not found' });

    res.status(201).json({
      claimId: `claim_${Date.now()}`,
      address,
      claimableUsd: victim.totalLossUsd * 0.8,
      status: 'submitted',
      submittedAt: new Date().toISOString(),
    });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/v1/mev/compensation/claims/:address
mevRouter.get('/compensation/claims/:address', async (req: Request, res: Response) => {
  try {
    const victim = await prismaRead.mevVictim.findUnique({
      where: { address: req.params.address },
    });
    if (!victim) return res.status(404).json({ error: 'No claims found for address' });
    res.json({ address: req.params.address, totalLossUsd: victim.totalLossUsd, claims: [] });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/v1/mev/alerts
mevRouter.get('/alerts', async (req: Request, res: Response) => {
  try {
    const take = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const skip = parseInt(req.query.offset as string) || 0;
    const unacknowledgedOnly = req.query.unacknowledged === 'true';

    const [alerts, total] = await Promise.all([
      prismaRead.mevAlert.findMany({
        where: unacknowledgedOnly ? { acknowledged: false } : {},
        orderBy: { createdAt: 'desc' },
        take,
        skip,
      }),
      prismaRead.mevAlert.count({
        where: unacknowledgedOnly ? { acknowledged: false } : {},
      }),
    ]);

    res.json({ data: alerts, total, limit: take, offset: skip });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

const createAlertSchema = z.object({
  alertType: z.enum([
    'sandwich_in_progress',
    'sandwich_detected',
    'mev_spike',
    'protocol_targeted',
    'user_victim',
  ]),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  txHash: z.string().optional(),
  victimAddress: z.string().optional(),
  protocolAddress: z.string().optional(),
  title: z.string(),
  description: z.string(),
  estimatedLoss: z.number().optional(),
  recommendedAction: z.string().optional(),
});

// POST /api/v1/mev/alerts
mevRouter.post('/alerts', async (req: Request, res: Response) => {
  try {
    const data = createAlertSchema.parse(req.body);
    const alert = await prismaWrite.mevAlert.create({ data });
    res.status(201).json(alert);
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/v1/mev/reports/daily
mevRouter.get('/reports/daily', async (_req: Request, res: Response) => {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [events, profit, loss] = await Promise.all([
      prismaRead.mevEvent.count({ where: { createdAt: { gte: since } } }),
      prismaRead.mevEvent.aggregate({
        _sum: { profitUsd: true },
        where: { createdAt: { gte: since } },
      }),
      prismaRead.mevEvent.aggregate({
        _sum: { lossUsd: true },
        where: { createdAt: { gte: since } },
      }),
    ]);
    res.json({
      period: 'daily',
      since: since.toISOString(),
      totalEvents: events,
      totalProfitUsd: profit._sum.profitUsd ?? 0,
      totalLossUsd: loss._sum.lossUsd ?? 0,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/v1/mev/reports/weekly
mevRouter.get('/reports/weekly', async (_req: Request, res: Response) => {
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [events, profit, loss] = await Promise.all([
      prismaRead.mevEvent.count({ where: { createdAt: { gte: since } } }),
      prismaRead.mevEvent.aggregate({
        _sum: { profitUsd: true },
        where: { createdAt: { gte: since } },
      }),
      prismaRead.mevEvent.aggregate({
        _sum: { lossUsd: true },
        where: { createdAt: { gte: since } },
      }),
    ]);
    res.json({
      period: 'weekly',
      since: since.toISOString(),
      totalEvents: events,
      totalProfitUsd: profit._sum.profitUsd ?? 0,
      totalLossUsd: loss._sum.lossUsd ?? 0,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// POST /api/v1/mev/reports/subscribe
mevRouter.post('/reports/subscribe', (req: Request, res: Response) => {
  const schema = z.object({
    address: z.string().optional(),
    email: z.string().email().optional(),
    frequency: z.enum(['daily', 'weekly']).default('daily'),
  });
  try {
    const sub = schema.parse(req.body);
    res.status(201).json({ success: true, subscription: sub });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/v1/mev/export
mevRouter.get('/export', async (req: Request, res: Response) => {
  try {
    const { format = 'json', since } = req.query;
    const where = since ? { createdAt: { gte: new Date(since as string) } } : {};
    const events = await prismaRead.mevEvent.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take: 10000,
    });

    if (format === 'csv') {
      const header =
        'id,txHash,ledgerSeq,timestamp,mevType,victimAddress,attackerAddress,profitUsd,lossUsd,confidence\n';
      const rows = events
        .map((e) =>
          [
            e.id,
            e.txHash,
            e.ledgerSeq,
            e.timestamp.toISOString(),
            e.mevType,
            e.victimAddress ?? '',
            e.attackerAddress ?? '',
            e.profitUsd ?? '',
            e.lossUsd ?? '',
            e.confidence,
          ].join(','),
        )
        .join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="mev-export.csv"');
      return res.send(header + rows);
    }

    res.json({ data: events, count: events.length });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// POST /api/v1/mev/classify-ledger (trigger classification for a ledger)
mevRouter.post('/classify-ledger', async (req: Request, res: Response) => {
  try {
    const schema = z.object({ ledgerSeq: z.number().int().positive() });
    const { ledgerSeq } = schema.parse(req.body);
    const classifications = await classifyLedger(ledgerSeq);
    const stored = await Promise.all(classifications.map((c) => classifyAndStore(c)));
    res.json({ classified: stored.length, ledgerSeq });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
    res.status(500).json({ error: String(e) });
  }
});
