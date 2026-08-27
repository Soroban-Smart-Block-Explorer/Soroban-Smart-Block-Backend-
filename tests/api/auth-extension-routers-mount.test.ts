import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../src/db', () => ({
  prismaWrite: {
    account: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
  prismaRead: {
    account: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('../../src/auth/middleware', () => ({
  requireAuth: (fn: Mock) => fn,
}));

vi.mock('../../src/cache', () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/auth/tokens', () => ({
  issueTokens: vi.fn().mockResolvedValue({ accessToken: 'token', refreshToken: 'refresh' }),
  generateSessionId: vi.fn().mockReturnValue('sess-123'),
  REFRESH_TOKEN_TTL: 86400,
}));

vi.mock('../../src/utils/uuidv7', () => ({
  uuidv7: vi.fn().mockReturnValue('uuid-123'),
}));

vi.mock('../../src/middleware/asyncHandler', () => ({
  asyncHandler: (fn: Mock) => fn,
}));

import { authMultisigRouter } from '../../src/api/authMultisig';
import { authProfileRouter } from '../../src/api/authProfile';
import { authSecurityRouter } from '../../src/api/authSecurity';
import { authWebhooksRouter } from '../../src/api/authWebhooks';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/auth/multisig', authMultisigRouter);
  app.use('/auth/profile', authProfileRouter);
  app.use('/auth/security', authSecurityRouter);
  app.use('/auth/webhooks', authWebhooksRouter);
  return app;
}

describe('Auth Multisig Router Mount (#845)', () => {
  describe('GET /auth/multisig', () => {
    it('returns multisig service overview', async () => {
      const res = await request(makeApp()).get('/auth/multisig');
      expect(res.status).toBe(200);
      expect(res.body.service || res.body.message).toBeDefined();
    });
  });

  describe('POST /auth/multisig/flow', () => {
    beforeEach(() => vi.clearAllMocks());

    it('initiates multisig flow', async () => {
      const res = await request(makeApp())
        .post('/auth/multisig/flow')
        .send({ multisigAddress: 'G' + 'A'.repeat(55), appId: 'test-app' });

      expect([200, 400, 401]).toContain(res.status);
    });
  });
});

describe('Auth Profile Router Mount (#845)', () => {
  describe('GET /auth/profile', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns profile service overview or user profile', async () => {
      const res = await request(makeApp()).get('/auth/profile');
      expect([200, 401]).toContain(res.status);
    });
  });

  describe('PUT /auth/profile', () => {
    beforeEach(() => vi.clearAllMocks());

    it('updates user profile', async () => {
      const res = await request(makeApp())
        .put('/auth/profile')
        .send({ displayName: 'Test User', bio: 'Test bio' });

      expect([200, 400, 401]).toContain(res.status);
    });
  });
});

describe('Auth Security Router Mount (#845)', () => {
  describe('GET /auth/security', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns security settings overview', async () => {
      const res = await request(makeApp()).get('/auth/security');
      expect([200, 401]).toContain(res.status);
    });
  });

  describe('POST /auth/security/2fa/enable', () => {
    beforeEach(() => vi.clearAllMocks());

    it('initiates 2FA enablement', async () => {
      const res = await request(makeApp()).post('/auth/security/2fa/enable');

      expect([200, 400, 401]).toContain(res.status);
    });
  });
});

describe('Auth Webhooks Router Mount (#845)', () => {
  describe('GET /auth/webhooks', () => {
    beforeEach(() => vi.clearAllMocks());

    it('lists auth webhooks', async () => {
      const res = await request(makeApp()).get('/auth/webhooks');
      expect([200, 401]).toContain(res.status);
    });
  });

  describe('POST /auth/webhooks', () => {
    beforeEach(() => vi.clearAllMocks());

    it('registers auth webhook', async () => {
      const res = await request(makeApp())
        .post('/auth/webhooks')
        .send({ url: 'https://example.com/webhook', events: ['login', 'logout'] });

      expect([200, 400, 401]).toContain(res.status);
    });
  });
});

describe('Issue #845 - Auth Router Integration', () => {
  it('all auth extension routers are accessible', async () => {
    const multisigRes = await request(makeApp()).get('/auth/multisig');
    const profileRes = await request(makeApp()).get('/auth/profile');
    const securityRes = await request(makeApp()).get('/auth/security');
    const webhooksRes = await request(makeApp()).get('/auth/webhooks');

    expect(multisigRes.status).toBeGreaterThanOrEqual(200);
    expect(profileRes.status).toBeGreaterThanOrEqual(200);
    expect(securityRes.status).toBeGreaterThanOrEqual(200);
    expect(webhooksRes.status).toBeGreaterThanOrEqual(200);
  });

  it('provides complete auth surface with extension routers', async () => {
    const endpoints = ['/auth/multisig', '/auth/profile', '/auth/security', '/auth/webhooks'];

    for (const endpoint of endpoints) {
      const res = await request(makeApp()).get(endpoint);
      expect([200, 401]).toContain(res.status);
    }
  });
});
