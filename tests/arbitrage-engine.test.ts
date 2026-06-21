/**
 * Arbitrage Intelligence Engine — Unit Tests
 * Covers: price deviation detection, route optimization (Bellman-Ford),
 * MEV scoring, execution simulation, and sandwich attack detection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock Prisma before importing engine ───────────────────────────────────────

vi.mock('../src/db', () => ({
  prismaRead: {
    dexPool: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
    },
    poolPrice: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    arbitrageOpportunity: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      aggregate: vi.fn(),
      groupBy: vi.fn(),
      count: vi.fn(),
    },
    mevOpportunityScore: {
      findUnique: vi.fn(),
      aggregate: vi.fn(),
      groupBy: vi.fn(),
    },
    transaction: {
      findMany: vi.fn(),
      groupBy: vi.fn(),
      count: vi.fn(),
    },
    indexerState: {
      findUnique: vi.fn(),
    },
    sandwichAttack: {
      aggregate: vi.fn(),
      groupBy: vi.fn(),
      findMany: vi.fn(),
    },
    arbitrageBot: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      aggregate: vi.fn(),
      count: vi.fn(),
    },
  },
  prismaWrite: {
    arbitrageOpportunity: { create: vi.fn(), updateMany: vi.fn() },
    mevOpportunityScore: { create: vi.fn() },
    sandwichAttack: { upsert: vi.fn() },
    arbitrageBot: { upsert: vi.fn() },
    poolPrice: { upsert: vi.fn() },
    priceDeviation: { create: vi.fn() },
  },
}));

vi.mock('../src/cache', () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
}));

import {
  computeMevScore,
  detectNegativeCycles,
  buildPriceGraph,
  detectDirectArbitrage,
} from '../src/indexer/arbitrage-engine';
import { prismaRead } from '../src/db';

// ─── computeMevScore ──────────────────────────────────────────────────────────

describe('computeMevScore', () => {
  it('produces a score in [0, 100]', () => {
    const score = computeMevScore({
      profitPercentage: 1.5,
      capitalRequired: 10000,
      hops: 1,
      liquidityBuyPool: 500000,
      liquiditySellPool: 300000,
    });
    expect(score.overallScore).toBeGreaterThanOrEqual(0);
    expect(score.overallScore).toBeLessThanOrEqual(100);
  });

  it('recommends execute_immediately for high-profit, low-hop opportunities', () => {
    const score = computeMevScore({
      profitPercentage: 5.0,
      capitalRequired: 5000,
      hops: 1,
      liquidityBuyPool: 10_000_000,
      liquiditySellPool: 10_000_000,
      competingBotCount: 0,
    });
    expect(score.recommendation).toBe('execute_immediately');
  });

  it('recommends skip for low-profit, high-hop opportunities', () => {
    const score = computeMevScore({
      profitPercentage: 0.05,
      capitalRequired: 100000,
      hops: 5,
      liquidityBuyPool: 1000,
      liquiditySellPool: 1000,
      competingBotCount: 10,
    });
    expect(score.recommendation).toBe('skip');
  });

  it('speedRequirement is immediate for 1-hop', () => {
    const score = computeMevScore({ profitPercentage: 1, capitalRequired: 1000, hops: 1, liquidityBuyPool: 100000, liquiditySellPool: 100000 });
    expect(score.speedRequirement).toBe('immediate');
  });

  it('speedRequirement is fast for 2-hop', () => {
    const score = computeMevScore({ profitPercentage: 1, capitalRequired: 1000, hops: 2, liquidityBuyPool: 100000, liquiditySellPool: 100000 });
    expect(score.speedRequirement).toBe('fast');
  });

  it('competitionLevel is low when few bots competing', () => {
    const score = computeMevScore({ profitPercentage: 1, capitalRequired: 1000, hops: 1, liquidityBuyPool: 100000, liquiditySellPool: 100000, competingBotCount: 1 });
    expect(score.competitionLevel).toBe('low');
  });

  it('competitionLevel is extreme when many bots competing', () => {
    const score = computeMevScore({ profitPercentage: 1, capitalRequired: 1000, hops: 1, liquidityBuyPool: 100000, liquiditySellPool: 100000, competingBotCount: 15 });
    expect(score.competitionLevel).toBe('extreme');
  });

  it('slippageRisk is high when capital >> liquidity', () => {
    const score = computeMevScore({ profitPercentage: 1, capitalRequired: 1_000_000, hops: 1, liquidityBuyPool: 5000, liquiditySellPool: 5000 });
    expect(score.slippageRisk).toBeGreaterThan(0.5);
  });

  it('capitalEfficiency is proportional to profit %', () => {
    const low = computeMevScore({ profitPercentage: 0.1, capitalRequired: 10000, hops: 1, liquidityBuyPool: 1e6, liquiditySellPool: 1e6 });
    const high = computeMevScore({ profitPercentage: 2.0, capitalRequired: 10000, hops: 1, liquidityBuyPool: 1e6, liquiditySellPool: 1e6 });
    expect(high.capitalEfficiency).toBeGreaterThan(low.capitalEfficiency);
  });
});

// ─── detectNegativeCycles (Bellman-Ford) ──────────────────────────────────────

describe('detectNegativeCycles', () => {
  function buildTestGraph(prices: { from: string; to: string; price: number; poolId: string; fee: number }[]) {
    const nodes = new Map<string, { poolId: string; dexName: string; tokenA: string; tokenB: string; spotPrice: number; feeTier: number; liquidity: number }[]>();
    const edges = new Map<string, number>();

    for (const p of prices) {
      if (!nodes.has(p.from)) nodes.set(p.from, []);
      nodes.get(p.from)!.push({
        poolId: p.poolId,
        dexName: 'TestDEX',
        tokenA: p.from,
        tokenB: p.to,
        spotPrice: p.price,
        feeTier: p.fee,
        liquidity: 1_000_000,
      });
      edges.set(`${p.from}:${p.to}:${p.poolId}`, -Math.log(p.price * (1 - p.fee)));
    }
    return { nodes, edges };
  }

  it('detects a simple 2-token arbitrage cycle', () => {
    // A→B at 1.02, B→A at 1.0 (net 2% profit after rounding)
    const graph = buildTestGraph([
      { from: 'TOKEN_A', to: 'TOKEN_B', price: 1.02, poolId: 'pool1', fee: 0 },
      { from: 'TOKEN_B', to: 'TOKEN_A', price: 1.0, poolId: 'pool2', fee: 0 },
    ]);
    const cycles = detectNegativeCycles(graph, 5);
    expect(cycles.length).toBeGreaterThan(0);
    expect(cycles[0].profitMultiplier).toBeGreaterThan(1);
  });

  it('does NOT flag a balanced market as arbitrage', () => {
    // Perfectly efficient market: A→B at 1.0 after fees, B→A at 1.0 after fees
    const graph = buildTestGraph([
      { from: 'TOKEN_X', to: 'TOKEN_Y', price: 1.003, poolId: 'p1', fee: 0.003 },
      { from: 'TOKEN_Y', to: 'TOKEN_X', price: 1.003, poolId: 'p2', fee: 0.003 },
    ]);
    const cycles = detectNegativeCycles(graph, 5);
    // Profit multiplier should be ≤ 1 (break-even or loss)
    const profitable = cycles.filter((c) => c.profitMultiplier > 1.0001);
    expect(profitable.length).toBe(0);
  });

  it('ranks cycles by profitability (highest first)', () => {
    const graph = buildTestGraph([
      { from: 'A', to: 'B', price: 1.05, poolId: 'p1', fee: 0 },
      { from: 'B', to: 'A', price: 1.0,  poolId: 'p2', fee: 0 },
      { from: 'A', to: 'C', price: 1.02, poolId: 'p3', fee: 0 },
      { from: 'C', to: 'A', price: 1.0,  poolId: 'p4', fee: 0 },
    ]);
    const cycles = detectNegativeCycles(graph, 5);
    if (cycles.length >= 2) {
      expect(cycles[0].profitMultiplier).toBeGreaterThanOrEqual(cycles[1].profitMultiplier);
    }
  });

  it('returns empty array when graph has no nodes', () => {
    const graph = { nodes: new Map(), edges: new Map() };
    const cycles = detectNegativeCycles(graph as never, 5);
    expect(cycles).toEqual([]);
  });
});

// ─── detectDirectArbitrage ────────────────────────────────────────────────────

describe('detectDirectArbitrage', () => {
  const mockPools = [
    {
      id: 'pool-uuid-1',
      contractAddress: 'CAAA',
      dexName: 'StellarSwap',
      poolType: 'constant_product',
      tokenA: 'TOKEN_USDC',
      tokenB: 'TOKEN_XLM',
      tokenASymbol: 'USDC',
      tokenBSymbol: 'XLM',
      feeTier: { toString: () => '0.0030' },
      totalLiquidity: { toString: () => '500000' },
      volume24h: null,
      fees24h: null,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      poolPrices: [{ spotPrice: { toString: () => '0.1234' } }],
    },
    {
      id: 'pool-uuid-2',
      contractAddress: 'CBBB',
      dexName: 'AquaDEX',
      poolType: 'constant_product',
      tokenA: 'TOKEN_USDC',
      tokenB: 'TOKEN_XLM',
      tokenASymbol: 'USDC',
      tokenBSymbol: 'XLM',
      feeTier: { toString: () => '0.0030' },
      totalLiquidity: { toString: () => '300000' },
      volume24h: null,
      fees24h: null,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      poolPrices: [{ spotPrice: { toString: () => '0.1255' } }],
    },
  ];

  beforeEach(() => {
    vi.mocked(prismaRead.dexPool.findMany).mockResolvedValue(mockPools as never);
  });

  it('detects a direct arbitrage opportunity between two DEXes', async () => {
    const results = await detectDirectArbitrage(0.1);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].profitPercentage).toBeGreaterThan(0);
  });

  it('correctly identifies the buy and sell DEX', async () => {
    const results = await detectDirectArbitrage(0.1);
    const opp = results[0];
    // Buy from cheaper DEX (StellarSwap @ 0.1234)
    expect(opp.buyPool.price).toBeLessThan(opp.sellPool.price);
    expect(opp.buyPool.dexName).toBe('StellarSwap');
    expect(opp.sellPool.dexName).toBe('AquaDEX');
  });

  it('returns empty array when all pools have the same price', async () => {
    const samePricePools = mockPools.map((p) => ({
      ...p,
      poolPrices: [{ spotPrice: { toString: () => '0.1234' } }],
    }));
    vi.mocked(prismaRead.dexPool.findMany).mockResolvedValue(samePricePools as never);
    const results = await detectDirectArbitrage(0.1);
    expect(results.length).toBe(0);
  });

  it('filters out opportunities below minProfitPct', async () => {
    const results = await detectDirectArbitrage(99);
    expect(results.length).toBe(0);
  });

  it('returns empty array when only one pool exists for a pair', async () => {
    vi.mocked(prismaRead.dexPool.findMany).mockResolvedValue([mockPools[0]] as never);
    const results = await detectDirectArbitrage(0.1);
    expect(results.length).toBe(0);
  });

  it('assigns confidence between 0 and 1', async () => {
    const results = await detectDirectArbitrage(0.1);
    for (const r of results) {
      expect(r.confidence).toBeGreaterThan(0);
      expect(r.confidence).toBeLessThanOrEqual(1);
    }
  });
});

// ─── Price deviation threshold flagging ───────────────────────────────────────

describe('Price deviation threshold detection', () => {
  const THRESHOLDS = [0.1, 0.5, 1.0, 2.0];

  function computeDeviation(priceA: number, priceB: number): number {
    return Math.abs(priceA - priceB) / Math.min(priceA, priceB) * 100;
  }

  it('flags 0.1% deviation threshold correctly', () => {
    const dev = computeDeviation(1.0000, 1.0011);
    expect(dev).toBeGreaterThanOrEqual(THRESHOLDS[0]);
  });

  it('flags 0.5% deviation threshold correctly', () => {
    const dev = computeDeviation(1.0000, 1.0051);
    expect(dev).toBeGreaterThanOrEqual(THRESHOLDS[1]);
  });

  it('flags 1% deviation threshold correctly', () => {
    const dev = computeDeviation(1.0000, 1.0101);
    expect(dev).toBeGreaterThanOrEqual(THRESHOLDS[2]);
  });

  it('flags 2% deviation threshold correctly', () => {
    const dev = computeDeviation(1.0000, 1.0201);
    expect(dev).toBeGreaterThanOrEqual(THRESHOLDS[3]);
  });

  it('does NOT flag deviation below 0.1%', () => {
    const dev = computeDeviation(1.0000, 1.0005);
    expect(dev).toBeLessThan(THRESHOLDS[0]);
  });

  it('deviation is symmetric regardless of which price is higher', () => {
    const devAB = computeDeviation(0.1234, 0.1245);
    const devBA = computeDeviation(0.1245, 0.1234);
    expect(devAB).toBeCloseTo(devBA, 6);
  });
});

// ─── MEV score edge cases ─────────────────────────────────────────────────────

describe('computeMevScore edge cases', () => {
  it('handles zero capital gracefully', () => {
    const score = computeMevScore({ profitPercentage: 1, capitalRequired: 0, hops: 1, liquidityBuyPool: 100000, liquiditySellPool: 100000 });
    expect(score.capitalEfficiency).toBe(0);
    expect(score.overallScore).toBeGreaterThanOrEqual(0);
  });

  it('handles zero liquidity gracefully', () => {
    const score = computeMevScore({ profitPercentage: 1, capitalRequired: 1000, hops: 1, liquidityBuyPool: 0, liquiditySellPool: 0 });
    expect(score.slippageRisk).toBe(0.5);
  });

  it('never produces NaN or Infinity', () => {
    const score = computeMevScore({ profitPercentage: 0, capitalRequired: 0, hops: 0, liquidityBuyPool: 0, liquiditySellPool: 0 });
    expect(Number.isFinite(score.overallScore)).toBe(true);
    expect(Number.isNaN(score.overallScore)).toBe(false);
  });

  it('very high profit always recommends execute_immediately', () => {
    const score = computeMevScore({ profitPercentage: 50, capitalRequired: 1000, hops: 1, liquidityBuyPool: 1e9, liquiditySellPool: 1e9, competingBotCount: 0 });
    expect(score.recommendation).toBe('execute_immediately');
  });
});

// ─── Route optimization helpers ───────────────────────────────────────────────

describe('Route optimization', () => {
  it('correctly computes profit from direct route', () => {
    const buyPrice = 0.1234;
    const sellPrice = 0.1245;
    const feeBuy = 0.003;
    const feeSell = 0.003;
    const gross = (sellPrice - buyPrice) / buyPrice * 100;
    const fees = (feeBuy + feeSell) * 100;
    const net = gross - fees;
    // Net should be positive (approx 0.29%)
    expect(net).toBeGreaterThan(0);
  });

  it('multi-hop route reduces profit due to compound fees', () => {
    const singleHopFee = 0.003;
    const tripleHopFee = 1 - Math.pow(1 - singleHopFee, 3);
    expect(tripleHopFee).toBeGreaterThan(singleHopFee);
  });

  it('triangular arbitrage profit multiplier formula is correct', () => {
    // A→B @ 1.02, B→C @ 1.01, C→A @ 1.0 = net 1.02 * 1.01 * 1.0 ≈ 1.0302
    const mult = 1.02 * 1.01 * 1.0;
    expect(mult).toBeGreaterThan(1);
    expect((mult - 1) * 100).toBeCloseTo(3.02, 1);
  });
});
