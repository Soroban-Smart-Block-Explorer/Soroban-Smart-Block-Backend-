import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';

import { treasuryRouter } from '../../src/api/treasury';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/treasury', treasuryRouter);
  return app;
}

describe('GET /treasury', () => {
  it('returns service overview', async () => {
    const res = await request(makeApp()).get('/treasury');
    expect(res.status).toBe(200);
    expect(res.body.service).toBe('Treasury API');
    expect(Array.isArray(res.body.endpoints)).toBe(true);
  });
});

describe('GET /treasury/balances', () => {
  it('returns empty balances with totalValueUSD', async () => {
    const res = await request(makeApp()).get('/treasury/balances');
    expect(res.status).toBe(200);
    expect(res.body.totalValueUSD).toBe(0);
    expect(Array.isArray(res.body.balances)).toBe(true);
  });
});

describe('GET /treasury/balances/:assetCode', () => {
  it('returns balance for specific asset', async () => {
    const res = await request(makeApp()).get('/treasury/balances/USDC');
    expect(res.status).toBe(200);
    expect(res.body.assetCode).toBe('USDC');
    expect(res.body.balance).toBe(0);
  });

  it('uppercases the asset code', async () => {
    const res = await request(makeApp()).get('/treasury/balances/xlm');
    expect(res.body.assetCode).toBe('XLM');
  });
});

describe('GET /treasury/proposals', () => {
  it('returns empty proposals list', async () => {
    const res = await request(makeApp()).get('/treasury/proposals');
    expect(res.status).toBe(200);
    expect(res.body.proposals).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  it('passes status filter through', async () => {
    const res = await request(makeApp()).get('/treasury/proposals?status=pending');
    expect(res.status).toBe(200);
    expect(res.body.filter.status).toBe('pending');
  });

  it('respects limit query param (max 100)', async () => {
    const res = await request(makeApp()).get('/treasury/proposals?limit=999');
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(100);
  });
});

describe('POST /treasury/proposals', () => {
  const validProposal = {
    title: 'Fund development',
    description: 'Fund new feature development for Q3',
    amount: 10000,
    assetCode: 'USDC',
    recipient: 'GA_DEV_TEAM',
    category: 'development',
  };

  it('creates a proposal and returns 201', async () => {
    const res = await request(makeApp()).post('/treasury/proposals').send(validProposal);

    expect(res.status).toBe(201);
    expect(res.body.id).toMatch(/^prop_/);
    expect(res.body.status).toBe('pending');
    expect(res.body.title).toBe('Fund development');
    expect(res.body.votes).toEqual({ for: 0, against: 0 });
  });

  it('returns 400 for missing required fields', async () => {
    const res = await request(makeApp()).post('/treasury/proposals').send({ title: 'Incomplete' });

    expect(res.status).toBe(400);
  });

  it('returns 400 for negative amount', async () => {
    const res = await request(makeApp())
      .post('/treasury/proposals')
      .send({ ...validProposal, amount: -100 });

    expect(res.status).toBe(400);
  });

  it('uses default category "other" when not specified', async () => {
    const { category, ...withoutCategory } = validProposal;
    const res = await request(makeApp()).post('/treasury/proposals').send(withoutCategory);

    expect(res.status).toBe(201);
    expect(res.body.category).toBe('other');
  });
});

describe('GET /treasury/proposals/:id', () => {
  it('returns 404 for unknown proposal', async () => {
    const res = await request(makeApp()).get('/treasury/proposals/nonexistent');
    expect(res.status).toBe(404);
    expect(res.body.proposalId).toBe('nonexistent');
  });
});

describe('POST /treasury/proposals/:id/vote', () => {
  it('records a vote and returns confirmation', async () => {
    const res = await request(makeApp())
      .post('/treasury/proposals/prop_123/vote')
      .send({ voter: 'GA_VOTER', support: true, signature: 'sig_abc' });

    expect(res.status).toBe(200);
    expect(res.body.proposalId).toBe('prop_123');
    expect(res.body.support).toBe(true);
  });

  it('returns 400 for missing voter', async () => {
    const res = await request(makeApp())
      .post('/treasury/proposals/prop_123/vote')
      .send({ support: true, signature: 'sig_abc' });

    expect(res.status).toBe(400);
  });
});

describe('GET /treasury/transactions', () => {
  it('returns empty transactions list', async () => {
    const res = await request(makeApp()).get('/treasury/transactions');
    expect(res.status).toBe(200);
    expect(res.body.transactions).toEqual([]);
  });

  it('respects limit query param (max 200)', async () => {
    const res = await request(makeApp()).get('/treasury/transactions?limit=999');
    expect(res.body.limit).toBe(200);
  });
});

describe('GET /treasury/allocations', () => {
  it('returns allocation breakdown', async () => {
    const res = await request(makeApp()).get('/treasury/allocations');
    expect(res.status).toBe(200);
    expect(res.body.allocations).toHaveProperty('development');
    expect(res.body.allocations).toHaveProperty('security');
    expect(res.body.totalUSD).toBe(0);
  });
});

describe('GET /treasury/stats', () => {
  it('returns treasury statistics', async () => {
    const res = await request(makeApp()).get('/treasury/stats');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('totalValueUSD');
    expect(res.body).toHaveProperty('totalProposals');
    expect(res.body).toHaveProperty('runwayMonths');
  });
});
