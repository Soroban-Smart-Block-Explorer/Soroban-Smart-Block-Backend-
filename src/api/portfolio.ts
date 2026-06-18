/**
 * GET  /api/v1/portfolio           — latest portfolio snapshot (all assets)
 * POST /api/v1/portfolio/scan      — trigger an on-demand portfolio scan
 */

import { Router, Request, Response } from 'express';
import { prismaRead as prisma } from '../db';
import { runPortfolioScan } from '../indexer/portfolioScanner';

export const portfolioRouter = Router();

// GET /portfolio — latest snapshot per contract
portfolioRouter.get('/', async (_req: Request, res: Response) => {
  try {
    // Return the most recent snapshot for each contract address
    const latest = await prisma.portfolioSnapshot.findMany({
      orderBy: { snapshotAt: 'desc' },
      distinct: ['contractAddress'],
    });

    const totalUsd = latest.reduce((sum, s) => sum + (s.valueUsd ?? 0), 0);
    const totalXlm = latest.reduce((sum, s) => sum + (s.valueXlm ?? 0), 0);

    res.json({ totalUsd, totalXlm, assets: latest });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// POST /portfolio/scan — on-demand trigger
portfolioRouter.post('/scan', async (_req: Request, res: Response) => {
  try {
    await runPortfolioScan();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});
