import { describe, it, expect } from 'vitest';
import {
  getAmountOut,
  getAmountIn,
  simulateSwap,
  slippageCurve,
  defaultCurveSizes,
  liquidityDepth,
  impermanentLossPct,
  impermanentLossSeverity,
  tvlUsd,
  aprPct,
} from '../src/indexer/dex/pool-math';
import { deriveTokenPrices, isStableSymbol } from '../src/indexer/dex/pricing';
import {
  classifyProtocol,
  poolActionFor,
  looksLikePoolEvent,
  applySwap,
  applyLiquidity,
} from '../src/indexer/dex/pool-detector';
import { findArbitrageOpportunities, pairKeyOf, type ArbPool } from '../src/indexer/dex/arbitrage';
import { ilRiskScore } from '../src/indexer/dex/pool-processor';

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 — pool detection & reserve tracking
// ─────────────────────────────────────────────────────────────────────────────

describe('protocol classification (3+ DEXes)', () => {
  it('distinguishes soroswap, phoenix, comet, and aquarius by event vocabulary', () => {
    expect(classifyProtocol('swap', null)).toBe('soroswap');
    expect(classifyProtocol('provide_liquidity', null)).toBe('phoenix');
    expect(classifyProtocol('join_pool', null)).toBe('comet');
    expect(classifyProtocol('trade', null)).toBe('aquarius');
    expect(classifyProtocol('something_else', null)).toBe('unknown');
  });

  it('gates and routes pool events to the right action', () => {
    expect(looksLikePoolEvent('swap', 'swap')).toBe(true);
    expect(looksLikePoolEvent(null, 'transfer')).toBe(false);
    expect(poolActionFor('swap', null)).toBe('swap');
    expect(poolActionFor('sync', null)).toBe('sync');
    expect(poolActionFor('provide_liquidity', null)).toBe('add');
    expect(poolActionFor('withdraw_liquidity', null)).toBe('remove');
  });
});

describe('event-sourced reserve tracking', () => {
  const tokenA = 'AAA';
  it('moves reserves correctly on a swap (in=A)', () => {
    const next = applySwap({ reserveA: 1000n, reserveB: 1000n }, tokenA, 'AAA', 100n, 90n);
    expect(next.reserveA).toBe(1100n);
    expect(next.reserveB).toBe(910n);
  });
  it('moves reserves correctly on a swap (in=B)', () => {
    const next = applySwap({ reserveA: 1000n, reserveB: 1000n }, tokenA, 'BBB', 100n, 90n);
    expect(next.reserveA).toBe(910n);
    expect(next.reserveB).toBe(1100n);
  });
  it('never drives reserves negative', () => {
    const next = applySwap({ reserveA: 50n, reserveB: 1000n }, tokenA, 'BBB', 100n, 999999n);
    expect(next.reserveA).toBe(0n);
  });
  it('adds and removes liquidity', () => {
    expect(applyLiquidity({ reserveA: 100n, reserveB: 200n }, 10n, 20n)).toEqual({ reserveA: 110n, reserveB: 220n });
    expect(applyLiquidity({ reserveA: 100n, reserveB: 200n }, -10n, -20n)).toEqual({ reserveA: 90n, reserveB: 180n });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — metric computation
// ─────────────────────────────────────────────────────────────────────────────

describe('constant-product swap math', () => {
  it('matches the Uniswap-v2 getAmountOut formula (0.30% fee)', () => {
    // 100 in, 1000/1000 reserves, 30 bps: floor(997000*1000 / (1000*10000+997000)) = 90
    expect(getAmountOut(100n, 1000n, 1000n, 30)).toBe(90n);
  });
  it('getAmountIn is the inverse direction of getAmountOut', () => {
    const out = getAmountOut(100n, 1000n, 1000n, 30);
    const need = getAmountIn(out, 1000n, 1000n, 30);
    // Re-deriving the input to obtain `out` should be within rounding of 100.
    expect(Number(need)).toBeGreaterThanOrEqual(99);
    expect(Number(need)).toBeLessThanOrEqual(101);
  });
  it('returns 0 for degenerate inputs', () => {
    expect(getAmountOut(0n, 1000n, 1000n, 30)).toBe(0n);
    expect(getAmountOut(100n, 0n, 1000n, 30)).toBe(0n);
    expect(getAmountIn(2000n, 1000n, 1000n, 30)).toBe(0n); // can't withdraw >= reserveOut
  });
});

describe('slippage simulation', () => {
  it('larger trades incur strictly more slippage', () => {
    const small = simulateSwap(10, 10_000, 10_000, 30);
    const big = simulateSwap(1_000, 10_000, 10_000, 30);
    expect(big.slippagePct).toBeGreaterThan(small.slippagePct);
    expect(small.slippagePct).toBeGreaterThan(0);
  });
  it('mid price reflects the reserve ratio', () => {
    const sim = simulateSwap(1, 1_000, 2_000, 30);
    expect(sim.midPrice).toBeCloseTo(2, 6); // 2000/1000 OUT per IN
  });
  it('produces a monotonic slippage curve over default sizes', () => {
    const sizes = defaultCurveSizes(10_000);
    const curve = slippageCurve(10_000, 10_000, 30, sizes);
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i].slippagePct).toBeGreaterThanOrEqual(curve[i - 1].slippagePct);
    }
  });
});

describe('liquidity depth at price-impact levels', () => {
  it('matches the closed-form depth for 1% marginal impact', () => {
    // x = reserveIn * (1/sqrt(1-p) - 1); p=0.01, reserveIn=10000 → ~50.38
    const [level] = liquidityDepth(10_000, [0.01]);
    expect(level.amountIn).toBeCloseTo(10_000 * (1 / Math.sqrt(0.99) - 1), 4);
    expect(level.amountIn).toBeCloseTo(50.38, 1);
  });
  it('values depth in USD when a price is supplied', () => {
    const [level] = liquidityDepth(10_000, [0.05], 2);
    expect(level.amountInUsd).toBeCloseTo(level.amountIn * 2, 6);
  });
});

describe('impermanent loss calculator (validated checkpoints)', () => {
  it('is zero when the price is unchanged', () => {
    expect(impermanentLossPct(1)).toBeCloseTo(0, 9);
  });
  it('matches known values: 2x → -5.72%, 4x → -20%', () => {
    expect(impermanentLossPct(2)).toBeCloseTo(-5.7191, 3);
    expect(impermanentLossPct(4)).toBeCloseTo(-20, 4);
  });
  it('is symmetric for reciprocal price ratios', () => {
    expect(impermanentLossPct(2)).toBeCloseTo(impermanentLossPct(0.5), 9);
  });
  it('classifies severity', () => {
    expect(impermanentLossSeverity(impermanentLossPct(1))).toBe('none');
    expect(impermanentLossSeverity(impermanentLossPct(4))).toBe('severe');
  });
});

describe('TVL & APR', () => {
  it('sums both priced sides', () => {
    expect(tvlUsd(100, 2, 200, 1)).toBe(400); // 100*2 + 200*1
  });
  it('doubles a single priced side (balanced-pool assumption)', () => {
    expect(tvlUsd(100, 2, 200, null)).toBe(400);
  });
  it('annualises fee APR from trailing 24h fees', () => {
    // $100/day on $36,500 TVL → 100*365/36500 *100 = 100%
    expect(aprPct(100, 36_500)).toBeCloseTo(100, 6);
    expect(aprPct(100, 0)).toBe(0);
  });
});

describe('IL risk score', () => {
  it('is higher for high-turnover, imbalanced pools', () => {
    const calm = ilRiskScore(1_000_000, 1_000, 500_000, 500_000);
    const hot = ilRiskScore(1_000_000, 900_000, 900_000, 100_000);
    expect(hot).toBeGreaterThan(calm);
    expect(hot).toBeLessThanOrEqual(100);
    expect(calm).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pricing
// ─────────────────────────────────────────────────────────────────────────────

describe('token pricing from pools', () => {
  it('anchors stablecoins at $1', () => {
    expect(isStableSymbol('USDC')).toBe(true);
    expect(isStableSymbol('xlm')).toBe(false);
  });
  it('implies a token price from a stablecoin pool', () => {
    // 1000 XLM : 120 USDC → XLM = $0.12
    const prices = deriveTokenPrices([
      { poolAddress: 'P', tokenA: 'XLM', tokenB: 'USDC', symbolA: 'XLM', symbolB: 'USDC', reserveAHuman: 1000, reserveBHuman: 120 },
    ]);
    expect(prices.get('USDC')?.priceUsd).toBe(1);
    expect(prices.get('XLM')?.priceUsd).toBeCloseTo(0.12, 9);
    expect(prices.get('XLM')?.source).toBe('pool');
  });
  it('propagates pricing transitively across hops', () => {
    const prices = deriveTokenPrices([
      { poolAddress: 'P1', tokenA: 'XLM', tokenB: 'USDC', symbolA: 'XLM', symbolB: 'USDC', reserveAHuman: 1000, reserveBHuman: 100 }, // XLM=$0.10
      { poolAddress: 'P2', tokenA: 'ABC', tokenB: 'XLM', symbolA: 'ABC', symbolB: 'XLM', reserveAHuman: 50, reserveBHuman: 1000 }, // ABC priced via XLM
    ]);
    expect(prices.get('XLM')?.priceUsd).toBeCloseTo(0.1, 9);
    // ABC: 1000 XLM * $0.10 / 50 = $2.00
    expect(prices.get('ABC')?.priceUsd).toBeCloseTo(2, 9);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 — arbitrage detection
// ─────────────────────────────────────────────────────────────────────────────

describe('arbitrage detection', () => {
  const pk = pairKeyOf('AAA', 'USDC');
  const base: Omit<ArbPool, 'poolAddress' | 'reserveBHuman'> = {
    pairKey: pk,
    tokenA: 'AAA',
    tokenB: 'USDC',
    reserveAHuman: 1000,
    feeBps: 30,
    quotePriceUsd: 1,
  };

  it('detects a price discrepancy across two pools of the same pair', () => {
    const pools: ArbPool[] = [
      { ...base, poolAddress: 'cheap', reserveBHuman: 1000 }, // rate 1.0 USDC/AAA
      { ...base, poolAddress: 'dear', reserveBHuman: 1100 }, // rate 1.1 USDC/AAA
    ];
    const [opp] = findArbitrageOpportunities(pools, { minSpreadPct: 0.3 });
    expect(opp).toBeDefined();
    expect(opp.buyPool).toBe('cheap');
    expect(opp.sellPool).toBe('dear');
    expect(opp.spreadPct).toBeCloseTo(10, 6);
    expect(opp.estProfitUsd).toBeGreaterThan(0);
  });

  it('ignores spreads within the fee/threshold band', () => {
    const pools: ArbPool[] = [
      { ...base, poolAddress: 'a', reserveBHuman: 1000 },
      { ...base, poolAddress: 'b', reserveBHuman: 1001 }, // 0.1% spread < 0.3% threshold
    ];
    expect(findArbitrageOpportunities(pools, { minSpreadPct: 0.3 })).toHaveLength(0);
  });

  it('requires at least two pools per pair', () => {
    expect(findArbitrageOpportunities([{ ...base, poolAddress: 'solo', reserveBHuman: 1000 }])).toHaveLength(0);
  });
});
