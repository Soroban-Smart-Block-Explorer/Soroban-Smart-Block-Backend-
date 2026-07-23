import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { analyzeTransaction, analyzeRange } from '../indexer/dex-analyzer';
import { asyncHandler } from '../middleware/asyncHandler';

export const dexRouter = Router();

// GET /dex/analyze/:hash — analyze a single transaction
dexRouter.get(
  '/analyze/:hash',
  asyncHandler(async (req: Request, res: Response) => {
    const result = await analyzeTransaction(req.params.hash);
    if (!result) return res.status(404).json({ error: 'Transaction not found' });
    res.json(result);
  }),
);

const rangeSchema = z.object({
  ledgerMin: z.coerce.number().int().min(0),
  ledgerMax: z.coerce.number().int().min(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

// GET /dex/analyze?ledgerMin=&ledgerMax=&limit= — analyze a ledger range
dexRouter.get(
  '/analyze',
  asyncHandler(async (req: Request, res: Response) => {
    const { ledgerMin, ledgerMax, limit } = rangeSchema.parse(req.query);
    if (ledgerMax < ledgerMin) {
      return res.status(400).json({ error: 'ledgerMax must be >= ledgerMin' });
    }
    const results = await analyzeRange(ledgerMin, ledgerMax, limit);
    res.json({ data: results, count: results.length });
  }),
);
