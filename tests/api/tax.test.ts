import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { taxRouter } from '../../src/api/tax';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/tax', taxRouter);
  return app;
}

describe('GET /tax', () => {
  it('returns service overview', async () => {
    const res = await request(makeApp()).get('/tax');
    expect(res.status).toBe(200);
    expect(res.body.service).toBe('Tax API');
    expect(Array.isArray(res.body.endpoints)).toBe(true);
    expect(Array.isArray(res.body.methods)).toBe(true);
  });
});

describe('GET /tax/accounts/:address/summary', () => {
  it('returns tax summary with zero values', async () => {
    const res = await request(makeApp()).get('/tax/accounts/GA_TEST/summary');
    expect(res.status).toBe(200);
    expect(res.body.address).toBe('GA_TEST');
    expect(res.body.netGainsUSD).toBe(0);
    expect(res.body).toHaveProperty('taxYear');
    expect(res.body).toHaveProperty('disclaimer');
  });

  it('uses provided year query param', async () => {
    const res = await request(makeApp()).get('/tax/accounts/GA_TEST/summary?year=2023');
    expect(res.body.taxYear).toBe(2023);
  });
});

describe('GET /tax/accounts/:address/gains', () => {
  it('returns capital gains data', async () => {
    const res = await request(makeApp()).get('/tax/accounts/GA_TEST/gains');
    expect(res.status).toBe(200);
    expect(res.body.address).toBe('GA_TEST');
    expect(res.body.gains).toEqual([]);
    expect(res.body.method).toBe('FIFO');
  });

  it('respects method query param', async () => {
    const res = await request(makeApp()).get('/tax/accounts/GA_TEST/gains?method=LIFO');
    expect(res.body.method).toBe('LIFO');
  });
});

describe('GET /tax/accounts/:address/income', () => {
  it('returns income events breakdown', async () => {
    const res = await request(makeApp()).get('/tax/accounts/GA_TEST/income');
    expect(res.status).toBe(200);
    expect(res.body.incomeEvents).toEqual([]);
    expect(res.body.byCategory).toHaveProperty('staking');
    expect(res.body.byCategory).toHaveProperty('yield');
    expect(res.body.byCategory).toHaveProperty('airdrops');
  });
});

describe('POST /tax/accounts/:address/report', () => {
  it('generates a tax report', async () => {
    const res = await request(makeApp())
      .post('/tax/accounts/GA_TEST/report')
      .send({ year: 2024, format: 'json', method: 'FIFO' });

    expect(res.status).toBe(200);
    expect(res.body.reportId).toMatch(/^tax_report_/);
    expect(res.body.taxYear).toBe(2024);
    expect(res.body.format).toBe('json');
    expect(res.body.status).toBe('generated');
    expect(res.body).toHaveProperty('disclaimer');
  });

  it('uses default values when body is empty', async () => {
    const res = await request(makeApp()).post('/tax/accounts/GA_TEST/report').send({});

    expect(res.status).toBe(200);
    expect(res.body.method).toBe('FIFO');
    expect(res.body.format).toBe('json');
  });

  it('returns 400 for invalid format', async () => {
    const res = await request(makeApp())
      .post('/tax/accounts/GA_TEST/report')
      .send({ format: 'xml' });

    expect(res.status).toBe(400);
  });

  it('returns 400 for year out of range', async () => {
    const res = await request(makeApp()).post('/tax/accounts/GA_TEST/report').send({ year: 1990 });

    expect(res.status).toBe(400);
  });
});

describe('GET /tax/accounts/:address/cost-basis', () => {
  it('returns cost basis data', async () => {
    const res = await request(makeApp()).get('/tax/accounts/GA_TEST/cost-basis');
    expect(res.status).toBe(200);
    expect(res.body.address).toBe('GA_TEST');
    expect(res.body.holdings).toEqual([]);
    expect(res.body.totalCostBasisUSD).toBe(0);
  });
});

describe('GET /tax/rates', () => {
  it('returns tax rates by jurisdiction', async () => {
    const res = await request(makeApp()).get('/tax/rates');
    expect(res.status).toBe(200);
    expect(res.body.rates).toHaveProperty('US');
    expect(res.body.rates).toHaveProperty('UK');
    expect(res.body.rates).toHaveProperty('DE');
    expect(res.body).toHaveProperty('disclaimer');
  });
});
