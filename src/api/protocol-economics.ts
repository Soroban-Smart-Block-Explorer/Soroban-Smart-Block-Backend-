/**
 * Protocol Economic Dashboard API (#301)
 *
 * GET  /api/v1/analytics/protocol-economics         — pre-aggregated snapshots
 * GET  /api/v1/analytics/protocol-economics/summary — cross-bucket totals
 * POST /api/v1/analytics/protocol-economics/run     — trigger on-demand computation
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prismaRead as prisma } from '../db';
import { runProtocolEconomics } from '../indexer/protocolEconomics';
import { asyncHandler } from '../middleware/asyncHandler';

export const protocolEconomicsRouter = Router();

const querySchema = z.object({
  bucket: z.enum(['hour', 'day', 'week']).default('day'),
  limit: z.coerce.number().min(1).max(500).default(48),
});

// GET /analytics/protocol-economics — paginated time-series snapshots
protocolEconomicsRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const { bucket, limit } = querySchema.parse(req.query);
    const data = await prisma.protocolEconomicsSnapshot.findMany({
      where: { bucket },
      orderBy: { bucketStart: 'desc' },
      take: limit,
    });
    res.json({ bucket, data });
  }),
);

// GET /analytics/protocol-economics/summary — aggregate totals per bucket granularity
protocolEconomicsRouter.get(
  '/summary',
  asyncHandler(async (_req: Request, res: Response) => {
    const buckets = ['hour', 'day', 'week'] as const;
    const summary: Record<string, object> = {};

    for (const bucket of buckets) {
      const agg = await prisma.protocolEconomicsSnapshot.aggregate({
        where: { bucket },
        _sum: { totalFees: true, feeBurn: true, networkRevenue: true, txCount: true },
        _avg: { avgFee: true },
        _count: { id: true },
      });
      summary[bucket] = {
        totalFees: agg._sum.totalFees ?? 0,
        feeBurn: agg._sum.feeBurn ?? 0,
        networkRevenue: agg._sum.networkRevenue ?? 0,
        txCount: agg._sum.txCount ?? 0,
        avgFee: agg._avg.avgFee ?? 0,
        snapshotCount: agg._count.id,
      };
    }

    res.json(summary);
  }),
);

// POST /analytics/protocol-economics/run — on-demand trigger
protocolEconomicsRouter.post(
  '/run',
  asyncHandler(async (_req: Request, res: Response) => {
    await runProtocolEconomics();
    res.json({ ok: true });
  }),
);
