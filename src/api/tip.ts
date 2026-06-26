/**
 * Threat Intelligence Platform REST API
 *
 * Advisories CRUD · subscriptions · webhooks · RSS/JSON feeds
 * Analytics · review workflow · community comments
 */
import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { z } from 'zod';
import { Prisma, PrismaClient } from '@prisma/client';
import { submitManual } from '../tip/collectors';
import { rescore, deduplicateAdvisories } from '../tip/correlator';
import { dispatchNotifications } from '../tip/notifier';
import {
  getSeverityDistribution,
  getTrendData,
  getTopAffectedContracts,
  getStatusSummary,
} from '../tip/analytics';

const db = new PrismaClient();

/**
 * @swagger
 * tags:
 *   name: Threat Intelligence
 *   description: Advisories, review workflow, subscriptions, webhooks, RSS/JSON feeds, analytics, and source management
 */
export const tipRouter = Router();

// ─── Schemas ──────────────────────────────────────────────────────────────────

const CreateAdvisory = z.object({
  title: z.string().min(3),
  description: z.string().min(10),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
  cvssScore: z.number().min(0).max(10).optional(),
  affectedContracts: z.array(z.string()).default([]),
  affectedChains: z.array(z.string()).default(['stellar']),
  mitigations: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  externalUrl: z.string().url().optional(),
});

const UpdateAdvisory = z.object({
  status: z.enum(['open', 'under_review', 'resolved', 'disputed']).optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).optional(),
  mitigations: z.array(z.string()).optional(),
  resolvedAt: z.string().datetime().optional(),
});

const ReviewSchema = z.object({
  role: z.enum(['analyst', 'admin']),
  decision: z.enum(['approve', 'reject', 'escalate']),
  notes: z.string().optional(),
  reviewerKey: z.string(),
});

const SubSchema = z.object({
  channel: z.enum(['email', 'slack', 'discord', 'telegram']),
  target: z.string().min(3),
  filters: z
    .object({
      severity: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
    })
    .optional(),
});

const WebhookSchema = z.object({
  url: z.string().url(),
  secret: z.string().min(8),
  events: z.array(z.string()).default(['advisory.created']),
});

// ─── Advisories ──────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/tip/advisories:
 *   get:
 *     summary: List threat advisories
 *     description: Paginated advisories, optionally filtered by severity, status, or keyword.
 *     tags: [Threat Intelligence]
 *     parameters:
 *       - in: query
 *         name: severity
 *         schema: { type: string, enum: [critical, high, medium, low, info] }
 *         description: Filter by severity level
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [open, under_review, resolved, disputed] }
 *         description: Filter by advisory status
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Case-insensitive substring match on title and description
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200:
 *         description: Paginated advisory list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 items:
 *                   type: array
 *                   items:
 *                     allOf:
 *                       - $ref: '#/components/schemas/ThreatAdvisory'
 *                       - type: object
 *                         properties:
 *                           source:
 *                             type: object
 *                             nullable: true
 *                             properties:
 *                               name: { type: string, example: NVD_CVE }
 *                 total: { type: integer, example: 42 }
 *                 page: { type: integer, example: 1 }
 *                 limit: { type: integer, example: 20 }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
tipRouter.get(
  '/advisories',
  asyncHandler(async (req: Request, res: Response) => {
    const {
      severity,
      status,
      page = '1',
      limit = '20',
      search,
    } = req.query as Record<string, string>;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const where: any = {};
    if (severity) where.severity = severity;
    if (status) where.status = status;
    if (search)
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];

    const [items, total] = await Promise.all([
      db.threatAdvisory.findMany({
        where,
        skip,
        take: parseInt(limit),
        orderBy: { createdAt: 'desc' },
        include: { source: { select: { name: true } } },
      }),
      db.threatAdvisory.count({ where }),
    ]);

    res.json({ items, total, page: parseInt(page), limit: parseInt(limit) });
  }),
);

/**
 * @swagger
 * /api/v1/tip/advisories/{id}:
 *   get:
 *     summary: Get a threat advisory by id
 *     description: Returns the advisory with its source, review history, and community comments.
 *     tags: [Threat Intelligence]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Advisory with related records
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/ThreatAdvisory' }]
 *               example:
 *                 id: clz9q1x4t0000s6h2advis001
 *                 title: Reentrancy in transfer hook
 *                 severity: high
 *                 status: open
 *                 affectedContracts: [CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5]
 *                 affectedChains: [stellar]
 *                 tags: [reentrancy, community]
 *                 createdAt: '2026-06-19T07:24:26.000Z'
 *                 updatedAt: '2026-06-19T07:24:27.000Z'
 *       404:
 *         description: Advisory not found
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Not found' }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
tipRouter.get(
  '/advisories/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const advisory = await db.threatAdvisory.findUnique({
      where: { id: req.params.id },
      include: { source: true, correlations: true, reviews: true, comments: true },
    });
    if (!advisory) return res.status(404).json({ error: 'Not found' });
    res.json(advisory);
  }),
);

/**
 * @swagger
 * /api/v1/tip/advisories:
 *   post:
 *     summary: Submit a new threat advisory
 *     tags: [Threat Intelligence]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title, description, severity]
 *             properties:
 *               title: { type: string, minLength: 3, example: 'Reentrancy in transfer hook' }
 *               description: { type: string, minLength: 10, example: 'A reentrancy vulnerability allows double-spend via malicious token hook.' }
 *               severity: { type: string, enum: [critical, high, medium, low, info], example: high }
 *               cvssScore: { type: number, minimum: 0, maximum: 10, example: 8.1 }
 *               affectedContracts:
 *                 type: array
 *                 items: { type: string }
 *                 example: [CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5]
 *               affectedChains:
 *                 type: array
 *                 items: { type: string }
 *                 example: [stellar]
 *               mitigations:
 *                 type: array
 *                 items: { type: string }
 *                 example: ['Upgrade to patched version >= 1.2.1']
 *               tags:
 *                 type: array
 *                 items: { type: string }
 *                 example: [reentrancy, token]
 *               externalUrl: { type: string, format: uri, example: 'https://nvd.nist.gov/vuln/detail/CVE-2026-1234' }
 *     responses:
 *       201:
 *         description: Advisory created; notifications dispatched
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: string, example: clz9q1x4t0000s6h2advis001 }
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ZodFlattenedError' }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
tipRouter.post(
  '/advisories',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = CreateAdvisory.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const submittedBy = (req.headers['x-api-key'] as string) ?? 'anonymous';
    const id = await submitManual({ ...parsed.data, submittedBy });

    const advisory = await db.threatAdvisory.findUnique({ where: { id } });
    await dispatchNotifications({
      advisoryId: id,
      event: 'advisory.created',
      title: advisory!.title,
      severity: advisory!.severity,
    });

    res.status(201).json({ id });
  }),
);

/**
 * @swagger
 * /api/v1/tip/advisories/{id}:
 *   patch:
 *     summary: Update an advisory's status, severity, mitigations, or resolved timestamp
 *     tags: [Threat Intelligence]
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
 *             properties:
 *               status: { type: string, enum: [open, under_review, resolved, disputed] }
 *               severity: { type: string, enum: [critical, high, medium, low, info] }
 *               mitigations:
 *                 type: array
 *                 items: { type: string }
 *                 example: ['Apply patch #42 from upstream']
 *               resolvedAt: { type: string, format: date-time, example: '2026-06-19T07:24:26.000Z' }
 *     responses:
 *       200:
 *         description: Updated advisory record
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/ThreatAdvisory' }]
 *               example:
 *                 id: clz9q1x4t0000s6h2advis001
 *                 severity: high
 *                 status: resolved
 *                 updatedAt: '2026-06-19T07:24:27.000Z'
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ZodFlattenedError' }
 *       500:
 *         description: Server error or advisory not found
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Record to update not found' }
 */
tipRouter.patch(
  '/advisories/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = UpdateAdvisory.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const updated = await db.threatAdvisory.update({
      where: { id: req.params.id },
      data: {
        ...parsed.data,
        resolvedAt: parsed.data.resolvedAt ? new Date(parsed.data.resolvedAt) : undefined,
      },
    });

    await dispatchNotifications({
      advisoryId: updated.id,
      event: parsed.data.status === 'resolved' ? 'advisory.resolved' : 'advisory.updated',
      title: updated.title,
      severity: updated.severity,
    });

    res.json(updated);
  }),
);

/**
 * @swagger
 * /api/v1/tip/advisories/{id}:
 *   delete:
 *     summary: Delete a threat advisory
 *     tags: [Threat Intelligence]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       204:
 *         description: Advisory deleted
 *       500:
 *         description: Server error or advisory not found
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Record to delete not found' }
 */
tipRouter.delete(
  '/advisories/:id',
  asyncHandler(async (req: Request, res: Response) => {
    await db.threatAdvisory.delete({ where: { id: req.params.id } });
    res.status(204).send();
  }),
);

// ─── Review workflow ──────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/tip/advisories/{id}/reviews:
 *   post:
 *     summary: Submit a review decision for an advisory
 *     description: An "approve" decision also advances the advisory status to "under_review".
 *     tags: [Threat Intelligence]
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
 *             required: [role, decision, reviewerKey]
 *             properties:
 *               role: { type: string, enum: [analyst, admin], example: analyst }
 *               decision: { type: string, enum: [approve, reject, escalate], example: approve }
 *               notes: { type: string, example: 'Confirmed exploitable on testnet.' }
 *               reviewerKey: { type: string, example: sk_live_abc123 }
 *     responses:
 *       201:
 *         description: Review created
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/ThreatReview' }]
 *               example:
 *                 id: clz9q1x4t0000s6h2review001
 *                 advisoryId: clz9q1x4t0000s6h2advis001
 *                 role: analyst
 *                 decision: approve
 *                 notes: Confirmed exploitable on testnet.
 *                 reviewerKey: sk_live_abc123
 *                 createdAt: '2026-06-19T07:24:26.000Z'
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ZodFlattenedError' }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
tipRouter.post(
  '/advisories/:id/reviews',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = ReviewSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const review = await db.threatReview.create({
      data: { advisoryId: req.params.id, ...parsed.data },
    });

    // Auto-promote status on approval
    if (parsed.data.decision === 'approve') {
      await db.threatAdvisory.update({
        where: { id: req.params.id },
        data: { status: 'under_review' },
      });
    }

    res.status(201).json(review);
  }),
);

// ─── Comments ─────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/tip/advisories/{id}/comments:
 *   post:
 *     summary: Post a community comment on an advisory
 *     tags: [Threat Intelligence]
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
 *             required: [body]
 *             properties:
 *               body: { type: string, example: 'Reproduced on testnet ledger 3168075.' }
 *     responses:
 *       201:
 *         description: Comment created
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/ThreatComment' }]
 *               example:
 *                 id: clz9q1x4t0000s6h2comment01
 *                 advisoryId: clz9q1x4t0000s6h2advis001
 *                 authorKey: anonymous
 *                 body: Reproduced on testnet ledger 3168075.
 *                 createdAt: '2026-06-19T07:24:26.000Z'
 *       400:
 *         description: Missing or non-string body field
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'body required' }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
tipRouter.post(
  '/advisories/:id/comments',
  asyncHandler(async (req: Request, res: Response) => {
    const { body } = req.body;
    if (!body || typeof body !== 'string') return res.status(400).json({ error: 'body required' });

    const authorKey = (req.headers['x-api-key'] as string) ?? 'anonymous';
    const comment = await db.threatComment.create({
      data: { advisoryId: req.params.id, authorKey, body },
    });
    res.status(201).json(comment);
  }),
);

// ─── Correlator ───────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/tip/correlate:
 *   post:
 *     summary: Run advisory deduplication and correlation
 *     description: Merges duplicate advisories and returns the number of records linked.
 *     tags: [Threat Intelligence]
 *     responses:
 *       200:
 *         description: Number of advisories linked by the correlator
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 linked: { type: integer, example: 3 }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Correlator failed' }
 */
tipRouter.post(
  '/correlate',
  asyncHandler(async (_req: Request, res: Response) => {
    const linked = await deduplicateAdvisories();
    res.json({ linked });
  }),
);

/**
 * @swagger
 * /api/v1/tip/advisories/{id}/rescore:
 *   post:
 *     summary: Recompute the severity score for an advisory
 *     tags: [Threat Intelligence]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Newly computed severity
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 severity: { type: string, enum: [critical, high, medium, low, info], example: high }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Rescore failed' }
 */
tipRouter.post(
  '/advisories/:id/rescore',
  asyncHandler(async (req: Request, res: Response) => {
    const newSeverity = await rescore(req.params.id);
    res.json({ severity: newSeverity });
  }),
);

// ─── Subscriptions ────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/tip/subscriptions:
 *   get:
 *     summary: List all TIP notification subscriptions
 *     tags: [Threat Intelligence]
 *     responses:
 *       200:
 *         description: All subscriptions
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { $ref: '#/components/schemas/TipSubscription' }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
tipRouter.get(
  '/subscriptions',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(await db.tipSubscription.findMany());
  }),
);

/**
 * @swagger
 * /api/v1/tip/subscriptions:
 *   post:
 *     summary: Create or reactivate a TIP notification subscription
 *     description: Upserts on (channel, target); reactivates an existing subscription if one exists.
 *     tags: [Threat Intelligence]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [channel, target]
 *             properties:
 *               channel: { type: string, enum: [email, slack, discord, telegram], example: slack }
 *               target: { type: string, minLength: 3, example: '#security-alerts' }
 *               filters:
 *                 type: object
 *                 properties:
 *                   severity:
 *                     type: array
 *                     items: { type: string }
 *                     example: [critical, high]
 *                   tags:
 *                     type: array
 *                     items: { type: string }
 *                     example: [reentrancy]
 *     responses:
 *       201:
 *         description: Subscription created or reactivated
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/TipSubscription' }]
 *               example:
 *                 id: clz9q1x4t0000s6h2tipsub01
 *                 channel: slack
 *                 target: '#security-alerts'
 *                 active: true
 *                 filters: { severity: [critical, high] }
 *                 createdAt: '2026-06-19T07:24:26.000Z'
 *                 updatedAt: '2026-06-19T07:24:26.000Z'
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ZodFlattenedError' }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
tipRouter.post(
  '/subscriptions',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = SubSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const sub = await db.tipSubscription.upsert({
      where: { channel_target: { channel: parsed.data.channel, target: parsed.data.target } },
      update: { active: true, filters: (parsed.data.filters ?? null) as Prisma.InputJsonValue },
      create: { ...parsed.data, filters: (parsed.data.filters ?? null) as Prisma.InputJsonValue },
    });
    res.status(201).json(sub);
  }),
);

/**
 * @swagger
 * /api/v1/tip/subscriptions/{id}:
 *   delete:
 *     summary: Delete a TIP subscription
 *     tags: [Threat Intelligence]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       204:
 *         description: Subscription deleted
 *       500:
 *         description: Server error or subscription not found
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Record to delete not found' }
 */
tipRouter.delete(
  '/subscriptions/:id',
  asyncHandler(async (req: Request, res: Response) => {
    await db.tipSubscription.delete({ where: { id: req.params.id } });
    res.status(204).send();
  }),
);

// ─── Webhooks ─────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/tip/webhooks:
 *   get:
 *     summary: List registered TIP webhooks
 *     description: Returns id, url, events, and active status; secret is excluded.
 *     tags: [Threat Intelligence]
 *     responses:
 *       200:
 *         description: Webhook list
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id: { type: string, example: clz9q1x4t0000s6h2webhook1 }
 *                   url: { type: string, format: uri, example: 'https://hooks.example.com/tip' }
 *                   events: { type: array, items: { type: string }, example: [advisory.created] }
 *                   active: { type: boolean, example: true }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
tipRouter.get(
  '/webhooks',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(
      await db.tipWebhook.findMany({ select: { id: true, url: true, events: true, active: true } }),
    );
  }),
);

/**
 * @swagger
 * /api/v1/tip/webhooks:
 *   post:
 *     summary: Register or update a TIP webhook
 *     description: Upserts on URL; an existing webhook's secret and events are overwritten.
 *     tags: [Threat Intelligence]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [url, secret]
 *             properties:
 *               url: { type: string, format: uri, example: 'https://hooks.example.com/tip' }
 *               secret: { type: string, minLength: 8, example: s3cr3t-hmac-key }
 *               events:
 *                 type: array
 *                 items: { type: string }
 *                 default: [advisory.created]
 *                 example: [advisory.created, advisory.resolved]
 *     responses:
 *       201:
 *         description: Webhook registered or updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: string, example: clz9q1x4t0000s6h2webhook1 }
 *                 url: { type: string, format: uri, example: 'https://hooks.example.com/tip' }
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ZodFlattenedError' }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
tipRouter.post(
  '/webhooks',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = WebhookSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const wh = await db.tipWebhook.upsert({
      where: { url: parsed.data.url },
      update: { ...parsed.data },
      create: { ...parsed.data },
    });
    res.status(201).json({ id: wh.id, url: wh.url });
  }),
);

/**
 * @swagger
 * /api/v1/tip/webhooks/{id}:
 *   delete:
 *     summary: Delete a TIP webhook
 *     tags: [Threat Intelligence]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       204:
 *         description: Webhook deleted
 *       500:
 *         description: Server error or webhook not found
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Record to delete not found' }
 */
tipRouter.delete(
  '/webhooks/:id',
  asyncHandler(async (req: Request, res: Response) => {
    await db.tipWebhook.delete({ where: { id: req.params.id } });
    res.status(204).send();
  }),
);

// ─── Feeds ────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/tip/feeds/json:
 *   get:
 *     summary: JSON feed of recent non-disputed advisories
 *     tags: [Threat Intelligence]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50, maximum: 200 }
 *         description: Clamped to 200; no 400 is returned for out-of-range values
 *     responses:
 *       200:
 *         description: Advisory feed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 feed: { type: string, example: Soroban TIP }
 *                 generated: { type: string, format: date-time, example: '2026-06-19T07:24:26.000Z' }
 *                 items:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string, example: clz9q1x4t0000s6h2advis001 }
 *                       title: { type: string, example: 'Reentrancy in transfer hook' }
 *                       severity: { type: string, enum: [critical, high, medium, low, info], example: high }
 *                       cveId: { type: string, nullable: true, example: 'CVE-2026-1234' }
 *                       ghsaId: { type: string, nullable: true, example: null }
 *                       affectedContracts:
 *                         type: array
 *                         items: { type: string }
 *                         example: [CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5]
 *                       affectedChains:
 *                         type: array
 *                         items: { type: string }
 *                         example: [stellar]
 *                       publishedAt: { type: string, format: date-time, nullable: true, example: '2026-06-19T07:24:26.000Z' }
 *                       externalUrl: { type: string, nullable: true, example: null }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
tipRouter.get(
  '/feeds/json',
  asyncHandler(async (req: Request, res: Response) => {
    const limit = Math.min(parseInt(String(req.query.limit ?? '50')), 200);
    const items = await db.threatAdvisory.findMany({
      where: { status: { not: 'disputed' } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        title: true,
        severity: true,
        cveId: true,
        ghsaId: true,
        affectedContracts: true,
        affectedChains: true,
        publishedAt: true,
        externalUrl: true,
      },
    });
    res.json({ feed: 'Soroban TIP', generated: new Date(), items });
  }),
);

/**
 * @swagger
 * /api/v1/tip/feeds/rss:
 *   get:
 *     summary: RSS 2.0 feed of recent non-disputed advisories
 *     description: Returns the 50 most recent non-disputed advisories as an RSS 2.0 XML document.
 *     tags: [Threat Intelligence]
 *     responses:
 *       200:
 *         description: RSS 2.0 XML feed
 *         content:
 *           application/rss+xml:
 *             schema:
 *               type: string
 *               example: "<?xml version=\"1.0\" encoding=\"UTF-8\"?><rss version=\"2.0\">...</rss>"
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
tipRouter.get(
  '/feeds/rss',
  asyncHandler(async (_req: Request, res: Response) => {
    const items = await db.threatAdvisory.findMany({
      where: { status: { not: 'disputed' } },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        title: true,
        description: true,
        severity: true,
        createdAt: true,
        externalUrl: true,
      },
    });

    const entries = items
      .map(
        (i) =>
          `<item><title><![CDATA[[${i.severity.toUpperCase()}] ${i.title}]]></title>` +
          `<link>${i.externalUrl ?? ''}</link>` +
          `<description><![CDATA[${i.description}]]></description>` +
          `<pubDate>${i.createdAt.toUTCString()}</pubDate>` +
          `<guid>${i.id}</guid></item>`,
      )
      .join('\n');

    res.type('application/rss+xml').send(
      `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>Soroban Threat Intelligence</title>
<link>https://soroban-explorer.local/api/v1/tip/feeds/rss</link>
<description>Security advisories for Soroban smart contracts</description>
${entries}
</channel></rss>`,
    );
  }),
);

// ─── Analytics ───────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/tip/analytics/severity:
 *   get:
 *     summary: Advisory count grouped by severity
 *     tags: [Threat Intelligence]
 *     responses:
 *       200:
 *         description: Per-severity counts
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   severity: { type: string, enum: [critical, high, medium, low, info], example: high }
 *                   count: { type: integer, example: 14 }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
tipRouter.get(
  '/analytics/severity',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(await getSeverityDistribution());
  }),
);

/**
 * @swagger
 * /api/v1/tip/analytics/trend:
 *   get:
 *     summary: Daily advisory creation trend
 *     description: Returns a per-day bucket of total, critical, and high advisories over the past N days.
 *     tags: [Threat Intelligence]
 *     parameters:
 *       - in: query
 *         name: days
 *         schema: { type: integer, default: 30, maximum: 365 }
 *         description: Lookback window in days; clamped to 365
 *     responses:
 *       200:
 *         description: Daily trend buckets
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   date: { type: string, example: '2026-06-19' }
 *                   total: { type: integer, example: 5 }
 *                   critical: { type: integer, example: 1 }
 *                   high: { type: integer, example: 2 }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
tipRouter.get(
  '/analytics/trend',
  asyncHandler(async (req: Request, res: Response) => {
    const days = Math.min(parseInt(String(req.query.days ?? '30')), 365);
    res.json(await getTrendData(days));
  }),
);

/**
 * @swagger
 * /api/v1/tip/analytics/top-contracts:
 *   get:
 *     summary: Contracts most frequently cited in advisories
 *     tags: [Threat Intelligence]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 10, maximum: 50 }
 *         description: Clamped to 50
 *     responses:
 *       200:
 *         description: Ranked contract list
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   contract: { type: string, example: CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5 }
 *                   count: { type: integer, example: 7 }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
tipRouter.get(
  '/analytics/top-contracts',
  asyncHandler(async (req: Request, res: Response) => {
    const limit = Math.min(parseInt(String(req.query.limit ?? '10')), 50);
    res.json(await getTopAffectedContracts(limit));
  }),
);

/**
 * @swagger
 * /api/v1/tip/analytics/status:
 *   get:
 *     summary: Advisory count grouped by status
 *     tags: [Threat Intelligence]
 *     responses:
 *       200:
 *         description: Per-status counts
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   status: { type: string, enum: [open, under_review, resolved, disputed], example: open }
 *                   count: { type: integer, example: 18 }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
tipRouter.get(
  '/analytics/status',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(await getStatusSummary());
  }),
);

// ─── Sources ─────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/tip/sources:
 *   get:
 *     summary: List vulnerability feed sources
 *     tags: [Threat Intelligence]
 *     responses:
 *       200:
 *         description: All registered sources (NVD, GHSA, COMMUNITY, etc.)
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { $ref: '#/components/schemas/VulnerabilitySource' }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
tipRouter.get(
  '/sources',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(await db.vulnerabilitySource.findMany());
  }),
);
