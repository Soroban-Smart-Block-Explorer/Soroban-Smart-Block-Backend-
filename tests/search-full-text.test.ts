import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../src/db', () => {
  const mockPrisma = {
    $queryRawUnsafe: vi.fn(),
    $executeRawUnsafe: vi.fn(),
    searchDocument: { upsert: vi.fn(), deleteMany: vi.fn() },
    searchIndexEntry: { findMany: vi.fn() },
    contractSource: { findMany: vi.fn() },
    transaction: { findMany: vi.fn() },
    event: { findMany: vi.fn() },
    contract: { findMany: vi.fn() },
  };
  return { prismaRead: mockPrisma, prismaWrite: mockPrisma };
});

import * as db from '../src/db';
import {
  buildContractContent,
  buildEventContent,
  buildTransactionContent,
  indexSearchDocument,
  indexSafely,
  indexTransaction,
  searchFullText,
  rebuildSearchIndex,
} from '../src/services/search/full-text-search';
import { searchRouter } from '../src/api/search';

// ── Content builders ────────────────────────────────────────────────────────

describe('search content builders', () => {
  it('folds transaction metadata into searchable content', () => {
    const content = buildTransactionContent({
      hash: 'abc123',
      sourceAccount: 'GSOURCE',
      contractAddress: 'CCONTRACT',
      functionName: 'transfer',
      humanReadable: 'Alice paid Bob 10 XLM',
      status: 'success',
      functionArgs: { amount: 10 },
    });

    expect(content).toContain('abc123');
    expect(content).toContain('transfer');
    expect(content).toContain('Alice paid Bob 10 XLM');
    expect(content).toContain('"amount":10');
  });

  it('folds decoded event payloads into searchable content', () => {
    const content = buildEventContent({
      contractAddress: 'CCONTRACT',
      eventType: 'transfer',
      topicSymbol: 'transfer',
      decoded: { from: 'GALICE', to: 'GBOB', amount: '1000' },
    });

    expect(content).toContain('CCONTRACT');
    expect(content).toContain('transfer');
    expect(content).toContain('GALICE');
    expect(content).toContain('GBOB');
  });

  it('joins contract function signatures', () => {
    const content = buildContractContent({
      address: 'CCONTRACT',
      name: 'StellarSwap',
      description: 'An automated market maker',
      functionSignatures: ['swap(a,b)', 'add_liquidity(x,y)'],
    });

    expect(content).toContain('StellarSwap');
    expect(content).toContain('An automated market maker');
    expect(content).toContain('swap(a,b)');
    expect(content).toContain('add_liquidity(x,y)');
  });
});

// ── Indexing ────────────────────────────────────────────────────────────────

describe('indexing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('upserts documents keyed by (docType, docId)', async () => {
    await indexSearchDocument({
      docType: 'contract',
      docId: 'C1',
      content: 'hello',
      metadata: { address: 'C1' },
    });

    expect(db.prismaWrite.searchDocument.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { docType_docId: { docType: 'contract', docId: 'C1' } },
        create: expect.objectContaining({ docType: 'contract', docId: 'C1', content: 'hello' }),
        update: { content: 'hello', metadata: { address: 'C1' } },
      }),
    );
  });

  it('indexes a transaction using its id as the document id', async () => {
    await indexTransaction({ id: 'tx-1', hash: 'deadbeef', functionName: 'swap' });

    expect(db.prismaWrite.searchDocument.upsert).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(db.prismaWrite.searchDocument.upsert).mock.calls[0][0] as any;
    expect(arg.create.docType).toBe('transaction');
    expect(arg.create.docId).toBe('tx-1');
    expect(arg.create.content).toContain('deadbeef');
  });

  it('swallows indexing failures so ingestion is never blocked', async () => {
    vi.mocked(db.prismaWrite.searchDocument.upsert).mockRejectedValueOnce(new Error('db down'));

    await expect(
      indexSafely('contract', () =>
        indexSearchDocument({ docType: 'contract', docId: 'C1', content: 'x' }),
      ),
    ).resolves.toBeUndefined();
  });
});

// ── Ranked query ────────────────────────────────────────────────────────────

describe('searchFullText', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ranks and highlights via Postgres FTS and paginates the response', async () => {
    vi.mocked(db.prismaRead.$queryRawUnsafe).mockImplementation(
      (sql: string) =>
        Promise.resolve(
          String(sql).includes('COUNT')
            ? [{ count: 7 }]
            : [
                {
                  doc_type: 'contract',
                  doc_id: 'C1',
                  content: 'Stellar Swap',
                  metadata: { address: 'C1' },
                  score: 0.87,
                  highlight: '<mark>Stellar</mark> Swap',
                },
              ],
        ) as any,
    );

    const page = await searchFullText({ q: 'stellar', type: 'contract', limit: 5, offset: 0 });

    expect(page.total).toBe(7);
    expect(page.limit).toBe(5);
    expect(page.type).toBe('contract');
    expect(page.results).toHaveLength(1);
    expect(page.results[0]).toMatchObject({
      docType: 'contract',
      docId: 'C1',
      score: 0.87,
      highlight: '<mark>Stellar</mark> Swap',
    });

    const listSql = vi
      .mocked(db.prismaRead.$queryRawUnsafe)
      .mock.calls.find(([sql]) => String(sql).includes('ts_rank'))?.[0] as string;
    expect(listSql).toContain(`"search_vector" @@ websearch_to_tsquery`);
    expect(listSql).toContain('ts_headline');
    expect(listSql).toContain('ORDER BY "score" DESC');
  });

  it('passes the type filter as a bound parameter', async () => {
    vi.mocked(db.prismaRead.$queryRawUnsafe).mockResolvedValue([] as any);

    await searchFullText({ q: 'swap', type: 'event' });

    const args = vi.mocked(db.prismaRead.$queryRawUnsafe).mock.calls[0];
    expect(String(args[0])).toContain(`"doc_type" = $2`);
    expect(args).toContain('event');
  });

  it('omits ts_headline when highlighting is disabled', async () => {
    vi.mocked(db.prismaRead.$queryRawUnsafe).mockResolvedValue([] as any);

    await searchFullText({ q: 'swap', highlight: false });

    const listSql = vi
      .mocked(db.prismaRead.$queryRawUnsafe)
      .mock.calls.find(([sql]) => String(sql).includes('ts_rank'))?.[0] as string;
    expect(listSql).not.toContain('ts_headline');
  });

  it('short-circuits empty queries without touching the database', async () => {
    const page = await searchFullText({ q: '   ' });

    expect(page.total).toBe(0);
    expect(page.results).toEqual([]);
    expect(db.prismaRead.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});

// ── Full rebuild ────────────────────────────────────────────────────────────

describe('rebuildSearchIndex', () => {
  beforeEach(() => vi.clearAllMocks());

  it('clears and repopulates the index from primary tables', async () => {
    vi.mocked(db.prismaRead.transaction.findMany)
      .mockResolvedValueOnce([{ id: 'tx-1', hash: 'h1', status: 'success' }] as any)
      .mockResolvedValueOnce([] as any);
    vi.mocked(db.prismaRead.event.findMany)
      .mockResolvedValueOnce([{ id: 'ev-1', contractAddress: 'C1', eventType: 'transfer' }] as any)
      .mockResolvedValueOnce([] as any);
    vi.mocked(db.prismaRead.contract.findMany)
      .mockResolvedValueOnce([{ id: 'c1', address: 'C1', name: 'Swap' }] as any)
      .mockResolvedValueOnce([] as any);

    const result = await rebuildSearchIndex(10);

    expect(db.prismaWrite.searchDocument.deleteMany).toHaveBeenCalledWith({});
    expect(result.indexed).toBe(3);
    expect(db.prismaWrite.searchDocument.upsert).toHaveBeenCalledTimes(3);
  });
});

// ── Route ───────────────────────────────────────────────────────────────────

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/search', searchRouter);
  return app;
}

describe('GET /api/v1/search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.prismaRead.$queryRawUnsafe).mockImplementation(
      (sql: string) =>
        Promise.resolve(
          String(sql).includes('COUNT')
            ? [{ count: 2 }]
            : [
                {
                  doc_type: 'transaction',
                  doc_id: 'tx-1',
                  content: 'swap on C1',
                  metadata: { hash: 'h1' },
                  score: 0.5,
                  highlight: '<mark>swap</mark> on C1',
                },
              ],
        ) as any,
    );
  });

  it('returns ranked, highlighted results for a typed query', async () => {
    const res = await request(makeApp()).get('/api/v1/search?q=swap&type=transaction');

    expect(res.status).toBe(200);
    expect(res.body.type).toBe('transaction');
    expect(res.body.total).toBe(2);
    expect(res.body.results[0].highlight).toContain('<mark>swap</mark>');
  });

  it('supports type=all', async () => {
    const res = await request(makeApp()).get('/api/v1/search?q=swap&type=all');

    expect(res.status).toBe(200);
    expect(res.body.type).toBe('all');
  });

  it('rejects an unknown type with 400', async () => {
    const res = await request(makeApp()).get('/api/v1/search?q=swap&type=wallet');

    expect(res.status).toBe(400);
  });

  it('rejects queries shorter than 2 characters with 400', async () => {
    const res = await request(makeApp()).get('/api/v1/search?q=a&type=contract');

    expect(res.status).toBe(400);
  });

  it('keeps the legacy faceted search when no type is supplied', async () => {
    vi.mocked(db.prismaRead.searchIndexEntry.findMany).mockResolvedValue([] as any);

    const res = await request(makeApp()).get('/api/v1/search?q=transfer');

    expect(res.status).toBe(200);
    expect(db.prismaRead.searchIndexEntry.findMany).toHaveBeenCalled();
    expect(db.prismaRead.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});
