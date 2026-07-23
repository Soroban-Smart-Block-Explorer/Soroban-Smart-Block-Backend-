import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../src/db', () => ({
  prismaWrite: {
    feedSubscription: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    feedChannel: {
      upsert: vi.fn(),
      findMany: vi.fn(),
    },
  },
  prismaRead: {
    feedSubscription: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    feedChannel: {
      findMany: vi.fn(),
    },
    feedMessage: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock('../src/feed/orchestrator', async () => {
  const { EventEmitter } = await import('events');
  const emitter = new EventEmitter();
  return { feedOrchestrator: emitter };
});

vi.mock('../src/middleware/asyncHandler', () => ({
  asyncHandler: (fn: unknown) => fn,
}));

// Pre-populate the ChannelManager in-memory map so isValidChannel returns true
// for channels used in tests without touching the database.
vi.mock('../src/feed/channelManager', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/feed/channelManager')>();
  const validNames = ['transactions', 'trades', 'events', 'ledgers'];
  for (const name of validNames) {
    (original.ChannelManager as any)['channels'].set(name, {
      name,
      category: 'transaction',
      schema: {},
    });
  }
  return original;
});

import { prismaWrite, prismaRead } from '../src/db';
import feedRouter from '../src/api/feed';
import feedSSERouter from '../src/api/feedSSE';
import { getSSEStats } from '../src/api/feedSSE';

// ── Test server ───────────────────────────────────────────────────────────────

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/feed/sse', feedSSERouter);
  app.use('/feed', feedRouter);

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

// ── Router export sanity ──────────────────────────────────────────────────────

describe('feedRouter export', () => {
  it('exports a router', () => {
    expect(typeof feedRouter).toBe('function');
    expect(feedRouter).toHaveProperty('stack');
  });
});

describe('feedSSERouter export', () => {
  it('exports a router', () => {
    expect(typeof feedSSERouter).toBe('function');
    expect(feedSSERouter).toHaveProperty('stack');
  });
});

// ── GET /feed/channels ────────────────────────────────────────────────────────

describe('GET /feed/channels', () => {
  it('returns available channels', async () => {
    (prismaRead.feedChannel.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        name: 'transactions',
        description: 'Tx feed',
        category: 'transaction',
        schema: {},
        retentionDays: 7,
      },
      {
        name: 'trades',
        description: 'Trade feed',
        category: 'derived',
        schema: {},
        retentionDays: 3,
      },
    ]);

    const res = await fetch(`${baseUrl}/feed/channels`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.channels)).toBe(true);
    expect(body.channels).toHaveLength(2);
    expect(body.channels[0]).toHaveProperty('latencyTarget');
  });

  it('returns empty array when no channels are enabled', async () => {
    (prismaRead.feedChannel.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const res = await fetch(`${baseUrl}/feed/channels`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.channels).toHaveLength(0);
  });
});

// ── POST /feed/subscribe ──────────────────────────────────────────────────────

const SUBSCRIPTION_FIXTURE = {
  id: 'sub-abc-123',
  userId: 'user-1',
  channelName: 'transactions',
  filters: null,
  deliveryType: 'webhook',
  deliveryConfig: { url: 'https://example.com/hook' },
  status: 'active',
  totalDelivered: 0,
  totalFailed: 0,
  lastDeliveryAt: null,
  createdAt: new Date().toISOString(),
};

const VALID_SUBSCRIBE_BODY = {
  channelName: 'transactions',
  deliveryType: 'webhook',
  deliveryConfig: { url: 'https://example.com/hook' },
};

describe('POST /feed/subscribe', () => {
  it('creates a subscription and returns 201', async () => {
    (prismaWrite.feedSubscription.create as ReturnType<typeof vi.fn>).mockResolvedValue(
      SUBSCRIPTION_FIXTURE,
    );

    const res = await fetch(`${baseUrl}/feed/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID_SUBSCRIBE_BODY),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe('sub-abc-123');
    expect(body.channelName).toBe('transactions');
    expect(body.status).toBe('active');
    expect(prismaWrite.feedSubscription.create).toHaveBeenCalledOnce();
  });

  it('returns 400 for invalid channel name', async () => {
    const res = await fetch(`${baseUrl}/feed/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...VALID_SUBSCRIBE_BODY, channelName: 'nonexistent' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid channel/i);
  });

  it('returns 400 for missing required fields', async () => {
    const res = await fetch(`${baseUrl}/feed/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelName: 'transactions' }),
    });

    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid deliveryType', async () => {
    const res = await fetch(`${baseUrl}/feed/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...VALID_SUBSCRIBE_BODY, deliveryType: 'email' }),
    });

    expect(res.status).toBe(400);
  });
});

// ── GET /feed/subscriptions ───────────────────────────────────────────────────

describe('GET /feed/subscriptions', () => {
  it('lists subscriptions for the requesting user', async () => {
    (prismaWrite.feedSubscription.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      SUBSCRIPTION_FIXTURE,
    ]);

    const res = await fetch(`${baseUrl}/feed/subscriptions`, {
      headers: { 'x-user-id': 'user-1' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.subscriptions).toHaveLength(1);
    expect(body.subscriptions[0].id).toBe('sub-abc-123');
  });
});

// ── GET /feed/subscriptions/:id ───────────────────────────────────────────────

describe('GET /feed/subscriptions/:id', () => {
  it('returns the subscription when found', async () => {
    (prismaWrite.feedSubscription.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      SUBSCRIPTION_FIXTURE,
    );

    const res = await fetch(`${baseUrl}/feed/subscriptions/sub-abc-123`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe('sub-abc-123');
  });

  it('returns 404 when subscription does not exist', async () => {
    (prismaWrite.feedSubscription.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const res = await fetch(`${baseUrl}/feed/subscriptions/unknown-id`);
    expect(res.status).toBe(404);
  });
});

// ── DELETE /feed/subscriptions/:id — unsubscribe ──────────────────────────────

describe('DELETE /feed/subscriptions/:id', () => {
  it('deletes the subscription and returns 204', async () => {
    (prismaWrite.feedSubscription.delete as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const res = await fetch(`${baseUrl}/feed/subscriptions/sub-abc-123`, {
      method: 'DELETE',
    });

    expect(res.status).toBe(204);
    expect(prismaWrite.feedSubscription.delete).toHaveBeenCalledWith({
      where: { id: 'sub-abc-123' },
    });
  });
});

// ── Pause / Resume lifecycle ──────────────────────────────────────────────────

describe('subscription pause / resume lifecycle', () => {
  it('pauses a subscription', async () => {
    const paused = { ...SUBSCRIPTION_FIXTURE, status: 'paused' };
    (prismaWrite.feedSubscription.update as ReturnType<typeof vi.fn>).mockResolvedValue(paused);

    const res = await fetch(`${baseUrl}/feed/subscriptions/sub-abc-123/pause`, {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('paused');
  });

  it('resumes a paused subscription', async () => {
    const active = { ...SUBSCRIPTION_FIXTURE, status: 'active' };
    (prismaWrite.feedSubscription.update as ReturnType<typeof vi.fn>).mockResolvedValue(active);

    const res = await fetch(`${baseUrl}/feed/subscriptions/sub-abc-123/resume`, {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('active');
  });
});

// ── GET /feed/subscriptions/:id/status ───────────────────────────────────────

describe('GET /feed/subscriptions/:id/status', () => {
  it('returns delivery stats with computed delivery rate', async () => {
    const fixture = {
      ...SUBSCRIPTION_FIXTURE,
      totalDelivered: 90,
      totalFailed: 10,
      lastError: null,
    };
    (prismaWrite.feedSubscription.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      fixture,
    );

    const res = await fetch(`${baseUrl}/feed/subscriptions/sub-abc-123/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deliveryRate).toBe(90);
    expect(body.totalDelivered).toBe(90);
    expect(body.totalFailed).toBe(10);
  });

  it('reports 0% delivery rate when no messages have been sent', async () => {
    (prismaWrite.feedSubscription.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      SUBSCRIPTION_FIXTURE,
    );

    const res = await fetch(`${baseUrl}/feed/subscriptions/sub-abc-123/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deliveryRate).toBe(0);
  });
});

// ── SSE stream — connect and disconnect cleanup ───────────────────────────────

async function readUntil(body: ReadableStream<Uint8Array>, marker: string): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let accumulated = '';
  let chunk = await reader.read();
  while (!chunk.done) {
    accumulated += decoder.decode(chunk.value, { stream: true });
    if (accumulated.includes(marker)) break;
    chunk = await reader.read();
  }
  return accumulated;
}

describe('GET /feed/sse — SSE stream', () => {
  it('returns text/event-stream content-type with connection event', async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/feed/sse?channels=transactions`, {
      signal: controller.signal,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);

    const accumulated = await readUntil(res.body!, 'event: connected');
    expect(accumulated).toContain('event: connected');
    controller.abort();
  });

  it('removes the connection from the pool on client disconnect', async () => {
    const controller = new AbortController();

    const res = await fetch(`${baseUrl}/feed/sse?channels=trades`, {
      signal: controller.signal,
    });

    // Wait until the connected event arrives so the connection is registered
    await readUntil(res.body!, 'event: connected');

    // Abort the request to simulate client disconnect
    controller.abort();

    // Allow the close event to propagate
    await new Promise((r) => setTimeout(r, 50));

    const stats = getSSEStats();
    // The connection for 'trades' should have been removed
    expect(stats.channelStats['trades'] ?? 0).toBe(0);
  });

  it('returns 400 for an invalid channel name', async () => {
    const res = await fetch(`${baseUrl}/feed/sse?channels=nonexistent`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid channel/i);
  });

  it('returns 400 for malformed filters JSON', async () => {
    const res = await fetch(`${baseUrl}/feed/sse?channels=transactions&filters=notjson`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid filters/i);
  });
});
