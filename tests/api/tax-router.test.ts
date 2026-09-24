/**
 * Integration tests for the Tax Reporting API router (#830).
 *
 * These tests verify:
 *   1. /tax router is properly mounted and accessible
 *   2. GET /tax returns service overview
 *   3. GET /tax/accounts/:address/summary returns tax summary
 *   4. GET /tax/accounts/:address/gains returns capital gains data
 *   5. POST /tax/accounts/:address/report generates reports
 *   6. Parameter validation and error handling
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import request from 'supertest';

// Mock dependencies
vi.mock('../../src/db', () => ({
  prismaRead: {
    taxReport: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
    },
  },
  prismaWrite: {
    taxReport: {
      create: vi.fn().mockResolvedValue({
        id: 'tax_report_123',
        address: 'GTEST...',
        year: 2024,
        status: 'generated',
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
import { taxRouter } from '../../src/api/tax';

function buildTestApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/tax', taxRouter);
  return app;
}

describe('Tax Reporting API Router', () => {
  let app: Express;

  beforeEach(() => {
    app = buildTestApp();
    vi.clearAllMocks();
  });

  describe('GET /tax', () => {
    it('should return service overview with 200', async () => {
      const res = await request(app).get('/tax');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('service');
      expect(res.body.service).toContain('Tax');
    });

    it('should include description and methods', async () => {
      const res = await request(app).get('/tax');
      expect(res.body).toHaveProperty('description');
      expect(res.body).toHaveProperty('methods');
      expect(Array.isArray(res.body.methods)).toBe(true);
    });

    it('should list all available endpoints', async () => {
      const res = await request(app).get('/tax');
      expect(res.body).toHaveProperty('endpoints');
      expect(Array.isArray(res.body.endpoints)).toBe(true);
      expect(res.body.endpoints.length).toBeGreaterThan(0);
    });
  });

  describe('GET /tax/accounts/:address/summary', () => {
    it('should return tax summary for valid address', async () => {
      const address = 'GBRPYHIL2CI3WHZDTOOQFC6EB4RRJC3XNSOLXAUJJG35SBATP5A3RED';
      const res = await request(app).get(`/tax/accounts/${address}/summary`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('address');
      expect(res.body).toHaveProperty('taxYear');
      expect(res.body).toHaveProperty('totalTaxableEvents');
    });

    it('should support year parameter', async () => {
      const address = 'GBRPYHIL2CI3WHZDTOOQFC6EB4RRJC3XNSOLXAUJJG35SBATP5A3RED';
      const res = await request(app).get(`/tax/accounts/${address}/summary?year=2023`);
      expect(res.status).toBe(200);
      expect(res.body.taxYear).toBe(2023);
    });

    it('should include gains and income data in summary', async () => {
      const address = 'GBRPYHIL2CI3WHZDTOOQFC6EB4RRJC3XNSOLXAUJJG35SBATP5A3RED';
      const res = await request(app).get(`/tax/accounts/${address}/summary`);
      expect(res.body).toHaveProperty('shortTermGainsUSD');
      expect(res.body).toHaveProperty('longTermGainsUSD');
      expect(res.body).toHaveProperty('totalIncomeUSD');
    });
  });

  describe('GET /tax/accounts/:address/gains', () => {
    it('should return capital gains for address', async () => {
      const address = 'GBRPYHIL2CI3WHZDTOOQFC6EB4RRJC3XNSOLXAUJJG35SBATP5A3RED';
      const res = await request(app).get(`/tax/accounts/${address}/gains`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('address');
      expect(res.body).toHaveProperty('method');
      expect(res.body).toHaveProperty('gains');
    });

    it('should support method parameter', async () => {
      const address = 'GBRPYHIL2CI3WHZDTOOQFC6EB4RRJC3XNSOLXAUJJG35SBATP5A3RED';
      const res = await request(app).get(`/tax/accounts/${address}/gains?method=LIFO`);
      expect(res.status).toBe(200);
      expect(res.body.method).toBe('LIFO');
    });

    it('should default to FIFO method', async () => {
      const address = 'GBRPYHIL2CI3WHZDTOOQFC6EB4RRJC3XNSOLXAUJJG35SBATP5A3RED';
      const res = await request(app).get(`/tax/accounts/${address}/gains`);
      expect(res.body.method).toBe('FIFO');
    });
  });

  describe('GET /tax/accounts/:address/income', () => {
    it('should return income events for address', async () => {
      const address = 'GBRPYHIL2CI3WHZDTOOQFC6EB4RRJC3XNSOLXAUJJG35SBATP5A3RED';
      const res = await request(app).get(`/tax/accounts/${address}/income`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('address');
      expect(res.body).toHaveProperty('incomeEvents');
      expect(res.body).toHaveProperty('byCategory');
    });

    it('should categorize income by type', async () => {
      const address = 'GBRPYHIL2CI3WHZDTOOQFC6EB4RRJC3XNSOLXAUJJG35SBATP5A3RED';
      const res = await request(app).get(`/tax/accounts/${address}/income`);
      expect(res.body.byCategory).toHaveProperty('staking');
      expect(res.body.byCategory).toHaveProperty('yield');
      expect(res.body.byCategory).toHaveProperty('airdrops');
    });
  });

  describe('POST /tax/accounts/:address/report', () => {
    it('should generate report with valid input', async () => {
      const address = 'GBRPYHIL2CI3WHZDTOOQFC6EB4RRJC3XNSOLXAUJJG35SBATP5A3RED';
      const reportRequest = {
        year: 2023,
        format: 'json',
        method: 'FIFO',
      };

      const res = await request(app).post(`/tax/accounts/${address}/report`).send(reportRequest);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('reportId');
      expect(res.body).toHaveProperty('status');
      expect(res.body.status).toBe('generated');
    });

    it('should reject invalid format', async () => {
      const address = 'GBRPYHIL2CI3WHZDTOOQFC6EB4RRJC3XNSOLXAUJJG35SBATP5A3RED';
      const reportRequest = {
        year: 2023,
        format: 'invalid_format',
        method: 'FIFO',
      };

      const res = await request(app).post(`/tax/accounts/${address}/report`).send(reportRequest);
      expect(res.status).toBe(400);
    });

    it('should reject invalid method', async () => {
      const address = 'GBRPYHIL2CI3WHZDTOOQFC6EB4RRJC3XNSOLXAUJJG35SBATP5A3RED';
      const reportRequest = {
        year: 2023,
        format: 'json',
        method: 'INVALID_METHOD',
      };

      const res = await request(app).post(`/tax/accounts/${address}/report`).send(reportRequest);
      expect(res.status).toBe(400);
    });

    it('should reject year outside valid range', async () => {
      const address = 'GBRPYHIL2CI3WHZDTOOQFC6EB4RRJC3XNSOLXAUJJG35SBATP5A3RED';
      const reportRequest = {
        year: 1999,
        format: 'json',
        method: 'FIFO',
      };

      const res = await request(app).post(`/tax/accounts/${address}/report`).send(reportRequest);
      expect(res.status).toBe(400);
    });

    it('should support multiple format types', async () => {
      const address = 'GBRPYHIL2CI3WHZDTOOQFC6EB4RRJC3XNSOLXAUJJG35SBATP5A3RED';

      for (const format of ['json', 'csv', 'pdf']) {
        const reportRequest = {
          year: 2024,
          format,
          method: 'FIFO',
        };

        const res = await request(app).post(`/tax/accounts/${address}/report`).send(reportRequest);
        expect(res.status).toBe(200);
        expect(res.body.format).toBe(format);
      }
    });
  });

  describe('GET /tax/accounts/:address/cost-basis', () => {
    it('should return cost basis for address', async () => {
      const address = 'GBRPYHIL2CI3WHZDTOOQFC6EB4RRJC3XNSOLXAUJJG35SBATP5A3RED';
      const res = await request(app).get(`/tax/accounts/${address}/cost-basis`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('address');
      expect(res.body).toHaveProperty('holdings');
      expect(res.body).toHaveProperty('totalCostBasisUSD');
    });
  });

  describe('GET /tax/rates', () => {
    it('should return tax rates', async () => {
      const res = await request(app).get('/tax/rates');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('rates');
      expect(res.body.rates).toHaveProperty('US');
    });
  });

  describe('Error Handling', () => {
    it('should handle missing endpoint gracefully', async () => {
      const res = await request(app).get('/tax/nonexistent-endpoint');
      expect(res.status).toBe(404);
    });

    it('should handle malformed JSON', async () => {
      const address = 'GBRPYHIL2CI3WHZDTOOQFC6EB4RRJC3XNSOLXAUJJG35SBATP5A3RED';
      const res = await request(app)
        .post(`/tax/accounts/${address}/report`)
        .set('Content-Type', 'application/json')
        .send('invalid json');
      expect(res.status).toBe(400);
    });
  });
});
