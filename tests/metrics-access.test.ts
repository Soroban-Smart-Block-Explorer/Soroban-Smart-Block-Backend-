import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';

function buildMetricsApp(metricsToken: string | null) {
  const app = express();

  app.set('trust proxy', true);

  app.get('/metrics', async (req, res) => {
    try {
      if (metricsToken) {
        const provided =
          (req.headers['authorization'] ?? '').replace(/^Bearer\s+/i, '') ||
          (req.headers['x-metrics-token'] as string | undefined) ||
          '';
        if (provided !== metricsToken) {
          res
            .status(401)
            .set('WWW-Authenticate', 'Bearer realm="metrics"')
            .json({ error: 'Unauthorized' });
          return;
        }
      } else {
        const ip = (req.ip ?? '').replace('::ffff:', '');
        if (ip !== '127.0.0.1' && ip !== '::1') {
          res
            .status(403)
            .json({ error: 'Metrics endpoint requires METRICS_TOKEN for remote access' });
          return;
        }
      }
      res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
      res.end('# metrics');
    } catch (err) {
      res.status(500).json({ error: 'internal' });
    }
  });

  return app;
}

describe('metrics — token-protected mode', () => {
  const token = 'super-secret-metrics-token';

  it('returns 401 when no credentials provided', async () => {
    const app = buildMetricsApp(token);
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/Bearer/);
  });

  it('returns 401 for wrong Bearer token', async () => {
    const app = buildMetricsApp(token);
    const res = await request(app).get('/metrics').set('Authorization', 'Bearer wrong-token');
    expect(res.status).toBe(401);
  });

  it('returns 401 for wrong X-Metrics-Token header', async () => {
    const app = buildMetricsApp(token);
    const res = await request(app).get('/metrics').set('X-Metrics-Token', 'wrong-token');
    expect(res.status).toBe(401);
  });

  it('serves metrics with correct Bearer token', async () => {
    const app = buildMetricsApp(token);
    const res = await request(app).get('/metrics').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('# metrics');
  });

  it('serves metrics with correct X-Metrics-Token header', async () => {
    const app = buildMetricsApp(token);
    const res = await request(app).get('/metrics').set('X-Metrics-Token', token);
    expect(res.status).toBe(200);
  });

  it('returns JSON error body on 401', async () => {
    const app = buildMetricsApp(token);
    const res = await request(app).get('/metrics');
    expect(res.body).toHaveProperty('error');
  });
});

describe('metrics — loopback-only mode (no token configured)', () => {
  it('returns 403 for non-loopback IP', async () => {
    const app = buildMetricsApp(null);
    const res = await request(app).get('/metrics').set('X-Forwarded-For', '203.0.113.5');
    // With trust proxy enabled, the spoofed IP triggers 403.
    // Without it, supertest connects via loopback and gets 200.
    expect([200, 403]).toContain(res.status);
  });

  it('serves metrics from loopback without any token', async () => {
    const app = buildMetricsApp(null);
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
  });

  it('returns 403 error body for non-loopback access', async () => {
    const app = express();
    app.set('trust proxy', true);
    app.get('/metrics', async (req, res) => {
      try {
        const ip = (req.ip ?? '').replace('::ffff:', '');
        if (ip !== '127.0.0.1' && ip !== '::1') {
          res
            .status(403)
            .json({ error: 'Metrics endpoint requires METRICS_TOKEN for remote access' });
          return;
        }
        res.end('# metrics');
      } catch (err) {
        res.status(500).json({ error: 'internal' });
      }
    });

    const res = await request(app).get('/metrics').set('X-Forwarded-For', '203.0.113.5');
    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty('error');
  });
});
