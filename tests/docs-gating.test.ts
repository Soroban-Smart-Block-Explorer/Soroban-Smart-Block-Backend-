import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';

function buildApp(nodeEnv: string, enableDocs?: string) {
  const app = express();

  const docsEnabled = nodeEnv !== 'production' || enableDocs === 'true';

  if (docsEnabled) {
    app.get('/api/docs', (_req, res) => res.status(200).send('<html>swagger</html>'));
  }

  // Raw schema is always available
  app.get('/api/docs.json', (_req, res) => res.json({ openapi: '3.0.0' }));
  app.get('/api/v1/openapi.json', (_req, res) => res.json({ openapi: '3.0.0' }));

  return app;
}

describe('docs gating — production', () => {
  it('blocks /api/docs in production by default', async () => {
    const app = buildApp('production');
    const res = await request(app).get('/api/docs');
    expect(res.status).toBe(404);
  });

  it('allows /api/docs in production when ENABLE_DOCS=true', async () => {
    const app = buildApp('production', 'true');
    const res = await request(app).get('/api/docs');
    expect(res.status).toBe(200);
  });

  it('exposes /api/docs.json regardless of env', async () => {
    const app = buildApp('production');
    const res = await request(app).get('/api/docs.json');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('openapi');
  });

  it('exposes /api/v1/openapi.json regardless of env', async () => {
    const app = buildApp('production');
    const res = await request(app).get('/api/v1/openapi.json');
    expect(res.status).toBe(200);
  });
});

describe('docs gating — non-production', () => {
  it('serves /api/docs in development', async () => {
    const app = buildApp('development');
    const res = await request(app).get('/api/docs');
    expect(res.status).toBe(200);
  });

  it('serves /api/docs in test', async () => {
    const app = buildApp('test');
    const res = await request(app).get('/api/docs');
    expect(res.status).toBe(200);
  });
});

describe('GraphiQL gating — logic', () => {
  function graphiqlEnabled(nodeEnv: string, enableGraphiql?: string): boolean {
    return nodeEnv !== 'production' || enableGraphiql === 'true';
  }

  it('is enabled in development', () => {
    expect(graphiqlEnabled('development')).toBe(true);
  });

  it('is enabled in test', () => {
    expect(graphiqlEnabled('test')).toBe(true);
  });

  it('is disabled in production by default', () => {
    expect(graphiqlEnabled('production')).toBe(false);
  });

  it('is enabled in production when ENABLE_GRAPHIQL=true', () => {
    expect(graphiqlEnabled('production', 'true')).toBe(true);
  });

  it('is disabled in production when ENABLE_GRAPHIQL=false', () => {
    expect(graphiqlEnabled('production', 'false')).toBe(false);
  });
});
