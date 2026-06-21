/**
 * GET  /api/v1/protocol                    — current protocol version status (#51)
 * GET  /api/v1/protocol/reconciliation     — trigger/view reconciliation report (#50)
 * POST /api/v1/protocol/validate-upgrade   — pre-validate XDR invariants for an upcoming protocol version
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { getProtocolStatus } from '../indexer/protocol-guard';
import { runReconciliation } from '../indexer/reconciliation';
import { verifyUpgradeInvariants } from '../indexer/upgrade-invariant';

export const protocolRouter = Router();

// GET /protocol — protocol version and feature status
protocolRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const status = await getProtocolStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /protocol/reconciliation — run reconciliation and return report
protocolRouter.get('/reconciliation', async (req: Request, res: Response) => {
  try {
    const lookback = Math.min(10_000, Math.max(1, Number(req.query.lookback ?? 1000)));
    const report = await runReconciliation(lookback);
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

const validateUpgradeSchema = z.object({
  protocolVersion: z.number().int().min(1),
  candidates: z.object({
    envelopeXdr: z.string().optional(),
    resultXdr: z.string().optional(),
    resultMetaXdr: z.string().optional(),
    ledgerEntryXdr: z.string().optional(),
  }),
});

// POST /protocol/validate-upgrade — pre-validate XDR invariants before a protocol upgrade goes live
protocolRouter.post('/validate-upgrade', (req: Request, res: Response) => {
  const parsed = validateUpgradeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }
  const { protocolVersion, candidates } = parsed.data;
  const result = verifyUpgradeInvariants(candidates, protocolVersion);
  res.status(result.safe ? 200 : 422).json(result);
});
