/**
 * GET /api/v1/analytics/gas        — pre-aggregated gas cost snapshots
 * POST /api/v1/analytics/gas/run   — trigger an on-demand analytics run
 */

import { Router, Request, Response } from 'express';
import { prismaRead as prisma } from '../db';
import { runGasAnalytics } from '../indexer/gasAnalytics';
import { z } from 'zod';

export const analyticsRouter = Router();

const querySchema = z.object({
  bucket: z.enum(['hour', 'day', 'week']).default('day'),
  limit: z.coerce.number().min(1).max(500).default(48),
});

// GET /analytics/gas — return pre-computed snapshots
analyticsRouter.get('/gas', async (req: Request, res: Response) => {
  try {
    const { bucket, limit } = querySchema.parse(req.query);

    const snapshots = await prisma.gasAnalyticsSnapshot.findMany({
      where: { bucket },
      orderBy: { bucketStart: 'desc' },
      take: limit,
    });

    res.json({ bucket, data: snapshots });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// POST /analytics/gas/run — on-demand trigger
analyticsRouter.post('/gas/run', async (_req: Request, res: Response) => {
  try {
    await runGasAnalytics();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});
