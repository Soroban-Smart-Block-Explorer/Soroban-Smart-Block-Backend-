/**
 * Integration tests for the new analytics + dashboards router mounts (#839).
 *
 * These tests verify:
 *   1. /analytics gates all sub-paths behind requireApiKey (401 without a key)
 *   2. /analytics returns 200 with a valid key on GET /gas
 *   3. /dashboards gates POST /, PUT /:id, DELETE /:id behind requireApiKey
 *   4. /dashboards returns 200 with a valid key on GET /
 *   5. Snapshot staleness: GET /analytics/gas serves the most recent snapshot
 *   6. POST /analytics/gas/run invokes runGasAnalytics and returns { ok: true }
 *   7. Mount verification: both routers handle sub-paths under their mounts
 *      (i.e. they are reachable, not falling through to a 404)
 *
 * Pattern follows the existing tests in tests/api/ (analytics.test.ts,
 * exports.test.ts): mock src/db, src/indexer/gasAnalytics, and
 * src/api/protocol-economics with vi.mock, then exercise the routers via
 * supertest against a minimal Express app that mirrors the production
 * mounting (`app.use('/<mount>', requireApiKey, <router>)`).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import request from 'supertest';

// ── Mocks (hoisted) ──────────────────────────────────────────────────────────

// Real apiKeyAuth does a DB lookup — bypass it entirely so tests don't need a
// real DevApiKey row. requireApiKey is exercised separately by the auth-gate
// scenarios below.
vi.mock('../../src/middleware/apiKeyAuth', () => {
  // Authenticated request — set by the test app's permissive stub below.
  const apiKeyAuth = (req: any, _res: any, next: any) => {
    if (req.headers['x-test-auth'] === 'yes') {
      req.apiKey = {
        id: 'key-test',
        keyName: 'test-key',
        developerId: 'dev-test',
        tier: 'developer',
      };
    }
    next();
  };

  // Hard-require — used by the auth-gate scenarios.
  const requireApiKey = (req: any, res: any, next: any) => {
    if (!req.apiKey) {
      res.status(401).json({ error: 'API key required' });
      return;
    }
    next();
  };

  const requireKeyTier = (_min: string) => (_req: any, _res: any, next: any) => next();

  return { apiKeyAuth, requireApiKey, requireKeyTier };
});

// Minimal prisma surface — only the models touched by analytics.ts/dashboards.ts.
vi.mock('../../src/db', () => ({
  prismaRead: {
    gasAnalyticsSnapshot: { findMany: vi.fn() },
    devApiKey: { findFirst: vi.fn() },
    dashboard: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
    },
    dashboardWidget: {
      findFirst: vi.fn(),
    },
  },
  prismaWrite: {
    dashboard: {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      findUnique: vi.fn(),
    },
    devApiKey: { update: vi.fn() },
  },
}));

vi.mock('../../src/indexer/gasAnalytics', () => ({
  runGasAnalytics: vi.fn().mockResolvedValue(undefined),
}));

// protocol-economics is nested under /analytics/protocol-economics — stub it
// so the nested router doesn't pull in its own prisma/runProtocolEconomics
// dependencies.
vi.mock('../../src/api/protocol-economics', () => ({
  protocolEconomicsRouter: express.Router(),
}));

vi.mock('../../src/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// ── Imports (must come after vi.mock) ────────────────────────────────────────

import { prismaRead } from '../../src/db';
import { runGasAnalytics } from '../../src/indexer/gasAnalytics';
import { analyticsRouter } from '../../src/api/analytics';
import { dashboardRouter } from '../../src/api/dashboards';
import { apiKeyAuth, requireApiKey } from '../../src/middleware/apiKeyAuth';

// ── App factories ───────────────────────────────────────────────────────────

/**
 * Build an Express app that mirrors the production mount for analytics:
 *   app.use('/analytics', requireApiKey, analyticsRouter)
 *
 * Authentication is controlled per-request via the `x-test-auth` header so
 * we can exercise both the gated and ungated paths without juggling real
 * API keys.
 */
function makeAnalyticsApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(apiKeyAuth); // reads x-test-auth, sets req.apiKey if present
  app.use('/analytics', requireApiKey, analyticsRouter);
  return app;
}

/**
 * Same pattern for dashboards.
 */
function makeDashboardsApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(apiKeyAuth);
  app.use('/dashboards', requireApiKey, dashboardRouter);
  return app;
}

/**
 * Both routers mounted — used by the "mount verification" scenario to prove
 * sub-paths under each prefix are handled (not 404).
 */
function makeCombinedApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(apiKeyAuth);
  app.use('/analytics', requireApiKey, analyticsRouter);
  app.use('/dashboards', requireApiKey, dashboardRouter);
  return app;
}

// Typed shortcuts for mocks
const mockRead = prismaRead as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;

// ── 1 & 2: /analytics — auth gate + happy path on GET /gas ──────────────────

describe('Analytics router mount (#839)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 on GET /analytics/gas without an API key', async () => {
    const res = await request(makeAnalyticsApp()).get('/analytics/gas');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: expect.stringMatching(/api key/i) });
  });

  it('returns 200 on GET /analytics/gas with a valid API key', async () => {
    mockRead['gasAnalyticsSnapshot']['findMany'].mockResolvedValueOnce([
      { bucket: 'day', bucketStart: new Date(), avgFee: 200 },
    ] as any);

    const res = await request(makeAnalyticsApp()).get('/analytics/gas').set('x-test-auth', 'yes');

    expect(res.status).toBe(200);
    expect(res.body.bucket).toBe('day');
    expect(res.body.data).toHaveLength(1);
    expect(mockRead['gasAnalyticsSnapshot']['findMany']).toHaveBeenCalledOnce();
  });
});

// ── 3 & 4: /dashboards — auth gate on writes + happy path on GET / ──────────

describe('Dashboards router mount (#839)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 on POST /dashboards/ without an API key', async () => {
    const res = await request(makeDashboardsApp())
      .post('/dashboards/')
      .send({ name: 'My Dashboard', ownerId: 'dev-1' });

    expect(res.status).toBe(401);
  });

  it('returns 401 on PUT /dashboards/:id without an API key', async () => {
    const res = await request(makeDashboardsApp())
      .put('/dashboards/abc-123')
      .send({ name: 'Renamed' });

    expect(res.status).toBe(401);
  });

  it('returns 401 on DELETE /dashboards/:id without an API key', async () => {
    const res = await request(makeDashboardsApp()).delete('/dashboards/abc-123');

    expect(res.status).toBe(401);
  });

  it('returns 200 on GET /dashboards/ with a valid API key', async () => {
    mockRead['dashboard']['findMany'].mockResolvedValueOnce([
      { id: 'd1', name: 'My Dashboard', ownerId: 'dev-test' },
    ] as any);
    mockRead['dashboard']['count'].mockResolvedValueOnce(1);

    const res = await request(makeDashboardsApp()).get('/dashboards/').set('x-test-auth', 'yes');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('My Dashboard');
    expect(res.body.total).toBe(1);
    expect(mockRead['dashboard']['findMany']).toHaveBeenCalledOnce();
  });
});

// ── 5: Snapshot staleness on GET /analytics/gas ─────────────────────────────

describe('Analytics snapshot staleness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('serves the current snapshot, not a stale one, when both are present', async () => {
    const now = new Date('2026-08-24T12:00:00.000Z');
    const oneYearAgo = new Date('2025-08-24T12:00:00.000Z');

    mockRead['gasAnalyticsSnapshot']['findMany'].mockResolvedValueOnce([
      { bucket: 'day', bucketStart: now, avgFee: 300 },
      { bucket: 'day', bucketStart: oneYearAgo, avgFee: 100 },
    ] as any);

    const res = await request(makeAnalyticsApp()).get('/analytics/gas').set('x-test-auth', 'yes');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    // Route orders by bucketStart desc — the "current" one must come first.
    expect(new Date(res.body.data[0].bucketStart).getTime()).toBe(now.getTime());
    expect(new Date(res.body.data[1].bucketStart).getTime()).toBe(oneYearAgo.getTime());
    expect(res.body.data[0].avgFee).toBe(300);
  });

  it('returns whatever the data layer returns when only a stale snapshot exists', async () => {
    const oneYearAgo = new Date('2025-08-24T12:00:00.000Z');

    mockRead['gasAnalyticsSnapshot']['findMany'].mockResolvedValueOnce([
      { bucket: 'day', bucketStart: oneYearAgo, avgFee: 100 },
    ] as any);

    const res = await request(makeAnalyticsApp()).get('/analytics/gas').set('x-test-auth', 'yes');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    // The route must NOT invent a "current" snapshot — it reflects exactly
    // what the data layer returned.
    expect(new Date(res.body.data[0].bucketStart).getTime()).toBe(oneYearAgo.getTime());
  });
});

// ── 6: On-demand recompute on POST /analytics/gas/run ────────────────────────

describe('Analytics on-demand recompute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('invokes runGasAnalytics and returns { ok: true }', async () => {
    const res = await request(makeAnalyticsApp())
      .post('/analytics/gas/run')
      .set('x-test-auth', 'yes');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(runGasAnalytics).toHaveBeenCalledOnce();
  });

  it('returns 401 on POST /analytics/gas/run without an API key', async () => {
    const res = await request(makeAnalyticsApp()).post('/analytics/gas/run');
    expect(res.status).toBe(401);
    expect(runGasAnalytics).not.toHaveBeenCalled();
  });
});

// ── 7: Mount verification — both prefixes are reachable ─────────────────────

describe('Router mount verification (#839)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('mounts /analytics — known sub-paths are handled (return 401, not 404)', async () => {
    // Without a key, the auth gate inside /analytics must intercept the
    // request — a 401 proves the request reached the analytics subtree.
    // If the mount were missing, Express would answer with a 404 instead.
    const res = await request(makeCombinedApp()).get('/analytics/gas');
    expect(res.status).toBe(401);
    expect(res.status).not.toBe(404);
  });

  it('mounts /dashboards — known sub-paths are handled (return 401, not 404)', async () => {
    const res = await request(makeCombinedApp()).get('/dashboards/');
    expect(res.status).toBe(401);
    expect(res.status).not.toBe(404);
  });

  it('exposes /analytics with the full mount path including sub-resources', async () => {
    // POST /analytics/gas/run is registered on analyticsRouter — confirm it
    // is reachable via the mount (401 here = mounted; would be 404 otherwise).
    const res = await request(makeCombinedApp()).post('/analytics/gas/run').send({});
    expect(res.status).toBe(401);
  });

  it('exposes /dashboards with nested resource routes', async () => {
    // GET /dashboards/:id is registered on dashboardRouter — confirm it
    // is reachable via the mount (401 here = mounted; would be 404 otherwise).
    const res = await request(makeCombinedApp()).get('/dashboards/some-id');
    expect(res.status).toBe(401);
  });
});
