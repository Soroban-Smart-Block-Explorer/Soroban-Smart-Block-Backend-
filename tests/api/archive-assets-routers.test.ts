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

vi.mock('../../src/archive/query-engine', () => ({
  getStateAtLedger: vi.fn(),
  getKeyHistory: vi.fn(),
  getLedgerDiff: vi.fn(),
  getFullSnapshot: vi.fn(),
}));

vi.mock('../../src/archive/archiver', () => ({
  captureStateChangesForTransaction: vi.fn(),
}));

vi.mock('../../src/archive/scval-decoder', () => ({
  decodeScValXdr: vi.fn(),
}));

vi.mock('../../src/indexer/assetTracker', () => ({
  computeAssetMetrics: vi.fn(),
}));

describe('Archive & Assets Routers Mounting (#842)', () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use('/api/v1', router);
  });

  describe('Archive Router', () => {
    it('mounts at /archive', async () => {
      const res = await request(app).get('/api/v1/archive');
      // Archive router requires path params, so we expect 400 or 404 from param parsing
      expect(res.status).not.toBe(404);
    });
  });

  describe('Assets Router', () => {
    it('mounts at /assets', async () => {
      const res = await request(app).get('/api/v1/assets');
      expect(res.status).not.toBe(404);
    });

    it('GET /assets/metrics is reachable', async () => {
      const res = await request(app).get('/api/v1/assets/metrics');
      expect(res.status).not.toBe(404);
    });
  });
});
