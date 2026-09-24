import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../src/db', () => ({
  prismaRead: {
    poolSnapshot: { findMany: vi.fn().mockResolvedValue([]) },
    poolSwap: { findMany: vi.fn().mockResolvedValue([]) },
    dexPool: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    tokenPriceHistory: { findMany: vi.fn().mockResolvedValue([]) },
    tokenPrice: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    contract: { findMany: vi.fn().mockResolvedValue([]) },
    token: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

import * as db from '../../src/db';
import { seriesRouter } from '../../src/api/series';

const POOL = 'CPOOL1234567890';
const TOKEN = 'CTOKEN1234567890';
const HOUR = 3_600_000;
const BASE = new Date('2026-01-01T00:00:00.000Z');
const at = (h: number) => new Date(BASE.getTime() + h * HOUR);

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/series', seriesRouter);
  return app;
}

beforeEach(() => vi.clearAllMocks());

describe('GET /series/pools/:address', () => {
  const pool = {
    poolAddress: POOL,
    protocol: 'aquarius',
    dexName: 'Aquarius',
    tokenA: 'CA',
    tokenB: 'CB',
    tokenASymbol: 'USDC',
    tokenBSymbol: 'XLM',
    isActive: true,
  };

  it('returns bucketed pool metrics', async () => {
    vi.mocked(db.prismaRead.dexPool.findUnique).mockResolvedValue(pool as never);
    vi.mocked(db.prismaRead.poolSnapshot.findMany).mockResolvedValue([
      {
        createdAt: at(0),
        tvlUsd: 100,
        volume24hUsd: 10,
        fees24hUsd: 1,
        aprPct: 5,
        priceAUsd: 1,
        priceBUsd: 2,
      },
      {
        createdAt: at(1),
        tvlUsd: 200,
        volume24hUsd: 20,
        fees24hUsd: 2,
        aprPct: 6,
        priceAUsd: 2,
        priceBUsd: 3,
      },
      {
        createdAt: at(2),
        tvlUsd: 300,
        volume24hUsd: 30,
        fees24hUsd: 3,
        aprPct: 7,
        priceAUsd: 3,
        priceBUsd: 4,
      },
    ] as never);
    vi.mocked(db.prismaRead.poolSwap.findMany).mockResolvedValue([
      { ledgerCloseTime: at(0.2) },
      { ledgerCloseTime: at(0.8) },
      { ledgerCloseTime: at(1.5) },
    ] as never);

    const res = await request(makeApp()).get(
      `/series/pools/${POOL}?metrics=volume,tvl,trades&interval=1h&window=24h`,
    );

    expect(res.status).toBe(200);
    expect(res.body.poolAddress).toBe(POOL);
    expect(res.body.series.volume).toMatchObject({
      unit: 'usd',
      aggregation: 'last',
      interval: '1h',
    });
    expect(res.body.series.volume.sparkline).toEqual([10, 20, 30]);
    expect(res.body.series.volume.points).toHaveLength(3);
    expect(res.body.series.tvl.sparkline).toEqual([100, 200, 300]);
    expect(res.body.series.trades.sparkline).toEqual([2, 1]);
    expect(res.body.series.volume.stats).toMatchObject({ first: 10, last: 30, changePct: 200 });
  });

  it('omits points in sparkline format', async () => {
    vi.mocked(db.prismaRead.dexPool.findUnique).mockResolvedValue(pool as never);
    vi.mocked(db.prismaRead.poolSnapshot.findMany).mockResolvedValue([
      {
        createdAt: at(0),
        tvlUsd: 1,
        volume24hUsd: 1,
        fees24hUsd: 1,
        aprPct: 1,
        priceAUsd: 1,
        priceBUsd: 1,
      },
    ] as never);

    const res = await request(makeApp()).get(
      `/series/pools/${POOL}?metrics=volume&interval=1h&format=sparkline`,
    );

    expect(res.status).toBe(200);
    expect(res.body.series.volume.points).toBeUndefined();
    expect(res.body.series.volume.sparkline).toHaveLength(1);
  });

  it('returns 404 when the pool is unknown', async () => {
    vi.mocked(db.prismaRead.dexPool.findUnique).mockResolvedValue(null);

    const res = await request(makeApp()).get(`/series/pools/${POOL}?metrics=volume`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Pool not found');
  });

  it('returns 400 for an unknown metric', async () => {
    const res = await request(makeApp()).get(`/series/pools/${POOL}?metrics=nope`);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Unknown metric');
  });

  it('returns 400 for an invalid interval', async () => {
    const res = await request(makeApp()).get(`/series/pools/${POOL}?interval=2h`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid query parameters');
  });
});

describe('GET /series/tokens/:address', () => {
  it('returns bucketed token price history', async () => {
    vi.mocked(db.prismaRead.tokenPrice.findUnique).mockResolvedValue({
      priceUsd: 3,
      volume24hUsd: 30,
      marketCapUsd: 300,
      liquidityUsd: 50,
      priceChange24h: 1,
      confidence: 0.9,
      source: 'composite',
    } as never);
    vi.mocked(db.prismaRead.tokenPriceHistory.findMany).mockResolvedValue([
      {
        timestamp: at(0),
        priceUsd: 1,
        priceXlm: 1,
        volume24hUsd: 5,
        marketCapUsd: 100,
        confidence: 0.8,
      },
      {
        timestamp: at(1),
        priceUsd: 2,
        priceXlm: 2,
        volume24hUsd: 15,
        marketCapUsd: 200,
        confidence: 0.9,
      },
    ] as never);

    const res = await request(makeApp()).get(
      `/series/tokens/${TOKEN}?metrics=price,volume&interval=1h`,
    );

    expect(res.status).toBe(200);
    expect(res.body.series.price.sparkline).toEqual([1, 2]);
    expect(res.body.series.price.stats.changePct).toBe(100);
    expect(res.body.series.volume.aggregation).toBe('avg');
  });

  it('returns 404 for an unknown token', async () => {
    vi.mocked(db.prismaRead.tokenPrice.findUnique).mockResolvedValue(null);
    vi.mocked(db.prismaRead.tokenPriceHistory.findMany).mockResolvedValue([]);

    const res = await request(makeApp()).get(`/series/tokens/${TOKEN}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Token not found');
  });
});

describe('GET /series/top/pools', () => {
  it('ranks pools and includes sparklines', async () => {
    vi.mocked(db.prismaRead.dexPool.findMany).mockResolvedValue([
      {
        poolAddress: 'P1',
        protocol: 'aquarius',
        dexName: 'Aquarius',
        tokenASymbol: 'USDC',
        tokenBSymbol: 'XLM',
        tvlUsd: 900,
        volume24hUsd: 90,
        fees24hUsd: 9,
        aprPct: 12,
      },
      {
        poolAddress: 'P2',
        protocol: 'soroswap',
        dexName: 'Soroswap',
        tokenASymbol: 'AQUA',
        tokenBSymbol: 'XLM',
        tvlUsd: 400,
        volume24hUsd: 40,
        fees24hUsd: 4,
        aprPct: 8,
      },
    ] as never);
    vi.mocked(db.prismaRead.poolSnapshot.findMany).mockResolvedValue([
      {
        poolAddress: 'P1',
        createdAt: at(0),
        tvlUsd: 800,
        volume24hUsd: 1,
        fees24hUsd: 1,
        aprPct: 1,
        priceAUsd: 1,
        priceBUsd: 1,
      },
      {
        poolAddress: 'P1',
        createdAt: at(1),
        tvlUsd: 900,
        volume24hUsd: 1,
        fees24hUsd: 1,
        aprPct: 1,
        priceAUsd: 1,
        priceBUsd: 1,
      },
    ] as never);

    const res = await request(makeApp()).get('/series/top/pools?metric=tvl&interval=1h');

    expect(res.status).toBe(200);
    expect(res.body.metric).toBe('tvl');
    expect(res.body.count).toBe(2);
    expect(res.body.data[0]).toMatchObject({ rank: 1, poolAddress: 'P1', value: 900 });
    expect(res.body.data[0].sparkline).toEqual([800, 900]);
    expect(res.body.data[0].changePct).toBeCloseTo(12.5);
    expect(res.body.data[1].sparkline).toEqual([]);
  });

  it('skips sparkline queries when disabled', async () => {
    vi.mocked(db.prismaRead.dexPool.findMany).mockResolvedValue([
      {
        poolAddress: 'P1',
        protocol: 'aquarius',
        dexName: 'Aquarius',
        tokenASymbol: 'USDC',
        tokenBSymbol: 'XLM',
        tvlUsd: 900,
        volume24hUsd: 90,
        fees24hUsd: 9,
        aprPct: 12,
      },
    ] as never);

    const res = await request(makeApp()).get('/series/top/pools?metric=tvl&sparkline=false');

    expect(res.status).toBe(200);
    expect(res.body.data[0].sparkline).toEqual([]);
    expect(db.prismaRead.poolSnapshot.findMany).not.toHaveBeenCalled();
  });
});

describe('GET /series/top/tokens', () => {
  it('ranks tokens and resolves symbols', async () => {
    vi.mocked(db.prismaRead.tokenPrice.findMany).mockResolvedValue([
      {
        tokenAddress: 'T1',
        priceUsd: 2,
        volume24hUsd: 200,
        marketCapUsd: 2000,
        priceChange24h: 5,
        priceChange1h: 1,
        priceChange7d: 10,
      },
      {
        tokenAddress: 'T2',
        priceUsd: 1,
        volume24hUsd: 100,
        marketCapUsd: 1000,
        priceChange24h: -2,
        priceChange1h: 0,
        priceChange7d: -1,
      },
    ] as never);
    vi.mocked(db.prismaRead.contract.findMany).mockResolvedValue([
      { address: 'T1', tokenSymbol: 'AQUA', tokenName: 'Aquarius' },
    ] as never);
    vi.mocked(db.prismaRead.token.findMany).mockResolvedValue([
      { address: 'T2', symbol: 'USDC', name: 'USD Coin' },
    ] as never);
    vi.mocked(db.prismaRead.tokenPriceHistory.findMany).mockResolvedValue([
      {
        tokenAddress: 'T1',
        timestamp: at(0),
        priceUsd: 1,
        priceXlm: 1,
        volume24hUsd: 50,
        marketCapUsd: 500,
        confidence: 1,
      },
      {
        tokenAddress: 'T1',
        timestamp: at(1),
        priceUsd: 2,
        priceXlm: 2,
        volume24hUsd: 100,
        marketCapUsd: 1000,
        confidence: 1,
      },
    ] as never);

    const res = await request(makeApp()).get('/series/top/tokens?metric=volume&interval=1h');

    expect(res.status).toBe(200);
    expect(res.body.metric).toBe('volume');
    expect(res.body.data[0]).toMatchObject({
      rank: 1,
      tokenAddress: 'T1',
      symbol: 'AQUA',
      value: 200,
    });
    expect(res.body.data[1]).toMatchObject({ rank: 2, tokenAddress: 'T2', symbol: 'USDC' });
    expect(res.body.data[0].sparkline).toEqual([50, 100]);
  });
});

describe('GET /series', () => {
  it('advertises supported intervals, metrics and endpoints', async () => {
    const res = await request(makeApp()).get('/series');

    expect(res.status).toBe(200);
    expect(res.body.intervals).toContain('1h');
    expect(res.body.poolMetrics).toEqual(expect.arrayContaining(['volume', 'tvl', 'trades']));
    expect(res.body.tokenMetrics).toEqual(expect.arrayContaining(['price', 'volume']));
    expect(res.body.endpoints).toHaveLength(4);
  });
});
