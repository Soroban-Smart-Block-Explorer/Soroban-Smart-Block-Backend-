import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import {
  calculateSystemIndicator,
  calculateUptimePercentage,
  getDailyUptimeHistory,
  getLatencyHistory,
  recordHealthSample,
  createStatusIncident,
  updateStatusIncident,
  type ComponentStatus,
} from '../src/services/status-service';
import { statusRouter } from '../src/api/status';

vi.mock('../src/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../src/db', () => ({
  prismaRead: {
    incidentReport: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
  prismaWrite: {},
}));

vi.mock('../src/health', () => ({
  getHealthStatus: vi.fn().mockResolvedValue({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    dependencies: {
      database: {
        status: 'healthy',
        message: 'Database responsive',
        lastChecked: new Date().toISOString(),
      },
      cache: {
        status: 'healthy',
        message: 'Cache operational',
        lastChecked: new Date().toISOString(),
      },
      rpc: { status: 'healthy', message: 'RPC operational', lastChecked: new Date().toISOString() },
      indexer: {
        status: 'healthy',
        message: 'Indexer operational',
        lastChecked: new Date().toISOString(),
      },
      worker: {
        status: 'healthy',
        message: 'Workers operational',
        lastChecked: new Date().toISOString(),
      },
      p2p: { status: 'healthy', message: 'P2P operational', lastChecked: new Date().toISOString() },
      coldStorage: {
        status: 'healthy',
        message: 'Cold storage ready',
        lastChecked: new Date().toISOString(),
      },
    },
    system: {
      memory: { rss: 100, heapTotal: 50, heapUsed: 30, external: 10 },
      cpu: { user: 10, system: 5 },
      uptime: 3600,
    },
    readiness: { ready: true, dependencies: {} },
  }),
}));

describe('StatusService Unit Tests', () => {
  const baseComponent: ComponentStatus = {
    id: 'api',
    name: 'API',
    group: 'core',
    status: 'operational',
    latencyMs: 15,
    uptimePercentage: { '24h': 100, '7d': 100, '30d': 100, '90d': 100 },
    description: 'API Service',
    lastChecked: new Date().toISOString(),
  };

  it('calculates indicator "none" when all components are operational', () => {
    const components = [{ ...baseComponent }, { ...baseComponent, id: 'db', name: 'Database' }];
    const res = calculateSystemIndicator(components);
    expect(res.indicator).toBe('none');
    expect(res.description).toBe('All Systems Operational');
  });

  it('calculates indicator "minor" when at least one component is degraded', () => {
    const components = [
      { ...baseComponent },
      { ...baseComponent, id: 'rpc', status: 'degraded_performance' as const },
    ];
    const res = calculateSystemIndicator(components);
    expect(res.indicator).toBe('minor');
    expect(res.description).toBe('Degraded System Performance');
  });

  it('calculates indicator "major" when at least one component has a partial outage', () => {
    const components = [
      { ...baseComponent },
      { ...baseComponent, id: 'indexer', status: 'partial_outage' as const },
    ];
    const res = calculateSystemIndicator(components);
    expect(res.indicator).toBe('major');
    expect(res.description).toBe('Partial System Outage');
  });

  it('calculates indicator "critical" when a component has a major outage', () => {
    const components = [
      { ...baseComponent },
      { ...baseComponent, id: 'db', status: 'major_outage' as const },
    ];
    const res = calculateSystemIndicator(components);
    expect(res.indicator).toBe('critical');
    expect(res.description).toBe('Major System Outage');
  });

  it('calculates uptime percentage correctly with health samples', () => {
    const now = Date.now();
    recordHealthSample('healthy', 20, now - 1000);
    recordHealthSample('healthy', 25, now - 500);
    recordHealthSample('unhealthy', 100, now - 100);

    const uptime = calculateUptimePercentage(1);
    expect(uptime).toBeGreaterThanOrEqual(60);
    expect(uptime).toBeLessThanOrEqual(70);
  });

  it('returns daily historical uptime for requested number of days', () => {
    const days90 = getDailyUptimeHistory(90);
    expect(days90).toHaveLength(90);
    expect(days90[0]).toHaveProperty('date');
    expect(days90[0]).toHaveProperty('uptimePercentage');
    expect(days90[0]).toHaveProperty('status');
    expect(days90[0]).toHaveProperty('downtimeSeconds');

    const days30 = getDailyUptimeHistory(30);
    expect(days30).toHaveLength(30);
  });

  it('returns latency history data points with p50, p95, p99', () => {
    const latency = getLatencyHistory(24);
    expect(latency).toHaveLength(24);
    expect(latency[0]).toHaveProperty('p50Ms');
    expect(latency[0]).toHaveProperty('p95Ms');
    expect(latency[0]).toHaveProperty('p99Ms');
    expect(latency[0]).toHaveProperty('avgMs');
  });

  it('creates and updates status incidents with timeline', async () => {
    const incident = await createStatusIncident({
      title: 'Scheduled RPC Maintenance',
      impact: 'minor',
      affectedComponents: ['Stellar & Soroban RPC Nodes'],
      message: 'Routine node maintenance on Stellar testnet.',
    });

    expect(incident.id).toBeDefined();
    expect(incident.title).toBe('Scheduled RPC Maintenance');
    expect(incident.status).toBe('investigating');
    expect(incident.updates).toHaveLength(1);

    const updated = updateStatusIncident(incident.id, {
      status: 'resolved',
      message: 'Node maintenance completed successfully.',
    });

    expect(updated).not.toBeNull();
    expect(updated?.status).toBe('resolved');
    expect(updated?.resolvedAt).toBeDefined();
    expect(updated?.updates).toHaveLength(2);
  });
});

describe('Status API HTTP Integration Tests', () => {
  const app = express();
  app.use(express.json());
  app.use('/status', statusRouter);

  it('GET /status returns full status summary payload', async () => {
    const res = await supertest(app).get('/status');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('indicator');
    expect(res.body.data).toHaveProperty('components');
    expect(res.body.data).toHaveProperty('overallUptime');
    expect(Array.isArray(res.body.data.components)).toBe(true);
  });

  it('GET /status/components returns component list', async () => {
    const res = await supertest(app).get('/status/components');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.components)).toBe(true);
    expect(res.body.data.components.length).toBeGreaterThanOrEqual(5);
  });

  it('GET /status/uptime returns 90-day history and averages', async () => {
    const res = await supertest(app).get('/status/uptime?days=30');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.days).toBe(30);
    expect(res.body.data.history).toHaveLength(30);
    expect(res.body.data.averages).toHaveProperty('24h');
    expect(res.body.data.averages).toHaveProperty('7d');
    expect(res.body.data.averages).toHaveProperty('30d');
  });

  it('GET /status/latency returns latency distribution data points', async () => {
    const res = await supertest(app).get('/status/latency?hours=12');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.hours).toBe(12);
    expect(res.body.data.dataPoints).toHaveLength(24);
  });

  it('GET /status/incidents returns incident list', async () => {
    const res = await supertest(app).get('/status/incidents');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.incidents)).toBe(true);
  });

  it('POST /status/incidents creates a new incident', async () => {
    const res = await supertest(app)
      .post('/status/incidents')
      .send({
        title: 'High Ingestion Latency',
        impact: 'minor',
        affectedComponents: ['Ledger Ingestion & Indexer'],
        message: 'Investigating brief lag in ingestion pipeline.',
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBeDefined();

    const getRes = await supertest(app).get(`/status/incidents/${res.body.data.id}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.data.title).toBe('High Ingestion Latency');
  });

  it('GET /status/badge returns shields.io compatible JSON badge', async () => {
    const res = await supertest(app).get('/status/badge');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('schemaVersion', 1);
    expect(res.body).toHaveProperty('label', 'status');
    expect(res.body).toHaveProperty('message');
    expect(res.body).toHaveProperty('color');
  });
});
