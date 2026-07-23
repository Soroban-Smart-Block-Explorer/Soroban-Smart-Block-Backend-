import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../src/services/pricing/portfolio', () => ({
  valuatePortfolio: vi.fn(),
  computePortfolioHistory: vi.fn(),
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
    // Zod validation errors → 400
    if (err?.name === 'ZodError' || err?.issues) {
      return res.status(400).json({ error: 'Validation failed', details: err.issues });
    }
    // AppError → use its status
    if (err?.status) {
      return res.status(err.status).json({ error: err.message });
    }
    // Default → 500
    res.status(500).json({ error: err.message || 'Internal server error' });
  },
}));

import { portfolioRouter } from '../../src/api/portfolio';
import * as pricingService from '../../src/services/pricing/portfolio';
import { errorHandler } from '../../src/middleware/errorHandler';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/portfolio', portfolioRouter);
  app.use(errorHandler);
  return app;
}

describe('POST /portfolio/valuate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 400 when no holdings can be valued', async () => {
    vi.mocked(pricingService.valuatePortfolio).mockResolvedValue({
      totalUsd: 0,
      breakdown: [],
    } as any);

    const res = await request(makeApp())
      .post('/portfolio/valuate')
      .send({ holdings: [{ token: 'CA_TOKEN', balance: '1000' }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Could not valuate');
  });

  it('returns valuation when holdings are priced', async () => {
    vi.mocked(pricingService.valuatePortfolio).mockResolvedValue({
      totalUsd: 500,
      breakdown: [{ token: 'CA_TOKEN', balanceUsd: 500 }],
    } as any);

    const res = await request(makeApp())
      .post('/portfolio/valuate')
      .send({ holdings: [{ token: 'CA_TOKEN', balance: '1000' }] });

    expect(res.status).toBe(200);
    expect(res.body.totalUsd).toBe(500);
  });

  it('returns 400 for empty holdings array', async () => {
    const res = await request(makeApp()).post('/portfolio/valuate').send({ holdings: [] });

    expect(res.status).toBe(400);
  });

  it('returns 400 for missing holdings field', async () => {
    const res = await request(makeApp()).post('/portfolio/valuate').send({});

    expect(res.status).toBe(400);
  });

  it('accepts optional costBasisUsd field', async () => {
    vi.mocked(pricingService.valuatePortfolio).mockResolvedValue({
      totalUsd: 100,
      breakdown: [{ token: 'CA_TOKEN', balanceUsd: 100 }],
    } as any);

    const res = await request(makeApp())
      .post('/portfolio/valuate')
      .send({
        holdings: [{ token: 'CA_TOKEN', balance: '100', costBasisUsd: 0.5 }],
      });

    expect(res.status).toBe(200);
  });
});

describe('POST /portfolio/history', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns history with default date range', async () => {
    vi.mocked(pricingService.computePortfolioHistory).mockResolvedValue([
      { timestamp: new Date().toISOString(), totalUsd: 100 },
    ] as any);

    const res = await request(makeApp())
      .post('/portfolio/history')
      .send({ holdings: [{ token: 'CA_TOKEN', balance: '1000' }] });

    expect(res.status).toBe(200);
    expect(res.body.dataPoints).toBe(1);
    expect(res.body.history).toHaveLength(1);
  });

  it('respects custom from/to/interval', async () => {
    vi.mocked(pricingService.computePortfolioHistory).mockResolvedValue([]);

    const res = await request(makeApp())
      .post('/portfolio/history')
      .send({
        holdings: [{ token: 'CA_TOKEN', balance: '1000' }],
        from: '2024-01-01',
        to: '2024-01-31',
        interval: '1d',
      });

    expect(res.status).toBe(200);
    expect(pricingService.computePortfolioHistory).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Date),
      expect.any(Date),
      86400000, // 1d in ms
    );
  });

  it('returns 400 for too many holdings (>500)', async () => {
    const holdings = Array.from({ length: 501 }, (_, i) => ({
      token: `CA_${i}`,
      balance: '100',
    }));

    const res = await request(makeApp()).post('/portfolio/history').send({ holdings });

    expect(res.status).toBe(400);
  });
});
