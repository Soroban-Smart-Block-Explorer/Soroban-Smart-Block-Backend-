import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { factoryTrackerRouter } from '../../src/api/factory-tracker';
import { upgradeTraceRouter } from '../../src/api/upgrade-trace';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/factory-tracker', factoryTrackerRouter);
  app.use('/upgrade-trace', upgradeTraceRouter);
  return app;
}

describe('Factory Tracker Router Mount (#844)', () => {
  describe('GET /factory-tracker', () => {
    it('returns service overview', async () => {
      const res = await request(makeApp()).get('/factory-tracker');
      expect(res.status).toBe(200);
      expect(res.body.service).toContain('Factory Tracker');
      expect(Array.isArray(res.body.endpoints)).toBe(true);
    });

    it('includes expected endpoints', async () => {
      const res = await request(makeApp()).get('/factory-tracker');
      expect(res.status).toBe(200);
      expect(res.body.endpoints).toContain('GET  /factory-tracker');
      expect(res.body.endpoints).toContain('GET  /factory-tracker/factories');
      expect(res.body.endpoints).toContain('GET  /factory-tracker/stats');
    });
  });

  describe('GET /factory-tracker/factories', () => {
    it('returns empty factories list', async () => {
      const res = await request(makeApp()).get('/factory-tracker/factories');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.factories)).toBe(true);
      expect(res.body.total).toBe(0);
    });

    it('respects limit parameter', async () => {
      const res = await request(makeApp()).get('/factory-tracker/factories?limit=50');
      expect(res.status).toBe(200);
      expect(res.body.limit).toBeLessThanOrEqual(100);
    });
  });

  describe('GET /factory-tracker/factories/:contractId', () => {
    it('returns factory details', async () => {
      const res = await request(makeApp()).get('/factory-tracker/factories/CCCC');
      expect(res.status).toBe(200);
      expect(res.body.contractId).toBe('CCCC');
      expect(typeof res.body.isFactory).toBe('boolean');
    });
  });

  describe('GET /factory-tracker/factories/:contractId/children', () => {
    it('returns child contracts list', async () => {
      const res = await request(makeApp()).get('/factory-tracker/factories/CCCC/children');
      expect(res.status).toBe(200);
      expect(res.body.factoryId).toBe('CCCC');
      expect(Array.isArray(res.body.children)).toBe(true);
    });
  });

  describe('GET /factory-tracker/contracts/:contractId/lineage', () => {
    it('returns contract lineage', async () => {
      const res = await request(makeApp()).get('/factory-tracker/contracts/CCCC/lineage');
      expect(res.status).toBe(200);
      expect(res.body.contractId).toBe('CCCC');
      expect(Array.isArray(res.body.lineage)).toBe(true);
    });
  });

  describe('GET /factory-tracker/stats', () => {
    it('returns factory statistics', async () => {
      const res = await request(makeApp()).get('/factory-tracker/stats');
      expect(res.status).toBe(200);
      expect(res.body.totalFactories).toBe(0);
      expect(res.body.totalChildContracts).toBe(0);
      expect(typeof res.body.avgChildrenPerFactory).toBe('number');
    });
  });
});

describe('Upgrade Trace Router Mount (#844)', () => {
  describe('GET /upgrade-trace', () => {
    it('returns service overview', async () => {
      const res = await request(makeApp()).get('/upgrade-trace');
      expect(res.status).toBe(200);
      expect(res.body.service).toContain('Upgrade Trace');
      expect(Array.isArray(res.body.endpoints)).toBe(true);
    });

    it('includes expected endpoints', async () => {
      const res = await request(makeApp()).get('/upgrade-trace');
      expect(res.status).toBe(200);
      expect(res.body.endpoints).toContain('GET  /upgrade-trace');
      expect(res.body.endpoints).toContain('GET  /upgrade-trace/contracts/:contractId');
      expect(res.body.endpoints).toContain('GET  /upgrade-trace/stats');
    });
  });

  describe('GET /upgrade-trace/contracts/:contractId', () => {
    it('returns contract upgrade status', async () => {
      const res = await request(makeApp()).get('/upgrade-trace/contracts/CCCC');
      expect(res.status).toBe(200);
      expect(res.body.contractId).toBe('CCCC');
    });
  });

  describe('GET /upgrade-trace/contracts/:contractId/history', () => {
    it('returns upgrade history', async () => {
      const res = await request(makeApp()).get('/upgrade-trace/contracts/CCCC/history');
      expect(res.status).toBe(200);
      expect(res.body.contractId).toBe('CCCC');
      expect(Array.isArray(res.body.upgrades) || typeof res.body.upgrades === 'undefined').toBe(
        true,
      );
    });
  });

  describe('GET /upgrade-trace/contracts/:contractId/diff', () => {
    it('returns wasm diff information with from parameter', async () => {
      const res = await request(makeApp()).get(
        '/upgrade-trace/contracts/CCCC/diff?from=abc123def456',
      );
      expect(res.status).toBe(200);
      expect(res.body.contractId).toBe('CCCC');
    });

    it('returns 400 when from parameter is missing', async () => {
      const res = await request(makeApp()).get('/upgrade-trace/contracts/CCCC/diff');
      expect(res.status).toBe(400);
    });
  });

  describe('GET /upgrade-trace/recent', () => {
    it('returns recent upgrades', async () => {
      const res = await request(makeApp()).get('/upgrade-trace/recent');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.upgrades) || typeof res.body.upgrades === 'undefined').toBe(
        true,
      );
    });
  });

  describe('GET /upgrade-trace/stats', () => {
    it('returns upgrade statistics', async () => {
      const res = await request(makeApp()).get('/upgrade-trace/stats');
      expect(res.status).toBe(200);
      expect(typeof res.body.totalUpgradesIndexed).toBe('number');
      expect(typeof res.body.totalContractsTracked).toBe('number');
    });
  });
});

describe('Issue #844 - Router Integration', () => {
  it('both routers are accessible from main app', async () => {
    const factoryRes = await request(makeApp()).get('/factory-tracker');
    expect(factoryRes.status).toBe(200);

    const upgradeRes = await request(makeApp()).get('/upgrade-trace');
    expect(upgradeRes.status).toBe(200);
  });

  it('provides contract provenance and upgrade history transparency', async () => {
    const factoryRes = await request(makeApp()).get('/factory-tracker');
    const upgradeRes = await request(makeApp()).get('/upgrade-trace');

    expect(factoryRes.body.description).toContain('lineage');
    expect(upgradeRes.body.description).toContain('upgrade');
  });
});
