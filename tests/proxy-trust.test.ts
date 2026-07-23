import request from 'supertest';
import express from 'express';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
vi.mock('../src/middleware/tokenBucket', () => ({
  checkTokenBucket: vi.fn().mockResolvedValue({
    allowed: true,
    limit: 100,
    remaining: 99,
    resetAt: Math.floor(Date.now() / 1000) + 60,
    tier: 'free',
  }),
  setRateLimitRedisClient: vi.fn(),
}));
vi.mock('../src/db', () => ({
  prismaRead: { devApiKey: { findFirst: vi.fn() } },
  prismaWrite: { devApiKey: { update: vi.fn().mockResolvedValue(null) } },
}));

import { apiKeyAuth } from '../src/middleware/apiKeyAuth';
import { tieredRateLimit } from '../src/middleware/rateLimit';
import { rejectUntrustedForwardedHeaders } from '../src/middleware/proxyTrust';
import { prismaRead } from '../src/db';

const VALID_RECORD = {
  id: 'key1',
  name: 'test',
  developerId: 'dev1',
  tier: 'developer',
  rateLimitOverride: null,
  allowedIps: ['198.51.100.1'],
  allowedEndpoints: null,
  allowedDomains: null,
  expiresAt: null,
  revokedAt: null,
};

function buildApp(trustProxy: boolean | string | string[]) {
  const app = express();
  app.set('trust proxy', trustProxy);
  app.use(rejectUntrustedForwardedHeaders);
  app.use(express.json());
  app.use(apiKeyAuth);
  app.use(tieredRateLimit);
  app.get('/api/test', (req, res) => {
    res.json({ ip: req.ip, apiKeyId: req.apiKey?.id ?? null });
  });
  app.use((_req, res) => res.status(404).json({ error: 'not found' }));
  return app;
}

describe('Proxy trust and forwarded headers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prismaRead as any).devApiKey.findFirst.mockResolvedValue(VALID_RECORD);
  });

  it('rejects forwarded proxy headers when proxy trust is disabled', async () => {
    const app = buildApp(false);
    const response = await request(app)
      .get('/api/test')
      .set('x-forwarded-for', '198.51.100.1, 203.0.113.5')
      .set('x-api-key', 'valid-key');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Untrusted proxy headers are not allowed' });
  });

  it('accepts forwarded proxy headers when proxy trust is enabled', async () => {
    const app = buildApp(true);
    const response = await request(app)
      .get('/api/test')
      .set('x-forwarded-for', '198.51.100.1, 203.0.113.5')
      .set('x-api-key', 'valid-key');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ip: '198.51.100.1', apiKeyId: 'key1' });
  });

  it('allows API key IP allowlist to match the proxied client address', async () => {
    const app = buildApp(true);

    const response = await request(app)
      .get('/api/test')
      .set('x-forwarded-for', '198.51.100.1, 203.0.113.5')
      .set('x-api-key', 'valid-key');

    expect(response.status).toBe(200);
    expect(response.body.ip).toBe('198.51.100.1');
    expect(response.body.apiKeyId).toBe('key1');
  });
});
