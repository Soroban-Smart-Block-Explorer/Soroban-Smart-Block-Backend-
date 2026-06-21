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

tipRouter.delete(
  '/advisories/:id',
  asyncHandler(async (req: Request, res: Response) => {
    await db.threatAdvisory.delete({ where: { id: req.params.id } });
    res.status(204).send();
  }),
);

// ─── Review workflow ──────────────────────────────────────────────────────────

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

tipRouter.post(
  '/correlate',
  asyncHandler(async (_req: Request, res: Response) => {
    const linked = await deduplicateAdvisories();
    res.json({ linked });
  }),
);

tipRouter.post(
  '/advisories/:id/rescore',
  asyncHandler(async (req: Request, res: Response) => {
    const newSeverity = await rescore(req.params.id);
    res.json({ severity: newSeverity });
  }),
);

// ─── Subscriptions ────────────────────────────────────────────────────────────

tipRouter.get(
  '/subscriptions',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(await db.tipSubscription.findMany());
  }),
);

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

tipRouter.delete(
  '/subscriptions/:id',
  asyncHandler(async (req: Request, res: Response) => {
    await db.tipSubscription.delete({ where: { id: req.params.id } });
    res.status(204).send();
  }),
);

// ─── Webhooks ─────────────────────────────────────────────────────────────────

tipRouter.get(
  '/webhooks',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(
      await db.tipWebhook.findMany({ select: { id: true, url: true, events: true, active: true } }),
    );
  }),
);

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

tipRouter.delete(
  '/webhooks/:id',
  asyncHandler(async (req: Request, res: Response) => {
    await db.tipWebhook.delete({ where: { id: req.params.id } });
    res.status(204).send();
  }),
);

// ─── Feeds ────────────────────────────────────────────────────────────────────

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

tipRouter.get(
  '/analytics/severity',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(await getSeverityDistribution());
  }),
);

tipRouter.get(
  '/analytics/trend',
  asyncHandler(async (req: Request, res: Response) => {
    const days = Math.min(parseInt(String(req.query.days ?? '30')), 365);
    res.json(await getTrendData(days));
  }),
);

tipRouter.get(
  '/analytics/top-contracts',
  asyncHandler(async (req: Request, res: Response) => {
    const limit = Math.min(parseInt(String(req.query.limit ?? '10')), 50);
    res.json(await getTopAffectedContracts(limit));
  }),
);

tipRouter.get(
  '/analytics/status',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(await getStatusSummary());
  }),
);

// ─── Sources ─────────────────────────────────────────────────────────────────

tipRouter.get(
  '/sources',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(await db.vulnerabilitySource.findMany());
  }),
);
