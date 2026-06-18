/**
 * #219 — Commodity Compliance Dual-Signer Verification Logging
 *
 * POST  /api/v1/commodity-compliance              — log a dual-signer verification event
 * GET   /api/v1/commodity-compliance              — list logs (filterable)
 * GET   /api/v1/commodity-compliance/:txHash      — get by transaction hash
 * PATCH /api/v1/commodity-compliance/:txHash/sign — record a signer approval
 */

import { Router, Request, Response } from 'express';
import { prismaRead as prisma } from '../db';
import { z } from 'zod';

export const commodityComplianceRouter = Router();

const createSchema = z.object({
  transactionHash:         z.string().min(1),
  commodityType:           z.enum(['crude_oil', 'natural_gas', 'gold', 'wheat', 'other']),
  commodityCode:           z.string().min(1),
  contractAddress:         z.string().min(1),
  traderAddress:           z.string().min(1),
  primarySignerAddress:    z.string().min(1),
  secondarySignerAddress:  z.string().min(1),
  quantity:                z.string().min(1),
  unit:                    z.enum(['barrel', 'troy_oz', 'bushel', 'mmbtu', 'other']),
  notionalValueUsd:        z.string().optional(),
  regulatoryJurisdiction:  z.enum(['CFTC', 'FCA', 'ESMA', 'other']).default('CFTC'),
  expiresAt:               z.string().datetime().optional(),
  ledgerSequence:          z.number().int().min(0),
  ledgerCloseTime:         z.string().datetime(),
});

const listSchema = z.object({
  commodityCode:  z.string().optional(),
  commodityType:  z.enum(['crude_oil', 'natural_gas', 'gold', 'wheat', 'other']).optional(),
  contract:       z.string().optional(),
  trader:         z.string().optional(),
  signer:         z.string().optional(),
  status:         z.enum(['pending', 'approved', 'rejected', 'expired']).optional(),
  jurisdiction:   z.string().optional(),
  ledgerMin:      z.coerce.number().int().min(0).optional(),
  ledgerMax:      z.coerce.number().int().min(0).optional(),
  page:           z.coerce.number().min(1).default(1),
  limit:          z.coerce.number().min(1).max(100).default(20),
});

const signSchema = z.object({
  signerAddress: z.string().min(1),
  approved:      z.boolean(),
});

// POST /commodity-compliance — log a new dual-signer verification event
commodityComplianceRouter.post('/', async (req: Request, res: Response) => {
  try {
    const data = createSchema.parse(req.body);
    const record = await prisma.commodityDualSignerLog.create({
      data: {
        ...data,
        expiresAt: data.expiresAt ? new Date(data.expiresAt) : undefined,
        ledgerCloseTime: new Date(data.ledgerCloseTime),
      },
    });
    res.status(201).json(record);
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// GET /commodity-compliance — list with filters
commodityComplianceRouter.get('/', async (req: Request, res: Response) => {
  try {
    const q = listSchema.parse(req.query);
    const where = {
      ...(q.commodityCode && { commodityCode: q.commodityCode }),
      ...(q.commodityType && { commodityType: q.commodityType }),
      ...(q.contract      && { contractAddress: q.contract }),
      ...(q.trader        && { traderAddress: q.trader }),
      ...(q.status        && { complianceStatus: q.status }),
      ...(q.jurisdiction  && { regulatoryJurisdiction: q.jurisdiction }),
      ...(q.signer && {
        OR: [
          { primarySignerAddress: q.signer },
          { secondarySignerAddress: q.signer },
        ],
      }),
      ...((q.ledgerMin !== undefined || q.ledgerMax !== undefined) && {
        ledgerSequence: {
          ...(q.ledgerMin !== undefined && { gte: q.ledgerMin }),
          ...(q.ledgerMax !== undefined && { lte: q.ledgerMax }),
        },
      }),
    };

    const skip = (q.page - 1) * q.limit;
    const [data, total] = await Promise.all([
      prisma.commodityDualSignerLog.findMany({
        where,
        orderBy: { ledgerSequence: 'desc' },
        skip,
        take: q.limit,
      }),
      prisma.commodityDualSignerLog.count({ where }),
    ]);

    res.json({ data, total, page: q.page, limit: q.limit, pages: Math.ceil(total / q.limit) });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// GET /commodity-compliance/:txHash — get by transaction hash
commodityComplianceRouter.get('/:txHash', async (req: Request, res: Response) => {
  const record = await prisma.commodityDualSignerLog.findUnique({
    where: { transactionHash: req.params.txHash },
  });
  if (!record) return res.status(404).json({ error: 'Not found' });
  res.json(record);
});

// PATCH /commodity-compliance/:txHash/sign — record a signer approval/rejection
commodityComplianceRouter.patch('/:txHash/sign', async (req: Request, res: Response) => {
  try {
    const { signerAddress, approved } = signSchema.parse(req.body);

    const existing = await prisma.commodityDualSignerLog.findUnique({
      where: { transactionHash: req.params.txHash },
    });
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const isPrimary   = existing.primarySignerAddress === signerAddress;
    const isSecondary = existing.secondarySignerAddress === signerAddress;

    if (!isPrimary && !isSecondary) {
      return res.status(403).json({ error: 'Address is not a registered signer for this record' });
    }

    const primarySigned   = isPrimary   ? approved : existing.primarySigned;
    const secondarySigned = isSecondary ? approved : existing.secondarySigned;
    const bothSigned      = primarySigned && secondarySigned;

    // Determine compliance status
    let complianceStatus = existing.complianceStatus;
    if (!approved) {
      complianceStatus = 'rejected';
    } else if (bothSigned) {
      complianceStatus = 'approved';
    }

    const record = await prisma.commodityDualSignerLog.update({
      where: { transactionHash: req.params.txHash },
      data: { primarySigned, secondarySigned, bothSigned, complianceStatus },
    });

    res.json(record);
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});
