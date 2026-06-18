import { Router, Request, Response } from 'express';
import { prismaRead as prisma } from '../db';
import { z } from 'zod';

export const yieldDistributionRouter = Router();

const querySchema = z.object({
  contract: z.string().optional(),
  windowLabel: z.string().optional(),
  distributionId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

// GET /yield-distributions — list distribution entries with grouping
yieldDistributionRouter.get('/', async (req: Request, res: Response) => {
  try {
    const query = querySchema.parse(req.query);

    const where: Record<string, unknown> = {};
    if (query.contract) where.contractAddress = query.contract;
    if (query.windowLabel) where.windowLabel = query.windowLabel;
    if (query.distributionId) where.distributionId = query.distributionId;

    const [rows, total] = await Promise.all([
      prisma.yieldDistribution.findMany({
        where,
        orderBy: { ledgerCloseTime: 'desc' },
        take: query.limit,
        skip: query.offset,
      }),
      prisma.yieldDistribution.count({ where }),
    ]);

    res.json({ rows, total, limit: query.limit, offset: query.offset });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// GET /yield-distributions/stats — aggregated stats per window/label
yieldDistributionRouter.get('/stats', async (req: Request, res: Response) => {
  try {
    const contract = req.query.contract as string | undefined;

    const where: Record<string, unknown> = {};
    if (contract) where.contractAddress = contract;

    const windows = await prisma.yieldDistribution.groupBy({
      by: ['windowLabel', 'contractAddress'],
      where,
      _count: { id: true, recipient: true },
      _sum: {},
      orderBy: { windowLabel: 'asc' },
    });

    const enriched = await Promise.all(
      windows.map(async (w) => {
        const [first, last] = await Promise.all([
          prisma.yieldDistribution.findFirst({
            where: { windowLabel: w.windowLabel, contractAddress: w.contractAddress },
            orderBy: { ledgerCloseTime: 'asc' },
            select: { ledgerCloseTime: true },
          }),
          prisma.yieldDistribution.findFirst({
            where: { windowLabel: w.windowLabel, contractAddress: w.contractAddress },
            orderBy: { ledgerCloseTime: 'desc' },
            select: { ledgerCloseTime: true },
          }),
        ]);

        const recipients = await prisma.yieldDistribution.groupBy({
          by: ['recipient'],
          where: { windowLabel: w.windowLabel, contractAddress: w.contractAddress },
          _count: true,
        });

        return {
          windowLabel: w.windowLabel,
          contractAddress: w.contractAddress,
          totalEntries: w._count.id,
          uniqueRecipients: recipients.length,
          firstDistribution: first?.ledgerCloseTime ?? null,
          lastDistribution: last?.ledgerCloseTime ?? null,
        };
      }),
    );

    res.json({ windows: enriched });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});
