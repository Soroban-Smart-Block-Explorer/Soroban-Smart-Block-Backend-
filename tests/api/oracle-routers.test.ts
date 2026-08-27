import { describe, it, expect, beforeAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { router } from '../../src/api/router';

vi.mock('../../src/db', () => ({
  prismaRead: { $connect: vi.fn() },
  prismaWrite: { $connect: vi.fn() },
}));

vi.mock('../../src/cache', () => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cacheDelete: vi.fn(),
}));

vi.mock('../../src/auth/middleware', () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  optionalAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireApiKey: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireKeyTier: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../../src/middleware/asyncHandler', () => ({
  asyncHandler: (fn: any) => fn,
}));

describe('Oracle Routers Mounting (#841)', () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use('/api/v1', router);
  });

  describe('Oracle Audit Router', () => {
    it('mounts at /oracles/audit', async () => {
      const res = await request(app).get('/api/v1/oracles/audit');
      expect(res.status).not.toBe(404);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('service', 'Oracle Audit API');
    });

    it('GET /oracles/audit returns service info', async () => {
      const res = await request(app).get('/api/v1/oracles/audit');
      expect(res.body).toHaveProperty('description');
      expect(res.body).toHaveProperty('endpoints');
    });

    it('GET /oracles/audit/requests is reachable', async () => {
      const res = await request(app).get('/api/v1/oracles/audit/requests');
      expect(res.status).not.toBe(404);
    });
  });

  describe('Oracle Feeds Router', () => {
    it('mounts at /oracles/feeds', async () => {
      const res = await request(app).get('/api/v1/oracles/feeds');
      expect(res.status).not.toBe(404);
    });

    it('GET /oracles/feeds returns service info or price data', async () => {
      const res = await request(app).get('/api/v1/oracles/feeds');
      // Either a 200 with service info or a 400/422 with validation error (no query params)
      expect(res.status).not.toBe(404);
    });
  });
});
