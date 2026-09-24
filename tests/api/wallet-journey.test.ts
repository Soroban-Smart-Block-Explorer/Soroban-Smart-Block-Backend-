/**
 * Tests for the unified wallet journey endpoint (src/api/wallets.ts):
 *   GET /wallets/:address/journey
 *
 * Verifies that transactions, events, governance votes, and derived token
 * changes are merged onto one time axis, that token-moving events are emitted
 * as typed `token_change` items with signed deltas, and that pagination walks
 * time (exclusive `before` cursor) rather than offsets.
 *
 * Prisma is mocked through the service container so no database is required.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';

vi.mock('../../src/services/container', () => {
  const model = () => ({
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
  });
  const client = {
    transaction: model(),
    event: model(),
    governanceVote: model(),
    ledger: model(),
  };
  return { container: { getPrismaRead: () => client } };
});

vi.mock('../../src/stellar/horizon-client', () => ({
  fetchHorizonOperations: vi.fn().mockResolvedValue({ records: [] }),
}));

import { container } from '../../src/services/container';
import { walletRouter } from '../../src/api/wallets';

const prisma = container.getPrismaRead() as any;

const app = express();
app.use(express.json());
app.use('/wallets', walletRouter);
app.use((err: Error, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) return next(err);
  const status = err.name === 'ZodError' ? 400 : 500;
  res.status(status).json({ error: err.message });
});

const ADDRESS = Keypair.random().publicKey();
const OTHER = Keypair.random().publicKey();
const CONTRACT = 'CGOVCONTRACT1';

function txRow(overrides: Record<string, unknown> = {}) {
  return {
    hash: 'a'.repeat(64),
    ledgerSequence: 300,
    ledgerCloseTime: new Date('2026-06-19T07:24:26.000Z'),
    status: 'success',
    contractAddress: CONTRACT,
    functionName: 'swap',
    humanReadable: 'swapped 100 USDC for 98.7 XLM',
    ...overrides,
  };
}

function transferEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt-transfer-1',
    transactionHash: 'b'.repeat(64),
    contractAddress: CONTRACT,
    eventType: 'transfer',
    topicSymbol: 'transfer',
    decoded: { from: OTHER, to: ADDRESS, amount: '100', asset: 'USDC' },
    ledgerSequence: 300,
    ledgerCloseTime: new Date('2026-06-19T07:24:26.000Z'),
    ...overrides,
  };
}

function customEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt-swap-1',
    transactionHash: 'c'.repeat(64),
    contractAddress: CONTRACT,
    eventType: 'swap',
    topicSymbol: 'swap',
    decoded: { from: ADDRESS, amount_in: '10', amount_out: '9' },
    ledgerSequence: 299,
    ledgerCloseTime: new Date('2026-06-19T07:23:00.000Z'),
    ...overrides,
  };
}

function voteRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'vote-1',
    contractAddress: CONTRACT,
    proposalId: '7',
    support: 'for',
    weight: '500',
    reason: null,
    transactionHash: null,
    ledgerSequence: 310,
    createdAt: new Date('2026-06-19T07:05:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.transaction.findMany.mockResolvedValue([txRow()]);
  prisma.event.findMany.mockResolvedValue([transferEvent(), customEvent()]);
  prisma.governanceVote.findMany.mockResolvedValue([voteRow()]);
  prisma.ledger.findMany.mockResolvedValue([
    { sequence: 310, closeTime: new Date('2026-06-19T07:10:00.000Z') },
  ]);
});

describe('GET /wallets/:address/journey', () => {
  it('merges all four sources into one newest-first typed timeline', async () => {
    const res = await request(app).get(`/wallets/${ADDRESS}/journey`);

    expect(res.status).toBe(200);
    expect(res.body.data.map((item: any) => item.type)).toEqual([
      'token_change',
      'transaction',
      'event',
      'governance_vote',
    ]);
    expect(res.body.counts).toEqual({
      transaction: 1,
      event: 1,
      token_change: 1,
      governance_vote: 1,
    });
    expect(res.body.hasMore).toBe(false);
  });

  it('resolves token-moving events into signed token_change deltas', async () => {
    const res = await request(app).get(`/wallets/${ADDRESS}/journey`);

    const tokenChange = res.body.data.find((item: any) => item.type === 'token_change');
    expect(tokenChange).toMatchObject({
      asset: 'USDC',
      direction: 'in',
      amount: '100',
      delta: '+100',
      from: OTHER,
      to: ADDRESS,
      counterparty: OTHER,
      ledgerSequence: 300,
    });

    // The non-token event survives as a plain `event` item with its payload.
    const event = res.body.data.find((item: any) => item.type === 'event');
    expect(event).toMatchObject({ eventType: 'swap', topicSymbol: 'swap' });
  });

  it('aligns governance votes to ledger close time when the ledger is known', async () => {
    const res = await request(app).get(`/wallets/${ADDRESS}/journey`);

    const vote = res.body.data.find((item: any) => item.type === 'governance_vote');
    expect(vote.timestamp).toBe('2026-06-19T07:10:00.000Z');
    expect(vote).toMatchObject({ proposalId: '7', support: 'for', weight: '500' });
  });

  it('paginates by time, passing the exclusive cursor to every source', async () => {
    const before = '2026-06-20T00:00:00.000Z';
    const res = await request(app).get(`/wallets/${ADDRESS}/journey`).query({ before, limit: 2 });

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.hasMore).toBe(true);
    // Cursor = oldest item on the returned page.
    expect(res.body.nextCursor).toBe(res.body.data[1].timestamp);

    const cursor = { lt: new Date(before) };
    expect(prisma.transaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ sourceAccount: ADDRESS, ledgerCloseTime: cursor }),
      }),
    );
    expect(prisma.event.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ ledgerCloseTime: cursor }),
      }),
    );
    expect(prisma.governanceVote.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ voter: ADDRESS, createdAt: cursor }),
      }),
    );
  });

  it('omits the time filter when no cursor is supplied', async () => {
    await request(app).get(`/wallets/${ADDRESS}/journey`);

    const call = prisma.transaction.findMany.mock.calls[0][0];
    expect(call.where.ledgerCloseTime).toBeUndefined();
  });

  it('rejects an invalid Stellar address', async () => {
    const res = await request(app).get('/wallets/not-an-address/journey');
    expect(res.status).toBe(400);
  });

  it('rejects a malformed time cursor', async () => {
    const res = await request(app)
      .get(`/wallets/${ADDRESS}/journey`)
      .query({ before: 'yesterday' });
    expect(res.status).toBe(400);
  });
});
