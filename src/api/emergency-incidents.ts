import { Router, Request, Response } from 'express';
import { prismaRead, prismaWrite } from '../db';
import { z } from 'zod';

export const incidentRouter = Router();

const createSchema = z.object({
  contractAddress: z.string().min(1),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  title: z.string().min(1).max(255),
  description: z.string().optional(),
  pauseEventId: z.string().optional(),
  affectedUsersEstimate: z.number().int().positive().optional(),
  affectedTvlEstimate: z.string().optional(),
});

const listSchema = z.object({
  status: z.string().optional(),
  severity: z.string().optional(),
  contract: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
});

const updateSchema = z.object({
  status: z.enum(['open', 'investigating', 'resolved', 'closed']).optional(),
  rootCause: z.string().optional(),
  resolutionNotes: z.string().optional(),
  timelineEntry: z.object({ event: z.string(), detail: z.string() }).optional(),
  affectedUsersEstimate: z.number().int().positive().optional(),
  affectedTvlEstimate: z.string().optional(),
});

// POST /emergency/incidents
incidentRouter.post('/', async (req: Request, res: Response) => {
  try {
    const data = createSchema.parse(req.body);
    const incident = await prismaWrite.incidentReport.create({
      data: {
        contractAddress: data.contractAddress,
        severity: data.severity,
        title: data.title,
        description: data.description,
        pauseEventId: data.pauseEventId,
        affectedUsersEstimate: data.affectedUsersEstimate,
        affectedTvlEstimate: data.affectedTvlEstimate,
        timeline: [{ timestamp: new Date().toISOString(), event: 'created', detail: 'Incident created' }],
      },
    });
    res.status(201).json(incident);
  } catch (err: any) {
    res.status(400).json({ error: err.message ?? String(err) });
  }
});

// GET /emergency/incidents
incidentRouter.get('/', async (req: Request, res: Response) => {
  try {
    const { status, severity, contract, from, to, page, limit } = listSchema.parse(req.query);
    const skip = (page - 1) * limit;
    const where: any = {
      ...(status ? { status } : {}),
      ...(severity ? { severity } : {}),
      ...(contract ? { contractAddress: contract } : {}),
      ...(from || to
        ? { createdAt: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } }
        : {}),
    };

    const [data, total] = await Promise.all([
      prismaRead.incidentReport.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: { _count: { select: { comments: true } } },
      }),
      prismaRead.incidentReport.count({ where }),
    ]);

    res.json({ data, total, page, limit });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /emergency/incidents/stats
incidentRouter.get('/stats', async (_req: Request, res: Response) => {
  try {
    const [bySeverity, byStatus, resolved] = await Promise.all([
      prismaRead.incidentReport.groupBy({ by: ['severity'], _count: { id: true } }),
      prismaRead.incidentReport.groupBy({ by: ['status'], _count: { id: true } }),
      prismaRead.incidentReport.findMany({
        where: { resolvedAt: { not: null } },
        select: { createdAt: true, resolvedAt: true },
      }),
    ]);

    const mttrMs = resolved.length
      ? resolved.reduce((sum, r) => sum + (r.resolvedAt!.getTime() - r.createdAt.getTime()), 0) / resolved.length
      : null;

    res.json({
      bySeverity: Object.fromEntries(bySeverity.map((b) => [b.severity, b._count.id])),
      byStatus: Object.fromEntries(byStatus.map((b) => [b.status, b._count.id])),
      meanTimeToResolveHours: mttrMs ? Math.round(mttrMs / 3600_000 * 10) / 10 : null,
      totalResolved: resolved.length,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /emergency/incidents/:id
incidentRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const incident = await prismaRead.incidentReport.findUnique({
      where: { id: req.params.id },
      include: { comments: { orderBy: { createdAt: 'asc' } }, pauseEvent: true },
    });
    if (!incident) return res.status(404).json({ error: 'Not found' });
    res.json(incident);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// PATCH /emergency/incidents/:id
incidentRouter.patch('/:id', async (req: Request, res: Response) => {
  try {
    const data = updateSchema.parse(req.body);

    let timelineUpdate: object | undefined;
    if (data.timelineEntry) {
      const current = await prismaRead.incidentReport.findUnique({
        where: { id: req.params.id },
        select: { timeline: true },
      });
      const existing = (current?.timeline as object[]) ?? [];
      timelineUpdate = [
        ...existing,
        { timestamp: new Date().toISOString(), ...data.timelineEntry },
      ];
    }

    const updated = await prismaWrite.incidentReport.update({
      where: { id: req.params.id },
      data: {
        ...(data.status ? { status: data.status } : {}),
        ...(data.rootCause ? { rootCause: data.rootCause } : {}),
        ...(data.resolutionNotes ? { resolutionNotes: data.resolutionNotes } : {}),
        ...(data.affectedUsersEstimate ? { affectedUsersEstimate: data.affectedUsersEstimate } : {}),
        ...(data.affectedTvlEstimate ? { affectedTvlEstimate: data.affectedTvlEstimate } : {}),
        ...(timelineUpdate ? { timeline: timelineUpdate } : {}),
        updatedAt: new Date(),
      },
    });
    res.json(updated);
  } catch (err: any) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Not found' });
    res.status(400).json({ error: String(err) });
  }
});

// POST /emergency/incidents/:id/comments
incidentRouter.post('/:id/comments', async (req: Request, res: Response) => {
  try {
    const { author, body } = z.object({ author: z.string().min(1), body: z.string().min(1) }).parse(req.body);
    const comment = await prismaWrite.incidentComment.create({
      data: { incidentId: req.params.id, author, body },
    });
    res.status(201).json(comment);
  } catch (err: any) {
    res.status(400).json({ error: String(err) });
  }
});

// POST /emergency/incidents/:id/resolve
incidentRouter.post('/:id/resolve', async (req: Request, res: Response) => {
  try {
    const { resolutionNotes } = z.object({ resolutionNotes: z.string().optional() }).parse(req.body);
    const incident = await prismaRead.incidentReport.findUnique({
      where: { id: req.params.id },
      select: { timeline: true },
    });
    const timeline = (incident?.timeline as object[]) ?? [];

    const updated = await prismaWrite.incidentReport.update({
      where: { id: req.params.id },
      data: {
        status: 'resolved',
        resolvedAt: new Date(),
        resolutionNotes,
        timeline: [...timeline, { timestamp: new Date().toISOString(), event: 'resolved', detail: resolutionNotes ?? 'Marked resolved' }],
        updatedAt: new Date(),
      },
    });
    res.json(updated);
  } catch (err: any) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Not found' });
    res.status(400).json({ error: String(err) });
  }
});
