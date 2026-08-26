import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  requireRole: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
  list: vi.fn(),
  updateFlag: vi.fn(),
  setOverride: vi.fn(),
  clearOverride: vi.fn(),
}));

vi.mock('../../src/auth/middleware', () => ({
  requireAuth: mocks.requireAuth,
  requireRole: mocks.requireRole,
}));

vi.mock('../../src/feature-flags', () => ({
  featureFlags: {
    list: mocks.list,
    updateFlag: mocks.updateFlag,
    setOverride: mocks.setOverride,
    clearOverride: mocks.clearOverride,
  },
}));

import { featureFlagsAdminRouter } from '../../src/api/feature-flags';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin/feature-flags', featureFlagsAdminRouter);
  return app;
}

function allowAdmin() {
  mocks.requireAuth.mockImplementation((_req: unknown, _res: unknown, next: () => void) => next());
  mocks.requireRole.mockImplementation(
    () => (_req: unknown, _res: unknown, next: () => void) => next(),
  );
}

function resolvedFlag(overrides: Record<string, unknown> = {}) {
  return {
    key: 'poolMonitor',
    description: 'Pool price monitor',
    defaultEnabled: false,
    rolloutPercent: 0,
    requiredTables: ['_dex_pools'],
    enabled: false,
    available: true,
    reason: 'default',
    overrides: { environment: {}, developer: {} },
    ...overrides,
  };
}

describe('feature flags admin API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    allowAdmin();
    mocks.list.mockResolvedValue([resolvedFlag()]);
    mocks.updateFlag.mockResolvedValue(resolvedFlag({ defaultEnabled: true, reason: 'default' }));
    mocks.setOverride.mockResolvedValue(
      resolvedFlag({
        enabled: true,
        reason: 'developer_override',
        overrides: { environment: {}, developer: { 'dev-1': true } },
      }),
    );
    mocks.clearOverride.mockResolvedValue(undefined);
  });

  it('blocks non-admin callers', async () => {
    // The router captures requireRole('admin') at import time, so re-import it
    // after swapping the mock to a 403 enforcer.
    mocks.requireRole.mockImplementation(
      () => (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => unknown } }) =>
        res.status(403).json({ error: 'Forbidden' }),
    );
    vi.resetModules();
    const { featureFlagsAdminRouter: blockedRouter } = await import('../../src/api/feature-flags');
    const app = express();
    app.use(express.json());
    app.use('/api/v1/admin/feature-flags', blockedRouter);

    const res = await request(app).get('/api/v1/admin/feature-flags');
    expect(res.status).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('lists all flags with resolved state', async () => {
    const res = await request(buildApp()).get('/api/v1/admin/feature-flags');
    expect(res.status).toBe(200);
    expect(res.body.flags).toHaveLength(1);
    expect(res.body.flags[0].key).toBe('poolMonitor');
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it('updates a flag default and rollout percent', async () => {
    const res = await request(buildApp())
      .put('/api/v1/admin/feature-flags/poolMonitor')
      .send({ defaultEnabled: true, rolloutPercent: 10 });
    expect(res.status).toBe(200);
    expect(mocks.updateFlag).toHaveBeenCalledWith('poolMonitor', {
      defaultEnabled: true,
      rolloutPercent: 10,
    });
    expect(res.body.flag.defaultEnabled).toBe(true);
  });

  it('rejects unknown flag keys on update', async () => {
    const res = await request(buildApp())
      .put('/api/v1/admin/feature-flags/nope')
      .send({ defaultEnabled: true });
    expect(res.status).toBe(404);
    expect(mocks.updateFlag).not.toHaveBeenCalled();
  });

  it('rejects an empty update body and out-of-range rollout', async () => {
    const empty = await request(buildApp()).put('/api/v1/admin/feature-flags/poolMonitor').send({});
    expect(empty.status).toBe(400);

    const badRollout = await request(buildApp())
      .put('/api/v1/admin/feature-flags/poolMonitor')
      .send({ rolloutPercent: 101 });
    expect(badRollout.status).toBe(400);
  });

  it('sets a per-developer override', async () => {
    const res = await request(buildApp())
      .put('/api/v1/admin/feature-flags/poolMonitor/overrides/developer/dev-1')
      .send({ enabled: true });
    expect(res.status).toBe(200);
    expect(mocks.setOverride).toHaveBeenCalledWith('poolMonitor', 'developer', 'dev-1', true);
    expect(res.body.flag.overrides.developer['dev-1']).toBe(true);
  });

  it('sets a per-environment override', async () => {
    const res = await request(buildApp())
      .put('/api/v1/admin/feature-flags/poolMonitor/overrides/environment/mainnet')
      .send({ enabled: false });
    expect(res.status).toBe(200);
    expect(mocks.setOverride).toHaveBeenCalledWith('poolMonitor', 'environment', 'mainnet', false);
  });

  it('rejects invalid scope types and non-boolean enabled', async () => {
    const badScope = await request(buildApp())
      .put('/api/v1/admin/feature-flags/poolMonitor/overrides/team/eng')
      .send({ enabled: true });
    expect(badScope.status).toBe(400);

    const badEnabled = await request(buildApp())
      .put('/api/v1/admin/feature-flags/poolMonitor/overrides/developer/dev-1')
      .send({ enabled: 'yes' });
    expect(badEnabled.status).toBe(400);
  });

  it('clears an override', async () => {
    const res = await request(buildApp()).delete(
      '/api/v1/admin/feature-flags/poolMonitor/overrides/developer/dev-1',
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mocks.clearOverride).toHaveBeenCalledWith('poolMonitor', 'developer', 'dev-1');
  });

  it('rate limits requests beyond the configured max', async () => {
    // The router reads rate-limit settings from config at import time, so
    // re-import it with a low RATE_LIMIT_MAX to exercise the 429 path.
    const prevMax = process.env.RATE_LIMIT_MAX;
    process.env.RATE_LIMIT_MAX = '2';
    vi.resetModules();
    const { featureFlagsAdminRouter: limitedRouter } = await import('../../src/api/feature-flags');
    const app = express();
    app.use(express.json());
    app.use('/api/v1/admin/feature-flags', limitedRouter);

    const first = await request(app).get('/api/v1/admin/feature-flags');
    expect(first.status).toBe(200);
    const second = await request(app).get('/api/v1/admin/feature-flags');
    expect(second.status).toBe(200);
    const third = await request(app).get('/api/v1/admin/feature-flags');
    expect(third.status).toBe(429);
    expect(third.body.error).toBe('Rate limit exceeded');

    if (prevMax === undefined) {
      delete process.env.RATE_LIMIT_MAX;
    } else {
      process.env.RATE_LIMIT_MAX = prevMax;
    }
  });
});
