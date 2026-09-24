import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../src/db', () => ({
  prismaRead: {
    devApiKey: { findFirst: vi.fn() },
  },
  prismaWrite: {
    devApiKey: { update: vi.fn() },
  },
}));

vi.mock('../../src/feed/streamingServer', () => ({
  streamingServer: { broadcast: vi.fn() },
}));

import { alertRulesRouter } from '../../src/api/alert-rules';
import { getSuspiciousActivityAlertService } from '../../src/services/suspiciousActivityAlerts';

function makeApp(withKey = true) {
  const app = express();
  app.use(express.json());
  if (withKey) {
    app.use((req, _res, next) => {
      (req as any).apiKey = { id: 'key-1', developerId: 'dev-1', keyName: 'test', tier: 'free' };
      next();
    });
  }
  app.use('/alert-rules', alertRulesRouter);
  return app;
}

const validActivity = {
  eventType: 'approve',
  sourceAccount: 'G_OWNER',
  decoded: { spender: 'G_SPENDER', unlimited: true },
  timestamp: new Date().toISOString(),
};

describe('/alert-rules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ALERT_WEBHOOK_URL;
    delete process.env.SUSPICIOUS_ALERT_WEBHOOK_URL;
    getSuspiciousActivityAlertService().reset();
  });

  it('GET /rules lists the registry', async () => {
    const res = await request(makeApp()).get('/alert-rules/rules');
    expect(res.status).toBe(200);
    expect(res.body.rules.map((r: any) => r.id)).toContain('wash_trading');
  });

  it('GET /config returns defaults for the calling tenant', async () => {
    const res = await request(makeApp()).get('/alert-rules/config');
    expect(res.status).toBe(200);
    expect(res.body.tenantId).toBe('key-1');
    expect(res.body.rules.rapid_value_movement.enabled).toBe(true);
  });

  it('PUT /config applies and persists per-tenant overrides', async () => {
    const res = await request(makeApp())
      .put('/alert-rules/config')
      .send({ rules: { wash_trading: { enabled: false, cooldownMs: 1000 } } });

    expect(res.status).toBe(200);
    expect(res.body.rules.wash_trading.enabled).toBe(false);
    expect(res.body.rules.wash_trading.cooldownMs).toBe(1000);

    const after = await request(makeApp()).get('/alert-rules/config');
    expect(after.body.rules.wash_trading.enabled).toBe(false);
  });

  it('PUT /config rejects invalid payloads', async () => {
    const res = await request(makeApp())
      .put('/alert-rules/config')
      .send({ rules: { wash_trading: { minSeverity: 'catastrophic' } } });
    expect(res.status).toBe(400);
  });

  it('DELETE /config restores defaults', async () => {
    await request(makeApp())
      .put('/alert-rules/config')
      .send({ rules: { wash_trading: { enabled: false } } });

    const res = await request(makeApp()).delete('/alert-rules/config');
    expect(res.status).toBe(200);
    expect(res.body.rules.wash_trading.enabled).toBe(true);
  });

  it('POST /ingest requires an API key', async () => {
    const res = await request(makeApp(false))
      .post('/alert-rules/ingest')
      .send({ activities: [validActivity] });
    expect(res.status).toBe(401);
  });

  it('POST /ingest evaluates activity and returns emitted alerts', async () => {
    const res = await request(makeApp())
      .post('/alert-rules/ingest')
      .send({ activities: [validActivity] });

    expect(res.status).toBe(202);
    expect(res.body.tenantId).toBe('key-1');
    expect(res.body.emitted.length).toBeGreaterThan(0);
    expect(res.body.emitted[0].ruleId).toBe('unusual_approval');
  });

  it('POST /ingest rejects malformed payloads', async () => {
    const res = await request(makeApp()).post('/alert-rules/ingest').send({ activities: [] });
    expect(res.status).toBe(400);
  });

  it('GET /recent returns alerts scoped to the tenant', async () => {
    await request(makeApp())
      .post('/alert-rules/ingest')
      .send({ activities: [validActivity] });

    const res = await request(makeApp()).get('/alert-rules/recent');
    expect(res.status).toBe(200);
    expect(res.body.alerts).toHaveLength(1);

    const other = await request(makeApp()).get('/alert-rules/recent?tenantId=other');
    expect(other.body.alerts).toHaveLength(1);
  });
});
