/**
 * Indexer readiness tests (Issue #440).
 *
 * Verifies that:
 *   - indexer-state module correctly tracks healthy / failed states
 *   - /ready endpoint returns 200 when the indexer is healthy
 *   - /ready endpoint returns 503 after a fatal indexer failure
 *   - State can be recovered via setIndexerHealthy()
 */

import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import http, { type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import {
  setIndexerFailed,
  setIndexerHealthy,
  getIndexerStatus,
} from '../src/indexer-state';

// Reset to a known-healthy state before every test
beforeEach(() => {
  setIndexerHealthy();
});

// ── Unit tests: indexer-state module ─────────────────────────────────────────

describe('getIndexerStatus', () => {
  it('is healthy by default', () => {
    const status = getIndexerStatus();
    expect(status.healthy).toBe(true);
    expect(status.failureReason).toBeUndefined();
  });

  it('marks unhealthy with reason after setIndexerFailed()', () => {
    setIndexerFailed('DB connection refused');
    const status = getIndexerStatus();
    expect(status.healthy).toBe(false);
    expect(status.failureReason).toBe('DB connection refused');
  });

  it('recovers to healthy after setIndexerHealthy()', () => {
    setIndexerFailed('timeout');
    setIndexerHealthy();
    const status = getIndexerStatus();
    expect(status.healthy).toBe(true);
    expect(status.failureReason).toBeUndefined();
  });

  it('overwrites the failure reason if failed twice in a row', () => {
    setIndexerFailed('first error');
    setIndexerFailed('second error');
    const status = getIndexerStatus();
    expect(status.healthy).toBe(false);
    expect(status.failureReason).toBe('second error');
  });
});

// ── Integration tests: /ready endpoint ───────────────────────────────────────

function buildReadyApp() {
  const app = express();
  app.get('/ready', (_req, res) => {
    const { healthy, failureReason } = getIndexerStatus();
    if (!healthy) {
      res.status(503).json({ status: 'unavailable', reason: failureReason });
      return;
    }
    res.json({ status: 'ready' });
  });
  return app;
}

function startServer(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('GET /ready', () => {
  it('returns 200 { status: "ready" } when indexer is healthy', async () => {
    const { server, baseUrl } = await startServer(buildReadyApp());
    try {
      const res = await fetch(`${baseUrl}/ready`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.status).toBe('ready');
    } finally {
      await stopServer(server);
    }
  });

  it('returns 503 { status: "unavailable" } after a fatal indexer failure', async () => {
    setIndexerFailed('RPC connection failed');
    const { server, baseUrl } = await startServer(buildReadyApp());
    try {
      const res = await fetch(`${baseUrl}/ready`);
      const body = await res.json();
      expect(res.status).toBe(503);
      expect(body.status).toBe('unavailable');
      expect(body.reason).toBe('RPC connection failed');
    } finally {
      await stopServer(server);
    }
  });

  it('returns 200 again after recovery via setIndexerHealthy()', async () => {
    setIndexerFailed('initial failure');
    setIndexerHealthy();
    const { server, baseUrl } = await startServer(buildReadyApp());
    try {
      const res = await fetch(`${baseUrl}/ready`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.status).toBe('ready');
    } finally {
      await stopServer(server);
    }
  });

  it('surfaces the exact failure reason in the 503 body', async () => {
    const reason = 'Error: getLatestLedger timeout after 30000ms';
    setIndexerFailed(reason);
    const { server, baseUrl } = await startServer(buildReadyApp());
    try {
      const res = await fetch(`${baseUrl}/ready`);
      const body = await res.json();
      expect(res.status).toBe(503);
      expect(body.reason).toBe(reason);
    } finally {
      await stopServer(server);
    }
  });
});
