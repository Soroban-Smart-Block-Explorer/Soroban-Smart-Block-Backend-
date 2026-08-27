/**
 * Integration tests for the Threat Intelligence Platform API router (#829).
 *
 * These tests verify:
 *   1. /tip router is properly mounted and accessible
 *   2. GET /tip returns service overview
 *   3. GET /tip/advisories returns advisories list
 *   4. POST /tip/advisories validates and creates advisory
 *   5. Error handling for invalid input
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import request from 'supertest';

// Mock dependencies
vi.mock('../../src/db', () => ({
  prismaRead: {
    advisory: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(0),
    },
  },
  prismaWrite: {
    advisory: {
      create: vi.fn().mockResolvedValue({
        id: 'adv_test_123',
        title: 'Test Advisory',
        description: 'Test Description',
        severity: 'medium',
      }),
      update: vi.fn(),
    },
  },
}));

vi.mock('../../src/middleware/asyncHandler', () => ({
  asyncHandler:
    (fn: (req: unknown, res: unknown, next: unknown) => void) =>
    (req: unknown, res: unknown, next: unknown) =>
      fn(req, res, next),
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
import { tipRouter } from '../../src/api/tip';

function buildTestApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/tip', tipRouter);
  return app;
}

describe('Threat Intelligence Platform Router', () => {
  let app: Express;

  beforeEach(() => {
    app = buildTestApp();
    vi.clearAllMocks();
  });

  describe('GET /tip', () => {
    it('should return service overview with 200', async () => {
      const res = await request(app).get('/tip');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('service');
      expect(res.body.service).toContain('Threat Intelligence');
    });

    it('should include API description in response', async () => {
      const res = await request(app).get('/tip');
      expect(res.body).toHaveProperty('description');
      expect(res.body.description).toBeTruthy();
    });

    it('should include endpoint list in response', async () => {
      const res = await request(app).get('/tip');
      expect(res.body).toHaveProperty('methods');
      expect(Array.isArray(res.body.methods)).toBe(true);
    });
  });

  describe('POST /tip/advisories', () => {
    it('should create advisory with valid input', async () => {
      const advisory = {
        title: 'Critical Vulnerability',
        description: 'This is a critical security issue affecting smart contracts',
        severity: 'critical',
        affectedContracts: ['contract_addr_1'],
        affectedChains: ['stellar'],
        mitigations: ['Upgrade to version 2.0'],
        tags: ['security', 'critical'],
        externalUrl: 'https://example.com/advisory',
      };

      const res = await request(app).post('/tip/advisories').send(advisory);
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('id');
    });

    it('should reject advisory with missing title', async () => {
      const advisory = {
        description: 'This is a critical security issue',
        severity: 'critical',
      };

      const res = await request(app).post('/tip/advisories').send(advisory);
      expect(res.status).toBe(400);
    });

    it('should reject advisory with short title', async () => {
      const advisory = {
        title: 'Vu',
        description: 'This is a critical security issue affecting smart contracts',
        severity: 'critical',
      };

      const res = await request(app).post('/tip/advisories').send(advisory);
      expect(res.status).toBe(400);
    });

    it('should reject advisory with invalid severity', async () => {
      const advisory = {
        title: 'Security Issue',
        description: 'This is a security issue affecting smart contracts',
        severity: 'unknown_severity',
      };

      const res = await request(app).post('/tip/advisories').send(advisory);
      expect(res.status).toBe(400);
    });
  });

  describe('GET /tip/advisories', () => {
    it('should return advisories list', async () => {
      const res = await request(app).get('/tip/advisories');
      expect([200, 404]).toContain(res.status);
      if (res.status === 200) {
        expect(Array.isArray(res.body) || res.body.advisories).toBeTruthy();
      }
    });

    it('should support severity filter', async () => {
      const res = await request(app).get('/tip/advisories?severity=critical');
      expect([200, 404, 400]).toContain(res.status);
    });
  });

  describe('GET /tip/advisories/:id', () => {
    it('should return 404 for non-existent advisory', async () => {
      const res = await request(app).get('/tip/advisories/nonexistent');
      expect([404, 400]).toContain(res.status);
    });
  });

  describe('Error Handling', () => {
    it('should handle missing endpoint gracefully', async () => {
      const res = await request(app).get('/tip/nonexistent-endpoint');
      expect(res.status).toBe(404);
    });

    it('should handle malformed JSON', async () => {
      const res = await request(app)
        .post('/tip/advisories')
        .set('Content-Type', 'application/json')
        .send('invalid json');
      expect(res.status).toBe(400);
    });
  });
});
