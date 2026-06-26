/**
 * POST /api/v1/admin/consistency-check
 *
 * Scans the last N ledgers and verifies hash chain continuity (previousLedgerHash matches previous ledger hash).
 * Output a report of any inconsistencies found.
 */

import { Router, Request, Response } from 'express';
import { prismaRead as prisma } from '../db';
import { asyncHandler } from '../middleware/asyncHandler';

export const adminRouter = Router();

adminRouter.post(
  '/consistency-check',
  asyncHandler(async (req: Request, res: Response) => {
    const limit = Number(req.body.limit ?? req.body.count ?? 100);

    const ledgers = await prisma.ledger.findMany({
      orderBy: { sequence: 'desc' },
      take: limit,
    });

    const inconsistencies: Array<{
      sequence: number;
      expectedPreviousHash: string;
      actualPreviousHash: string;
      message: string;
    }> = [];

    // Scan ledgers and verify hash chain continuity
    for (let i = 0; i < ledgers.length - 1; i++) {
      const current = ledgers[i];
      const previous = ledgers[i + 1]; // because ordered desc, index i+1 is sequence - 1

      if (current.sequence - 1 !== previous.sequence) {
        inconsistencies.push({
          sequence: current.sequence,
          expectedPreviousHash: '',
          actualPreviousHash: '',
          message: `Gap detected between ledger ${current.sequence} and ${previous.sequence}`,
        });
        continue;
      }

      if (current.previousLedgerHash && current.previousLedgerHash !== previous.hash) {
        inconsistencies.push({
          sequence: current.sequence,
          expectedPreviousHash: previous.hash,
          actualPreviousHash: current.previousLedgerHash,
          message: `Hash mismatch at ledger ${current.sequence}: previous hash in DB is ${previous.hash}, but current previousLedgerHash is ${current.previousLedgerHash}`,
        });
      }
    }

    res.json({
      success: inconsistencies.length === 0,
      scannedCount: ledgers.length,
      inconsistenciesCount: inconsistencies.length,
      inconsistencies,
    });
  }),
);
