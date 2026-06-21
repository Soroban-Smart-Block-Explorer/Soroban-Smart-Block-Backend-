/**
 * #218 — DTCC Tokenized Securities Settlement ID Bridge
 *
 * POST /api/v1/dtcc-settlement          — register a settlement bridge record
 * GET  /api/v1/dtcc-settlement          — list records (filterable)
 * GET  /api/v1/dtcc-settlement/:txHash  — get by transaction hash
 * GET  /api/v1/dtcc-settlement/id/:dtccId — get by DTCC settlement ID
 * PATCH /api/v1/dtcc-settlement/:txHash/status — update settlement status
 */

import { Router, Request, Response } from 'express';
import { prismaRead as prisma } from '../db';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';

export const dtccSettlementRouter = Router();

const createSchema = z.object({
  transactionHash: z.string().min(1),
  dtccSettlementId: z.string().min(1),
  securityId: z.string().min(1),
  securityType: z.enum(['equity', 'bond', 'etf', 'other']),
  sellerAddress: z.string().min(1),
  buyerAddress: z.string().min(1),
  quantity: z.string().min(1),
  settlementAmount: z.string().min(1),
  currency: z.string().default('USD'),
  contractAddress: z.string().optional(),
  settlementDate: z.string().datetime().optional(),
  ledgerSequence: z.number().int().min(0),
  ledgerCloseTime: z.string().datetime(),
});

const listSchema = z.object({
  securityId: z.string().optional(),
  securityType: z.enum(['equity', 'bond', 'etf', 'other']).optional(),
  seller: z.string().optional(),
  buyer: z.string().optional(),
  status: z.enum(['pending', 'settled', 'failed', 'cancelled']).optional(),
  ledgerMin: z.coerce.number().int().min(0).optional(),
  ledgerMax: z.coerce.number().int().min(0).optional(),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
});

const statusSchema = z.object({
  settlementStatus: z.enum(['pending', 'settled', 'failed', 'cancelled']),
  settlementDate: z.string().datetime().optional(),
});

// POST /dtcc-settlement — register a new settlement bridge record
dtccSettlementRouter.post('/', async (req: Request, res: Response) => {
  try {
    const data = createSchema.parse(req.body);
    const record = await prisma.dtccSettlementBridge.create({
      data: {
        ...data,
        settlementDate: data.settlementDate ? new Date(data.settlementDate) : undefined,
        ledgerCloseTime: new Date(data.ledgerCloseTime),
      },
    });
    res.status(201).json(record);
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// GET /dtcc-settlement — list with filters
dtccSettlementRouter.get('/', async (req: Request, res: Response) => {
  try {
    const q = listSchema.parse(req.query);
    const where = {
      ...(q.securityId && { securityId: q.securityId }),
      ...(q.securityType && { securityType: q.securityType }),
      ...(q.seller && { sellerAddress: q.seller }),
      ...(q.buyer && { buyerAddress: q.buyer }),
      ...(q.status && { settlementStatus: q.status }),
      ...((q.ledgerMin !== undefined || q.ledgerMax !== undefined) && {
        ledgerSequence: {
          ...(q.ledgerMin !== undefined && { gte: q.ledgerMin }),
          ...(q.ledgerMax !== undefined && { lte: q.ledgerMax }),
        },
      }),
    };

    const skip = (q.page - 1) * q.limit;
    const [data, total] = await Promise.all([
      prisma.dtccSettlementBridge.findMany({
        where,
        orderBy: { ledgerSequence: 'desc' },
        skip,
        take: q.limit,
      }),
      prisma.dtccSettlementBridge.count({ where }),
    ]);

    res.json({ data, total, page: q.page, limit: q.limit, pages: Math.ceil(total / q.limit) });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// GET /dtcc-settlement/id/:dtccId — lookup by DTCC settlement ID
dtccSettlementRouter.get('/id/:dtccId', async (req: Request, res: Response) => {
  try {
    const records = await prisma.dtccSettlementBridge.findMany({
      where: { dtccSettlementId: req.params.dtccId },
      orderBy: { createdAt: 'desc' },
    });
    if (!records.length) return res.status(404).json({ error: 'Not found' });
    res.json({ dtccSettlementId: req.params.dtccId, count: records.length, records });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// GET /dtcc-settlement/:txHash — get by transaction hash
dtccSettlementRouter.get(
  '/:txHash',
  asyncHandler(async (req: Request, res: Response) => {
    const record = await prisma.dtccSettlementBridge.findUnique({
      where: { transactionHash: req.params.txHash },
    });
    if (!record) return res.status(404).json({ error: 'Not found' });
    res.json(record);
  }),
);

// PATCH /dtcc-settlement/:txHash/status — update settlement status
dtccSettlementRouter.patch('/:txHash/status', async (req: Request, res: Response) => {
  try {
    const { settlementStatus, settlementDate } = statusSchema.parse(req.body);
    const record = await prisma.dtccSettlementBridge.update({
      where: { transactionHash: req.params.txHash },
      data: {
        settlementStatus,
        ...(settlementDate && { settlementDate: new Date(settlementDate) }),
      },
    });
    res.json(record);
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});
