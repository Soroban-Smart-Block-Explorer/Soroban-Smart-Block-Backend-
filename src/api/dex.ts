import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { analyzeTransaction, analyzeRange } from '../indexer/dex-analyzer';

export const dexRouter = Router();

// GET /dex/analyze/:hash — analyze a single transaction
// GET /dex/analyze/:hash
// Analyze a single transaction for flash loans, arbitrage, and multi-hop routes.
dexRouter.get('/analyze/:hash', async (req: Request, res: Response) => {
  try {
    const result = await analyzeTransaction(req.params.hash);
    if (!result) return res.status(404).json({ error: 'Transaction not found' });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

const rangeSchema = z.object({
  ledgerMin: z.coerce.number().int().min(0),
  ledgerMax: z.coerce.number().int().min(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

// GET /dex/analyze?ledgerMin=&ledgerMax=&limit= — analyze a ledger range
// GET /dex/analyze?ledgerMin=&ledgerMax=&limit=
// Analyze all transactions in a ledger range.
dexRouter.get('/analyze', async (req: Request, res: Response) => {
  try {
    const { ledgerMin, ledgerMax, limit } = rangeSchema.parse(req.query);
    if (ledgerMax < ledgerMin) {
      return res.status(400).json({ error: 'ledgerMax must be >= ledgerMin' });
    }
    const results = await analyzeRange(ledgerMin, ledgerMax, limit);
    res.json({ data: results, count: results.length });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});
