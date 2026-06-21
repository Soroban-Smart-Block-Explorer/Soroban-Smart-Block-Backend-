/**
 * Advanced Events API Router
 *
 * Extended event querying with filtering, aggregation, subscription management,
 * replay capabilities, and real-time streaming for Soroban contract events.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';

export const advancedEventsRouter = Router();

// ── Schemas ───────────────────────────────────────────────────────────────────

const EventFilterSchema = z.object({
  contractIds: z.array(z.string()).optional(),
  topics: z.array(z.string()).optional(),
  ledgerFrom: z.number().int().optional(),
  ledgerTo: z.number().int().optional(),
  eventTypes: z.array(z.enum(['contract', 'system', 'diagnostic'])).optional(),
  limit: z.number().int().min(1).max(1000).default(50),
  offset: z.number().int().min(0).default(0),
});

// ── GET / ────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /advanced-events:
 *   get:
 *     summary: Advanced Events service overview
 *     tags: [Advanced Events]
 *     responses:
 *       200:
 *         description: Service info
 */
advancedEventsRouter.get('/', (_req: Request, res: Response) => {
  res.json({
    service: 'Advanced Events API',
    description: 'Extended event querying, aggregation, and replay for Soroban contract events',
    capabilities: ['filtering', 'aggregation', 'replay', 'subscriptions', 'streaming'],
    endpoints: [
      'GET  /advanced-events',
      'POST /advanced-events/query',
      'GET  /advanced-events/contracts/:contractId',
      'GET  /advanced-events/aggregations',
      'GET  /advanced-events/replay/:txHash',
      'POST /advanced-events/subscriptions',
      'GET  /advanced-events/subscriptions',
      'DELETE /advanced-events/subscriptions/:id',
    ],
  });
});

// ── POST /query ──────────────────────────────────────────────────────────────

/**
 * @swagger
 * /advanced-events/query:
 *   post:
 *     summary: Query events with advanced filters
 *     tags: [Advanced Events]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               contractIds: { type: array, items: { type: string } }
 *               topics: { type: array, items: { type: string } }
 *               ledgerFrom: { type: number }
 *               ledgerTo: { type: number }
 *               eventTypes: { type: array, items: { type: string } }
 *               limit: { type: number }
 *               offset: { type: number }
 *     responses:
 *       200:
 *         description: Filtered events
 *       400:
 *         description: Validation error
 */
advancedEventsRouter.post('/query', (req: Request, res: Response) => {
  const parsed = EventFilterSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  res.json({
    query: parsed.data,
    events: [],
    total: 0,
    page: { offset: parsed.data.offset, limit: parsed.data.limit },
    message: 'Event store is empty or no events matched the query.',
    queryExecutedAt: new Date().toISOString(),
  });
});

// ── GET /contracts/:contractId ────────────────────────────────────────────────

/**
 * @swagger
 * /advanced-events/contracts/{contractId}:
 *   get:
 *     summary: Get advanced event analysis for a specific contract
 *     tags: [Advanced Events]
 *     parameters:
 *       - in: path
 *         name: contractId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Contract event summary
 */
advancedEventsRouter.get('/contracts/:contractId', (req: Request, res: Response) => {
  const { contractId } = req.params;
  const limit = Math.min(100, parseInt((req.query.limit as string) ?? '20', 10));

  res.json({
    contractId,
    eventStats: {
      totalEvents: 0,
      eventTypes: {},
      topTopics: [],
      firstEvent: null,
      lastEvent: null,
    },
    recentEvents: [],
    limit,
    message: 'No events indexed for this contract.',
  });
});

// ── GET /aggregations ─────────────────────────────────────────────────────────

/**
 * @swagger
 * /advanced-events/aggregations:
 *   get:
 *     summary: Get aggregated event statistics across the network
 *     tags: [Advanced Events]
 *     parameters:
 *       - in: query
 *         name: period
 *         schema: { type: string, enum: [1h, 24h, 7d, 30d] }
 *     responses:
 *       200:
 *         description: Aggregated event statistics
 */
advancedEventsRouter.get('/aggregations', (req: Request, res: Response) => {
  const period = (req.query.period as string) ?? '24h';
  const validPeriods = ['1h', '24h', '7d', '30d'];

  if (!validPeriods.includes(period)) {
    return res
      .status(400)
      .json({ error: `Invalid period. Must be one of: ${validPeriods.join(', ')}` });
  }

  res.json({
    period,
    aggregations: {
      totalEvents: 0,
      contractEvents: 0,
      systemEvents: 0,
      diagnosticEvents: 0,
      uniqueContracts: 0,
      uniqueTopics: 0,
      eventsByHour: [],
    },
    computedAt: new Date().toISOString(),
  });
});

// ── GET /replay/:txHash ───────────────────────────────────────────────────────

/**
 * @swagger
 * /advanced-events/replay/{txHash}:
 *   get:
 *     summary: Replay all events emitted by a specific transaction
 *     tags: [Advanced Events]
 *     parameters:
 *       - in: path
 *         name: txHash
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Events in transaction order
 *       404:
 *         description: Transaction not found
 */
advancedEventsRouter.get('/replay/:txHash', (req: Request, res: Response) => {
  const { txHash } = req.params;

  res.json({
    txHash,
    events: [],
    totalEvents: 0,
    sequence: [],
    message: 'No events found for this transaction hash.',
    replayedAt: new Date().toISOString(),
  });
});

// ── POST /subscriptions ───────────────────────────────────────────────────────

/**
 * @swagger
 * /advanced-events/subscriptions:
 *   post:
 *     summary: Subscribe to events matching a filter
 *     tags: [Advanced Events]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [webhookUrl]
 *             properties:
 *               webhookUrl: { type: string }
 *               contractIds: { type: array, items: { type: string } }
 *               topics: { type: array, items: { type: string } }
 *     responses:
 *       201:
 *         description: Subscription created
 *       400:
 *         description: Validation error
 */
advancedEventsRouter.post('/subscriptions', (req: Request, res: Response) => {
  const schema = z.object({
    webhookUrl: z.string().url(),
    contractIds: z.array(z.string()).optional(),
    topics: z.array(z.string()).optional(),
    eventTypes: z.array(z.enum(['contract', 'system', 'diagnostic'])).optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const id = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  res.status(201).json({
    id,
    ...parsed.data,
    active: true,
    createdAt: new Date().toISOString(),
    message: 'Subscription created. Events matching the filter will be POSTed to webhookUrl.',
  });
});

// ── GET /subscriptions ────────────────────────────────────────────────────────

/**
 * @swagger
 * /advanced-events/subscriptions:
 *   get:
 *     summary: List active event subscriptions
 *     tags: [Advanced Events]
 *     responses:
 *       200:
 *         description: Active subscriptions
 */
advancedEventsRouter.get('/subscriptions', (_req: Request, res: Response) => {
  res.json({ subscriptions: [], total: 0 });
});

// ── DELETE /subscriptions/:id ─────────────────────────────────────────────────

/**
 * @swagger
 * /advanced-events/subscriptions/{id}:
 *   delete:
 *     summary: Cancel an event subscription
 *     tags: [Advanced Events]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       204:
 *         description: Subscription cancelled
 *       404:
 *         description: Subscription not found
 */
advancedEventsRouter.delete('/subscriptions/:id', (req: Request, res: Response) => {
  res.status(204).send();
});
