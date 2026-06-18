import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { getEcosystemOverview, getOverviewHistory, getNetworkComparison } from '../../stellar/overview-service';

export const overviewRouter = Router();

// GET /api/v1/stellar/overview
overviewRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const data = await getEcosystemOverview();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/v1/stellar/overview/history
overviewRouter.get('/history', async (req: Request, res: Response) => {
  try {
    const days = z.coerce.number().min(1).max(365).default(30).parse(req.query.days);
    const data = await getOverviewHistory(days);
    res.json(data);
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// GET /api/v1/stellar/overview/comparison
overviewRouter.get('/comparison', async (_req: Request, res: Response) => {
  try {
    const data = await getNetworkComparison();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});
