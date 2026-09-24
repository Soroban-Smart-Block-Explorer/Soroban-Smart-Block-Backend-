import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../src/db', () => ({
  prismaWrite: {
    webhookSubscription: {
      create: vi.fn(),
      delete: vi.fn(),
      update: vi.fn(),
    },
  },
  prismaRead: {
    webhookSubscription: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    webhookDelivery: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock('../src/middleware/asyncHandler', () => ({
  asyncHandler: (fn: unknown) => fn,
}));

// #478: the webhooks router enforces API-key auth on every route; bypass it
// here (this suite exercises the route handlers, not the auth middleware).
vi.mock('../src/middleware/apiKeyAuth', () => ({
  apiKeyAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireApiKey: (req: { apiKey?: unknown }, _res: unknown, next: () => void) => {
    req.apiKey = { id: 'test-api-key' };
    next();
  },
}));

// Unit tests must not depend on live DNS for the SSRF guard.
vi.mock('../src/webhooks/ssrf-guard', () => ({
  assertSafeUrl: vi.fn().mockResolvedValue(undefined),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

import { prismaWrite, prismaRead } from '../src/db';
import { webhooksRouter } from '../src/api/webhooks';

// ── Test server ───────────────────────────────────────────────────────────────

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/webhooks', webhooksRouter);

  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(
  () =>
    new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
);

beforeEach(() => vi.clearAllMocks());

// ── Route-registry: mount check ───────────────────────────────────────────────

describe('webhooksRouter export', () => {
  it('exports a router', () => {
    expect(typeof webhooksRouter).toBe('function');
    expect(webhooksRouter).toHaveProperty('stack');
  });
});

// ── POST /webhooks — register ─────────────────────────────────────────────────

describe('POST /webhooks', () => {
  const FIXTURE = {
    id: 'sub-1',
    url: 'https://example.com/hook',
    contractAddress: null,
    eventType: null,
    topicSymbol: null,
    active: true,
    createdAt: new Date(),
  };

  it('creates a webhook subscription', async () => {
    (prismaWrite.webhookSubscription.create as ReturnType<typeof vi.fn>).mockResolvedValue(FIXTURE);

    const res = await fetch(`${baseUrl}/webhooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://example.com/hook',
        secret: 'supersecret-0123456789abcdefghijklmnop',
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe('sub-1');
    expect(body.url).toBe('https://example.com/hook');
    expect(prismaWrite.webhookSubscription.create).toHaveBeenCalledOnce();
  });

  it('returns 400 when url is missing', async () => {
    const res = await fetch(`${baseUrl}/webhooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: 'supersecret-0123456789abcdefghijklmnop' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when url is not a valid URI', async () => {
    const res = await fetch(`${baseUrl}/webhooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'not-a-url' }),
    });
    expect(res.status).toBe(400);
  });

  it('accepts optional contractAddress and eventType filters', async () => {
    (prismaWrite.webhookSubscription.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FIXTURE,
      contractAddress: 'CABC123',
      eventType: 'transfer',
    });

    const res = await fetch(`${baseUrl}/webhooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://example.com/hook',
        contractAddress: 'CABC123',
        eventType: 'transfer',
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.contractAddress).toBe('CABC123');
  });
});

// ── GET /webhooks — list ──────────────────────────────────────────────────────

describe('GET /webhooks', () => {
  it('lists subscriptions without secrets', async () => {
    (prismaRead.webhookSubscription.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'sub-1',
        url: 'https://example.com/hook',
        contractAddress: null,
        eventType: null,
        topicSymbol: null,
        active: true,
        createdAt: new Date(),
      },
    ]);

    const res = await fetch(`${baseUrl}/webhooks`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).not.toHaveProperty('secret');
  });
});
