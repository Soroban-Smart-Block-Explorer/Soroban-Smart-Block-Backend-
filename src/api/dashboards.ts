import { Router, Request, Response } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { prismaWrite as prisma, prismaRead } from '../db';

export const dashboardRouter = Router();

// ─── Schemas ─────────────────────────────────────────────────────────────────

const widgetSchema = z.object({
  type: z.enum(['chart', 'table', 'metric', 'map', 'heatmap', 'feed', 'text']),
  title: z.string().optional(),
  config: z.record(z.unknown()).default({}),
  position: z
    .object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
    .default({ x: 0, y: 0, w: 4, h: 3 }),
  refreshMs: z.number().int().min(5000).max(300000).default(30000),
});

const createDashboardSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  ownerId: z.string().min(1),
  isPublic: z.boolean().default(false),
  layout: z.array(z.unknown()).default([]),
  theme: z.record(z.unknown()).default({}),
  tags: z.array(z.string()).default([]),
});

const updateDashboardSchema = createDashboardSchema.partial().omit({ ownerId: true });

const collaboratorSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(['viewer', 'editor', 'admin']).default('viewer'),
});

const querySchema = z.object({
  widgetId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

// ─── Dashboard CRUD ───────────────────────────────────────────────────────────

dashboardRouter.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = createDashboardSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const dashboard = await prisma.dashboard.create({
      data: { ...parsed.data },
      include: { widgets: true, collaborators: true },
    });
    res.status(201).json(dashboard);
  }),
);

dashboardRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const ownerId = req.query.ownerId as string | undefined;
    const userId = req.query.userId as string | undefined;
    const tag = req.query.tag as string | undefined;
    const isPublic = req.query.public === 'true';
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, parseInt(req.query.limit as string) || 20);

    const where: Record<string, unknown> = {};

    if (ownerId) {
      where.ownerId = ownerId;
    } else if (userId) {
      where.OR = [{ ownerId: userId }, { collaborators: { some: { userId } } }, { isPublic: true }];
    } else if (isPublic) {
      where.isPublic = true;
    }

    if (tag) where.tags = { has: tag };

    const [dashboards, total] = await Promise.all([
      prismaRead.dashboard.findMany({
        where,
        include: { widgets: true, collaborators: { select: { userId: true, role: true } } },
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prismaRead.dashboard.count({ where }),
    ]);

    res.json({ data: dashboards, total, page, pages: Math.ceil(total / limit) });
  }),
);

dashboardRouter.get(
  '/embed/:token',
  asyncHandler(async (req: Request, res: Response) => {
    const dashboard = await prismaRead.dashboard.findUnique({
      where: { embedToken: req.params.token },
      include: { widgets: true },
    });
    if (!dashboard) return res.status(404).json({ error: 'Not found' });
    if (!dashboard.isPublic && !dashboard.embedToken)
      return res.status(403).json({ error: 'Forbidden' });
    res.json(dashboard);
  }),
);

dashboardRouter.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const dashboard = await prismaRead.dashboard.findUnique({
      where: { id: req.params.id },
      include: {
        widgets: { orderBy: { createdAt: 'asc' } },
        collaborators: { orderBy: { createdAt: 'asc' } },
        snapshots: { orderBy: { createdAt: 'desc' }, take: 5 },
      },
    });
    if (!dashboard) return res.status(404).json({ error: 'Not found' });
    res.json(dashboard);
  }),
);

dashboardRouter.put(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = updateDashboardSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const existing = await prismaRead.dashboard.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const dashboard = await prisma.dashboard.update({
      where: { id: req.params.id },
      data: parsed.data,
      include: { widgets: true, collaborators: true },
    });
    res.json(dashboard);
  }),
);

dashboardRouter.delete(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const existing = await prismaRead.dashboard.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    await prisma.dashboard.delete({ where: { id: req.params.id } });
    res.json({ deleted: true });
  }),
);

// ─── Embed Token ──────────────────────────────────────────────────────────────

dashboardRouter.post(
  '/:id/share',
  asyncHandler(async (req: Request, res: Response) => {
    const existing = await prismaRead.dashboard.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const token = crypto.randomBytes(24).toString('hex');
    const dashboard = await prisma.dashboard.update({
      where: { id: req.params.id },
      data: { embedToken: token, isPublic: true },
    });
    res.json({ embedToken: dashboard.embedToken, embedUrl: `/api/v1/dashboards/embed/${token}` });
  }),
);

dashboardRouter.delete(
  '/:id/share',
  asyncHandler(async (req: Request, res: Response) => {
    const existing = await prismaRead.dashboard.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    await prisma.dashboard.update({ where: { id: req.params.id }, data: { embedToken: null } });
    res.json({ revoked: true });
  }),
);

// ─── Widgets ──────────────────────────────────────────────────────────────────

dashboardRouter.post(
  '/:id/widgets',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = widgetSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const existing = await prismaRead.dashboard.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Dashboard not found' });

    const widget = await prisma.dashboardWidget.create({
      data: { dashboardId: req.params.id, ...parsed.data },
    });
    res.status(201).json(widget);
  }),
);

dashboardRouter.put(
  '/:id/widgets/:widgetId',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = widgetSchema.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const existing = await prismaRead.dashboardWidget.findFirst({
      where: { id: req.params.widgetId, dashboardId: req.params.id },
    });
    if (!existing) return res.status(404).json({ error: 'Widget not found' });

    const widget = await prisma.dashboardWidget.update({
      where: { id: req.params.widgetId },
      data: parsed.data,
    });
    res.json(widget);
  }),
);

dashboardRouter.delete(
  '/:id/widgets/:widgetId',
  asyncHandler(async (req: Request, res: Response) => {
    const existing = await prismaRead.dashboardWidget.findFirst({
      where: { id: req.params.widgetId, dashboardId: req.params.id },
    });
    if (!existing) return res.status(404).json({ error: 'Widget not found' });
    await prisma.dashboardWidget.delete({ where: { id: req.params.widgetId } });
    res.json({ deleted: true });
  }),
);

// ─── Dashboard Data Query (analytics) ────────────────────────────────────────

dashboardRouter.get(
  '/:id/data',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const dashboard = await prismaRead.dashboard.findUnique({
      where: { id: req.params.id },
      include: { widgets: true },
    });
    if (!dashboard) return res.status(404).json({ error: 'Not found' });

    const { widgetId, from, to, limit } = parsed.data;
    const widgets = widgetId
      ? dashboard.widgets.filter((w) => w.id === widgetId)
      : dashboard.widgets;

    const fromDate = from ? new Date(from) : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const toDate = to ? new Date(to) : new Date();

    const results = await Promise.all(
      widgets.map(async (widget) => {
        const cfg = widget.config as Record<string, unknown>;
        const datasource = (cfg.datasource as string) ?? 'events';
        let data: unknown[] = [];

        if (datasource === 'events') {
          data = await prismaRead.event.findMany({
            where: {
              ...(cfg.contractAddress ? { contractAddress: cfg.contractAddress as string } : {}),
              ...(cfg.eventType ? { eventType: cfg.eventType as string } : {}),
              ledgerCloseTime: { gte: fromDate, lte: toDate },
            },
            orderBy: { ledgerCloseTime: 'desc' },
            take: limit,
            select: {
              id: true,
              eventType: true,
              contractAddress: true,
              ledgerCloseTime: true,
              decoded: true,
            },
          });
        } else if (datasource === 'transactions') {
          data = await prismaRead.transaction.findMany({
            where: {
              ...(cfg.contractAddress ? { contractAddress: cfg.contractAddress as string } : {}),
              ledgerCloseTime: { gte: fromDate, lte: toDate },
            },
            orderBy: { ledgerCloseTime: 'desc' },
            take: limit,
            select: {
              id: true,
              hash: true,
              status: true,
              contractAddress: true,
              functionName: true,
              ledgerCloseTime: true,
              feeCharged: true,
            },
          });
        } else if (datasource === 'ledgers') {
          data = await prismaRead.ledger.findMany({
            where: { closeTime: { gte: fromDate, lte: toDate } },
            orderBy: { closeTime: 'desc' },
            take: limit,
            select: { sequence: true, closeTime: true, txCount: true },
          });
        }

        return { widgetId: widget.id, widgetType: widget.type, datasource, data };
      }),
    );

    res.json({ dashboardId: req.params.id, from: fromDate, to: toDate, widgets: results });
  }),
);

// ─── Collaborators ────────────────────────────────────────────────────────────

dashboardRouter.post(
  '/:id/collaborators',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = collaboratorSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const existing = await prismaRead.dashboard.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Dashboard not found' });

    const collab = await prisma.dashboardCollaborator.upsert({
      where: { dashboardId_userId: { dashboardId: req.params.id, userId: parsed.data.userId } },
      update: { role: parsed.data.role },
      create: { dashboardId: req.params.id, ...parsed.data },
    });
    res.status(201).json(collab);
  }),
);

dashboardRouter.get(
  '/:id/collaborators',
  asyncHandler(async (req: Request, res: Response) => {
    const existing = await prismaRead.dashboard.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const collaborators = await prismaRead.dashboardCollaborator.findMany({
      where: { dashboardId: req.params.id },
    });
    res.json(collaborators);
  }),
);

dashboardRouter.delete(
  '/:id/collaborators/:userId',
  asyncHandler(async (req: Request, res: Response) => {
    const existing = await prismaRead.dashboardCollaborator.findUnique({
      where: { dashboardId_userId: { dashboardId: req.params.id, userId: req.params.userId } },
    });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    await prisma.dashboardCollaborator.delete({
      where: { dashboardId_userId: { dashboardId: req.params.id, userId: req.params.userId } },
    });
    res.json({ removed: true });
  }),
);

// ─── Snapshots ────────────────────────────────────────────────────────────────

dashboardRouter.post(
  '/:id/snapshots',
  asyncHandler(async (req: Request, res: Response) => {
    const dashboard = await prismaRead.dashboard.findUnique({
      where: { id: req.params.id },
      include: { widgets: true },
    });
    if (!dashboard) return res.status(404).json({ error: 'Not found' });

    const snapshot = await prisma.dashboardSnapshot.create({
      data: {
        dashboardId: req.params.id,
        label: req.body.label as string | undefined,
        data: { dashboard, capturedAt: new Date().toISOString() },
      },
    });
    res.status(201).json(snapshot);
  }),
);

dashboardRouter.get(
  '/:id/snapshots',
  asyncHandler(async (req: Request, res: Response) => {
    const existing = await prismaRead.dashboard.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const snapshots = await prismaRead.dashboardSnapshot.findMany({
      where: { dashboardId: req.params.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json(snapshots);
  }),
);

dashboardRouter.get(
  '/:id/snapshots/:snapshotId',
  asyncHandler(async (req: Request, res: Response) => {
    const snapshot = await prismaRead.dashboardSnapshot.findFirst({
      where: { id: req.params.snapshotId, dashboardId: req.params.id },
    });
    if (!snapshot) return res.status(404).json({ error: 'Not found' });
    res.json(snapshot);
  }),
);

// ─── Real-Time Stream Info ────────────────────────────────────────────────────

dashboardRouter.get(
  '/:id/stream-config',
  asyncHandler(async (req: Request, res: Response) => {
    const dashboard = await prismaRead.dashboard.findUnique({
      where: { id: req.params.id },
      include: { widgets: true },
    });
    if (!dashboard) return res.status(404).json({ error: 'Not found' });

    const streamableWidgets = dashboard.widgets.filter((w) =>
      ['chart', 'metric', 'feed'].includes(w.type),
    );

    const contracts = [
      ...new Set(
        streamableWidgets
          .map((w) => (w.config as Record<string, unknown>).contractAddress as string)
          .filter(Boolean),
      ),
    ];

    res.json({
      dashboardId: req.params.id,
      wsEndpoint: `/ws/events`,
      wsParams: contracts.length === 1 ? `?contract=${contracts[0]}` : '',
      subscribedContracts: contracts,
      streamableWidgets: streamableWidgets.map((w) => ({
        id: w.id,
        type: w.type,
        refreshMs: w.refreshMs,
      })),
    });
  }),
);
