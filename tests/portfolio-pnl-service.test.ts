import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as db from '../src/db';

vi.mock('../src/db', () => ({
  prismaRead: {
    contract: { findMany: vi.fn() },
    event: { findMany: vi.fn() },
    tokenPriceHistory: { findFirst: vi.fn() },
    portfolioPosition: { findMany: vi.fn() },
    portfolioBalanceSnapshot: { findMany: vi.fn() },
  },
  prismaWrite: {
    portfolioPosition: { upsert: vi.fn() },
    portfolioBalanceSnapshot: { createMany: vi.fn() },
  },
}));

vi.mock('../src/services/pricing/composite-price', () => ({
  computeCompositePrice: vi.fn(),
}));

import {
  computeCompositePrice,
  type CompositePrice,
} from '../src/services/pricing/composite-price';
import {
  computePortfolioPnl,
  deriveCostBasisFromEvents,
  getPortfolioPnl,
  persistPortfolioPnl,
  upsertPositions,
  listBalanceSnapshots,
} from '../src/services/pricing/pnl';

function price(priceUsd: number, source = 'dex'): CompositePrice {
  return {
    priceUsd,
    priceXlm: priceUsd * 2.5,
    source,
    confidence: 0.9,
    volume24hUsd: 0,
    liquidityUsd: 0,
    marketCapUsd: null,
    priceChange1h: null,
    priceChange24h: null,
    priceChange7d: null,
    twap1h: 0,
    twap24h: 0,
    breakdown: [],
  };
}

const prismaRead = db.prismaRead as any;
const prismaWrite = db.prismaWrite as any;

describe('computePortfolioPnl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(computeCompositePrice).mockResolvedValue(price(1));
  });

  it('values holdings across networks and decomposes by chain and asset', async () => {
    prismaRead.contract.findMany.mockResolvedValue([
      { address: 'USDC', tokenSymbol: 'USDC', tokenDecimals: 7 },
    ]);
    vi.mocked(computeCompositePrice).mockImplementation(async (token: string) =>
      token === 'USDC' ? price(1, 'peg') : price(3000, 'dex'),
    );

    const result = await computePortfolioPnl({
      wallet: 'wallet-1',
      networks: [
        {
          network: 'stellar',
          holdings: [{ token: 'USDC', balance: '1000000000', costBasisUsd: 90 }],
        },
        {
          network: 'ethereum',
          holdings: [
            { token: 'ETH', balance: '1000000000000000000', costBasisUsd: 2000, decimals: 18 },
          ],
        },
      ],
      deriveCostBasisFromEvents: false,
    });

    // stellar: 100 USDC * $1 = $100 ; ethereum: 1 ETH * $3000 = $3000
    expect(result.totalValueUsd).toBe(3100);
    expect(result.totalCostBasisUsd).toBe(2090);
    expect(result.unrealizedPnlUsd).toBeCloseTo(1010, 6);
    expect(result.assetCount).toBe(2);
    expect(result.byChain).toHaveLength(2);

    // byAsset sorted by value descending
    expect(result.byAsset[0].token).toBe('ETH');
    expect(result.byAsset[1].token).toBe('USDC');

    const stellar = result.byChain.find((c) => c.network === 'stellar')!;
    expect(stellar.assets[0].symbol).toBe('USDC'); // enriched from contract registry
    expect(stellar.assets[0].costBasisSource).toBe('provided');
    expect(stellar.assets[0].unrealizedPnlUsd).toBeCloseTo(10, 6);

    // allocations should sum to ~100 across assets
    const totalAlloc = result.byAsset.reduce((s, a) => s + a.allocationPct, 0);
    expect(totalAlloc).toBeCloseTo(100, 4);
  });

  it('derives cost basis from indexed events when none is provided', async () => {
    prismaRead.contract.findMany.mockResolvedValue([]);
    vi.mocked(computeCompositePrice).mockResolvedValue(price(2));
    prismaRead.event.findMany.mockResolvedValue([
      { decoded: { to: 'GADDR', amount: 5 }, ledgerCloseTime: new Date('2026-01-01T00:00:00Z') },
    ]);
    prismaRead.tokenPriceHistory.findFirst.mockResolvedValue({ priceUsd: 1 });

    const result = await computePortfolioPnl({
      networks: [
        {
          network: 'stellar',
          address: 'GADDR',
          holdings: [{ token: 'USDC', balance: '10000000' }],
        },
      ],
    });

    // 1 USDC now worth $2, acquired for $5 at event time
    expect(result.byAsset[0].costBasisSource).toBe('events');
    expect(result.byAsset[0].costBasisUsd).toBe(5);
    expect(result.byAsset[0].valueUsd).toBe(2);
    expect(result.byAsset[0].unrealizedPnlUsd).toBe(-3);
  });

  it('falls back to a zero cost basis for non-Stellar networks without events', async () => {
    prismaRead.contract.findMany.mockResolvedValue([]);
    vi.mocked(computeCompositePrice).mockResolvedValue(price(3000));

    const result = await computePortfolioPnl({
      networks: [
        {
          network: 'ethereum',
          address: '0xabc',
          holdings: [{ token: 'ETH', balance: '1000000000000000000', decimals: 18 }],
        },
      ],
    });

    expect(prismaRead.event.findMany).not.toHaveBeenCalled();
    expect(result.byAsset[0].costBasisSource).toBe('zero');
    expect(result.byAsset[0].costBasisUsd).toBe(0);
    expect(result.byAsset[0].unrealizedPnlUsd).toBeCloseTo(3000, 6);
  });

  it('handles an empty network set', async () => {
    const result = await computePortfolioPnl({ networks: [] });
    expect(result.totalValueUsd).toBe(0);
    expect(result.unrealizedPnlPct).toBeNull();
    expect(result.byChain).toHaveLength(0);
  });
});

describe('deriveCostBasisFromEvents', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null when no events reference the token', async () => {
    prismaRead.event.findMany.mockResolvedValue([]);
    const value = await deriveCostBasisFromEvents({
      address: 'GADDR',
      token: 'USDC',
      asOf: new Date(),
    });
    expect(value).toBeNull();
  });
});

describe('persistPortfolioPnl', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes one snapshot row per asset', async () => {
    prismaWrite.portfolioBalanceSnapshot.createMany.mockResolvedValue({ count: 2 });

    const written = await persistPortfolioPnl('wallet-1', {
      wallet: 'wallet-1',
      totalValueUsd: 110,
      totalCostBasisUsd: 100,
      unrealizedPnlUsd: 10,
      unrealizedPnlPct: 10,
      realizedPnlUsd: 0,
      byChain: [],
      byAsset: [
        {
          network: 'stellar',
          token: 'USDC',
          symbol: 'USDC',
          balance: '1000000000',
          quantity: 100,
          decimals: 7,
          priceUsd: 1,
          valueUsd: 100,
          costBasisUsd: 90,
          unrealizedPnlUsd: 10,
          unrealizedPnlPct: 11.1,
          allocationPct: 90.9,
          priceSource: 'peg',
          confidence: 1,
          costBasisSource: 'provided',
        },
        {
          network: 'stellar',
          token: 'XLM',
          symbol: 'XLM',
          balance: '50000000',
          quantity: 5,
          decimals: 7,
          priceUsd: 2,
          valueUsd: 10,
          costBasisUsd: 10,
          unrealizedPnlUsd: 0,
          unrealizedPnlPct: 0,
          allocationPct: 9.1,
          priceSource: 'dex',
          confidence: 0.9,
          costBasisSource: 'provided',
        },
      ],
      assetCount: 2,
      timestamp: '2026-09-24T00:00:00.000Z',
    });

    expect(written).toBe(2);
    const { data, data: rows } = prismaWrite.portfolioBalanceSnapshot.createMany.mock.calls[0][0];
    expect(rows).toHaveLength(2);
    expect(data[0].wallet).toBe('wallet-1');
    expect(data[0].unrealizedPnlUsd).toBe(10);
  });

  it('does nothing for an empty portfolio', async () => {
    const written = await persistPortfolioPnl('wallet-1', {
      byAsset: [],
      timestamp: new Date().toISOString(),
    } as any);
    expect(written).toBe(0);
    expect(prismaWrite.portfolioBalanceSnapshot.createMany).not.toHaveBeenCalled();
  });
});

describe('upsertPositions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('upserts each holding as a cost-basis lot', async () => {
    prismaWrite.portfolioPosition.upsert.mockResolvedValue({});

    const count = await upsertPositions('wallet-1', [
      {
        network: 'stellar',
        address: 'GADDR',
        holdings: [{ token: 'USDC', balance: '1000000000', costBasisUsd: 90 }],
      },
    ]);

    expect(count).toBe(1);
    const call = prismaWrite.portfolioPosition.upsert.mock.calls[0][0];
    expect(call.where.wallet_network_token).toEqual({
      wallet: 'wallet-1',
      network: 'stellar',
      token: 'USDC',
    });
    expect(call.create.quantity).toBe(100);
    expect(call.create.costBasisUsd).toBe(90);
  });
});

describe('getPortfolioPnl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaRead.contract.findMany.mockResolvedValue([]);
    vi.mocked(computeCompositePrice).mockResolvedValue(price(1));
  });

  it('recomputes P&L from stored positions', async () => {
    prismaRead.portfolioPosition.findMany.mockResolvedValue([
      {
        wallet: 'wallet-1',
        network: 'stellar',
        address: 'GADDR',
        token: 'USDC',
        symbol: 'USDC',
        decimals: 7,
        quantity: 100,
        costBasisUsd: 90,
        realizedPnlUsd: 5,
      },
    ]);

    const result = await getPortfolioPnl('wallet-1');
    expect(result.assetCount).toBe(1);
    expect(result.totalValueUsd).toBe(100);
    expect(result.realizedPnlUsd).toBe(5);
    expect(result.byChain[0].network).toBe('stellar');
  });
});

describe('listBalanceSnapshots', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps rows to plain numbers and ISO timestamps', async () => {
    prismaRead.portfolioBalanceSnapshot.findMany.mockResolvedValue([
      {
        id: 's1',
        wallet: 'wallet-1',
        network: 'stellar',
        token: 'USDC',
        symbol: 'USDC',
        quantity: 100,
        priceUsd: 1,
        valueUsd: 100,
        costBasisUsd: 90,
        unrealizedPnlUsd: 10,
        snapshotAt: new Date('2026-09-24T00:00:00Z'),
      },
    ]);

    const snapshots = await listBalanceSnapshots('wallet-1', { network: 'stellar', limit: 10 });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].valueUsd).toBe(100);
    expect(snapshots[0].snapshotAt).toBe('2026-09-24T00:00:00.000Z');

    const where = prismaRead.portfolioBalanceSnapshot.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ wallet: 'wallet-1', network: 'stellar' });
  });
});
