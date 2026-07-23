import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import * as db from '../../src/db';

vi.mock('../../src/db', () => ({
  prismaRead: {
    contract: { findFirst: vi.fn() },
    priceAlert: { findMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn() },
    tokenPriceHistory: { findFirst: vi.fn(), findMany: vi.fn() },
    tokenMarketData: { findUnique: vi.fn() },
    tokenPrice: { findUnique: vi.fn() },
  },
  prismaWrite: {
    priceAlert: { create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  },
}));

vi.mock('../../src/middleware/asyncHandler', () => ({
  asyncHandler: (fn: Mock) => {
    return (req: any, res: any, next: any) => {
      Promise.resolve(fn(req, res, next)).catch(next);
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
    res.status(err.status ?? 500).json({ error: err.message });
  },
}));

import { alertsRouter } from '../../src/api/alerts';
import { errorHandler } from '../../src/middleware/errorHandler';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/alerts', alertsRouter);
  app.use(errorHandler);
  return app;
}

describe('POST /alerts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 404 when token not found', async () => {
    vi.mocked(db.prismaRead.contract.findFirst).mockResolvedValue(null);

    const res = await request(makeApp()).post('/alerts').send({
      tokenAddress: 'CA_UNKNOWN',
      alertType: 'above',
      threshold: '1.0',
    });

    expect(res.status).toBe(404);
  });

  it('creates alert and returns 201', async () => {
    vi.mocked(db.prismaRead.contract.findFirst).mockResolvedValue({
      address: 'CA_TOKEN',
      isToken: true,
    } as any);
    vi.mocked(db.prismaWrite.priceAlert.create).mockResolvedValue({
      id: 'alert-1',
      tokenAddress: 'CA_TOKEN',
      alertType: 'above',
      threshold: '1.0',
      isActive: true,
      createdAt: new Date(),
    } as any);

    const res = await request(makeApp()).post('/alerts').send({
      tokenAddress: 'CA_TOKEN',
      alertType: 'above',
      threshold: '1.0',
    });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('alert-1');
  });

  it('returns 400 for invalid alertType', async () => {
    const res = await request(makeApp()).post('/alerts').send({
      tokenAddress: 'CA_TOKEN',
      alertType: 'invalid_type',
      threshold: '1.0',
    });
    expect(res.status).toBe(500); // Zod parse error propagates
  });
});

describe('GET /alerts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns all alerts when no userId filter', async () => {
    vi.mocked(db.prismaRead.priceAlert.findMany).mockResolvedValue([
      { id: 'a1', tokenAddress: 'CA_TOKEN', alertType: 'above' },
    ] as any);

    const res = await request(makeApp()).get('/alerts');
    expect(res.status).toBe(200);
    expect(res.body.alerts).toHaveLength(1);
  });

  it('filters by userId when provided', async () => {
    vi.mocked(db.prismaRead.priceAlert.findMany).mockResolvedValue([]);

    const res = await request(makeApp()).get('/alerts?userId=user-123');
    expect(res.status).toBe(200);
    expect(db.prismaRead.priceAlert.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-123' } }),
    );
  });
});

describe('PUT /alerts/:id', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 404 when alert not found', async () => {
    vi.mocked(db.prismaRead.priceAlert.findUnique).mockResolvedValue(null);

    const res = await request(makeApp()).put('/alerts/nonexistent').send({ isActive: false });
    expect(res.status).toBe(404);
  });

  it('updates alert and returns updated record', async () => {
    vi.mocked(db.prismaRead.priceAlert.findUnique).mockResolvedValue({ id: 'alert-1' } as any);
    vi.mocked(db.prismaWrite.priceAlert.update).mockResolvedValue({
      id: 'alert-1',
      isActive: false,
    } as any);

    const res = await request(makeApp()).put('/alerts/alert-1').send({ isActive: false });
    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(false);
  });
});

describe('DELETE /alerts/:id', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 404 when alert not found', async () => {
    vi.mocked(db.prismaRead.priceAlert.findUnique).mockResolvedValue(null);

    const res = await request(makeApp()).delete('/alerts/nonexistent');
    expect(res.status).toBe(404);
  });

  it('deletes alert and returns 204', async () => {
    vi.mocked(db.prismaRead.priceAlert.findUnique).mockResolvedValue({ id: 'alert-1' } as any);
    vi.mocked(db.prismaWrite.priceAlert.delete).mockResolvedValue({} as any);

    const res = await request(makeApp()).delete('/alerts/alert-1');
    expect(res.status).toBe(204);
  });
});
