import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../src/indexer/rpc', () => ({
  rpc: {
    simulateTransaction: vi.fn(),
  },
}));

vi.mock('../../src/config', () => ({
  config: {
    networkPassphrase: 'Test SDF Network ; September 2015',
    stellarRpcUrl: 'http://localhost:8000',
  },
}));

vi.mock('../../src/db', () => ({
  prismaRead: {
    contract: { findUnique: vi.fn() },
  },
}));

vi.mock('../../src/indexer/xdr-parser', () => ({
  parseInvokeHostFunction: vi.fn().mockReturnValue(null),
}));

vi.mock('../../src/indexer/registry', () => ({
  getContractAbi: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/indexer/args-decoder', () => ({
  decodeScVal: vi.fn().mockReturnValue({ raw: null, formatted: null }),
}));

vi.mock('../../src/indexer/footprint-formatter', () => ({
  formatFootprint: vi.fn().mockReturnValue({}),
}));

vi.mock('../../src/indexer/auth-snippet-gen', () => ({
  generateAuthSnapshots: vi.fn().mockReturnValue([]),
}));

vi.mock('../../src/indexer/call-trace', () => ({
  parseCallTrace: vi.fn().mockReturnValue({ events: [] }),
}));

vi.mock('../../src/indexer/storage-classifier', () => ({
  classifyStorageEntries: vi.fn().mockReturnValue({}),
}));

vi.mock('../../src/indexer/ttl-tracker', () => ({
  trackTtlChanges: vi.fn().mockReturnValue({}),
}));

vi.mock('../../src/middleware/asyncHandler', () => ({
  asyncHandler: (fn: Mock) => fn,
}));

import { simulateRouter } from '../../src/api/simulate';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/simulate', simulateRouter);
  return app;
}

describe('POST /simulate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 400 when transaction field is missing', async () => {
    const res = await request(makeApp()).post('/simulate').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('transaction');
  });

  it('returns 400 when transaction is not a string', async () => {
    const res = await request(makeApp()).post('/simulate').send({ transaction: 12345 });
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid XDR', async () => {
    const res = await request(makeApp()).post('/simulate').send({ transaction: 'not-valid-xdr' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid transaction XDR');
  });
});
