/**
 * tests/readyz.test.ts
 *
 * Verifies the /readyz endpoint tracks real dependency state and returns
 * 503 with per-dependency details when any dependency is not yet ready.
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { DependencyName } from '../src/readiness';

// Each test gets a fresh module instance so state never leaks between tests.
async function freshReadiness() {
  vi.resetModules();
  return import('../src/readiness');
}

type ReadinessMod = Awaited<ReturnType<typeof freshReadiness>>;

function buildReadyzApp(mod: ReadinessMod, shutting = false) {
  const { getReadinessState, isFullyReady } = mod;
  const app = express();
  app.get('/readyz', (_req, res) => {
    if (shutting) {
      return res.status(503).json({ status: 'not_ready', reason: 'shutting_down' });
    }
    const dependencies = getReadinessState();
    if (!isFullyReady()) {
      return res.status(503).json({ status: 'not_ready', dependencies });
    }
    res.json({ status: 'ready', dependencies });
  });
  return app;
}

// ── Initial state ─────────────────────────────────────────────────────────────

describe('/readyz — initial state', () => {
  it('returns 503 when no dependencies have been marked ready', async () => {
    const mod = await freshReadiness();
    const res = await request(buildReadyzApp(mod)).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not_ready');
  });

  it('includes per-dependency breakdown in the 503 body', async () => {
    const mod = await freshReadiness();
    const res = await request(buildReadyzApp(mod)).get('/readyz');
    const { dependencies } = res.body as { dependencies: Record<DependencyName, boolean> };
    expect(dependencies).toBeDefined();
    expect(dependencies.db).toBe(false);
    expect(dependencies.cache).toBe(false);
    expect(dependencies.indexer).toBe(false);
    expect(dependencies.coldStorage).toBe(false);
  });
});

// ── Partial readiness ─────────────────────────────────────────────────────────

describe('/readyz — partial readiness', () => {
  it('returns 503 when only some dependencies are ready', async () => {
    const mod = await freshReadiness();
    mod.markReady('db');
    mod.markReady('cache');
    // indexer and coldStorage still false
    const res = await request(buildReadyzApp(mod)).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body.dependencies.db).toBe(true);
    expect(res.body.dependencies.cache).toBe(true);
    expect(res.body.dependencies.indexer).toBe(false);
    expect(res.body.dependencies.coldStorage).toBe(false);
  });
});

// ── Full readiness ────────────────────────────────────────────────────────────

describe('/readyz — fully ready', () => {
  it('returns 200 once all dependencies are marked ready', async () => {
    const mod = await freshReadiness();
    mod.markReady('db');
    mod.markReady('cache');
    mod.markReady('indexer');
    mod.markReady('coldStorage');
    const res = await request(buildReadyzApp(mod)).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
  });

  it('includes all dependencies as true in the 200 body', async () => {
    const mod = await freshReadiness();
    mod.markReady('db');
    mod.markReady('cache');
    mod.markReady('indexer');
    mod.markReady('coldStorage');
    const res = await request(buildReadyzApp(mod)).get('/readyz');
    const { dependencies } = res.body as { dependencies: Record<DependencyName, boolean> };
    expect(dependencies.db).toBe(true);
    expect(dependencies.cache).toBe(true);
    expect(dependencies.indexer).toBe(true);
    expect(dependencies.coldStorage).toBe(true);
  });
});

// ── Shutdown override ─────────────────────────────────────────────────────────

describe('/readyz — shutdown', () => {
  it('returns 503 with shutting_down reason even when all deps are ready', async () => {
    const mod = await freshReadiness();
    mod.markReady('db');
    mod.markReady('cache');
    mod.markReady('indexer');
    mod.markReady('coldStorage');
    const res = await request(buildReadyzApp(mod, /* shutting= */ true)).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body.reason).toBe('shutting_down');
  });
});

// ── Readiness transitions ─────────────────────────────────────────────────────

describe('/readyz — readiness transitions', () => {
  it('transitions from not_ready to ready as deps come up', async () => {
    const mod = await freshReadiness();
    const app = buildReadyzApp(mod);

    let res = await request(app).get('/readyz');
    expect(res.status).toBe(503);

    mod.markReady('db');
    mod.markReady('cache');
    mod.markReady('indexer');
    mod.markReady('coldStorage');

    res = await request(app).get('/readyz');
    expect(res.status).toBe(200);
  });

  it('transitions back to not_ready when the indexer fails post-startup', async () => {
    const mod = await freshReadiness();
    mod.markReady('db');
    mod.markReady('cache');
    mod.markReady('indexer');
    mod.markReady('coldStorage');

    const app = buildReadyzApp(mod);

    let res = await request(app).get('/readyz');
    expect(res.status).toBe(200);

    mod.markNotReady('indexer');

    res = await request(app).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body.dependencies.indexer).toBe(false);
    // Other deps remain up
    expect(res.body.dependencies.db).toBe(true);
    expect(res.body.dependencies.cache).toBe(true);
    expect(res.body.dependencies.coldStorage).toBe(true);
  });

  it('recovers to ready after a dep is restored', async () => {
    const mod = await freshReadiness();
    mod.markReady('db');
    mod.markReady('cache');
    mod.markReady('indexer');
    mod.markReady('coldStorage');

    const app = buildReadyzApp(mod);

    mod.markNotReady('cache');
    let res = await request(app).get('/readyz');
    expect(res.status).toBe(503);

    mod.markReady('cache');
    res = await request(app).get('/readyz');
    expect(res.status).toBe(200);
  });
});
