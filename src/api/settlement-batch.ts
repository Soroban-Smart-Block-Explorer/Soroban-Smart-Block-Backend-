/**
 * #220 — Batch-Settlement Compact Engine API
 *
 * GET /api/v1/settlement-batch              — list summaries (filterable)
 * GET /api/v1/settlement-batch/:id          — single summary by id
 * GET /api/v1/settlement-batch/contract/:address — summaries for a contract
 * POST /api/v1/settlement-batch/compact     — trigger compaction on-demand
 */

import { Router, Request, Response } from 'express';
import { prismaRead as prisma } from '../db';
import { runCompactor } from '../indexer/settlement-compactor';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';

export const settlementBatchRouter = Router();

const listSchema = z.object({
  contractAddress: z.string().optional(),
  ledgerMin: z.coerce.number().int().min(0).optional(),
  ledgerMax: z.coerce.number().int().min(0).optional(),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
});

// GET /settlement-batch
settlementBatchRouter.get('/', async (req: Request, res: Response) => {
  try {
    const q = listSchema.parse(req.query);
    const where = {
      ...(q.contractAddress && { contractAddress: q.contractAddress }),
      ...((q.ledgerMin !== undefined || q.ledgerMax !== undefined) && {
        ledgerMin: {
          ...(q.ledgerMin !== undefined && { gte: q.ledgerMin }),
          ...(q.ledgerMax !== undefined && { lte: q.ledgerMax }),
        },
      }),
    };
    const skip = (q.page - 1) * q.limit;
    const [data, total] = await Promise.all([
      prisma.settlementBatchSummary.findMany({
        where,
        orderBy: { ledgerMin: 'desc' },
        skip,
        take: q.limit,
      }),
      prisma.settlementBatchSummary.count({ where }),
    ]);
    res.json({ data, total, page: q.page, limit: q.limit, pages: Math.ceil(total / q.limit) });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// GET /settlement-batch/contract/:address
settlementBatchRouter.get('/contract/:address', async (req: Request, res: Response) => {
  try {
    const data = await prisma.settlementBatchSummary.findMany({
      where: { contractAddress: req.params.address },
      orderBy: { ledgerMin: 'desc' },
      take: 50,
    });
    res.json({ contractAddress: req.params.address, count: data.length, data });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// POST /settlement-batch/compact — on-demand compaction trigger
settlementBatchRouter.post('/compact', async (_req: Request, res: Response) => {
  try {
    await runCompactor();
    res.json({ ok: true, message: 'Compaction run completed' });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /settlement-batch/:id
settlementBatchRouter.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const record = await prisma.settlementBatchSummary.findUnique({
      where: { id: req.params.id },
    });
    if (!record) return res.status(404).json({ error: 'Not found' });
    res.json(record);
  }),
);
