/**
 * Scheduled risk scanning API (VE03): results and change feed.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { riskStore, runScanCycle } from '../scanning/scheduled-scanner';
import { adminAuth } from '../middleware/adminAuth';
import { asyncHandler } from '../middleware/asyncHandler';

export const scheduledScansRouter = Router();

const listSchema = z.object({
  minScore: z.coerce.number().min(0).max(100).optional(),
  category: z.enum(['reentrancy', 'overflow', 'privileged_call']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

scheduledScansRouter.get('/results', (req: Request, res: Response) => {
  const parsed = listSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const results = riskStore.list(parsed.data);
  res.json({ results, total: results.length });
});

scheduledScansRouter.get('/results/:address', (req: Request, res: Response) => {
  const record = riskStore.get(req.params.address);
  if (!record) return res.status(404).json({ error: 'No scan result for contract' });
  res.json(record);
});

scheduledScansRouter.get('/changes', (req: Request, res: Response) => {
  const since = z.coerce.number().int().min(0).default(0).parse(req.query.since ?? 0);
  const limit = z.coerce.number().int().min(1).max(500).default(100).parse(req.query.limit ?? 100);
  const changes = riskStore.changesSince(since, limit);
  res.json({ changes, nextSince: changes.length ? changes[changes.length - 1].seq : since });
});

scheduledScansRouter.post(
  '/run',
  adminAuth,
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(await runScanCycle());
  }),
);
