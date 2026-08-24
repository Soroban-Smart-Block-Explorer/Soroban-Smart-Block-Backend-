/**
 * POST /api/v1/admin/consistency-check
 *
 * Scans the last N ledgers and verifies hash chain continuity (previousLedgerHash matches previous ledger hash).
 * Output a report of any inconsistencies found.
 */

import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { adminService } from '../services/admin.service';

export const adminRouter = Router();

adminRouter.post(
  '/consistency-check',
  asyncHandler(async (req: Request, res: Response) => {
    const limit = Number(req.body.limit ?? req.body.count ?? 100);
    const report = await adminService.runConsistencyCheck(limit);
    res.json(report);
  }),
);
