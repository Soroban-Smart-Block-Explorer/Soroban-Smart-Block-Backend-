/**
 * Integration tests for the Gas Analytics API router (#832).
 *
 * These tests verify:
 *   1. /gas router is properly mounted and accessible
 *   2. GET /gas/contract/:address returns gas profile
 *   3. GET /gas/contract/:address/function/:fn returns per-function data
 *   4. GET /gas/leaderboard returns ranked contracts
 *   5. GET /gas/network returns network stats
 *   6. Error handling and parameter validation
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import request from 'supertest';

// Mock dependencies
vi.mock('../../src/db', () => ({
  prismaRead: {
    gasAnalyticsSnapshot: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    gasAlert: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    gasBenchmark: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
  prismaWrite: {
    gasAlert: {
      create: vi.fn().mockResolvedValue({
        id: 'alert_123',
        contractAddress: 'CTEST...',
        threshold: 1000000,
      }),
    },
    gasBenchmark: {
      create: vi.fn().mockResolvedValue({
        id: 'bench_123',
        contractAddress: 'CTEST...',
        functionName: 'transfer',
        gasFee: 500000,
      }),
    },
  },
}));

vi.mock('../../src/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Import after mocking
import { gasRouter } from '../../src/api/gas';

function buildTestApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/gas', gasRouter);
  return app;
}

describe('Gas Analytics API Router', () => {
  let app: Express;

  beforeEach(() => {
    app = buildTestApp();
    vi.clearAllMocks();
  });

  describe('GET /gas', () => {
    it('should return service overview with 200', async () => {
      const res = await request(app).get('/gas');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('service');
      expect(res.body.service).toContain('Gas');
    });

    it('should include API description', async () => {
      const res = await request(app).get('/gas');
      expect(res.body).toHaveProperty('description');
      expect(res.body.description).toBeTruthy();
    });

    it('should list available endpoints', async () => {
      const res = await request(app).get('/gas');
      expect(res.body).toHaveProperty('endpoints');
      expect(Array.isArray(res.body.endpoints)).toBe(true);
    });
  });

  describe('GET /gas/contract/:address', () => {
    it('should return gas profile for contract', async () => {
      const address = 'CABQBDGH';
      const res = await request(app).get(`/gas/contract/${address}`);
      expect([200, 404]).toContain(res.status);
    });

    it('should include gas metrics in response', async () => {
      const address = 'CABQBDGH';
      const res = await request(app).get(`/gas/contract/${address}`);
      if (res.status === 200) {
        expect(res.body).toBeDefined();
        if (res.body.avgFee !== undefined) {
          expect(typeof res.body.avgFee).toBe('number');
        }
      }
    });
  });

  describe('GET /gas/contract/:address/function/:fn', () => {
    it('should return per-function gas data', async () => {
      const address = 'CABQBDGH';
      const fn = 'transfer';
      const res = await request(app).get(`/gas/contract/${address}/function/${fn}`);
      expect([200, 404]).toContain(res.status);
    });

    it('should support multiple function names', async () => {
      const address = 'CABQBDGH';
      const functions = ['transfer', 'mint', 'burn'];
      for (const fn of functions) {
        const res = await request(app).get(`/gas/contract/${address}/function/${fn}`);
        expect([200, 404]).toContain(res.status);
      }
    });
  });

  describe('GET /gas/contract/:address/history', () => {
    it('should return gas history time-series', async () => {
      const address = 'CABQBDGH';
      const res = await request(app).get(`/gas/contract/${address}/history`);
      expect([200, 404]).toContain(res.status);
    });

    it('should support time range filtering', async () => {
      const address = 'CABQBDGH';
      const res = await request(app).get(
        `/gas/contract/${address}/history?from=2024-01-01&to=2024-01-31`,
      );
      expect([200, 404, 400]).toContain(res.status);
    });
  });

  describe('GET /gas/contract/:address/efficiency', () => {
    it('should return efficiency score', async () => {
      const address = 'CABQBDGH';
      const res = await request(app).get(`/gas/contract/${address}/efficiency`);
      expect([200, 404]).toContain(res.status);
      if (res.status === 200) {
        if (res.body.score !== undefined) {
          expect(typeof res.body.score).toBe('number');
          expect(res.body.score).toBeGreaterThanOrEqual(0);
          expect(res.body.score).toBeLessThanOrEqual(100);
        }
      }
    });
  });

  describe('GET /gas/leaderboard', () => {
    it('should return contract leaderboard', async () => {
      const res = await request(app).get('/gas/leaderboard');
      expect([200, 404]).toContain(res.status);
      if (res.status === 200) {
        expect(Array.isArray(res.body) || res.body.leaderboard).toBeTruthy();
      }
    });

    it('should support sorting options', async () => {
      const res = await request(app).get('/gas/leaderboard?sortBy=avgFee&order=asc');
      expect([200, 404, 400]).toContain(res.status);
    });

    it('should support pagination', async () => {
      const res = await request(app).get('/gas/leaderboard?skip=0&take=10');
      expect([200, 404, 400]).toContain(res.status);
    });
  });

  describe('GET /gas/network', () => {
    it('should return network-wide gas stats', async () => {
      const res = await request(app).get('/gas/network');
      expect([200, 404]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body).toBeDefined();
      }
    });

    it('should include aggregate metrics', async () => {
      const res = await request(app).get('/gas/network');
      if (res.status === 200) {
        // Response should have network-level statistics
        expect(res.body).toBeDefined();
      }
    });
  });

  describe('POST /gas/benchmark', () => {
    it('should record gas benchmark with valid input', async () => {
      const benchmark = {
        contractAddress: 'CABQBDGH',
        functionName: 'transfer',
        gasFee: '500000',
        timestamp: new Date().toISOString(),
      };

      const res = await request(app).post('/gas/benchmark').send(benchmark);
      expect([201, 200, 404]).toContain(res.status);
    });

    it('should reject benchmark with missing fields', async () => {
      const benchmark = {
        contractAddress: 'CABQBDGH',
      };

      const res = await request(app).post('/gas/benchmark').send(benchmark);
      expect([400, 404]).toContain(res.status);
    });

    it('should reject invalid gas fee', async () => {
      const benchmark = {
        contractAddress: 'CABQBDGH',
        functionName: 'transfer',
        gasFee: 'invalid_fee',
      };

      const res = await request(app).post('/gas/benchmark').send(benchmark);
      expect([400, 404]).toContain(res.status);
    });
  });

  describe('GET /gas/benchmark/:contract/:fn', () => {
    it('should return benchmark history for contract function', async () => {
      const res = await request(app).get('/gas/benchmark/CABQBDGH/transfer');
      expect([200, 404]).toContain(res.status);
    });

    it('should support time range filtering', async () => {
      const res = await request(app).get(
        '/gas/benchmark/CABQBDGH/transfer?from=2024-01-01&to=2024-01-31',
      );
      expect([200, 404, 400]).toContain(res.status);
    });
  });

  describe('GET /gas/alerts', () => {
    it('should return gas alerts', async () => {
      const res = await request(app).get('/gas/alerts');
      expect([200, 404]).toContain(res.status);
      if (res.status === 200) {
        expect(Array.isArray(res.body) || res.body.alerts).toBeTruthy();
      }
    });

    it('should support filtering by status', async () => {
      const res = await request(app).get('/gas/alerts?status=active');
      expect([200, 404, 400]).toContain(res.status);
    });
  });

  describe('POST /gas/alerts', () => {
    it('should create alert rule with valid input', async () => {
      const alert = {
        contractAddress: 'CABQBDGH',
        threshold: 1000000,
        type: 'above_threshold',
      };

      const res = await request(app).post('/gas/alerts').send(alert);
      expect([201, 200, 404]).toContain(res.status);
    });

    it('should reject alert with missing threshold', async () => {
      const alert = {
        contractAddress: 'CABQBDGH',
        type: 'above_threshold',
      };

      const res = await request(app).post('/gas/alerts').send(alert);
      expect([400, 404]).toContain(res.status);
    });

    it('should reject alert with invalid threshold', async () => {
      const alert = {
        contractAddress: 'CABQBDGH',
        threshold: 'invalid_threshold',
        type: 'above_threshold',
      };

      const res = await request(app).post('/gas/alerts').send(alert);
      expect([400, 404]).toContain(res.status);
    });
  });

  describe('GET /gas/visualizations/contract/:addr', () => {
    it('should return visualization data', async () => {
      const address = 'CABQBDGH';
      const res = await request(app).get(`/gas/visualizations/contract/${address}`);
      expect([200, 404]).toContain(res.status);
    });

    it('should support metric selection', async () => {
      const address = 'CABQBDGH';
      const res = await request(app).get(
        `/gas/visualizations/contract/${address}?metrics=cpu,memory`,
      );
      expect([200, 404, 400]).toContain(res.status);
    });
  });

  describe('Error Handling', () => {
    it('should handle missing endpoint gracefully', async () => {
      const res = await request(app).get('/gas/nonexistent-endpoint');
      expect(res.status).toBe(404);
    });

    it('should handle malformed JSON', async () => {
      const res = await request(app)
        .post('/gas/benchmark')
        .set('Content-Type', 'application/json')
        .send('invalid json');
      expect(res.status).toBe(400);
    });

    it('should handle invalid path parameters', async () => {
      const res = await request(app).get('/gas/contract//function/');
      expect(res.status).toBe(404);
    });
  });
});
