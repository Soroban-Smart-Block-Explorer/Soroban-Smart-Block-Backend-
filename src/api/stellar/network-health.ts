import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  getNetworkHealth,
  listValidators,
  getValidatorDetail,
  getNetworkHealthHistory,
  getNetworkHealthAlerts,
} from '../../stellar/network-health-service';

export const networkHealthRouter = Router();

// GET /api/v1/stellar/network-health
networkHealthRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const data = await getNetworkHealth();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/v1/stellar/network-health/validators
networkHealthRouter.get('/validators', async (req: Request, res: Response) => {
  try {
    const page = z.coerce.number().min(1).default(1).parse(req.query.page);
    const limit = z.coerce.number().min(1).max(100).default(20).parse(req.query.limit);
    const data = await listValidators(page, limit);
    res.json(data);
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// GET /api/v1/stellar/network-health/validators/:address
networkHealthRouter.get('/validators/:address', async (req: Request, res: Response) => {
  try {
    const data = await getValidatorDetail(req.params.address);
    if (!data) return res.status(404).json({ error: 'Validator not found' });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/v1/stellar/network-health/history
networkHealthRouter.get('/history', async (req: Request, res: Response) => {
  try {
    const days = z.coerce.number().min(1).max(365).default(30).parse(req.query.days);
    const data = await getNetworkHealthHistory(days);
    res.json(data);
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// GET /api/v1/stellar/network-health/alerts
networkHealthRouter.get('/alerts', async (_req: Request, res: Response) => {
  try {
    const data = await getNetworkHealthAlerts();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});
