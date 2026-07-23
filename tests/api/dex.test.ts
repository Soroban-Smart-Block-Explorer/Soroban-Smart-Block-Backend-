import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../src/indexer/dex-analyzer', () => ({
  analyzeTransaction: vi.fn(),
  analyzeRange: vi.fn(),
}));

import { dexRouter } from '../../src/api/dex';
import { analyzeTransaction, analyzeRange } from '../../src/indexer/dex-analyzer';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/dex', dexRouter);
  return app;
}

describe('GET /dex/analyze/:hash', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 404 when transaction not found', async () => {
    vi.mocked(analyzeTransaction).mockResolvedValue(null);

    const res = await request(makeApp()).get('/dex/analyze/nonexistent');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Transaction not found');
  });

  it('returns analysis result for known transaction', async () => {
    const mockResult = { hash: 'abc123', flashLoan: false, arbitrage: true };
    vi.mocked(analyzeTransaction).mockResolvedValue(mockResult as any);

    const res = await request(makeApp()).get('/dex/analyze/abc123');
    expect(res.status).toBe(200);
    expect(res.body.hash).toBe('abc123');
    expect(res.body.arbitrage).toBe(true);
  });

  it('returns 500 on unexpected error', async () => {
    vi.mocked(analyzeTransaction).mockRejectedValue(new Error('RPC error'));

    const res = await request(makeApp()).get('/dex/analyze/abc123');
    expect(res.status).toBe(500);
  });
});

describe('GET /dex/analyze (range)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns range analysis results', async () => {
    vi.mocked(analyzeRange).mockResolvedValue([{ hash: 'tx1' } as any, { hash: 'tx2' } as any]);

    const res = await request(makeApp()).get('/dex/analyze?ledgerMin=1000&ledgerMax=2000');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.data).toHaveLength(2);
  });

  it('returns 400 when ledgerMax < ledgerMin', async () => {
    const res = await request(makeApp()).get('/dex/analyze?ledgerMin=2000&ledgerMax=1000');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('ledgerMax must be');
  });

  it('returns 400 for missing required params', async () => {
    const res = await request(makeApp()).get('/dex/analyze?ledgerMin=1000');
    expect(res.status).toBe(400);
  });

  it('applies default limit of 100', async () => {
    vi.mocked(analyzeRange).mockResolvedValue([]);

    await request(makeApp()).get('/dex/analyze?ledgerMin=1000&ledgerMax=2000');
    expect(analyzeRange).toHaveBeenCalledWith(1000, 2000, 100);
  });

  it('respects custom limit', async () => {
    vi.mocked(analyzeRange).mockResolvedValue([]);

    await request(makeApp()).get('/dex/analyze?ledgerMin=1000&ledgerMax=2000&limit=50');
    expect(analyzeRange).toHaveBeenCalledWith(1000, 2000, 50);
  });

  it('returns 400 when limit exceeds max (500)', async () => {
    const res = await request(makeApp()).get(
      '/dex/analyze?ledgerMin=1000&ledgerMax=2000&limit=999',
    );
    expect(res.status).toBe(400);
  });
});
