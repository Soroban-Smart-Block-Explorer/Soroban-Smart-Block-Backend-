import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { getHealthStatus, getLivenessStatus, getReadinessStatus } from '../src/health';

// Mock dependencies
vi.mock('../src/db', () => ({
  prismaRead: {
    $queryRaw: vi.fn().mockResolvedValue([{ result: 1 }]),
  },
  prismaWrite: {
    $queryRaw: vi.fn().mockResolvedValue([{ result: 1 }]),
  },
}));

vi.mock('../src/cache', () => ({
  isCacheReady: vi.fn().mockReturnValue(true),
}));

vi.mock('../src/indexer-state', () => ({
  getIndexerStatus: vi.fn().mockReturnValue({ healthy: true }),
}));

vi.mock('../src/readiness', () => ({
  getReadinessState: vi.fn().mockReturnValue({
    db: true,
    cache: true,
    indexer: true,
    coldStorage: true,
  }),
}));

describe('Health Check Module', () => {
  describe('getHealthStatus', () => {
    it('returns healthy status when all dependencies are operational', async () => {
      const health = await getHealthStatus();

      expect(health.status).toBe('healthy');
      expect(health.dependencies.database.status).toBe('healthy');
      expect(health.dependencies.cache.status).toBe('healthy');
      expect(health.dependencies.indexer.status).toBe('healthy');
      expect(health.dependencies.worker.status).toBe('healthy');
      expect(health.readiness.ready).toBe(true);
    });

    it('includes timestamp in response', async () => {
      const health = await getHealthStatus();

      expect(health.timestamp).toBeDefined();
      expect(new Date(health.timestamp).getTime()).toBeGreaterThan(0);
    });

    it('includes detailed dependency information', async () => {
      const health = await getHealthStatus();

      expect(health.dependencies.database.details).toBeDefined();
      expect(health.dependencies.database.details?.responseTimeMs).toBeDefined();
      expect(health.dependencies.database.lastChecked).toBeDefined();
    });
  });

  describe('getLivenessStatus', () => {
    it('returns alive status with uptime', () => {
      const startTime = Date.now() - 5000; // 5 seconds ago
      const liveness = getLivenessStatus(startTime);

      expect(liveness.status).toBe('alive');
      expect(liveness.uptime).toBeGreaterThanOrEqual(5);
      expect(liveness.timestamp).toBeDefined();
    });
  });

  describe('getReadinessStatus', () => {
    it('returns ready status when all dependencies are ready', () => {
      const readiness = getReadinessStatus();

      expect(readiness.status).toBe('ready');
      expect(readiness.dependencies).toEqual({
        db: true,
        cache: true,
        indexer: true,
        coldStorage: true,
      });
      expect(readiness.blockers).toBeUndefined();
    });
  });
});

describe('Health Endpoints Integration', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();

    // Mock the health endpoints similar to index.ts
    app.get('/health', asyncHandler(async (_req, res) => {
      const healthStatus = await getHealthStatus();
      const statusCode = healthStatus.status === 'unhealthy' ? 503 : 200;
      res.status(statusCode).json(healthStatus);
    }));

    app.get('/livez', (_req, res) => {
      const liveness = getLivenessStatus(Date.now() - 10000);
      res.json(liveness);
    });

    app.get('/readyz', (_req, res) => {
      const readinessStatus = getReadinessStatus();
      const statusCode = readinessStatus.status === 'ready' ? 200 : 503;
      res.status(statusCode).json(readinessStatus);
    });
  });

  describe('GET /health', () => {
    it('returns 200 when healthy', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('healthy');
      expect(response.body.dependencies).toBeDefined();
    });

    it('includes all dependency health checks', async () => {
      const response = await request(app).get('/health');

      expect(response.body.dependencies.database).toBeDefined();
      expect(response.body.dependencies.cache).toBeDefined();
      expect(response.body.dependencies.indexer).toBeDefined();
      expect(response.body.dependencies.worker).toBeDefined();
    });

    it('includes readiness information', async () => {
      const response = await request(app).get('/health');

      expect(response.body.readiness).toBeDefined();
      expect(response.body.readiness.ready).toBe(true);
      expect(response.body.readiness.dependencies).toBeDefined();
    });
  });

  describe('GET /livez', () => {
    it('returns 200 with alive status', async () => {
      const response = await request(app).get('/livez');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('alive');
      expect(response.body.uptime).toBeGreaterThanOrEqual(10);
    });
  });

  describe('GET /readyz', () => {
    it('returns 200 when ready', async () => {
      const response = await request(app).get('/readyz');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ready');
      expect(response.body.dependencies).toBeDefined();
    });
  });
});

describe('Health Status Scenarios', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports degraded status when cache is unavailable', async () => {
    const { isCacheReady } = await import('../src/cache');
    vi.mocked(isCacheReady).mockReturnValue(false);

    const health = await getHealthStatus();

    expect(health.status).toBe('degraded');
    expect(health.dependencies.cache.status).toBe('degraded');
    expect(health.dependencies.cache.message).toContain('fallback');
  });

  it('reports unhealthy status when indexer fails', async () => {
    const { getIndexerStatus } = await import('../src/indexer-state');
    vi.mocked(getIndexerStatus).mockReturnValue({
      healthy: false,
      failureReason: 'Connection timeout',
    });

    const health = await getHealthStatus();

    expect(health.status).toBe('unhealthy');
    expect(health.dependencies.indexer.status).toBe('unhealthy');
    expect(health.dependencies.indexer.message).toContain('Connection timeout');
  });

  it('reports not_ready when dependencies are not ready', async () => {
    const { getReadinessState } = await import('../src/readiness');
    vi.mocked(getReadinessState).mockReturnValue({
      db: true,
      cache: true,
      indexer: false,
      coldStorage: false,
    });

    const readiness = getReadinessStatus();

    expect(readiness.status).toBe('not_ready');
    expect(readiness.blockers).toContain('indexer');
    expect(readiness.blockers).toContain('coldStorage');
  });

  it('reports degraded status for slow database', async () => {
    const { prismaRead } = await import('../src/db');

    // Simulate slow database query
    vi.mocked(prismaRead.$queryRaw).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve([{ result: 1 }]), 1500)),
    );

    const health = await getHealthStatus();

    expect(health.dependencies.database.status).toBe('degraded');
    expect(health.dependencies.database.message).toContain('High database latency');
    expect(health.dependencies.database.details?.responseTimeMs).toBeGreaterThan(1000);
  });
});
