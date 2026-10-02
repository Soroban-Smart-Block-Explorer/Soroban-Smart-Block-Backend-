/**
 * #219 — Commodity Compliance Dual-Signer Verification Logging
 *
 * POST  /api/v1/commodity-compliance              — log a dual-signer verification event
 * GET   /api/v1/commodity-compliance              — list logs (filterable)
 * GET   /api/v1/commodity-compliance/:txHash      — get by transaction hash
 * PATCH /api/v1/commodity-compliance/:txHash/sign — record a signer approval
 *
 * #1029 — Scheduled compliance report generator
 * GET   /api/v1/commodity-compliance/report       — render a human-reviewable
 *                                                    compliance report document
 *                                                    with an evidence snapshot
 */

import { Router, Request, Response } from 'express';
import { prismaRead as prisma } from '../db';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';

export const commodityComplianceRouter = Router();

const createSchema = z.object({
  transactionHash: z.string().min(1),
  commodityType: z.enum(['crude_oil', 'natural_gas', 'gold', 'wheat', 'other']),
  commodityCode: z.string().min(1),
  contractAddress: z.string().min(1),
  traderAddress: z.string().min(1),
  primarySignerAddress: z.string().min(1),
  secondarySignerAddress: z.string().min(1),
  quantity: z.string().min(1),
  unit: z.enum(['barrel', 'troy_oz', 'bushel', 'mmbtu', 'other']),
  notionalValueUsd: z.string().optional(),
  regulatoryJurisdiction: z.enum(['CFTC', 'FCA', 'ESMA', 'other']).default('CFTC'),
  expiresAt: z.string().datetime().optional(),
  ledgerSequence: z.number().int().min(0),
  ledgerCloseTime: z.string().datetime(),
});

const listSchema = z.object({
  commodityCode: z.string().optional(),
  commodityType: z.enum(['crude_oil', 'natural_gas', 'gold', 'wheat', 'other']).optional(),
  contract: z.string().optional(),
  trader: z.string().optional(),
  signer: z.string().optional(),
  status: z.enum(['pending', 'approved', 'rejected', 'expired']).optional(),
  jurisdiction: z.string().optional(),
  ledgerMin: z.coerce.number().int().min(0).optional(),
  ledgerMax: z.coerce.number().int().min(0).optional(),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
});

const signSchema = z.object({
  signerAddress: z.string().min(1),
  approved: z.boolean(),
});

// #1029 — report query schema: bounded window for a reproducible evidence snapshot
const reportSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  jurisdiction: z.string().optional(),
  commodityType: z.enum(['crude_oil', 'natural_gas', 'gold', 'wheat', 'other']).optional(),
  limit: z.coerce.number().min(1).max(1000).default(500),
});

// POST /commodity-compliance — log a new dual-signer verification event
commodityComplianceRouter.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const data = createSchema.parse(req.body);
      const record = await prisma.commodityDualSignerLog.create({
        data: {
          transactionHash: data.transactionHash,
          commodityType: data.commodityType,
          commodityCode: data.commodityCode,
          contractAddress: data.contractAddress,
          traderAddress: data.traderAddress,
          primarySignerAddress: data.primarySignerAddress,
          secondarySignerAddress: data.secondarySignerAddress,
          quantity: data.quantity,
          unit: data.unit,
          notionalValueUsd: data.notionalValueUsd,
          regulatoryJurisdiction: data.regulatoryJurisdiction,
          expiresAt: data.expiresAt ? new Date(data.expiresAt) : undefined,
          ledgerSequence: data.ledgerSequence,
          ledgerCloseTime: new Date(data.ledgerCloseTime),
        },
      });
      res.status(201).json(record);
    } catch (e) {
      res.status(400).json({ error: String(e) });
    }
  }),
);

// GET /commodity-compliance/report — render a compliance report document with evidence snapshot
commodityComplianceRouter.get(
  '/report',
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const q = reportSchema.parse(req.query);
      const where = {
        ...(q.jurisdiction && { regulatoryJurisdiction: q.jurisdiction }),
        ...(q.commodityType && { commodityType: q.commodityType }),
        ...((q.from !== undefined || q.to !== undefined) && {
          ledgerCloseTime: {
            ...(q.from !== undefined && { gte: new Date(q.from) }),
            ...(q.to !== undefined && { lte: new Date(q.to) }),
          },
        }),
      };

      const records = await prisma.commodityDualSignerLog.findMany({
        where,
        orderBy: { ledgerSequence: 'desc' },
        take: q.limit,
      });

      const byStatus: Record<string, number> = {};
      let notionalTotal = 0;
      for (const r of records) {
        byStatus[r.complianceStatus] = (byStatus[r.complianceStatus] ?? 0) + 1;
        if (r.notionalValueUsd) notionalTotal += Number(r.notionalValueUsd);
      }

      const generatedAt = new Date().toISOString();
      const evidenceSnapshot = {
        module: 'commodity-compliance',
        generatedAt,
        filters: q,
        recordCount: records.length,
        recordHashes: records.map((r) => r.transactionHash),
      };

      const lines: string[] = [
        '# Commodity Compliance Report',
        '',
        `Generated: ${generatedAt}`,
        `Jurisdiction: ${q.jurisdiction ?? 'all'}`,
        `Commodity type: ${q.commodityType ?? 'all'}`,
        `Window: ${q.from ?? 'beginning'} → ${q.to ?? 'now'}`,
        '',
        '## Summary',
        `- Records: ${records.length}`,
        `- Notional (USD): ${notionalTotal.toFixed(2)}`,
        ...Object.entries(byStatus).map(([status, count]) => `- ${status}: ${count}`),
        '',
        '## Records',
        ...records.map(
          (r) =>
            `- ${r.transactionHash} | ${r.commodityCode} | ${r.complianceStatus} | ledger ${r.ledgerSequence}`,
        ),
      ];

      res.json({
        module: 'commodity-compliance',
        generatedAt,
        document: lines.join('\n'),
        summary: { recordCount: records.length, notionalTotalUsd: notionalTotal, byStatus },
        evidenceSnapshot,
      });
    } catch (e) {
      res.status(400).json({ error: String(e) });
    }
  }),
);

// GET /commodity-compliance — list with filters
commodityComplianceRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const q = listSchema.parse(req.query);
      const where = {
        ...(q.commodityCode && { commodityCode: q.commodityCode }),
        ...(q.commodityType && { commodityType: q.commodityType }),
        ...(q.contract && { contractAddress: q.contract }),
        ...(q.trader && { traderAddress: q.trader }),
        ...(q.status && { complianceStatus: q.status }),
        ...(q.jurisdiction && { regulatoryJurisdiction: q.jurisdiction }),
        ...(q.signer && {
          OR: [{ primarySignerAddress: q.signer }, { secondarySignerAddress: q.signer }],
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
  }),
);

// GET /commodity-compliance/:txHash — get by transaction hash
commodityComplianceRouter.get(
  '/:txHash',
  asyncHandler(async (req: Request, res: Response) => {
    const record = await prisma.commodityDualSignerLog.findUnique({
      where: { transactionHash: req.params.txHash },
    });
    if (!record) return res.status(404).json({ error: 'Not found' });
    res.json(record);
  }),
);

// PATCH /commodity-compliance/:txHash/sign — record a signer approval/rejection
commodityComplianceRouter.patch(
  '/:txHash/sign',
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const { signerAddress, approved } = signSchema.parse(req.body);

      const existing = await prisma.commodityDualSignerLog.findUnique({
        where: { transactionHash: req.params.txHash },
      });
      if (!existing) return res.status(404).json({ error: 'Not found' });

      const isPrimary = existing.primarySignerAddress === signerAddress;
      const isSecondary = existing.secondarySignerAddress === signerAddress;

      if (!isPrimary && !isSecondary) {
        return res
          .status(403)
          .json({ error: 'Address is not a registered signer for this record' });
      }

      const primarySigned = isPrimary ? approved : existing.primarySigned;
      const secondarySigned = isSecondary ? approved : existing.secondarySigned;
      const bothSigned = primarySigned && secondarySigned;

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
  }),
);
