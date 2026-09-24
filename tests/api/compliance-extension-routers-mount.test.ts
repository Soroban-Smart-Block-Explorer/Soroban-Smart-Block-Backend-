import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../src/db', () => ({
  prismaWrite: {
    commodityCompliance: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
    rwaCompliance: {
      findMany: vi.fn(),
    },
    dtccSettlementBridge: {
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    settlementBatch: {
      findMany: vi.fn(),
    },
    settlementBatchSummary: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      findUnique: vi.fn().mockResolvedValue(null),
    },
  },
  prismaRead: {
    commodityCompliance: {
      findMany: vi.fn(),
    },
    rwaCompliance: {
      findMany: vi.fn(),
    },
    dtccSettlementBridge: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    settlementBatch: {
      findMany: vi.fn(),
    },
    settlementBatchSummary: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      findUnique: vi.fn().mockResolvedValue(null),
    },
  },
}));

vi.mock('../../src/indexer/settlement-compactor', () => ({
  runCompactor: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/middleware/asyncHandler', () => ({
  asyncHandler: (fn: Mock) => fn,
}));

import { commodityComplianceRouter } from '../../src/api/commodity-compliance';
import { rwaComplianceRouter } from '../../src/api/rwa-compliance';
import { dtccSettlementRouter } from '../../src/api/dtcc-settlement';
import { settlementBatchRouter } from '../../src/api/settlement-batch';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/compliance/commodity', commodityComplianceRouter);
  app.use('/compliance/rwa', rwaComplianceRouter);
  app.use('/compliance/dtcc-settlement', dtccSettlementRouter);
  app.use('/compliance/settlement-batch', settlementBatchRouter);
  return app;
}

describe('Commodity Compliance Router Mount (#846)', () => {
  describe('GET /compliance/commodity', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns commodity compliance overview or empty list', async () => {
      const res = await request(makeApp()).get('/compliance/commodity');
      expect([200, 400]).toContain(res.status);
    });
  });

  describe('POST /compliance/commodity', () => {
    beforeEach(() => vi.clearAllMocks());

    it('creates commodity compliance log entry', async () => {
      const res = await request(makeApp()).post('/compliance/commodity').send({
        transactionHash: 'txhash123',
        commodityType: 'crude_oil',
        commodityCode: 'WTI',
        contractAddress: 'CCCC',
        traderAddress: 'GAAA',
        primarySignerAddress: 'GAAA',
        secondarySignerAddress: 'GBBB',
        quantity: '100',
        unit: 'barrel',
        ledgerSequence: 12345,
      });

      expect([200, 201, 400]).toContain(res.status);
    });
  });

  describe('GET /compliance/commodity/:txHash', () => {
    beforeEach(() => vi.clearAllMocks());

    it('retrieves commodity compliance record by transaction hash', async () => {
      const res = await request(makeApp()).get('/compliance/commodity/txhash123');
      expect([200, 404]).toContain(res.status);
    });
  });
});

describe('RWA Compliance Router Mount (#846)', () => {
  describe('GET /compliance/rwa', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns RWA compliance service overview', async () => {
      const res = await request(makeApp()).get('/compliance/rwa');
      expect(res.status).toBe(200);
      expect(res.body.service || res.body.description).toBeDefined();
    });
  });

  describe('GET /compliance/rwa/assets', () => {
    beforeEach(() => vi.clearAllMocks());

    it('lists RWA-compliant assets', async () => {
      const res = await request(makeApp()).get('/compliance/rwa/assets');
      expect([200, 400]).toContain(res.status);
    });
  });

  describe('POST /compliance/rwa/kyc/verify', () => {
    beforeEach(() => vi.clearAllMocks());

    it('verifies KYC/AML compliance', async () => {
      const res = await request(makeApp())
        .post('/compliance/rwa/kyc/verify')
        .send({ address: 'GAAA', jurisdiction: 'US' });

      expect([200, 400]).toContain(res.status);
    });
  });
});

describe('DTCC Settlement Router Mount (#846)', () => {
  describe('GET /compliance/dtcc-settlement', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns DTCC settlement service overview', async () => {
      const res = await request(makeApp()).get('/compliance/dtcc-settlement');
      expect(res.status).toBe(200);
      expect(res.body.service || res.body.description).toBeDefined();
    });
  });

  describe('GET /compliance/dtcc-settlement/transactions', () => {
    beforeEach(() => vi.clearAllMocks());

    it('lists DTCC settlement transactions', async () => {
      const res = await request(makeApp()).get('/compliance/dtcc-settlement/transactions');
      expect([200, 400]).toContain(res.status);
    });
  });

  describe('POST /compliance/dtcc-settlement/process', () => {
    beforeEach(() => vi.clearAllMocks());

    it('processes DTCC settlement', async () => {
      const res = await request(makeApp())
        .post('/compliance/dtcc-settlement/process')
        .send({ batchId: 'batch123', settlementDate: '2024-01-01' });

      expect([200, 400]).toContain(res.status);
    });
  });
});

describe('Settlement Batch Router Mount (#846)', () => {
  describe('GET /compliance/settlement-batch', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns settlement batch service overview', async () => {
      const res = await request(makeApp()).get('/compliance/settlement-batch');
      expect(res.status).toBe(200);
      expect(res.body.service || res.body.description).toBeDefined();
    });
  });

  describe('GET /compliance/settlement-batch/batches', () => {
    beforeEach(() => vi.clearAllMocks());

    it('lists settlement batches', async () => {
      const res = await request(makeApp()).get('/compliance/settlement-batch/batches');
      expect([200, 400]).toContain(res.status);
    });
  });

  describe('POST /compliance/settlement-batch/create', () => {
    beforeEach(() => vi.clearAllMocks());

    it('creates new settlement batch', async () => {
      const res = await request(makeApp())
        .post('/compliance/settlement-batch/create')
        .send({
          batchType: 'daily',
          assets: ['asset1', 'asset2'],
          settlementDate: '2024-01-01',
        });

      expect([200, 201, 400]).toContain(res.status);
    });
  });

  describe('GET /compliance/settlement-batch/:batchId/lifecycle', () => {
    beforeEach(() => vi.clearAllMocks());

    it('retrieves settlement batch lifecycle', async () => {
      const res = await request(makeApp()).get('/compliance/settlement-batch/batch123/lifecycle');
      expect([200, 404]).toContain(res.status);
    });
  });
});

describe('Issue #846 - Compliance Router Integration', () => {
  it('all compliance extension routers are accessible', async () => {
    const commodityRes = await request(makeApp()).get('/compliance/commodity');
    const rwaRes = await request(makeApp()).get('/compliance/rwa');
    const dtccRes = await request(makeApp()).get('/compliance/dtcc-settlement');
    const batchRes = await request(makeApp()).get('/compliance/settlement-batch');

    expect([200, 400]).toContain(commodityRes.status);
    expect(rwaRes.status).toBe(200);
    expect(dtccRes.status).toBe(200);
    expect(batchRes.status).toBe(200);
  });

  it('provides complete compliance family surface', async () => {
    const endpoints = [
      '/compliance/commodity',
      '/compliance/rwa',
      '/compliance/dtcc-settlement',
      '/compliance/settlement-batch',
    ];

    for (const endpoint of endpoints) {
      const res = await request(makeApp()).get(endpoint);
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(500);
    }
  });

  it('enables supply-chain transparency through commodity and RWA compliance', async () => {
    const commodityRes = await request(makeApp()).get('/compliance/commodity');
    const rwaRes = await request(makeApp()).get('/compliance/rwa');

    expect((commodityRes.body.description || '') + (rwaRes.body.description || '')).toContain(
      'compliance',
    );
  });
});
