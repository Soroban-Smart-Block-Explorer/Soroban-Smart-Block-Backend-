import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../src/services/pricing/pnl', () => ({
  computePortfolioPnl: vi.fn(),
  getPortfolioPnl: vi.fn(),
  upsertPositions: vi.fn(),
  persistPortfolioPnl: vi.fn(),
  listBalanceSnapshots: vi.fn(),
}));

vi.mock('../../src/middleware/asyncHandler', () => ({
  asyncHandler: (fn: Mock) => {
    return (req: any, res: any, next: any) => {
      try {
        const result = fn(req, res, next);
        if (result && typeof result.catch === 'function') {
          result.catch(next);
        }
      } catch (err) {
        next(err);
      }
    };
  },
}));

vi.mock('../../src/middleware/errorHandler', () => ({
  AppError: class AppError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
  errorHandler: (err: any, _req: any, res: any, _next: any) => {
    if (err?.name === 'ZodError' || err?.issues) {
      return res.status(400).json({ error: 'Validation failed', details: err.issues });
    }
    if (err?.status) {
      return res.status(err.status).json({ error: err.message });
    }
    res.status(500).json({ error: err.message || 'Internal server error' });
  },
}));

import { portfolioRouter } from '../../src/api/portfolio';
import * as pnlService from '../../src/services/pricing/pnl';
import { errorHandler } from '../../src/middleware/errorHandler';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/portfolio', portfolioRouter);
  app.use(errorHandler);
  return app;
}

const samplePnl = {
  wallet: 'wallet-1',
  totalValueUsd: 3100,
  totalCostBasisUsd: 2090,
  unrealizedPnlUsd: 1010,
  unrealizedPnlPct: 48.3,
  realizedPnlUsd: 0,
  byChain: [
    { network: 'stellar', address: null, valueUsd: 100, costBasisUsd: 90, assets: [] },
    { network: 'ethereum', address: null, valueUsd: 3000, costBasisUsd: 2000, assets: [] },
  ],
  byAsset: [{ network: 'stellar', token: 'USDC', valueUsd: 100 }],
  assetCount: 1,
  timestamp: '2026-09-24T00:00:00.000Z',
};

describe('POST /portfolio/pnl', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns consolidated P&L decomposed by chain and asset', async () => {
    vi.mocked(pnlService.computePortfolioPnl).mockResolvedValue(samplePnl as any);

    const res = await request(makeApp())
      .post('/portfolio/pnl')
      .send({
        wallet: 'wallet-1',
        networks: [{ network: 'stellar', holdings: [{ token: 'USDC', balance: '1000000000' }] }],
      });

    expect(res.status).toBe(200);
    expect(res.body.totalValueUsd).toBe(3100);
    expect(res.body.byChain).toHaveLength(2);
    expect(res.body.snapshotsPersisted).toBe(0);
  });

  it('persists snapshots when persist=true and a wallet is supplied', async () => {
    vi.mocked(pnlService.computePortfolioPnl).mockResolvedValue(samplePnl as any);
    vi.mocked(pnlService.persistPortfolioPnl).mockResolvedValue(3);

    const res = await request(makeApp())
      .post('/portfolio/pnl')
      .send({
        wallet: 'wallet-1',
        persist: true,
        networks: [{ network: 'stellar', holdings: [{ token: 'USDC', balance: '1000000000' }] }],
      });

    expect(res.status).toBe(200);
    expect(res.body.snapshotsPersisted).toBe(3);
    expect(pnlService.persistPortfolioPnl).toHaveBeenCalledWith('wallet-1', samplePnl);
  });

  it('returns 400 when persist=true without a wallet', async () => {
    const res = await request(makeApp())
      .post('/portfolio/pnl')
      .send({
        persist: true,
        networks: [{ network: 'stellar', holdings: [{ token: 'USDC', balance: '1000000000' }] }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('wallet is required');
  });

  it('returns 400 for empty networks array', async () => {
    const res = await request(makeApp()).post('/portfolio/pnl').send({ networks: [] });
    expect(res.status).toBe(400);
  });

  it('returns 400 when a network has no holdings', async () => {
    const res = await request(makeApp())
      .post('/portfolio/pnl')
      .send({ networks: [{ network: 'stellar', holdings: [] }] });
    expect(res.status).toBe(400);
  });
});

describe('GET /portfolio/:wallet/pnl', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 404 when the wallet has no positions', async () => {
    vi.mocked(pnlService.getPortfolioPnl).mockResolvedValue({ assetCount: 0 } as any);

    const res = await request(makeApp()).get('/portfolio/wallet-1/pnl');
    expect(res.status).toBe(404);
  });

  it('returns the stored-wallet P&L', async () => {
    vi.mocked(pnlService.getPortfolioPnl).mockResolvedValue(samplePnl as any);

    const res = await request(makeApp()).get('/portfolio/wallet-1/pnl');
    expect(res.status).toBe(200);
    expect(res.body.unrealizedPnlUsd).toBe(1010);
    expect(pnlService.getPortfolioPnl).toHaveBeenCalledWith('wallet-1');
  });
});

describe('POST /portfolio/:wallet/positions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('upserts positions and reports the count', async () => {
    vi.mocked(pnlService.upsertPositions).mockResolvedValue(2);

    const res = await request(makeApp())
      .post('/portfolio/wallet-1/positions')
      .send({
        networks: [
          {
            network: 'stellar',
            address: 'GADDR',
            holdings: [
              { token: 'USDC', balance: '1000000000', costBasisUsd: 90 },
              { token: 'XLM', balance: '20000000', costBasisUsd: 5 },
            ],
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.positionsUpserted).toBe(2);
    expect(pnlService.upsertPositions).toHaveBeenCalledTimes(1);
  });
});

describe('GET /portfolio/:wallet/snapshots', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists snapshots with a default limit', async () => {
    vi.mocked(pnlService.listBalanceSnapshots).mockResolvedValue([
      {
        id: 's1',
        wallet: 'wallet-1',
        network: 'stellar',
        token: 'USDC',
        symbol: 'USDC',
        quantity: 100,
        priceUsd: 1,
        valueUsd: 100,
        costBasisUsd: 90,
        unrealizedPnlUsd: 10,
        snapshotAt: '2026-09-24T00:00:00.000Z',
      },
    ] as any);

    const res = await request(makeApp()).get('/portfolio/wallet-1/snapshots');

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.snapshots).toHaveLength(1);
    expect(pnlService.listBalanceSnapshots).toHaveBeenCalledWith(
      'wallet-1',
      expect.objectContaining({ limit: 100 }),
    );
  });

  it('forwards network and date filters', async () => {
    vi.mocked(pnlService.listBalanceSnapshots).mockResolvedValue([]);

    await request(makeApp()).get(
      '/portfolio/wallet-1/snapshots?network=ethereum&from=2026-01-01&limit=5',
    );

    const args = vi.mocked(pnlService.listBalanceSnapshots).mock.calls[0][1];
    expect(args.network).toBe('ethereum');
    expect(args.from).toBeInstanceOf(Date);
    expect(args.limit).toBe(5);
  });
});
