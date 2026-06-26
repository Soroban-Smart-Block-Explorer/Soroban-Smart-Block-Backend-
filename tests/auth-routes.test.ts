import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const cacheStore = new Map<string, unknown>();

vi.mock('../src/cache', () => ({
  cacheGet: async (key: string) => cacheStore.get(key) ?? null,
  cacheSet: async (key: string, value: unknown) => {
    cacheStore.set(key, value);
  },
  cacheDelete: async (key: string) => {
    cacheStore.delete(key);
  },
}));

vi.mock('../src/db', () => ({
  prismaWrite: {
    walletUser: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), count: vi.fn() },
    authSession: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    authEvent: { create: vi.fn(), findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn() },
    authWebhook: {
      create: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    multiSigWallet: { findMany: vi.fn(), upsert: vi.fn() },
    oAuthApp: {
      create: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    oAuthCode: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  },
  prismaRead: {},
}));

vi.mock('../src/auth/challenge', () => ({
  createChallenge: vi.fn(),
  consumeChallenge: vi.fn(),
  getChallenge: vi.fn(),
  incrementAttempts: vi.fn(),
  checkChallengeRateLimit: vi.fn().mockResolvedValue(true),
}));

vi.mock('../src/auth/tokens', () => ({
  issueTokens: vi.fn(),
  verifyToken: vi.fn(),
  hashToken: vi.fn((t: string) => `hash-${t}`),
  generateSessionId: vi.fn(() => 'sess_test'),
  REFRESH_TOKEN_TTL: 2592000,
  ACCESS_TOKEN_TTL: 86400,
}));

vi.mock('../src/auth/keys', () => ({
  getJwks: vi.fn().mockResolvedValue({ keys: [] }),
  rotateKeys: vi.fn().mockResolvedValue({ kid: 'kid-1', createdAt: Date.now() }),
  getOrCreateKeyPair: vi.fn(),
}));

vi.mock('../src/auth/rbac', () => ({
  getFeatures: vi.fn().mockReturnValue({
    webhooks: { max: 3, enabled: true },
    dashboards: { max: 3, enabled: true },
    rateLimit: { perMinute: 100, burst: 200 },
  }),
  featureList: vi.fn().mockReturnValue(['webhooks']),
  hasRole: vi.fn().mockReturnValue(true),
}));

vi.mock('../src/auth/middleware', () => ({
  requireAuth: vi.fn((req: { user?: unknown }, _res: unknown, next: () => void) => {
    // Populate req.user so handlers that use req.user!.id don't throw.
    req.user = {
      id: 'user-1',
      address: 'GTEST',
      role: 'user' as const,
      tier: 'free' as const,
      sessionId: 'sess_test',
      appId: 'explorer-web',
    };
    next();
  }),
  requireRole: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
  optionalAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { prismaWrite } from '../src/db';
import { createChallenge, checkChallengeRateLimit } from '../src/auth/challenge';
import { getJwks } from '../src/auth/keys';
import { authRouter } from '../src/api/auth';
import { authMultisigRouter } from '../src/api/authMultisig';
import { authOAuth2Router } from '../src/api/authOAuth2';
import { authProfileRouter } from '../src/api/authProfile';
import { authSecurityRouter } from '../src/api/authSecurity';
import { authWebhooksRouter } from '../src/api/authWebhooks';

// ── Test server ───────────────────────────────────────────────────────────────

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/auth', authRouter);
  app.use('/auth/multisig', authMultisigRouter);
  app.use('/auth/oauth2', authOAuth2Router);
  app.use('/auth/profiles', authProfileRouter);
  app.use('/auth/security', authSecurityRouter);
  app.use('/auth/webhooks', authWebhooksRouter);

  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(
  () =>
    new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
);

beforeEach(() => {
  vi.clearAllMocks();
  cacheStore.clear();
  (checkChallengeRateLimit as ReturnType<typeof vi.fn>).mockResolvedValue(true);
});

// ── authRouter (/auth) ────────────────────────────────────────────────────────

describe('GET /auth/.well-known/jwks.json', () => {
  it('returns JWKS', async () => {
    (getJwks as ReturnType<typeof vi.fn>).mockResolvedValue({ keys: [{ kid: 'k1', kty: 'RSA' }] });

    const res = await fetch(`${baseUrl}/auth/.well-known/jwks.json`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('keys');
  });
});

describe('POST /auth/challenge', () => {
  it('returns a challenge for a valid address', async () => {
    (createChallenge as ReturnType<typeof vi.fn>).mockResolvedValue({
      challengeId: 'ch_abc',
      message: 'nonce: abc123',
      expiresAt: new Date(),
      appId: 'explorer-web',
      address: 'GTEST',
    });

    const res = await fetch(`${baseUrl}/auth/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: 'GTEST' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('challenge');
    expect(body).toHaveProperty('challengeId');
    expect(body.type).toBe('stellar_message');
  });

  it('returns 400 when address is missing', async () => {
    const res = await fetch(`${baseUrl}/auth/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('returns 429 when rate limit is exceeded', async () => {
    (checkChallengeRateLimit as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const res = await fetch(`${baseUrl}/auth/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: 'GTEST' }),
    });
    expect(res.status).toBe(429);
  });
});

describe('GET /auth/me', () => {
  it('returns user profile when authenticated', async () => {
    (prismaWrite.walletUser.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'user-1',
      address: 'GTEST',
      displayName: 'Tester',
      role: 'user',
      tier: 'developer',
      email: null,
      createdAt: new Date(),
      lastLogin: new Date(),
    });
    (prismaWrite.authSession.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);
    (prismaWrite.authWebhook.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);

    const res = await fetch(`${baseUrl}/auth/me`, {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('address', 'GTEST');
    expect(body).toHaveProperty('role');
    expect(body).toHaveProperty('tier');
  });
});

describe('POST /auth/logout', () => {
  it('revokes the current session', async () => {
    (prismaWrite.authSession.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (prismaWrite.authEvent.create as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const res = await fetch(`${baseUrl}/auth/logout`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });
});

// ── authMultisigRouter (/auth/multisig) ───────────────────────────────────────

describe('POST /auth/multisig/initiate', () => {
  it('creates a multisig auth flow', async () => {
    const res = await fetch(`${baseUrl}/auth/multisig/initiate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        multisigAddress: 'GMULTI',
        signers: [
          { address: 'GSIGNER1', weight: 1 },
          { address: 'GSIGNER2', weight: 1 },
        ],
        threshold: 2,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('authFlowId');
    expect(body).toHaveProperty('challenge');
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await fetch(`${baseUrl}/auth/multisig/initiate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ multisigAddress: 'GMULTI' }),
    });
    expect(res.status).toBe(400);
  });
});

// ── authOAuth2Router (/auth/oauth2) ───────────────────────────────────────────

describe('POST /auth/oauth2/apps', () => {
  it('registers an OAuth2 app', async () => {
    (prismaWrite.oAuthApp.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'app-1',
      clientId: 'app_abc123',
      clientSecret: 'hashed',
      name: 'My App',
      redirectUris: ['https://example.com/callback'],
      scopes: ['read'],
      createdAt: new Date(),
    });

    const res = await fetch(`${baseUrl}/auth/oauth2/apps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({ name: 'My App', redirectUris: ['https://example.com/callback'] }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toHaveProperty('clientId');
    expect(body).toHaveProperty('clientSecret'); // shown once
  });

  it('returns 400 when name is missing', async () => {
    const res = await fetch(`${baseUrl}/auth/oauth2/apps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({ redirectUris: ['https://example.com/callback'] }),
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /auth/oauth2/apps', () => {
  it('lists OAuth2 apps for the user', async () => {
    (prismaWrite.oAuthApp.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { clientId: 'app_abc', name: 'My App', redirectUris: [], scopes: [], createdAt: new Date() },
    ]);

    const res = await fetch(`${baseUrl}/auth/oauth2/apps`, {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.apps).toHaveLength(1);
  });
});

// ── authProfileRouter (/auth/profiles) ───────────────────────────────────────

describe('GET /auth/profiles/me/profile', () => {
  it('returns user profile', async () => {
    (prismaWrite.walletUser.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'user-1',
      address: 'GTEST',
      displayName: 'Tester',
      avatarUrl: null,
      email: null,
      metadata: { profile: { bio: 'Hello' }, credentials: [] },
    });

    const res = await fetch(`${baseUrl}/auth/profiles/me/profile`, {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('address', 'GTEST');
    expect(body).toHaveProperty('profile');
  });
});

describe('GET /auth/profiles/:address/profile', () => {
  it('returns public profile for any address', async () => {
    (prismaWrite.walletUser.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'user-1',
      address: 'GTEST',
      displayName: 'Tester',
      avatarUrl: null,
      tier: 'developer',
      metadata: { profile: {}, credentials: [] },
    });

    const res = await fetch(`${baseUrl}/auth/profiles/GTEST/profile`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('address', 'GTEST');
    expect(body).toHaveProperty('tier');
  });

  it('returns 404 for unknown address', async () => {
    (prismaWrite.walletUser.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const res = await fetch(`${baseUrl}/auth/profiles/GUNKNOWN/profile`);
    expect(res.status).toBe(404);
  });
});

// ── authSecurityRouter (/auth/security) ───────────────────────────────────────

describe('GET /auth/security/events', () => {
  it('returns security events', async () => {
    (prismaWrite.authEvent.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'evt-1', eventType: 'failed_verify', createdAt: new Date(), ipAddress: '127.0.0.1' },
    ]);

    const res = await fetch(`${baseUrl}/auth/security/events`, {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toHaveLength(1);
  });
});

// ── authWebhooksRouter (/auth/webhooks) ───────────────────────────────────────

describe('POST /auth/webhooks', () => {
  it('registers an auth webhook', async () => {
    (prismaWrite.authWebhook.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'hook-1',
      url: 'https://example.com/hook',
      events: ['login', 'logout'],
      createdAt: new Date(),
    });

    const res = await fetch(`${baseUrl}/auth/webhooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({ url: 'https://example.com/hook', events: ['login', 'logout'] }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe('hook-1');
  });

  it('returns 400 when url or events are missing', async () => {
    const res = await fetch(`${baseUrl}/auth/webhooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({ url: 'https://example.com/hook' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /auth/webhooks', () => {
  it('lists auth webhooks', async () => {
    (prismaWrite.authWebhook.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'hook-1',
        url: 'https://example.com/hook',
        events: ['login'],
        isActive: true,
        createdAt: new Date(),
      },
    ]);

    const res = await fetch(`${baseUrl}/auth/webhooks`, {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.webhooks).toHaveLength(1);
  });
});
