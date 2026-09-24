import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';
import { valuatePortfolio, computePortfolioHistory } from '../services/pricing/portfolio';
import {
  computePortfolioPnl,
  getPortfolioPnl,
  upsertPositions,
  persistPortfolioPnl,
  listBalanceSnapshots,
  type NetworkPortfolioInput,
} from '../services/pricing/pnl';

export const portfolioRouter = Router();

const holdingSchema = z.object({
  token: z.string().min(1),
  balance: z.string().min(1),
  costBasisUsd: z.number().optional(),
});

// ── Multi-network P&L schemas ────────────────────────────────────────────────

const networkHoldingSchema = z.object({
  token: z.string().min(1),
  balance: z.string().min(1),
  /** Total USD cost basis for the open position (not per-unit). */
  costBasisUsd: z.number().finite().optional(),
  realizedPnlUsd: z.number().finite().optional(),
  symbol: z.string().optional(),
  decimals: z.number().int().min(0).max(38).optional(),
});

const networkPortfolioSchema = z.object({
  network: z.string().min(1).max(64),
  address: z.string().min(1).max(128).optional(),
  holdings: z.array(networkHoldingSchema).min(1).max(500),
});

const pnlSchema = z.object({
  wallet: z.string().min(1).max(128).optional(),
  networks: z.array(networkPortfolioSchema).min(1).max(50),
  snapshotAt: z.string().datetime().optional(),
  deriveCostBasisFromEvents: z.boolean().optional(),
  persist: z.boolean().optional(),
});

const positionsSchema = z.object({
  networks: z.array(networkPortfolioSchema).min(1).max(50),
});

const snapshotsQuerySchema = z.object({
  network: z.string().min(1).max(64).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().min(1).max(1000).default(100),
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

/**
 * POST /portfolio/pnl
 *
 * Consolidated profit/loss across multiple networks for a linked wallet.
 * Holdings are supplied per network; results are decomposed by chain and asset.
 * When `persist` is set (and a wallet is given) per-asset balance snapshots are
 * written so the portfolio can be replayed over time.
 */
portfolioRouter.post(
  '/pnl',
  asyncHandler(async (req: Request, res: Response) => {
    const { wallet, networks, snapshotAt, deriveCostBasisFromEvents, persist } = pnlSchema.parse(
      req.body,
    );

    if (persist && !wallet) {
      return res.status(400).json({ error: 'wallet is required when persist is true' });
    }

    const pnl = await computePortfolioPnl({
      wallet,
      // Zod infers object fields as optional (strictNullChecks is off project-wide);
      // the schema guarantees the shape at runtime.
      networks: networks as NetworkPortfolioInput[],
      snapshotAt,
      deriveCostBasisFromEvents,
    });

    let snapshotsPersisted = 0;
    if (persist && wallet) {
      snapshotsPersisted = await persistPortfolioPnl(wallet, pnl);
    }

    res.json({ ...pnl, snapshotsPersisted });
  }),
);

/**
 * GET /portfolio/:wallet/pnl
 *
 * Consolidated P&L for a wallet from its persisted cost-basis positions.
 */
portfolioRouter.get(
  '/:wallet/pnl',
  asyncHandler(async (req: Request, res: Response) => {
    const { wallet } = req.params;
    const pnl = await getPortfolioPnl(wallet);

    if (pnl.assetCount === 0) {
      return res.status(404).json({ error: 'No positions found for wallet' });
    }

    res.json(pnl);
  }),
);

/**
 * POST /portfolio/:wallet/positions
 *
 * Upsert per-network cost-basis lots for a linked wallet.
 */
portfolioRouter.post(
  '/:wallet/positions',
  asyncHandler(async (req: Request, res: Response) => {
    const { wallet } = req.params;
    const { networks } = positionsSchema.parse(req.body);

    const positionsUpserted = await upsertPositions(wallet, networks as NetworkPortfolioInput[]);

    res.json({ wallet, positionsUpserted });
  }),
);

/**
 * GET /portfolio/:wallet/snapshots
 *
 * List persisted per-network balance snapshots for a wallet, newest first.
 */
portfolioRouter.get(
  '/:wallet/snapshots',
  asyncHandler(async (req: Request, res: Response) => {
    const { wallet } = req.params;
    const { network, from, to, limit } = snapshotsQuerySchema.parse(req.query);

    const snapshots = await listBalanceSnapshots(wallet, {
      network,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      limit,
    });

    res.json({ wallet, network: network ?? null, count: snapshots.length, snapshots });
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
