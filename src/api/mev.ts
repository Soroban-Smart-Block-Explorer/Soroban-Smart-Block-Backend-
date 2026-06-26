import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prismaRead, prismaWrite } from '../db';
import {
  getMevOverview,
  getMevStatistics,
  classifyLedger,
  classifyAndStore,
} from '../indexer/mev-classifier';

/**
 * @swagger
 * tags:
 *   name: MEV
 *   description: MEV events, victims, attackers, protocol resistance, alerts, and reports
 */

export const mevRouter = Router();

/**
 * @swagger
 * /api/v1/mev/overview:
 *   get:
 *     summary: Aggregate MEV overview
 *     tags: [MEV]
 *     responses:
 *       200:
 *         description: Totals, per-type counts, top attackers/victims, and recent events
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/MevOverview' }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
// GET /api/v1/mev/overview
mevRouter.get('/overview', async (_req: Request, res: Response) => {
  try {
    const overview = await getMevOverview();
    res.json(overview);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * @swagger
 * /api/v1/mev/statistics:
 *   get:
 *     summary: MEV statistics
 *     description: The overview plus average confidence and attacker/victim/type totals.
 *     tags: [MEV]
 *     responses:
 *       200:
 *         description: MEV statistics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 overview: { $ref: '#/components/schemas/MevOverview' }
 *                 avgConfidence: { type: number, example: 0.88 }
 *                 totalAttackers: { type: integer, example: 312 }
 *                 totalVictims: { type: integer, example: 1840 }
 *                 sandwichCount: { type: integer, example: 820 }
 *                 flashLoanCount: { type: integer, example: 95 }
 *                 arbitrageCount: { type: integer, example: 410 }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
// GET /api/v1/mev/statistics
mevRouter.get('/statistics', async (_req: Request, res: Response) => {
  try {
    const stats = await getMevStatistics();
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * @swagger
 * /api/v1/mev/events:
 *   get:
 *     summary: List MEV events
 *     tags: [MEV]
 *     parameters:
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [sandwich, flash_loan_attack, backrunning, displacement, jit_liquidity, cex_dex_arbitrage, cross_dex_arbitrage, liquidation, nft_mev]
 *         description: Filter by MEV type
 *       - in: query
 *         name: victim
 *         schema: { type: string }
 *         description: Filter by victim address
 *       - in: query
 *         name: attacker
 *         schema: { type: string }
 *         description: Filter by attacker address
 *       - in: query
 *         name: protocol
 *         schema: { type: string }
 *         description: Filter by protocol address
 *       - in: query
 *         name: since
 *         schema: { type: string, format: date-time }
 *         description: Only events created at or after this timestamp
 *       - in: query
 *         name: until
 *         schema: { type: string, format: date-time }
 *         description: Only events created at or before this timestamp
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20, maximum: 100 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, default: 0 }
 *     responses:
 *       200:
 *         description: Paginated MEV events (offset-based)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/MevEvent' }
 *                 total: { type: integer, example: 1543 }
 *                 limit: { type: integer, example: 20 }
 *                 offset: { type: integer, example: 0 }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
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

/**
 * @swagger
 * /api/v1/mev/events/{id}:
 *   get:
 *     summary: Get an MEV event by id
 *     tags: [MEV]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: The MEV event
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/MevEvent' }
 *       404:
 *         description: MEV event not found
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'MEV event not found' }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
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

/**
 * @swagger
 * /api/v1/mev/events/{txHash}/by-tx:
 *   get:
 *     summary: Get an MEV event by transaction hash
 *     tags: [MEV]
 *     parameters:
 *       - in: path
 *         name: txHash
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: The MEV event
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/MevEvent' }
 *       404:
 *         description: MEV event not found
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'MEV event not found' }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
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

/**
 * @swagger
 * /api/v1/mev/victims/{address}:
 *   get:
 *     summary: Get a victim with recent events
 *     description: The victim record plus its 20 most recent MEV events.
 *     tags: [MEV]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: The victim and recent events
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/MevVictim'
 *                 - type: object
 *                   properties:
 *                     events:
 *                       type: array
 *                       items: { $ref: '#/components/schemas/MevEvent' }
 *       404:
 *         description: Victim not found
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Victim not found' }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
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

/**
 * @swagger
 * /api/v1/mev/attackers/{address}:
 *   get:
 *     summary: Get an attacker with recent events
 *     description: The attacker record plus its 20 most recent MEV events.
 *     tags: [MEV]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: The attacker and recent events
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/MevAttacker'
 *                 - type: object
 *                   properties:
 *                     events:
 *                       type: array
 *                       items: { $ref: '#/components/schemas/MevEvent' }
 *       404:
 *         description: Attacker not found
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Attacker not found' }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
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

/**
 * @swagger
 * /api/v1/mev/leaderboard:
 *   get:
 *     summary: Top attackers by total profit
 *     tags: [MEV]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 10, maximum: 50 }
 *     responses:
 *       200:
 *         description: Ranked attackers (summary fields only)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 leaderboard:
 *                   type: array
 *                   items:
 *                     type: object
 *                     description: Attacker summary (subset of the full MevAttacker record)
 *                     properties:
 *                       address: { type: string }
 *                       totalProfitUsd: { type: number }
 *                       attackCount: { type: integer }
 *                       favoriteType: { type: string, nullable: true }
 *                       lastAttackAt: { type: string, format: date-time, nullable: true }
 *                       isContract: { type: boolean }
 *                       tags: { type: array, items: { type: string }, nullable: true }
 *                 count: { type: integer }
 *               example:
 *                 leaderboard:
 *                   - address: GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN
 *                     totalProfitUsd: 1520.4
 *                     attackCount: 42
 *                     favoriteType: sandwich
 *                     lastAttackAt: '2026-06-19T07:24:26.000Z'
 *                     isContract: true
 *                     tags: [known-bot]
 *                 count: 1
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
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

/**
 * @swagger
 * /api/v1/mev/protections/{contract}:
 *   get:
 *     summary: Get a protocol's MEV-resistance profile
 *     tags: [MEV]
 *     parameters:
 *       - in: path
 *         name: contract
 *         required: true
 *         schema: { type: string }
 *         description: Protocol contract address
 *     responses:
 *       200:
 *         description: The MEV-resistance record
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ProtocolMevResistance' }
 *       404:
 *         description: Protocol protection data not found
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Protocol protection data not found' }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
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

/**
 * @swagger
 * /api/v1/mev/protections/{contract}/score-history:
 *   get:
 *     summary: Get a protocol's MEV-resistance score history
 *     tags: [MEV]
 *     parameters:
 *       - in: path
 *         name: contract
 *         required: true
 *         schema: { type: string }
 *         description: Protocol contract address
 *     responses:
 *       200:
 *         description: Score and score history
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 contractAddress: { type: string }
 *                 score: { type: number }
 *                 scoreHistory:
 *                   type: array
 *                   nullable: true
 *                   items: { type: object }
 *               example:
 *                 contractAddress: CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5
 *                 score: 72.5
 *                 scoreHistory:
 *                   - { score: 70, timestamp: '2026-06-01T00:00:00.000Z' }
 *                   - { score: 72.5, timestamp: '2026-06-19T07:24:26.000Z' }
 *       404:
 *         description: Protocol not found
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Protocol not found' }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
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

/**
 * @swagger
 * /api/v1/mev/protections/leaderboard:
 *   get:
 *     summary: Protocols ranked by MEV-resistance score
 *     tags: [MEV]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 10, maximum: 50 }
 *     responses:
 *       200:
 *         description: Ranked protocols
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 leaderboard:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/ProtocolMevResistance' }
 *                 count: { type: integer, example: 1 }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
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

/**
 * @swagger
 * /api/v1/mev/mempool/pending:
 *   get:
 *     summary: List unacknowledged in-progress sandwich alerts
 *     tags: [MEV]
 *     responses:
 *       200:
 *         description: Pending sandwich alerts
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 pending:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/MevAlert' }
 *                 count: { type: integer, example: 2 }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
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

/**
 * @swagger
 * /api/v1/mev/check-pending-tx:
 *   post:
 *     summary: Check whether a transaction is being sandwiched
 *     tags: [MEV]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [txHash]
 *             properties:
 *               txHash: { type: string }
 *             example:
 *               txHash: '3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566'
 *     responses:
 *       200:
 *         description: Protection status for the transaction
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 txHash: { type: string }
 *                 status: { type: string, enum: [being_sandwiched, safe] }
 *                 estimatedLoss: { type: string, description: 'Present when being sandwiched' }
 *                 confidence: { type: number }
 *                 recommendation: { type: string, nullable: true }
 *               example:
 *                 txHash: '3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566'
 *                 status: being_sandwiched
 *                 estimatedLoss: '180.60 USD'
 *                 confidence: 0.95
 *                 recommendation: Cancel and resubmit with lower slippage or use a private mempool
 *       400:
 *         description: Invalid request body
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ZodValidationError' }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
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

/**
 * @swagger
 * /api/v1/mev/protect-tx:
 *   post:
 *     summary: Request protected submission for a transaction
 *     description: Records a protection-request alert and returns its id.
 *     tags: [MEV]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [txHash]
 *             properties:
 *               txHash: { type: string }
 *               userAddress: { type: string }
 *             example:
 *               txHash: '3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566'
 *               userAddress: GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI
 *     responses:
 *       200:
 *         description: Protection request recorded
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 alertId: { type: string }
 *                 status: { type: string }
 *               example:
 *                 success: true
 *                 alertId: clz9q1x4t0000s6h2mevalrt1
 *                 status: protection_requested
 *       400:
 *         description: Invalid request body
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ZodValidationError' }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
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

/**
 * @swagger
 * /api/v1/mev/victims/{address}/notify:
 *   post:
 *     summary: Set notification config for a victim address
 *     description: Upserts the victim record and echoes the notification config.
 *     tags: [MEV]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               webhook: { type: string, format: uri }
 *               email: { type: string, format: email }
 *             example:
 *               webhook: https://example.com/mev-hook
 *               email: alerts@example.com
 *     responses:
 *       200:
 *         description: Notification config saved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 address: { type: string }
 *                 notificationConfig:
 *                   type: object
 *                   properties:
 *                     webhook: { type: string }
 *                     email: { type: string }
 *               example:
 *                 success: true
 *                 address: GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI
 *                 notificationConfig: { webhook: 'https://example.com/mev-hook', email: 'alerts@example.com' }
 *       400:
 *         description: Invalid request body
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/ZodValidationError' }]
 *               example:
 *                 error:
 *                   - { code: invalid_string, validation: url, path: [webhook], message: 'Invalid url' }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
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

/**
 * @swagger
 * /api/v1/mev/sandwich-patterns:
 *   get:
 *     summary: List known sandwich attack patterns
 *     tags: [MEV]
 *     responses:
 *       200:
 *         description: Sandwich patterns
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 patterns:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: integer }
 *                       name: { type: string }
 *                       description: { type: string }
 *                       confidence: { type: number, description: '0-1' }
 *                 count: { type: integer }
 *               example:
 *                 patterns:
 *                   - id: 1
 *                     name: Classic DEX Sandwich
 *                     description: Front-run swap, victim swap, back-run swap on same pool
 *                     confidence: 0.95
 *                 count: 5
 */
mevRouter.get('/sandwich-patterns', (_req: Request, res: Response) => {
  res.json({ patterns: SANDWICH_PATTERNS, count: SANDWICH_PATTERNS.length });
});

const patternSchema = z.object({
  name: z.string(),
  description: z.string(),
  confidence: z.number().min(0).max(1),
});

/**
 * @swagger
 * /api/v1/mev/sandwich-patterns:
 *   post:
 *     summary: Add a sandwich pattern
 *     description: Appends an in-memory pattern. Not persisted across restarts.
 *     tags: [MEV]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, description, confidence]
 *             properties:
 *               name: { type: string }
 *               description: { type: string }
 *               confidence: { type: number, minimum: 0, maximum: 1 }
 *             example:
 *               name: Backrun Sandwich
 *               description: Back-run only variant
 *               confidence: 0.7
 *     responses:
 *       201:
 *         description: The created pattern
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: integer }
 *                 name: { type: string }
 *                 description: { type: string }
 *                 confidence: { type: number }
 *               example:
 *                 id: 6
 *                 name: Backrun Sandwich
 *                 description: Back-run only variant
 *                 confidence: 0.7
 *       400:
 *         description: Invalid request body
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/ZodValidationError' }]
 *               example:
 *                 error:
 *                   - { code: invalid_type, expected: string, received: undefined, path: [name], message: 'Required' }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Internal error' }
 */
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

/**
 * @swagger
 * /api/v1/mev/arbitrage/opportunities:
 *   get:
 *     summary: Top arbitrage events by profit
 *     description: The 20 highest-profit cross-DEX and CEX-DEX arbitrage events.
 *     tags: [MEV]
 *     responses:
 *       200:
 *         description: Arbitrage events
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 opportunities:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/MevEvent' }
 *                 count: { type: integer, example: 20 }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
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

/**
 * @swagger
 * /api/v1/mev/arbitrage/executed:
 *   get:
 *     summary: Recent executed arbitrage events
 *     tags: [MEV]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20, maximum: 100 }
 *     responses:
 *       200:
 *         description: Executed arbitrage events (newest first)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/MevEvent' }
 *                 count: { type: integer, example: 20 }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
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

/**
 * @swagger
 * /api/v1/mev/arbitrage/leaderboard:
 *   get:
 *     summary: Top arbitrageurs by total profit
 *     tags: [MEV]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 10, maximum: 50 }
 *     responses:
 *       200:
 *         description: Ranked arbitrageurs
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 leaderboard:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/MevAttacker' }
 *                 count: { type: integer, example: 10 }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
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

/**
 * @swagger
 * /api/v1/mev/bots:
 *   get:
 *     summary: MEV bots ranked by attack count
 *     tags: [MEV]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20, maximum: 100 }
 *     responses:
 *       200:
 *         description: Bots (attackers) by attack count
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 bots:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/MevAttacker' }
 *                 count: { type: integer, example: 20 }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
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

/**
 * @swagger
 * /api/v1/mev/bots/active:
 *   get:
 *     summary: Bots active in the last 24 hours
 *     tags: [MEV]
 *     responses:
 *       200:
 *         description: Recently active bots
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 bots:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/MevAttacker' }
 *                 count: { type: integer, example: 7 }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
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

/**
 * @swagger
 * /api/v1/mev/flash-loan-attacks:
 *   get:
 *     summary: Recent flash loan attacks
 *     tags: [MEV]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20, maximum: 100 }
 *     responses:
 *       200:
 *         description: Flash loan attack events (newest first)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/MevEvent' }
 *                 count: { type: integer, example: 12 }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
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

/**
 * @swagger
 * /api/v1/mev/compensation/estimate/{address}:
 *   get:
 *     summary: Estimate claimable compensation for a victim
 *     description: Returns the victim's loss breakdown and an 80% claimable estimate.
 *     tags: [MEV]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Compensation estimate
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 address: { type: string }
 *                 totalLossUsd: { type: number }
 *                 incidentCount: { type: integer }
 *                 breakdown:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       txHash: { type: string }
 *                       mevType: { type: string }
 *                       lossUsd: { type: number }
 *                       date: { type: string, format: date-time }
 *                 claimableUsd: { type: number, description: '80% of totalLossUsd' }
 *               example:
 *                 address: GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI
 *                 totalLossUsd: 180.6
 *                 incidentCount: 3
 *                 breakdown:
 *                   - txHash: '3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566'
 *                     mevType: sandwich
 *                     lossUsd: 60.2
 *                     date: '2026-06-19T07:24:26.000Z'
 *                 claimableUsd: 144.48
 *       404:
 *         description: Victim not found
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Victim not found' }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
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

/**
 * @swagger
 * /api/v1/mev/compensation/claim:
 *   post:
 *     summary: Submit a compensation claim
 *     tags: [MEV]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [address]
 *             properties:
 *               address: { type: string }
 *               incidentIds: { type: array, items: { type: string } }
 *             example:
 *               address: GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI
 *     responses:
 *       201:
 *         description: Claim submitted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 claimId: { type: string }
 *                 address: { type: string }
 *                 claimableUsd: { type: number }
 *                 status: { type: string }
 *                 submittedAt: { type: string, format: date-time }
 *               example:
 *                 claimId: claim_1750319066000
 *                 address: GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI
 *                 claimableUsd: 144.48
 *                 status: submitted
 *                 submittedAt: '2026-06-19T07:24:26.000Z'
 *       400:
 *         description: Invalid request body
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/ZodValidationError' }]
 *               example:
 *                 error:
 *                   - { code: invalid_type, expected: string, received: undefined, path: [address], message: 'Required' }
 *       404:
 *         description: Victim not found
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Victim not found' }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
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

/**
 * @swagger
 * /api/v1/mev/compensation/claims/{address}:
 *   get:
 *     summary: List compensation claims for an address
 *     tags: [MEV]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Claims for the address (claims list is currently always empty)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 address: { type: string }
 *                 totalLossUsd: { type: number }
 *                 claims: { type: array, items: { type: object } }
 *               example:
 *                 address: GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI
 *                 totalLossUsd: 180.6
 *                 claims: []
 *       404:
 *         description: No claims found for address
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'No claims found for address' }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
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

/**
 * @swagger
 * /api/v1/mev/alerts:
 *   get:
 *     summary: List MEV alerts
 *     tags: [MEV]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20, maximum: 100 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, default: 0 }
 *       - in: query
 *         name: unacknowledged
 *         schema: { type: boolean }
 *         description: When true, only return unacknowledged alerts
 *     responses:
 *       200:
 *         description: Paginated alerts (offset-based)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/MevAlert' }
 *                 total: { type: integer, example: 53 }
 *                 limit: { type: integer, example: 20 }
 *                 offset: { type: integer, example: 0 }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
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

/**
 * @swagger
 * /api/v1/mev/alerts:
 *   post:
 *     summary: Create an MEV alert
 *     tags: [MEV]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [alertType, severity, title, description]
 *             properties:
 *               alertType: { type: string, enum: [sandwich_in_progress, sandwich_detected, mev_spike, protocol_targeted, user_victim] }
 *               severity: { type: string, enum: [critical, high, medium, low] }
 *               txHash: { type: string }
 *               victimAddress: { type: string }
 *               protocolAddress: { type: string }
 *               title: { type: string }
 *               description: { type: string }
 *               estimatedLoss: { type: number }
 *               recommendedAction: { type: string }
 *             example:
 *               alertType: sandwich_detected
 *               severity: high
 *               txHash: '3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566'
 *               victimAddress: GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI
 *               title: Sandwich attack detected
 *               description: Victim swap was front-run and back-run on the same pool
 *               estimatedLoss: 180.6
 *     responses:
 *       201:
 *         description: The created alert
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/MevAlert' }
 *       400:
 *         description: Invalid request body
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/ZodValidationError' }]
 *               example:
 *                 error:
 *                   - { code: invalid_type, expected: "'sandwich_in_progress' | 'sandwich_detected' | 'mev_spike' | 'protocol_targeted' | 'user_victim'", received: undefined, path: [alertType], message: 'Required' }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
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

/**
 * @swagger
 * /api/v1/mev/reports/daily:
 *   get:
 *     summary: MEV totals for the last 24 hours
 *     tags: [MEV]
 *     responses:
 *       200:
 *         description: Daily MEV totals
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 period: { type: string, example: daily }
 *                 since: { type: string, format: date-time }
 *                 totalEvents: { type: integer }
 *                 totalProfitUsd: { type: number }
 *                 totalLossUsd: { type: number }
 *               example:
 *                 period: daily
 *                 since: '2026-06-18T07:24:26.000Z'
 *                 totalEvents: 142
 *                 totalProfitUsd: 8420.5
 *                 totalLossUsd: 9100.25
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
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

/**
 * @swagger
 * /api/v1/mev/reports/weekly:
 *   get:
 *     summary: MEV totals for the last 7 days
 *     tags: [MEV]
 *     responses:
 *       200:
 *         description: Weekly MEV totals
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 period: { type: string, example: weekly }
 *                 since: { type: string, format: date-time }
 *                 totalEvents: { type: integer }
 *                 totalProfitUsd: { type: number }
 *                 totalLossUsd: { type: number }
 *               example:
 *                 period: weekly
 *                 since: '2026-06-12T07:24:26.000Z'
 *                 totalEvents: 980
 *                 totalProfitUsd: 58200.75
 *                 totalLossUsd: 63100.4
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
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

/**
 * @swagger
 * /api/v1/mev/reports/subscribe:
 *   post:
 *     summary: Subscribe to MEV reports
 *     description: Validates and echoes the subscription. Not persisted.
 *     tags: [MEV]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               address: { type: string }
 *               email: { type: string, format: email }
 *               frequency: { type: string, enum: [daily, weekly], default: daily }
 *             example:
 *               email: alerts@example.com
 *               frequency: weekly
 *     responses:
 *       201:
 *         description: Subscription accepted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 subscription:
 *                   type: object
 *                   properties:
 *                     address: { type: string }
 *                     email: { type: string }
 *                     frequency: { type: string, enum: [daily, weekly] }
 *               example:
 *                 success: true
 *                 subscription: { email: 'alerts@example.com', frequency: weekly }
 *       400:
 *         description: Invalid request body
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/ZodValidationError' }]
 *               example:
 *                 error:
 *                   - { code: invalid_string, validation: email, path: [email], message: 'Invalid email' }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Internal error' }
 */
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

/**
 * @swagger
 * /api/v1/mev/export:
 *   get:
 *     summary: Export MEV events
 *     description: Returns up to 10000 events as JSON, or a CSV file when format=csv.
 *     tags: [MEV]
 *     parameters:
 *       - in: query
 *         name: format
 *         schema: { type: string, enum: [json, csv], default: json }
 *       - in: query
 *         name: since
 *         schema: { type: string, format: date-time }
 *         description: Only events created at or after this timestamp
 *     responses:
 *       200:
 *         description: Events as JSON, or a CSV file attachment when format=csv
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/MevEvent' }
 *                 count: { type: integer, example: 1543 }
 *           text/csv:
 *             schema: { type: string }
 *             example: |
 *               id,txHash,ledgerSeq,timestamp,mevType,victimAddress,attackerAddress,profitUsd,lossUsd,confidence
 *               clz9q1x4t0000s6h2mevevt01,3389e9f0...445566,3168075,2026-06-19T07:24:26.000Z,sandwich,GBZX...,GAAZ...,152.4,180.6,0.95
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
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

/**
 * @swagger
 * /api/v1/mev/classify-ledger:
 *   post:
 *     summary: Classify and store MEV events for a ledger
 *     tags: [MEV]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ledgerSeq]
 *             properties:
 *               ledgerSeq: { type: integer, minimum: 1 }
 *             example:
 *               ledgerSeq: 3168075
 *     responses:
 *       200:
 *         description: Classification result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 classified: { type: integer, description: 'Number of events stored' }
 *                 ledgerSeq: { type: integer }
 *               example:
 *                 classified: 4
 *                 ledgerSeq: 3168075
 *       400:
 *         description: Invalid request body
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/ZodValidationError' }]
 *               example:
 *                 error:
 *                   - { code: invalid_type, expected: number, received: undefined, path: [ledgerSeq], message: 'Required' }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
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
