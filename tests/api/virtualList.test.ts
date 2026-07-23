/**
 * tests/api/virtualList.test.ts
 *
 * Unit tests for the virtualList route handler.
 * Covers:
 *  - Phase 1: humanReadable field is used (not phantom decodedDescription)
 *  - Correct row-height calculation
 *  - Select clause includes humanReadable
 *  - Structured payload shape
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock prismaRead BEFORE importing the router so the module picks up the mock
// ---------------------------------------------------------------------------

vi.mock('../../src/db', () => ({
  prismaRead: {
    transaction: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
    event: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
  },
}));

import { prismaRead as prismaMock } from '../../src/db';
import express, { type Express } from 'express';
import request from 'supertest';
import { virtualListRouter } from '../../src/api/virtualList';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/virtual-list', virtualListRouter);
  return app;
}

const MOCK_DATE = new Date('2024-01-15T12:00:00Z');

function makeTx(
  overrides: Partial<{
    id: string;
    hash: string;
    contractAddress: string | null;
    status: string;
    ledgerSequence: number;
    ledgerCloseTime: Date;
    humanReadable: string | null;
  }> = {},
) {
  return {
    id: 'cuid-1',
    hash: 'abc123',
    contractAddress: 'GABC',
    status: 'success',
    ledgerSequence: 100,
    ledgerCloseTime: MOCK_DATE,
    humanReadable: 'Address A swapped 100 USDC → 98.7 XLM',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Phase 1 tests — humanReadable is used correctly
// ---------------------------------------------------------------------------

describe('GET /api/v1/virtual-list/transactions', () => {
  let app: Express;

  beforeEach(() => {
    app = makeApp();
    vi.clearAllMocks();
  });

  it('returns decoded field from humanReadable, not decodedDescription', async () => {
    const tx = makeTx({ humanReadable: 'Address X swapped 100 USDC → 98.7 XLM' });
    (prismaMock.transaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([tx]);
    (prismaMock.transaction.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    const res = await request(app).get('/api/v1/virtual-list/transactions');

    expect(res.status).toBe(200);
    const item = res.body.items[0];
    // The decoded field must equal tx.humanReadable
    expect(item.decoded).toBe('Address X swapped 100 USDC → 98.7 XLM');
  });

  it('sets decoded to undefined when humanReadable is null', async () => {
    const tx = makeTx({ humanReadable: null });
    (prismaMock.transaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([tx]);
    (prismaMock.transaction.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    const res = await request(app).get('/api/v1/virtual-list/transactions');

    expect(res.status).toBe(200);
    // null humanReadable → decoded should be absent / undefined (JSON omits undefined)
    expect(res.body.items[0].decoded).toBeUndefined();
  });

  it('includes all required VirtualListItem fields', async () => {
    const tx = makeTx();
    (prismaMock.transaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([tx]);
    (prismaMock.transaction.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    const res = await request(app).get('/api/v1/virtual-list/transactions');

    expect(res.status).toBe(200);
    const item = res.body.items[0];
    expect(item).toHaveProperty('id');
    expect(item).toHaveProperty('hash');
    expect(item).toHaveProperty('contractAddress');
    expect(item).toHaveProperty('status');
    expect(item).toHaveProperty('ledger');
    expect(item).toHaveProperty('timestamp');
    expect(item).toHaveProperty('rowHeight');
  });

  it('returns correct timestamp from ledgerCloseTime', async () => {
    const tx = makeTx();
    (prismaMock.transaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([tx]);
    (prismaMock.transaction.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    const res = await request(app).get('/api/v1/virtual-list/transactions');
    expect(res.body.items[0].timestamp).toBe(MOCK_DATE.getTime());
  });

  it('rowHeight is at least the ESTIMATED_ROW_HEIGHT fallback (64px)', async () => {
    const tx = makeTx({ humanReadable: null, hash: 'x' });
    (prismaMock.transaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([tx]);
    (prismaMock.transaction.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    const res = await request(app).get('/api/v1/virtual-list/transactions');
    expect(res.body.items[0].rowHeight).toBeGreaterThanOrEqual(64);
  });

  it('rowHeight grows with longer humanReadable content', async () => {
    const short = makeTx({ humanReadable: 'short' });
    const long = makeTx({ humanReadable: 'A'.repeat(500) });

    (prismaMock.transaction.findMany as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([short])
      .mockResolvedValueOnce([long]);
    (prismaMock.transaction.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    const res1 = await request(app).get('/api/v1/virtual-list/transactions');
    const res2 = await request(app).get('/api/v1/virtual-list/transactions');

    expect(res2.body.items[0].rowHeight).toBeGreaterThan(res1.body.items[0].rowHeight);
  });

  it('returns hasMore=true when more records exist', async () => {
    (prismaMock.transaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
      Array(50).fill(makeTx()),
    );
    (prismaMock.transaction.count as ReturnType<typeof vi.fn>).mockResolvedValue(200);

    const res = await request(app).get('/api/v1/virtual-list/transactions?offset=0&limit=50');
    expect(res.body.hasMore).toBe(true);
    expect(res.body.totalCount).toBe(200);
  });

  it('returns hasMore=false on last page', async () => {
    (prismaMock.transaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeTx()]);
    (prismaMock.transaction.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    const res = await request(app).get('/api/v1/virtual-list/transactions?offset=0&limit=50');
    expect(res.body.hasMore).toBe(false);
  });

  it('respects the displayDims shape', async () => {
    (prismaMock.transaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeTx()]);
    (prismaMock.transaction.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    const res = await request(app).get('/api/v1/virtual-list/transactions');
    const dims = res.body.items[0].displayDims;
    expect(dims).toHaveProperty('height');
    expect(dims).toHaveProperty('components');
    expect(dims.components).toHaveProperty('avatarSize');
    expect(dims.components).toHaveProperty('titleHeight');
    expect(dims.components).toHaveProperty('bodyHeight');
    expect(dims.components).toHaveProperty('metaHeight');
    expect(dims.components).toHaveProperty('padding');
  });

  it('passes humanReadable through findMany select clause (query shape)', async () => {
    (prismaMock.transaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeTx()]);
    (prismaMock.transaction.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    await request(app).get('/api/v1/virtual-list/transactions');

    const callArgs = (prismaMock.transaction.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // humanReadable must be in the select clause
    expect(callArgs.select).toHaveProperty('humanReadable', true);
    // decodedDescription must NOT be in the select clause (phantom field)
    expect(callArgs.select).not.toHaveProperty('decodedDescription');
  });

  it('contractAddress defaults to empty string when null', async () => {
    const tx = makeTx({ contractAddress: null });
    (prismaMock.transaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([tx]);
    (prismaMock.transaction.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    const res = await request(app).get('/api/v1/virtual-list/transactions');
    expect(res.body.items[0].contractAddress).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Phase 2 — Validator logic unit tests
// ---------------------------------------------------------------------------

describe('validate-prisma-references logic', () => {
  it('parsePrismaSchema extracts Transaction.humanReadable correctly', async () => {
    // Inline a mini schema to test the parser without filesystem dependency
    const { parsePrismaSchema } = await import('../../scripts/validate-prisma-references');
    const path = await import('path');
    const schemaPath = path.resolve(__dirname, '../../prisma/schema.prisma');
    const models = parsePrismaSchema(schemaPath);

    const txModel = models.get('Transaction');
    expect(txModel).toBeDefined();
    const humanReadableField = txModel!.fields.find((f) => f.name === 'humanReadable');
    expect(humanReadableField).toBeDefined();
    expect(humanReadableField!.type).toBe('String');
    expect(humanReadableField!.isOptional).toBe(true);
  });

  it('parsePrismaSchema does NOT expose decodedDescription on Transaction', async () => {
    const { parsePrismaSchema } = await import('../../scripts/validate-prisma-references');
    const path = await import('path');
    const schemaPath = path.resolve(__dirname, '../../prisma/schema.prisma');
    const models = parsePrismaSchema(schemaPath);

    const txModel = models.get('Transaction');
    expect(txModel).toBeDefined();
    const phantom = txModel!.fields.find((f) => f.name === 'decodedDescription');
    expect(phantom).toBeUndefined();
  });
});
