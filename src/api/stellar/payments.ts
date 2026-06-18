import { Router, Request, Response } from 'express';
import { validateAddressParam } from '../../middleware/sanitize';
import { getPaymentHistory, getPaymentCorridors, getPaymentStats } from '../../stellar/payment-analyzer';

export const paymentsRouter = Router();

// GET /api/v1/stellar/payments/corridors
paymentsRouter.get('/corridors', async (_req: Request, res: Response) => {
  try {
    const data = await getPaymentCorridors();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/v1/stellar/payments/stats
paymentsRouter.get('/stats', async (_req: Request, res: Response) => {
  try {
    const data = await getPaymentStats();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/v1/stellar/payments/:address
paymentsRouter.get('/:address', validateAddressParam('address'), async (req: Request, res: Response) => {
  try {
    const data = await getPaymentHistory(req.params.address);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});
