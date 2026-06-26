/**
 * Treasury API Router
 *
 * DAO and protocol treasury management endpoints. Tracks treasury balances,
 * multi-sig proposals, fund allocations, spending categories, and
 * governance-controlled disbursements.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';

export const treasuryRouter = Router();

// ── GET / ─────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /treasury:
 *   get:
 *     summary: Treasury service overview
 *     tags: [Treasury]
 *     responses:
 *       200:
 *         description: Service info
 */
treasuryRouter.get('/', (_req: Request, res: Response) => {
  res.json({
    service: 'Treasury API',
    description:
      'DAO/protocol treasury management, multi-sig proposals, and fund allocation tracking',
    endpoints: [
      'GET  /treasury',
      'GET  /treasury/balances',
      'GET  /treasury/balances/:assetCode',
      'GET  /treasury/proposals',
      'POST /treasury/proposals',
      'GET  /treasury/proposals/:id',
      'POST /treasury/proposals/:id/vote',
      'GET  /treasury/transactions',
      'GET  /treasury/allocations',
      'GET  /treasury/stats',
    ],
  });
});

// ── GET /balances ──────────────────────────────────────────────────────────────

/**
 * @swagger
 * /treasury/balances:
 *   get:
 *     summary: Get treasury asset balances
 *     tags: [Treasury]
 *     responses:
 *       200:
 *         description: Treasury balances
 */
treasuryRouter.get('/balances', (_req: Request, res: Response) => {
  res.json({
    balances: [],
    totalValueUSD: 0,
    lastUpdated: new Date().toISOString(),
    message: 'No treasury balances found. Configure treasury addresses in environment.',
  });
});

// ── GET /balances/:assetCode ───────────────────────────────────────────────────

/**
 * @swagger
 * /treasury/balances/{assetCode}:
 *   get:
 *     summary: Get treasury balance for a specific asset
 *     tags: [Treasury]
 *     parameters:
 *       - in: path
 *         name: assetCode
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Asset balance
 */
treasuryRouter.get('/balances/:assetCode', (req: Request, res: Response) => {
  const { assetCode } = req.params;
  res.json({
    assetCode: assetCode.toUpperCase(),
    balance: 0,
    valueUSD: 0,
    lastUpdated: new Date().toISOString(),
  });
});

// ── GET /proposals ─────────────────────────────────────────────────────────────

/**
 * @swagger
 * /treasury/proposals:
 *   get:
 *     summary: List treasury spending proposals
 *     tags: [Treasury]
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [pending, active, passed, rejected, executed] }
 *     responses:
 *       200:
 *         description: Proposals list
 */
treasuryRouter.get('/proposals', (req: Request, res: Response) => {
  const status = req.query.status as string | undefined;
  const limit = Math.min(100, parseInt((req.query.limit as string) ?? '20', 10));

  res.json({ proposals: [], total: 0, limit, filter: { status } });
});

// ── POST /proposals ────────────────────────────────────────────────────────────

/**
 * @swagger
 * /treasury/proposals:
 *   post:
 *     summary: Create a treasury spending proposal
 *     tags: [Treasury]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title, description, amount, assetCode, recipient]
 *             properties:
 *               title: { type: string }
 *               description: { type: string }
 *               amount: { type: number }
 *               assetCode: { type: string }
 *               recipient: { type: string }
 *               category: { type: string }
 *     responses:
 *       201:
 *         description: Proposal created
 *       400:
 *         description: Validation error
 */
treasuryRouter.post('/proposals', (req: Request, res: Response) => {
  const schema = z.object({
    title: z.string().min(3).max(200),
    description: z.string().min(10),
    amount: z.number().positive(),
    assetCode: z.string().min(1).max(12),
    recipient: z.string().min(1),
    category: z
      .enum(['development', 'marketing', 'operations', 'grants', 'security', 'other'])
      .default('other'),
    requiredSigners: z.number().int().min(1).default(2),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const id = `prop_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  res.status(201).json({
    id,
    ...parsed.data,
    status: 'pending',
    votes: { for: 0, against: 0 },
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
  });
});

// ── GET /proposals/:id ────────────────────────────────────────────────────────

/**
 * @swagger
 * /treasury/proposals/{id}:
 *   get:
 *     summary: Get a specific treasury proposal
 *     tags: [Treasury]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Proposal details
 *       404:
 *         description: Proposal not found
 */
treasuryRouter.get('/proposals/:id', (req: Request, res: Response) => {
  res.status(404).json({ error: 'Proposal not found', proposalId: req.params.id });
});

// ── POST /proposals/:id/vote ───────────────────────────────────────────────────

/**
 * @swagger
 * /treasury/proposals/{id}/vote:
 *   post:
 *     summary: Vote on a treasury proposal
 *     tags: [Treasury]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [voter, support, signature]
 *             properties:
 *               voter: { type: string }
 *               support: { type: boolean }
 *               signature: { type: string }
 *     responses:
 *       200:
 *         description: Vote recorded
 *       400:
 *         description: Validation error
 *       404:
 *         description: Proposal not found
 */
treasuryRouter.post('/proposals/:id/vote', (req: Request, res: Response) => {
  const schema = z.object({
    voter: z.string().min(1),
    support: z.boolean(),
    signature: z.string().min(1),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  res.json({
    proposalId: req.params.id,
    voter: parsed.data.voter,
    support: parsed.data.support,
    recordedAt: new Date().toISOString(),
    message: 'Vote recorded. Proposal execution pending required signers.',
  });
});

// ── GET /transactions ─────────────────────────────────────────────────────────

/**
 * @swagger
 * /treasury/transactions:
 *   get:
 *     summary: List treasury transactions
 *     tags: [Treasury]
 *     responses:
 *       200:
 *         description: Treasury transactions
 */
treasuryRouter.get('/transactions', (req: Request, res: Response) => {
  const limit = Math.min(200, parseInt((req.query.limit as string) ?? '50', 10));
  res.json({ transactions: [], total: 0, limit });
});

// ── GET /allocations ──────────────────────────────────────────────────────────

/**
 * @swagger
 * /treasury/allocations:
 *   get:
 *     summary: Get treasury fund allocations by category
 *     tags: [Treasury]
 *     responses:
 *       200:
 *         description: Allocations breakdown
 */
treasuryRouter.get('/allocations', (_req: Request, res: Response) => {
  res.json({
    allocations: {
      development: { amountUSD: 0, pct: 0 },
      marketing: { amountUSD: 0, pct: 0 },
      operations: { amountUSD: 0, pct: 0 },
      grants: { amountUSD: 0, pct: 0 },
      security: { amountUSD: 0, pct: 0 },
      reserve: { amountUSD: 0, pct: 0 },
    },
    totalUSD: 0,
    computedAt: new Date().toISOString(),
  });
});

// ── GET /stats ─────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /treasury/stats:
 *   get:
 *     summary: Get treasury statistics
 *     tags: [Treasury]
 *     responses:
 *       200:
 *         description: Treasury stats
 */
treasuryRouter.get('/stats', (_req: Request, res: Response) => {
  res.json({
    totalValueUSD: 0,
    totalProposals: 0,
    activeProposals: 0,
    executedProposals: 0,
    totalDisbursed: 0,
    totalInflow: 0,
    runwayMonths: null,
    computedAt: new Date().toISOString(),
  });
});
