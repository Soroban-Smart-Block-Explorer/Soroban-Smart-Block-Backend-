import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import * as db from '../../src/db';

vi.mock('../../src/db', () => ({
  prismaRead: {
    contract: { findMany: vi.fn() },
    stellarAccount: { findMany: vi.fn() },
    transaction: { findMany: vi.fn() },
    event: { findMany: vi.fn() },
    token: { findMany: vi.fn() },
    governanceProposal: { findMany: vi.fn() },
  },
}));

vi.mock('../../src/middleware/asyncHandler', () => ({
  asyncHandler: (fn: any) => (req: any, res: any, next: any) =>
    Promise.resolve(fn(req, res, next)).catch(next),
}));

import { hydrationRouter } from '../../src/api/hydration';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/hydration', hydrationRouter);
  return app;
}

function resetMocks() {
  vi.clearAllMocks();
  vi.mocked(db.prismaRead.contract.findMany).mockResolvedValue([]);
  vi.mocked(db.prismaRead.stellarAccount.findMany).mockResolvedValue([]);
  vi.mocked(db.prismaRead.transaction.findMany).mockResolvedValue([]);
  vi.mocked(db.prismaRead.event.findMany).mockResolvedValue([]);
  vi.mocked(db.prismaRead.token.findMany).mockResolvedValue([]);
  vi.mocked(db.prismaRead.governanceProposal.findMany).mockResolvedValue([]);
}

describe('POST /hydration/entities', () => {
  beforeEach(resetMocks);

  it('rejects an empty refs array', async () => {
    const res = await request(makeApp()).post('/hydration/entities').send({ refs: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid hydration request');
  });

  it('rejects more than 50 refs', async () => {
    const refs = Array.from({ length: 51 }, (_, i) => ({ type: 'contract', id: `C${i}` }));
    const res = await request(makeApp()).post('/hydration/entities').send({ refs });
    expect(res.status).toBe(400);
  });

  it('rejects unknown entity types', async () => {
    const res = await request(makeApp())
      .post('/hydration/entities')
      .send({ refs: [{ type: 'unknown', id: 'x' }] });
    expect(res.status).toBe(400);
  });

  it('returns summaries in request order and omits unknown refs', async () => {
    vi.mocked(db.prismaRead.contract.findMany).mockResolvedValue([
      {
        address: 'C_USDC',
        name: 'USD Coin',
        tokenName: null,
        tokenSymbol: 'USDC',
        isToken: true,
        isVerified: true,
        updatedAt: new Date('2026-06-01T00:00:00.000Z'),
      },
    ] as any);

    const res = await request(makeApp())
      .post('/hydration/entities')
      .send({
        refs: [
          { type: 'wallet', id: 'G_MISSING' },
          { type: 'contract', id: 'C_USDC' },
          { type: 'contract', id: 'C_MISSING' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.entities).toHaveLength(1);
    expect(res.body.entities[0]).toEqual({
      type: 'contract',
      id: 'C_USDC',
      label: 'USD Coin',
      sublabel: 'USDC',
      status: 'verified',
      updatedAt: '2026-06-01T00:00:00.000Z',
    });
  });

  it('marks unverified contracts', async () => {
    vi.mocked(db.prismaRead.contract.findMany).mockResolvedValue([
      {
        address: 'C_PLAIN',
        name: null,
        tokenName: null,
        tokenSymbol: null,
        isToken: false,
        isVerified: false,
        updatedAt: new Date('2026-06-01T00:00:00.000Z'),
      },
    ] as any);

    const res = await request(makeApp())
      .post('/hydration/entities')
      .send({ refs: [{ type: 'contract', id: 'C_PLAIN' }] });

    expect(res.body.entities[0]).toEqual(
      expect.objectContaining({ label: 'C_PLAIN', sublabel: 'Contract', status: 'unverified' }),
    );
  });

  it('summarises wallets with balance and funds status', async () => {
    vi.mocked(db.prismaRead.stellarAccount.findMany).mockResolvedValue([
      {
        address: 'G_WALLET',
        homeDomain: 'example.com',
        xlmBalance: '12.5',
        isActivated: true,
        lastActivity: new Date('2026-06-02T00:00:00.000Z'),
      },
      {
        address: 'G_EMPTY',
        homeDomain: null,
        xlmBalance: '0',
        isActivated: false,
        lastActivity: null,
      },
    ] as any);

    const res = await request(makeApp())
      .post('/hydration/entities')
      .send({
        refs: [
          { type: 'wallet', id: 'G_WALLET' },
          { type: 'wallet', id: 'G_EMPTY' },
        ],
      });

    expect(res.body.entities[0]).toEqual(
      expect.objectContaining({ label: 'example.com', sublabel: '12.5 XLM' }),
    );
    expect(res.body.entities[1]).toEqual(
      expect.objectContaining({ label: 'G_EMPTY', status: 'unfunded' }),
    );
  });

  it('queries each model with the matching id field', async () => {
    await request(makeApp())
      .post('/hydration/entities')
      .send({
        refs: [
          { type: 'contract', id: 'C1' },
          { type: 'wallet', id: 'G1' },
          { type: 'transaction', id: 'TX1' },
          { type: 'event', id: 'EV1' },
          { type: 'token', id: 'T1' },
          { type: 'proposal', id: 'P1' },
        ],
      });

    expect(db.prismaRead.contract.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { address: { in: ['C1'] } } }),
    );
    expect(db.prismaRead.transaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { hash: { in: ['TX1'] } } }),
    );
    expect(db.prismaRead.event.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['EV1'] } } }),
    );
    expect(db.prismaRead.governanceProposal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['P1'] } } }),
    );
  });

  it('skips empty lookups for types not present in the request', async () => {
    await request(makeApp())
      .post('/hydration/entities')
      .send({ refs: [{ type: 'contract', id: 'C1' }] });

    expect(db.prismaRead.transaction.findMany).not.toHaveBeenCalled();
    expect(db.prismaRead.stellarAccount.findMany).not.toHaveBeenCalled();
  });

  it('deduplicates repeated ids before querying', async () => {
    await request(makeApp())
      .post('/hydration/entities')
      .send({
        refs: [
          { type: 'contract', id: 'C1' },
          { type: 'contract', id: 'C1' },
        ],
      });

    expect(db.prismaRead.contract.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { address: { in: ['C1'] } } }),
    );
  });
});
