import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Mock } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../src/db', () => ({
  prismaRead: {
    dtccSettlementBridge: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('../../src/middleware/asyncHandler', () => ({
  asyncHandler: (fn: Mock) => fn,
}));

import * as db from '../../src/db';
import { dtccSettlementRouter } from '../../src/api/dtcc-settlement';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/dtcc', dtccSettlementRouter);
  return app;
}

const validRecord = {
  transactionHash: 'abc123',
  dtccSettlementId: 'DTCC-2024-001',
  securityId: 'AAPL',
  securityType: 'equity',
  sellerAddress: 'GA_SELLER',
  buyerAddress: 'GA_BUYER',
  quantity: '100',
  settlementAmount: '15000',
  currency: 'USD',
  ledgerSequence: 1000,
  ledgerCloseTime: '2024-01-01T00:00:00Z',
};

describe('POST /dtcc', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a settlement record and returns 201', async () => {
    vi.mocked(db.prismaRead.dtccSettlementBridge.create).mockResolvedValue({
      ...validRecord,
      id: 'rec-1',
    } as any);

    const res = await request(makeApp()).post('/dtcc').send(validRecord);
    expect(res.status).toBe(201);
    expect(res.body.id).toBe('rec-1');
  });

  it('returns 400 for missing required fields', async () => {
    const res = await request(makeApp()).post('/dtcc').send({ transactionHash: 'abc123' });
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid securityType', async () => {
    const res = await request(makeApp())
      .post('/dtcc')
      .send({ ...validRecord, securityType: 'crypto' });
    expect(res.status).toBe(400);
  });
});

describe('GET /dtcc', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns paginated list of records', async () => {
    vi.mocked(db.prismaRead.dtccSettlementBridge.findMany).mockResolvedValue([
      { id: 'rec-1', transactionHash: 'abc123' },
    ] as any);
    vi.mocked(db.prismaRead.dtccSettlementBridge.count).mockResolvedValue(1);

    const res = await request(makeApp()).get('/dtcc');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.total).toBe(1);
    expect(res.body).toHaveProperty('pages');
  });

  it('filters by securityId', async () => {
    vi.mocked(db.prismaRead.dtccSettlementBridge.findMany).mockResolvedValue([]);
    vi.mocked(db.prismaRead.dtccSettlementBridge.count).mockResolvedValue(0);

    const res = await request(makeApp()).get('/dtcc?securityId=AAPL');
    expect(res.status).toBe(200);
    expect(db.prismaRead.dtccSettlementBridge.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ securityId: 'AAPL' }) }),
    );
  });

  it('returns 400 for limit exceeding max (100)', async () => {
    const res = await request(makeApp()).get('/dtcc?limit=999');
    expect(res.status).toBe(400);
  });
});

describe('GET /dtcc/id/:dtccId', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 404 when no records found', async () => {
    vi.mocked(db.prismaRead.dtccSettlementBridge.findMany).mockResolvedValue([]);

    const res = await request(makeApp()).get('/dtcc/id/DTCC-UNKNOWN');
    expect(res.status).toBe(404);
  });

  it('returns records for known DTCC ID', async () => {
    vi.mocked(db.prismaRead.dtccSettlementBridge.findMany).mockResolvedValue([
      { id: 'rec-1', dtccSettlementId: 'DTCC-2024-001' },
    ] as any);

    const res = await request(makeApp()).get('/dtcc/id/DTCC-2024-001');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.dtccSettlementId).toBe('DTCC-2024-001');
  });
});

describe('GET /dtcc/:txHash', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 404 when record not found', async () => {
    vi.mocked(db.prismaRead.dtccSettlementBridge.findUnique).mockResolvedValue(null);

    const res = await request(makeApp()).get('/dtcc/nonexistent');
    expect(res.status).toBe(404);
  });

  it('returns record when found', async () => {
    vi.mocked(db.prismaRead.dtccSettlementBridge.findUnique).mockResolvedValue({
      id: 'rec-1',
      transactionHash: 'abc123',
    } as any);

    const res = await request(makeApp()).get('/dtcc/abc123');
    expect(res.status).toBe(200);
    expect(res.body.transactionHash).toBe('abc123');
  });
});

describe('PATCH /dtcc/:txHash/status', () => {
  beforeEach(() => vi.clearAllMocks());

  it('updates settlement status', async () => {
    vi.mocked(db.prismaRead.dtccSettlementBridge.update).mockResolvedValue({
      transactionHash: 'abc123',
      settlementStatus: 'settled',
    } as any);

    const res = await request(makeApp())
      .patch('/dtcc/abc123/status')
      .send({ settlementStatus: 'settled' });

    expect(res.status).toBe(200);
    expect(res.body.settlementStatus).toBe('settled');
  });

  it('returns 400 for invalid status', async () => {
    const res = await request(makeApp())
      .patch('/dtcc/abc123/status')
      .send({ settlementStatus: 'unknown_status' });

    expect(res.status).toBe(400);
  });
});
