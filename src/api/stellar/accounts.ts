import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { validateAddressParam } from '../../middleware/sanitize';
import {
  getUnifiedAccountView,
  getAccountTrustlines,
  getAccountSigners,
  getUnifiedTransactions,
  getBalanceHistory,
} from '../../stellar/account-aggregator';

export const accountsRouter = Router();

const paginationSchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
});

// GET /api/v1/stellar/accounts/:address
accountsRouter.get('/:address', validateAddressParam('address'), async (req: Request, res: Response) => {
  try {
    const view = await getUnifiedAccountView(req.params.address);
    res.json(view);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/v1/stellar/accounts/:address/trustlines
accountsRouter.get('/:address/trustlines', validateAddressParam('address'), async (req: Request, res: Response) => {
  try {
    const data = await getAccountTrustlines(req.params.address);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/v1/stellar/accounts/:address/signers
accountsRouter.get('/:address/signers', validateAddressParam('address'), async (req: Request, res: Response) => {
  try {
    const data = await getAccountSigners(req.params.address);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/v1/stellar/accounts/:address/transactions
accountsRouter.get('/:address/transactions', validateAddressParam('address'), async (req: Request, res: Response) => {
  try {
    const { page, limit } = paginationSchema.parse(req.query);
    const data = await getUnifiedTransactions(req.params.address, page, limit);
    res.json(data);
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// GET /api/v1/stellar/accounts/:address/transactions/cross-domain
accountsRouter.get(
  '/:address/transactions/cross-domain',
  validateAddressParam('address'),
  async (req: Request, res: Response) => {
    try {
      const { page, limit } = paginationSchema.parse(req.query);
      const data = await getUnifiedTransactions(req.params.address, page, limit, true);
      res.json(data);
    } catch (e) {
      res.status(400).json({ error: String(e) });
    }
  },
);

// GET /api/v1/stellar/accounts/:address/balance-history
accountsRouter.get(
  '/:address/balance-history',
  validateAddressParam('address'),
  async (req: Request, res: Response) => {
    try {
      const days = z.coerce.number().min(1).max(365).default(30).parse(req.query.days);
      const data = await getBalanceHistory(req.params.address, days);
      res.json({ history: data });
    } catch (e) {
      res.status(400).json({ error: String(e) });
    }
  },
);
