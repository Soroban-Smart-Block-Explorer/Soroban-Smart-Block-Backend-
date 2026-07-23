/**
 * GET  /api/v1/protocol                    — current protocol version status (#51)
 * GET  /api/v1/protocol/reconciliation     — trigger/view reconciliation report (#50)
 * POST /api/v1/protocol/validate-upgrade   — pre-validate XDR invariants for an upcoming protocol version
 */
import { Router, Request, Response } from 'express';
import { getProtocolStatus } from '../indexer/protocol-guard';
import { runReconciliation } from '../indexer/reconciliation';
import { asyncHandler } from '../middleware/asyncHandler';

export const protocolRouter = Router();

protocolRouter.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    const status = await getProtocolStatus();
    res.json(status);
  }),
);

protocolRouter.get(
  '/reconciliation',
  asyncHandler(async (req: Request, res: Response) => {
    const lookback = Math.min(10_000, Math.max(1, Number(req.query.lookback ?? 1000)));
    const report = await runReconciliation(lookback);
    res.json(report);
  }),
);
