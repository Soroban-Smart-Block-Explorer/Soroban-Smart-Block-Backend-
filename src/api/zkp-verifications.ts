import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';
import { prismaRead } from '../db';
import {
  formatZkpVerification,
  getZkpVerificationHistory,
  type ZkpProofData,
} from '../indexer/zkp-verifier';

export const zkpVerificationsRouter = Router();

// GET /api/v1/zkp-verifications/contracts/:address
zkpVerificationsRouter.get(
  '/contracts/:address',
  asyncHandler(async (req: Request, res: Response) => {
    const params = z
      .object({
        address: z.string().min(1),
        limit: z.coerce.number().min(1).max(200).default(50),
      })
      .parse({ address: req.params.address, limit: req.query.limit });

    const events = await getZkpVerificationHistory(params.address, params.limit);
    res.json({ contractAddress: params.address, limit: params.limit, events });
  }),
);

// GET /api/v1/zkp-verifications/transactions/:hash
zkpVerificationsRouter.get(
  '/transactions/:hash',
  asyncHandler(async (req: Request, res: Response) => {
    const events = await prismaRead.zkpVerificationEvent.findMany({
      where: { transactionHash: req.params.hash },
      orderBy: { ledgerSequence: 'desc' },
    });

    const enriched = events.map((e) => {
      const zkpData: ZkpProofData = {
        proofType: e.proofType ?? 'unknown',
        publicInputHash: e.publicInputHash ?? '',
        verified: e.verificationResult ?? false,
        certaintyPercent: e.certaintyPercent ?? undefined,
      };
      return {
        id: e.id,
        transactionHash: e.transactionHash,
        contractAddress: e.contractAddress,
        proofType: e.proofType,
        publicInputHash: e.publicInputHash,
        certaintyPercent: e.certaintyPercent,
        verificationResult: e.verificationResult === true ? 'verified' : 'failed',
        ledger: e.ledgerSequence,
        ledgerCloseTime: e.ledgerCloseTime,
        humanReadable: formatZkpVerification(zkpData),
      };
    });

    if (enriched.length === 0) {
      return res.status(404).json({ error: 'No ZKP verification events for transaction' });
    }
    res.json({ transactionHash: req.params.hash, events: enriched });
  }),
);

// GET /api/v1/zkp-verifications/proof-types/summary
zkpVerificationsRouter.get(
  '/proof-types/summary',
  asyncHandler(async (_req: Request, res: Response) => {
    const grouped = await prismaRead.zkpVerificationEvent.groupBy({
      by: ['proofType', 'verificationResult'],
      _count: { _all: true },
      _avg: { certaintyPercent: true },
    });

    const totals = await prismaRead.zkpVerificationEvent.groupBy({
      by: ['proofType'],
      _count: { _all: true },
    });

    const byProofType = totals.map((t) => ({
      proofType: t.proofType ?? 'unknown',
      total: t._count._all,
    }));

    const withAvgCertainty = byProofType.map((pt) => {
      const rows = grouped.filter((g) => (g.proofType ?? 'unknown') === pt.proofType);
      const verifiedCount = rows
        .filter((r) => r.verificationResult === true)
        .reduce((acc, r) => acc + r._count._all, 0);
      const avgCertainty =
        rows.length > 0
          ? rows.reduce((acc, r) => acc + (r._avg.certaintyPercent ?? 0), 0) / rows.length
          : null;
      return { ...pt, verifiedCount, avgCertainty };
    });

    res.json({ summary: withAvgCertainty });
  }),
);

// GET /api/v1/zkp-verifications/recent
zkpVerificationsRouter.get(
  '/recent',
  asyncHandler(async (req: Request, res: Response) => {
    const params = z
      .object({
        limit: z.coerce.number().min(1).max(200).default(20),
        proofType: z.string().optional(),
      })
      .parse({
        limit: req.query.limit ?? 20,
        proofType: req.query.proofType,
      });

    const events = await prismaRead.zkpVerificationEvent.findMany({
      where: params.proofType ? { proofType: params.proofType } : undefined,
      orderBy: { ledgerSequence: 'desc' },
      take: params.limit,
    });

    const enriched = events.map((e) => {
      const zkpData: ZkpProofData = {
        proofType: e.proofType ?? 'unknown',
        publicInputHash: e.publicInputHash ?? '',
        verified: e.verificationResult === true,
        certaintyPercent: e.certaintyPercent ?? undefined,
      };
      return {
        id: e.id,
        transactionHash: e.transactionHash,
        contractAddress: e.contractAddress,
        proofType: e.proofType,
        publicInputHash: e.publicInputHash,
        certaintyPercent: e.certaintyPercent,
        verificationResult: e.verificationResult === true ? 'verified' : 'failed',
        ledger: e.ledgerSequence,
        ledgerCloseTime: e.ledgerCloseTime,
        humanReadable: formatZkpVerification(zkpData),
      };
    });

    res.json({ limit: params.limit, events: enriched });
  }),
);
