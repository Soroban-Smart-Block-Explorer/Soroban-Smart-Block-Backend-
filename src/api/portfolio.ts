import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';
import { valuatePortfolio, computePortfolioHistory } from '../services/pricing/portfolio';

export const portfolioRouter = Router();

const holdingSchema = z.object({
  token: z.string().min(1),
  balance: z.string().min(1),
  costBasisUsd: z.number().optional(),
});

const valuateSchema = z.object({
  holdings: z.array(holdingSchema).min(1).max(500),
});

const historySchema = z.object({
  holdings: z.array(holdingSchema).min(1).max(500),
  from: z.string().optional(),
  to: z.string().optional(),
  interval: z.string().optional(),
});

portfolioRouter.post(
  '/valuate',
  asyncHandler(async (req: Request, res: Response) => {
    const { holdings } = valuateSchema.parse(req.body);

    const valuation = await valuatePortfolio(holdings);

    if (valuation.breakdown.length === 0) {
      return res.status(400).json({ error: 'Could not valuate any holdings' });
    }

    res.json(valuation);
  }),
);

portfolioRouter.post(
  '/history',
  asyncHandler(async (req: Request, res: Response) => {
    const { holdings, from, to, interval } = historySchema.parse(req.body);

    const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const toDate = to ? new Date(to) : new Date();
    const intervalMs = interval ? parseInterval(interval) : 24 * 60 * 60 * 1000;

    const history = await computePortfolioHistory(holdings, fromDate, toDate, intervalMs);

    res.json({
      holdings: holdings.map((h) => h.token),
      from: fromDate.toISOString(),
      to: toDate.toISOString(),
      dataPoints: history.length,
      history,
    });
  }),
);

function parseInterval(interval: string): number {
  const match = interval.match(/^(\d+)([mhdw])$/);
  if (!match) return 24 * 60 * 60 * 1000;
  const value = parseInt(match[1]);
  const unit = match[2];
  const multipliers: Record<string, number> = {
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
  };
  return value * (multipliers[unit] ?? 24 * 60 * 60 * 1000);
}
