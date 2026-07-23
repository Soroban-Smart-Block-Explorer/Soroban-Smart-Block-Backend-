import { describe, it, expect } from 'vitest';
import express from 'express';
import cors from 'cors';
import request from 'supertest';

function buildApp(corsAllowedOrigins?: string, nodeEnv = 'development') {
  const app = express();

  const corsOrigin: cors.CorsOptions['origin'] = (() => {
    const raw = corsAllowedOrigins?.trim();
    if (raw) return raw.split(',').map((o) => o.trim());
    if (nodeEnv === 'production') return false;
    return '*';
  })();

  app.use(
    cors({
      origin: corsOrigin,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Api-Key', 'X-Request-Id'],
      credentials: true,
    }),
  );

  app.get('/ping', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('CORS — development (no allowlist)', () => {
  it('allows any origin in development', async () => {
    const app = buildApp(undefined, 'development');
    const res = await request(app).get('/ping').set('Origin', 'https://evil.example.com');
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('handles OPTIONS preflight in development', async () => {
    const app = buildApp(undefined, 'development');
    const res = await request(app)
      .options('/ping')
      .set('Origin', 'https://app.example.com')
      .set('Access-Control-Request-Method', 'POST');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-methods']).toMatch(/POST/);
  });
});

describe('CORS — production (no allowlist → deny all)', () => {
  it('does not set allow-origin header for unknown origin in production', async () => {
    const app = buildApp(undefined, 'production');
    const res = await request(app).get('/ping').set('Origin', 'https://evil.example.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('preflight returns 204 but no allow-origin for unlisted origin in production', async () => {
    const app = buildApp(undefined, 'production');
    const res = await request(app)
      .options('/ping')
      .set('Origin', 'https://evil.example.com')
      .set('Access-Control-Request-Method', 'GET');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('CORS — explicit origin allowlist', () => {
  const allowlist = 'https://app.stellar.org,https://explorer.stellar.org';

  it('allows a listed origin', async () => {
    const app = buildApp(allowlist, 'production');
    const res = await request(app).get('/ping').set('Origin', 'https://app.stellar.org');
    expect(res.headers['access-control-allow-origin']).toBe('https://app.stellar.org');
  });

  it('blocks an unlisted origin', async () => {
    const app = buildApp(allowlist, 'production');
    const res = await request(app).get('/ping').set('Origin', 'https://attacker.example.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('preflight succeeds for listed origin', async () => {
    const app = buildApp(allowlist, 'production');
    const res = await request(app)
      .options('/ping')
      .set('Origin', 'https://explorer.stellar.org')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'X-Api-Key');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://explorer.stellar.org');
    expect(res.headers['access-control-allow-headers']).toMatch(/X-Api-Key/i);
  });

  it('exposes credentials header', async () => {
    const app = buildApp(allowlist, 'production');
    const res = await request(app).get('/ping').set('Origin', 'https://app.stellar.org');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('allows all configured methods in preflight', async () => {
    const app = buildApp(allowlist, 'production');
    const res = await request(app)
      .options('/ping')
      .set('Origin', 'https://app.stellar.org')
      .set('Access-Control-Request-Method', 'DELETE');
    const methods = res.headers['access-control-allow-methods'] ?? '';
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(methods).toMatch(method);
    }
  });
});
