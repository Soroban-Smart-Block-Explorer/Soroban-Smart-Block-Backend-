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

describe('Storage Routers Mounting (#838)', () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use('/api/v1', router);
  });

  describe('Storage Router', () => {
    it('mounts at /storage', async () => {
      const res = await request(app).get('/api/v1/storage');
      expect(res.status).not.toBe(404);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('service', 'Storage API');
    });

    it('GET /storage returns service info', async () => {
      const res = await request(app).get('/api/v1/storage');
      expect(res.body).toHaveProperty('description');
      expect(res.body).toHaveProperty('entryTypes');
      expect(res.body).toHaveProperty('endpoints');
    });
  });

  describe('Storage Trap Router', () => {
    it('mounts at /storage-trap', async () => {
      const res = await request(app).get('/api/v1/storage-trap');
      expect(res.status).not.toBe(404);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('service', 'Storage Trap API');
    });

    it('GET /storage-trap returns service info', async () => {
      const res = await request(app).get('/api/v1/storage-trap');
      expect(res.body).toHaveProperty('description');
      expect(res.body).toHaveProperty('detectionRules');
      expect(res.body).toHaveProperty('endpoints');
    });
  });
});
