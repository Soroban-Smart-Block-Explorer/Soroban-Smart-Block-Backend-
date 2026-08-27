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

vi.mock('../../src/agents', () => ({
  agentEngine: {},
  marketplace: {},
  communicationBus: {},
  discoveryRegistry: {},
  agentReputation: {},
  agentMonitor: {},
  verificationNetwork: {},
}));

describe('Agents Router Mounting (#840)', () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use('/api/v1', router);
  });

  describe('Agents Router', () => {
    it('mounts at /agents with API key auth', async () => {
      const res = await request(app).get('/api/v1/agents');
      expect(res.status).not.toBe(404);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('service', 'Agents API');
    });

    it('GET /agents returns service info', async () => {
      const res = await request(app).get('/api/v1/agents');
      expect(res.body).toHaveProperty('description');
      expect(res.body).toHaveProperty('endpoints');
    });

    it('GET /agents/status returns status info', async () => {
      const res = await request(app).get('/api/v1/agents/status');
      expect(res.status).not.toBe(404);
    });
  });
});
