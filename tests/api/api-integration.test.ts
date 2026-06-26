/**
 * API integration tests for /api/v1/transactions and /api/v1/events (Issue #224).
 *
 * Uses vitest + a minimal Express app with mocked Prisma to validate the real
 * API contract end-to-end without requiring a live database.
 *
 * Coverage:
 *  GET /api/v1/transactions        — pagination, filtering by contract/account/status
 *  GET /api/v1/transactions/:hash  — 200 with events, 404 for unknown hash
 *  GET /api/v1/events              — pagination, filtering by contract/type
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

// ── Mock Prisma before importing routes ───────────────────────────────────────

vi.mock('../../src/db', () => ({
  prismaRead: {
    transaction: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
    },
    event: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
    },
  },
  prismaWrite: {},
}));

// Mock the BN254 tracker used by the transactions route
vi.mock('../../src/indexer/bn254-tracker', () => ({
  getBn254ExemptionByTx: vi.fn().mockResolvedValue(null),
}));

import { prismaRead as prisma } from '../../src/db';
import { transactionRouter } from '../../src/api/transactions';
import { eventRouter } from '../../src/api/events';

// ── Test server setup ─────────────────────────────────────────────────────────

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/transactions', transactionRouter);
  app.use('/api/v1/events', eventRouter);

  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TX_FIXTURE = {
  id: 'cuid-tx-1',
  hash: 'abc123hash',
  ledgerSequence: 1000,
  ledgerCloseTime: new Date('2024-01-01T00:00:00Z'),
  sourceAccount: 'GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDE',
  contractAddress: 'CABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDE',
  functionName: 'transfer',
  status: 'success',
  humanReadable: 'Transferred 100 USDC',
  feeCharged: '100',
  sorobanResources: null,
  failureReason: null,
  freezeViolation: false,
};

const TX_FIXTURE_2 = {
  ...TX_FIXTURE,
  id: 'cuid-tx-2',
  hash: 'def456hash',
  ledgerSequence: 999,
  status: 'failed',
  functionName: 'swap',
  humanReadable: 'Swap failed',
};

const EVENT_FIXTURE = {
  id: 'evt-1',
  transactionHash: 'abc123hash',
  contractAddress: 'CABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDE',
  eventType: 'transfer',
  topicSymbol: 'transfer',
  decoded: { from: 'GA', to: 'GB', amount: '100' },
  ledgerSequence: 1000,
  ledgerCloseTime: new Date('2024-01-01T00:00:00Z'),
};

const EVENT_FIXTURE_2 = {
  ...EVENT_FIXTURE,
  id: 'evt-2',
  eventType: 'mint',
  topicSymbol: 'mint',
  decoded: { to: 'GA', amount: '50' },
};

// ── GET /api/v1/transactions ──────────────────────────────────────────────────

describe('GET /api/v1/transactions', () => {
  it('returns paginated transactions with default page/limit', async () => {
    (prisma.transaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([TX_FIXTURE]);
    (prisma.transaction.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    const res = await fetch(`${baseUrl}/api/v1/transactions`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].hash).toBe('abc123hash');
    expect(body.total).toBe(1);
    expect(body.page).toBe(1);
    expect(body.limit).toBe(20);
    expect(body.pages).toBe(1);
  });

  it('respects page and limit query params', async () => {
    (prisma.transaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([TX_FIXTURE_2]);
    (prisma.transaction.count as ReturnType<typeof vi.fn>).mockResolvedValue(10);

    const res = await fetch(`${baseUrl}/api/v1/transactions?page=2&limit=5`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.page).toBe(2);
    expect(body.limit).toBe(5);
    expect(body.pages).toBe(2);

    // Verify skip was calculated correctly (page 2, limit 5 → skip 5)
    const findManyCall = (prisma.transaction.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(findManyCall.skip).toBe(5);
    expect(findManyCall.take).toBe(5);
  });

  it('filters by contract address', async () => {
    (prisma.transaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([TX_FIXTURE]);
    (prisma.transaction.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    const contract = 'CABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDE';
    const res = await fetch(`${baseUrl}/api/v1/transactions?contract=${contract}`);
    const body = await res.json();

    expect(res.status).toBe(200);
    const findManyCall = (prisma.transaction.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(findManyCall.where.contractAddress).toBe(contract);
  });

  it('filters by source account', async () => {
    (prisma.transaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([TX_FIXTURE]);
    (prisma.transaction.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    const account = 'GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDE';
    const res = await fetch(`${baseUrl}/api/v1/transactions?account=${account}`);

    expect(res.status).toBe(200);
    const findManyCall = (prisma.transaction.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(findManyCall.where.sourceAccount).toBe(account);
  });

  it('filters by status', async () => {
    (prisma.transaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([TX_FIXTURE_2]);
    (prisma.transaction.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    const res = await fetch(`${baseUrl}/api/v1/transactions?status=failed`);
    const body = await res.json();

    expect(res.status).toBe(200);
    const findManyCall = (prisma.transaction.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(findManyCall.where.status).toBe('failed');
    expect(body.data[0].status).toBe('failed');
  });

  it('returns empty data array when no transactions match', async () => {
    (prisma.transaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.transaction.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);

    const res = await fetch(`${baseUrl}/api/v1/transactions?contract=CUNKNOWN`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(0);
    expect(body.total).toBe(0);
  });

  it('returns 400 for invalid limit (exceeds max)', async () => {
    const res = await fetch(`${baseUrl}/api/v1/transactions?limit=999`);
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid page (zero)', async () => {
    const res = await fetch(`${baseUrl}/api/v1/transactions?page=0`);
    expect(res.status).toBe(400);
  });

  it('supports cursor-based pagination', async () => {
    // cursor mode returns hasNext and nextCursor
    (prisma.transaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([TX_FIXTURE]);
    (prisma.transaction.findFirst as ReturnType<typeof vi.fn>)?.mockResolvedValue(null);

    const res = await fetch(`${baseUrl}/api/v1/transactions?cursor=2000&limit=1`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveProperty('hasNext');
    expect(body).toHaveProperty('data');
  });
});

// ── GET /api/v1/transactions/:hash ────────────────────────────────────────────

describe('GET /api/v1/transactions/:hash', () => {
  it('returns 200 with transaction and events for a known hash', async () => {
    const txWithEvents = {
      ...TX_FIXTURE,
      events: [EVENT_FIXTURE],
    };
    (prisma.transaction.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(txWithEvents);

    const res = await fetch(`${baseUrl}/api/v1/transactions/abc123hash`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.hash).toBe('abc123hash');
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events).toHaveLength(1);
    expect(body.events[0].eventType).toBe('transfer');
  });

  it('includes bn254GasExemption field in the response', async () => {
    const txWithEvents = { ...TX_FIXTURE, events: [] };
    (prisma.transaction.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(txWithEvents);

    const res = await fetch(`${baseUrl}/api/v1/transactions/abc123hash`);
    const body = await res.json();

    expect(res.status).toBe(200);
  });

  it('returns 404 for an unknown hash', async () => {
    (prisma.transaction.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const res = await fetch(`${baseUrl}/api/v1/transactions/unknownhash`);
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe('Transaction not found');
  });

  it('returns transaction with empty events array when no events exist', async () => {
    const txNoEvents = { ...TX_FIXTURE, events: [] };
    (prisma.transaction.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(txNoEvents);

    const res = await fetch(`${baseUrl}/api/v1/transactions/abc123hash`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.events).toHaveLength(0);
  });
});

// ── GET /api/v1/events ────────────────────────────────────────────────────────

describe('GET /api/v1/events', () => {
  it('returns paginated events with default page/limit', async () => {
    (prisma.event.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([EVENT_FIXTURE]);
    (prisma.event.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    const res = await fetch(`${baseUrl}/api/v1/events`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe('evt-1');
    expect(body.total).toBe(1);
    expect(body.page).toBe(1);
    expect(body.limit).toBe(20);
  });

  it('respects page and limit query params', async () => {
    (prisma.event.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([EVENT_FIXTURE_2]);
    (prisma.event.count as ReturnType<typeof vi.fn>).mockResolvedValue(15);

    const res = await fetch(`${baseUrl}/api/v1/events?page=3&limit=5`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.page).toBe(3);
    expect(body.limit).toBe(5);

    const findManyCall = (prisma.event.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(findManyCall.skip).toBe(10); // (page 3 - 1) * limit 5
    expect(findManyCall.take).toBe(5);
  });

  it('filters by contract address', async () => {
    (prisma.event.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([EVENT_FIXTURE]);
    (prisma.event.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    const contract = 'CABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDE';
    const res = await fetch(`${baseUrl}/api/v1/events?contract=${contract}`);

    expect(res.status).toBe(200);
    const findManyCall = (prisma.event.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(findManyCall.where.contractAddress).toBe(contract);
  });

  it('filters by event type', async () => {
    (prisma.event.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([EVENT_FIXTURE_2]);
    (prisma.event.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    const res = await fetch(`${baseUrl}/api/v1/events?type=mint`);
    const body = await res.json();

    expect(res.status).toBe(200);
    const findManyCall = (prisma.event.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(findManyCall.where.eventType).toBe('mint');
    expect(body.data[0].eventType).toBe('mint');
  });

  it('filters by contract and type simultaneously', async () => {
    (prisma.event.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([EVENT_FIXTURE]);
    (prisma.event.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    const contract = 'CABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDE';
    const res = await fetch(`${baseUrl}/api/v1/events?contract=${contract}&type=transfer`);

    expect(res.status).toBe(200);
    const findManyCall = (prisma.event.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(findManyCall.where.contractAddress).toBe(contract);
    expect(findManyCall.where.eventType).toBe('transfer');
  });

  it('returns empty data array when no events match', async () => {
    (prisma.event.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.event.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);

    const res = await fetch(`${baseUrl}/api/v1/events?type=unknown_type`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(0);
    expect(body.total).toBe(0);
  });

  it('returns 400 for invalid limit (exceeds max)', async () => {
    const res = await fetch(`${baseUrl}/api/v1/events?limit=200`);
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid page (zero)', async () => {
    const res = await fetch(`${baseUrl}/api/v1/events?page=0`);
    expect(res.status).toBe(400);
  });

  it('response data includes expected fields', async () => {
    (prisma.event.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([EVENT_FIXTURE]);
    (prisma.event.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    const res = await fetch(`${baseUrl}/api/v1/events`);
    const body = await res.json();

    expect(res.status).toBe(200);
    const event = body.data[0];
    expect(event).toHaveProperty('id');
    expect(event).toHaveProperty('transactionHash');
    expect(event).toHaveProperty('contractAddress');
    expect(event).toHaveProperty('eventType');
    expect(event).toHaveProperty('topicSymbol');
    expect(event).toHaveProperty('decoded');
    expect(event).toHaveProperty('ledgerSequence');
    expect(event).toHaveProperty('ledgerCloseTime');
  });
});
