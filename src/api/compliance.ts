/**
 * Compliance API Router
 *
 * General compliance management for Stellar network activity. Covers
 * sanctions screening, transaction monitoring, suspicious activity
 * reporting, and regulatory audit log generation.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';

export const complianceRouter = Router();

// ── GET / ─────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /compliance:
 *   get:
 *     summary: Compliance service overview
 *     tags: [Compliance]
 *     responses:
 *       200:
 *         description: Service info
 */
complianceRouter.get('/', (_req: Request, res: Response) => {
  res.json({
    service: 'Compliance API',
    description:
      'Sanctions screening, transaction monitoring, and regulatory reporting for Stellar',
    endpoints: [
      'GET  /compliance',
      'POST /compliance/screen',
      'GET  /compliance/watchlist',
      'GET  /compliance/watchlist/:address',
      'POST /compliance/watchlist',
      'DELETE /compliance/watchlist/:address',
      'GET  /compliance/alerts',
      'POST /compliance/report',
      'GET  /compliance/reports',
      'GET  /compliance/stats',
    ],
  });
});

// ── POST /screen ──────────────────────────────────────────────────────────────

/**
 * @swagger
 * /compliance/screen:
 *   post:
 *     summary: Screen an address against sanctions lists
 *     tags: [Compliance]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [address]
 *             properties:
 *               address: { type: string }
 *               context: { type: string }
 *     responses:
 *       200:
 *         description: Screening result
 *       400:
 *         description: Validation error
 */
complianceRouter.post('/screen', (req: Request, res: Response) => {
  const schema = z.object({
    address: z.string().min(1),
    context: z.string().optional(),
    checkLists: z.array(z.string()).optional().default(['OFAC', 'EU', 'UN']),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { address, checkLists } = parsed.data;

  res.json({
    address,
    screened: true,
    sanctioned: false,
    listsChecked: checkLists,
    matches: [],
    riskScore: 0,
    riskLevel: 'low',
    screenedAt: new Date().toISOString(),
    note: 'Demo response. Connect real sanctions screening service for production use.',
  });
});

// ── GET /watchlist ────────────────────────────────────────────────────────────

/**
 * @swagger
 * /compliance/watchlist:
 *   get:
 *     summary: List addresses on the compliance watchlist
 *     tags: [Compliance]
 *     responses:
 *       200:
 *         description: Watchlist entries
 */
complianceRouter.get('/watchlist', (req: Request, res: Response) => {
  const limit = Math.min(200, parseInt((req.query.limit as string) ?? '50', 10));
  res.json({ watchlist: [], total: 0, limit });
});

// ── GET /watchlist/:address ────────────────────────────────────────────────────

/**
 * @swagger
 * /compliance/watchlist/{address}:
 *   get:
 *     summary: Check if an address is on the watchlist
 *     tags: [Compliance]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Watchlist status
 */
complianceRouter.get('/watchlist/:address', (req: Request, res: Response) => {
  res.json({
    address: req.params.address,
    onWatchlist: false,
    reason: null,
    addedAt: null,
  });
});

// ── POST /watchlist ────────────────────────────────────────────────────────────

/**
 * @swagger
 * /compliance/watchlist:
 *   post:
 *     summary: Add an address to the watchlist
 *     tags: [Compliance]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [address, reason]
 *             properties:
 *               address: { type: string }
 *               reason: { type: string }
 *               severity: { type: string, enum: [low, medium, high, critical] }
 *     responses:
 *       201:
 *         description: Address added
 *       400:
 *         description: Validation error
 */
complianceRouter.post('/watchlist', (req: Request, res: Response) => {
  const schema = z.object({
    address: z.string().min(1),
    reason: z.string().min(3),
    severity: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
    addedBy: z.string().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  res.status(201).json({
    ...parsed.data,
    id: `wl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    addedAt: new Date().toISOString(),
  });
});

// ── DELETE /watchlist/:address ─────────────────────────────────────────────────

/**
 * @swagger
 * /compliance/watchlist/{address}:
 *   delete:
 *     summary: Remove an address from the watchlist
 *     tags: [Compliance]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       204:
 *         description: Address removed
 */
complianceRouter.delete('/watchlist/:address', (_req: Request, res: Response) => {
  res.status(204).send();
});

// ── GET /alerts ────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /compliance/alerts:
 *   get:
 *     summary: Get compliance alerts for suspicious activity
 *     tags: [Compliance]
 *     parameters:
 *       - in: query
 *         name: severity
 *         schema: { type: string, enum: [low, medium, high, critical] }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [open, resolved, dismissed] }
 *     responses:
 *       200:
 *         description: Compliance alerts
 */
complianceRouter.get('/alerts', (req: Request, res: Response) => {
  const severity = req.query.severity as string | undefined;
  const status = (req.query.status as string) ?? 'open';
  const limit = Math.min(200, parseInt((req.query.limit as string) ?? '50', 10));

  res.json({ alerts: [], total: 0, limit, filter: { severity, status } });
});

// ── POST /report ───────────────────────────────────────────────────────────────

/**
 * @swagger
 * /compliance/report:
 *   post:
 *     summary: File a suspicious activity report (SAR)
 *     tags: [Compliance]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [subjectAddress, activityType, description]
 *             properties:
 *               subjectAddress: { type: string }
 *               activityType: { type: string }
 *               description: { type: string }
 *               relatedTxHashes: { type: array, items: { type: string } }
 *     responses:
 *       201:
 *         description: SAR filed
 *       400:
 *         description: Validation error
 */
complianceRouter.post('/report', (req: Request, res: Response) => {
  const schema = z.object({
    subjectAddress: z.string().min(1),
    activityType: z.enum([
      'money_laundering',
      'sanctions_evasion',
      'fraud',
      'market_manipulation',
      'other',
    ]),
    description: z.string().min(20),
    relatedTxHashes: z.array(z.string()).default([]),
    reportedBy: z.string().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const reportId = `SAR_${Date.now()}_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

  res.status(201).json({
    reportId,
    ...parsed.data,
    status: 'filed',
    filedAt: new Date().toISOString(),
    message: 'Suspicious activity report filed successfully.',
  });
});

// ── GET /reports ───────────────────────────────────────────────────────────────

/**
 * @swagger
 * /compliance/reports:
 *   get:
 *     summary: List filed compliance reports
 *     tags: [Compliance]
 *     responses:
 *       200:
 *         description: Reports list
 */
complianceRouter.get('/reports', (req: Request, res: Response) => {
  const limit = Math.min(100, parseInt((req.query.limit as string) ?? '20', 10));
  res.json({ reports: [], total: 0, limit });
});

// ── GET /stats ─────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /compliance/stats:
 *   get:
 *     summary: Get compliance system statistics
 *     tags: [Compliance]
 *     responses:
 *       200:
 *         description: Compliance stats
 */
complianceRouter.get('/stats', (_req: Request, res: Response) => {
  res.json({
    watchlistSize: 0,
    openAlerts: 0,
    resolvedAlerts: 0,
    totalReports: 0,
    screeningsLast24h: 0,
    sanctionedHits: 0,
    computedAt: new Date().toISOString(),
  });
});
