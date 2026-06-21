/**
 * Comprehensive tests for the Cross-Protocol Liquidity Aggregation Engine (Issue #334)
 *
 * Tests cover only pure functions — no database dependency required.
 * 
 * 1. Pool math (constant product, stable, weighted)
 * 2. Smart Order Router utilities
 * 3. Split Routing
 * 4. MEV Risk Assessment
 * 5. Gas Estimation
 * 6. CL Math
 * 7. Risk Management
 * 8. Bridge Aggregation
 */

import { describe, it, expect } from 'vitest';

// ─── 1. Pool Math Tests ─────────────────────────────────────────────────────

describe('Pool Math', () => {
  describe('Constant Product AMM', () => {
    it('should calculate getAmountOut correctly', () => {
      // Import the pure function directly
      const { constantProductGetAmountOut } = require('../src/indexer/aggregator/price-engine');
      
      const amountIn = 100n;
      const reserveIn = 1_000_000n;
      const reserveOut = 2_000_000n;
      const feeBps = 30; // 0.3%

      const amountOut = constantProductGetAmountOut(amountIn, reserveIn, reserveOut, feeBps);
      expect(amountOut).toBeGreaterThan(0n);
      // Without fee: 100 * 2,000,000 / (1,000,000 + 100) = ~199.98
      // With fee (0.3%): 99.7 * 2,000,000 / (1,000,000 + 99.7) = ~199.36
      expect(amountOut).toBeLessThan(200n);
    });

    it('should return 0 for zero amountIn', () => {
      const { constantProductGetAmountOut } = require('../src/indexer/aggregator/price-engine');
      const result = constantProductGetAmountOut(0n, 1_000_000n, 2_000_000n, 30);
      expect(result).toBe(0n);
    });

    it('should return 0 for zero reserves', () => {
      const { constantProductGetAmountOut } = require('../src/indexer/aggregator/price-engine');
      const result = constantProductGetAmountOut(100n, 0n, 0n, 30);
      expect(result).toBe(0n);
    });

    it('should calculate getAmountIn correctly', () => {
      const { constantProductGetAmountIn } = require('../src/indexer/aggregator/price-engine');
      const amountOut = 100n;
      const reserveIn = 1_000_000n;
      const reserveOut = 2_000_000n;
      const feeBps = 30;

      const amountIn = constantProductGetAmountIn(amountOut, reserveIn, reserveOut, feeBps);
      expect(amountIn).toBeGreaterThan(0n);
    });

    it('should handle proportional reserves', () => {
      const { constantProductGetAmountOut } = require('../src/indexer/aggregator/price-engine');
      // Swap 100 USDC for XLM from a pool with 1000 USDC and 1000 XLM
      const usdcIn = 100n;
      const usdcReserve = 1_000_000n;
      const xlmReserve = 1_000_000n;
      const xlmOut = constantProductGetAmountOut(usdcIn, usdcReserve, xlmReserve, 30);
      
      expect(xlmOut).toBeGreaterThan(0n);
      // Should get slightly less than 100 XLM due to 0.3% fee
      expect(xlmOut).toBeLessThan(100n);
    });

    it('should respect fee tier impact', () => {
      const { constantProductGetAmountOut } = require('../src/indexer/aggregator/price-engine');
      const amountIn = 1000n;
      const a = constantProductGetAmountOut(amountIn, 1_000_000n, 1_000_000n, 30); // 0.3%
      const b = constantProductGetAmountOut(amountIn, 1_000_000n, 1_000_000n, 100); // 1%
      expect(a).toBeGreaterThan(b);
    });
  });

  describe('StableSwap AMM', () => {
    it('should calculate stable swap amount out', () => {
      const { stableSwapGetAmountOut } = require('../src/indexer/aggregator/price-engine');
      const amountIn = 1_000_000n;
      const reserveIn = 10_000_000n;
      const reserveOut = 10_000_000n;
      const feeBps = 4; // 0.04%

      const amountOut = stableSwapGetAmountOut(amountIn, reserveIn, reserveOut, feeBps, 100);
      expect(amountOut).toBeGreaterThan(0n);
      // Stable pools should give ~997k out (less slippage than constant product)
      expect(amountOut).toBeLessThan(amountIn); // Always loses some to fees
    });

    it('should have less slippage than constant product for same reserves', () => {
      const { stableSwapGetAmountOut, constantProductGetAmountOut } = require('../src/indexer/aggregator/price-engine');
      const amountIn = 1_000_000n;
      const reserveIn = 10_000_000n;
      const reserveOut = 10_000_000n;

      const stableOut = stableSwapGetAmountOut(amountIn, reserveIn, reserveOut, 4, 100);
      const constOut = constantProductGetAmountOut(amountIn, reserveIn, reserveOut, 4);
      
      // StableSwap should give higher output for same trade size (less slippage)
      expect(stableOut).toBeGreaterThan(constOut);
    });

    it('should return 0 for zero reserves', () => {
      const { stableSwapGetAmountOut } = require('../src/indexer/aggregator/price-engine');
      const result = stableSwapGetAmountOut(100n, 0n, 0n, 4, 100);
      expect(result).toBe(0n);
    });
  });

  describe('Weighted Pool AMM', () => {
    it('should calculate weighted pool amount out', () => {
      const { weightedPoolGetAmountOut } = require('../src/indexer/aggregator/price-engine');
      const amountIn = 100_000n;
      const reserveIn = 1_000_000n;
      const reserveOut = 1_000_000n;
      const feeBps = 50; // 0.5%

      const amountOut = weightedPoolGetAmountOut(amountIn, reserveIn, reserveOut, 0.5, 0.5, feeBps);
      expect(amountOut).toBeGreaterThan(0n);
    });

    it('should handle uneven weights', () => {
      const { weightedPoolGetAmountOut } = require('../src/indexer/aggregator/price-engine');
      // 80/20 pool
      const amountOut = weightedPoolGetAmountOut(100_000n, 1_000_000n, 1_000_000n, 0.8, 0.2, 50);
      expect(amountOut).toBeGreaterThan(0n);
    });
  });

  describe('Price Engine', () => {
    it('should compute getMidPrice', () => {
      const { getMidPrice } = require('../src/indexer/aggregator/price-engine');
      const pool = {
        reserveA: 1_000_000_000_000n,
        reserveB: 2_000_000_000_000n,
        tokenADecimals: 7,
        tokenBDecimals: 7,
      };
      const price = getMidPrice(pool as any);
      expect(price).toBeCloseTo(2.0, 1);
    });

    it('should compute getCanonicalPairKey', () => {
      const { getCanonicalPairKey } = require('../src/indexer/aggregator/pool-indexer');
      const key = getCanonicalPairKey('C_tokenB', 'C_tokenA');
      const reversed = getCanonicalPairKey('C_tokenA', 'C_tokenB');
      expect(key).toBe(reversed);
    });

    it('should simulate swap with price impact', () => {
      const { simulateDirectSwap } = require('../src/indexer/aggregator/price-engine');
      const pool = {
        id: 'test',
        dexName: 'soroswap',
        poolAddress: 'addr',
        poolType: 'constant_product',
        tokenA: 'A',
        tokenB: 'B',
        tokenADecimals: 7,
        tokenBDecimals: 7,
        feeTier: 30,
        reserveA: 1_000_000_000n,
        reserveB: 2_000_000_000n,
        lastUpdated: new Date(),
        volume24h: 0n,
        fees24h: 0n,
      };
      const result = simulateDirectSwap(pool, 'A', 100_000n);
      expect(result.amountOut).toBeGreaterThan(0n);
      expect(result.priceImpact).toBeGreaterThanOrEqual(0);
      expect(result.feePaid).toBeGreaterThan(0n);
    });
  });
});

// ─── 2. Gas Estimation Tests ────────────────────────────────────────────────

describe('Gas Estimation', () => {
  it('should estimate hop gas based on pool type', () => {
    const { estimateHopGas } = require('../src/indexer/aggregator/gas-optimizer');
    const pool = { poolType: 'constant_product', id: 'p1' };
    const gas = estimateHopGas(pool as any);
    expect(gas).toBeGreaterThan(0n);
  });

  it('should estimate higher gas for complex pools', () => {
    const { estimateHopGas } = require('../src/indexer/aggregator/gas-optimizer');
    const pools = [
      { poolType: 'constant_product', id: 'cp' },
      { poolType: 'stable', id: 'st' },
      { poolType: 'weighted', id: 'w' },
      { poolType: 'concentrated', id: 'cl' },
    ];
    
    const gases = pools.map((p) => estimateHopGas(p as any));
    
    // CL should be most expensive
    expect(gases[3]).toBeGreaterThan(gases[0]);
    // Weighted more than stable
    expect(gases[2]).toBeGreaterThan(gases[1]);
  });

  it('should estimate total route gas', () => {
    const { estimateRouteGas } = require('../src/indexer/aggregator/gas-optimizer');
    const hops = [
      { poolId: 'p1', dexName: 'soroswap', poolAddress: 'a1', tokenIn: 'A', tokenOut: 'B', amountIn: 0n, amountOut: 0n, priceImpact: 0, feePaid: 0n },
      { poolId: 'p2', dexName: 'aquarius', poolAddress: 'a2', tokenIn: 'B', tokenOut: 'C', amountIn: 0n, amountOut: 0n, priceImpact: 0, feePaid: 0n },
    ];
    const estimate = estimateRouteGas(hops);
    expect(estimate.totalGas).toBeGreaterThan(0n);
    expect(estimate.totalFee).toBeGreaterThan(0n);
    expect(estimate.gasPerHop.length).toBe(2);
    expect(['fast', 'standard', 'slow']).toContain(estimate.gasPricePriority);
  });

  it('should return gas prices', () => {
    const { getGasPrices } = require('../src/indexer/aggregator/gas-optimizer');
    const prices = getGasPrices();
    expect(prices.fast).toBeGreaterThan(0);
    expect(prices.standard).toBeGreaterThan(0);
    expect(prices.slow).toBeGreaterThan(0);
    expect(prices.fast).toBeGreaterThan(prices.standard);
    expect(prices.standard).toBeGreaterThan(prices.slow);
  });

  it('should optimize route for gas', () => {
    const { optimizeForGas } = require('../src/indexer/aggregator/gas-optimizer');
    const route = {
      hops: [
        { poolId: 'p1', dexName: 'soroswap', poolAddress: '', tokenIn: 'A', tokenOut: 'B', amountIn: 100000n, amountOut: 95000n, priceImpact: 0.5, feePaid: 300n },
        { poolId: 'p2', dexName: 'soroswap', poolAddress: '', tokenIn: 'B', tokenOut: 'C', amountIn: 95000n, amountOut: 90000n, priceImpact: 0.5, feePaid: 285n },
      ],
      totalAmountIn: 100000n,
      totalAmountOut: 90000n,
      totalPriceImpact: 1,
      totalFeePaid: 585n,
      estimatedGas: 0n,
      executionPrice: 0.9,
      midPrice: 1,
      slippagePct: 10,
    };
    const result = optimizeForGas(route);
    expect(['use_original', 'use_optimized', 'neutral']).toContain(result.recommendation);
    expect(result.gasSavings).toBeGreaterThanOrEqual(0n);
  });
});

// ─── 3. MEV Protection Tests ────────────────────────────────────────────────

describe('MEV Protection', () => {
  it('should assess MEV risk for a route', () => {
    const { assessMevRisk } = require('../src/indexer/aggregator/mev-protection');
    const risk = assessMevRisk('test-route', BigInt(1_000_000_000), 3);
    expect(risk.routeId).toBe('test-route');
    expect(risk.sandwichRisk).toBeGreaterThanOrEqual(0);
    expect(risk.frontrunRisk).toBeGreaterThanOrEqual(0);
    expect(risk.backrunRisk).toBeGreaterThanOrEqual(0);
    expect(risk.overallScore).toBeGreaterThanOrEqual(0);
    expect(['safe', 'caution', 'danger']).toContain(risk.recommendation);
    expect(risk.protectionsAvailable.length).toBeGreaterThanOrEqual(2);
  });

  it('should detect sandwich attack', () => {
    const { detectSandwichAttack } = require('../src/indexer/aggregator/mev-protection');
    const result = detectSandwichAttack(
      { hash: 'tx1', amountIn: '1000', amountOut: '2000' },
      { hash: 'tx2', amountIn: '500', amountOut: '950' },
      { hash: 'tx3', amountIn: '1000', amountOut: '1900' },
    );
    expect(result.confidence).toBeGreaterThan(0);
    expect(typeof result.isSandwich).toBe('boolean');
    expect(result.victimLoss).toBeGreaterThanOrEqual(0n);
  });

  it('should have higher risk for larger amounts', () => {
    const { assessMevRisk } = require('../src/indexer/aggregator/mev-protection');
    const smallRisk = assessMevRisk('small', BigInt(1_000), 1);
    const largeRisk = assessMevRisk('large', BigInt(1_000_000_000_000_000), 5);
    expect(largeRisk.overallScore).toBeGreaterThanOrEqual(smallRisk.overallScore);
  });

  it('should provide protection strategies', () => {
    const { assessMevRisk, applyMevProtection } = require('../src/indexer/aggregator/mev-protection');
    const risk = assessMevRisk('test', BigInt(100_000_000), 2);
    
    const protection = applyMevProtection({
      userAddress: 'GABC',
      routeId: 'test-route',
      slippageTolerance: 0.5,
      deadlineBlocks: 10,
      strategy: 'private_mempool',
    });
    expect(protection.protectionApplied).toBe(true);
    expect(protection.protectedTx.strategy).toBe('private_mempool');
  });
});

// ─── 4. Risk Management Tests ───────────────────────────────────────────────

describe('Risk Management', () => {
  it('should calculate impermanent loss', () => {
    const { calculateImpermanentLoss } = require('../src/indexer/aggregator/risk-manager');
    const il = calculateImpermanentLoss(2); // 2x price change
    expect(il).toBeLessThan(0); // IL is always negative or zero
  });

  it('should have known IL values', () => {
    const { calculateImpermanentLoss } = require('../src/indexer/aggregator/risk-manager');
    // At 2x price change, IL ≈ -5.72%
    expect(calculateImpermanentLoss(2)).toBeCloseTo(-0.0572, 2);
    // At 4x price change, IL ≈ -20%
    expect(calculateImpermanentLoss(4)).toBeCloseTo(-0.2, 1);
    // At 1.25x price change, IL ≈ -0.6%
    expect(calculateImpermanentLoss(1.25)).toBeCloseTo(-0.006, 2);
  });

  it('should return 0 IL for no price change', () => {
    const { calculateImpermanentLoss } = require('../src/indexer/aggregator/risk-manager');
    expect(calculateImpermanentLoss(1)).toBeCloseTo(0, 5);
  });

  it('should handle token risk checks', () => {
    const { checkTokenRisk, getBlacklistedTokens } = require('../src/indexer/aggregator/risk-manager');
    const risk = checkTokenRisk('CKNOWNTOKEN', BigInt(1_000_000));
    expect(risk.tokenAddress).toBeDefined();
    expect(risk.riskScore).toBeGreaterThanOrEqual(0);
    expect(['safe', 'low', 'medium', 'high', 'critical']).toContain(risk.riskLabel);
    
    // Blacklist should be empty initially
    const blacklisted = getBlacklistedTokens();
    expect(Array.isArray(blacklisted)).toBe(true);
  });

  it('should assess route risk', () => {
    const { assessRouteRisk } = require('../src/indexer/aggregator/risk-manager');
    const pools = [
      { poolAddress: 'pool1', tokenA: 'A', tokenB: 'B', feeTier: 30, reserveA: 1000n, reserveB: 2000n },
      { poolAddress: 'pool2', tokenA: 'B', tokenB: 'C', feeTier: 30, reserveA: 1000n, reserveB: 2000n },
    ];
    const risk = assessRouteRisk(pools as any, BigInt(1000));
    expect(risk.overallRisk).toBeGreaterThanOrEqual(0);
    expect(risk.warnings).toBeDefined();
  });
});

// ─── 5. CL Math Tests ──────────────────────────────────────────────────────

describe('Concentrated Liquidity Math', () => {
  it('should convert sqrt price to tick and back', () => {
    const { tickToSqrtPrice, sqrtPriceToTick } = require('../src/indexer/aggregator/cl-math');
    const tick = 50000;
    const sqrtPrice = tickToSqrtPrice(tick);
    const decodedTick = sqrtPriceToTick(sqrtPrice);
    expect(Math.abs(decodedTick - tick)).toBeLessThanOrEqual(1);
  });

  it('should convert tick 0 to sqrt price 1', () => {
    const { tickToSqrtPrice, sqrtPriceToTick } = require('../src/indexer/aggregator/cl-math');
    const sqrtPrice = tickToSqrtPrice(0);
    expect(sqrtPriceToTick(sqrtPrice)).toBeCloseTo(0, 0);
  });

  it('should calculate amounts from liquidity', () => {
    const { calculateAmounts, tickToSqrtPrice } = require('../src/indexer/aggregator/cl-math');
    const liquidity = 1_000_000_000_000n;
    const sqrtPrice = tickToSqrtPrice(50000);
    const amounts = calculateAmounts(liquidity, sqrtPrice, 40000, 60000);
    expect(amounts.amountA).toBeGreaterThan(0n);
    expect(amounts.amountB).toBeGreaterThan(0n);
  });

  it('should determine if position is in range', () => {
    const { isPositionInRange } = require('../src/indexer/aggregator/cl-math');
    expect(isPositionInRange(50000, 40000, 60000)).toBe(true);
    expect(isPositionInRange(30000, 40000, 60000)).toBe(false);
    expect(isPositionInRange(70000, 40000, 60000)).toBe(false);
  });

  it('should suggest optimal range centered on current tick', () => {
    const { suggestOptimalRange } = require('../src/indexer/aggregator/cl-math');
    const suggestion = suggestOptimalRange(50000, 100, 2);
    expect(suggestion.tickLower).toBeLessThan(suggestion.tickUpper);
    expect(suggestion.tickLower).toBeLessThan(50000);
    expect(suggestion.tickUpper).toBeGreaterThan(50000);
  });

  it('should estimate CL APR', () => {
    const { estimateClApr } = require('../src/indexer/aggregator/cl-math');
    const apr = estimateClApr(30, BigInt(1_000_000), BigInt(100_000_000), 0.5);
    expect(apr).toBeGreaterThan(0);
  });

  it('should provide sensible range suggestions with wider ranges for higher volatility', () => {
    const { suggestOptimalRange } = require('../src/indexer/aggregator/cl-math');
    const lowVol = suggestOptimalRange(50000, 50, 2);
    const highVol = suggestOptimalRange(50000, 200, 2);
    const lowWidth = lowVol.tickUpper - lowVol.tickLower;
    const highWidth = highVol.tickUpper - highVol.tickLower;
    expect(highWidth).toBeGreaterThan(lowWidth);
  });
});

// ─── 6. Bridge Aggregation Tests ────────────────────────────────────────────

describe('Bridge Aggregation', () => {
  it('should find available bridges between chains', () => {
    const { getAvailableBridges } = require('../src/indexer/aggregator/bridge-aggregator');
    const bridges = getAvailableBridges('soroban', 'ethereum');
    expect(bridges.length).toBeGreaterThan(0);
  });

  it('should compute cross-chain quotes', () => {
    const { computeCrossChainQuote } = require('../src/indexer/aggregator/bridge-aggregator');
    const quotes = computeCrossChainQuote('soroban', 'ethereum', 'USDC', BigInt(1_000_000_000));
    expect(quotes.length).toBeGreaterThan(0);
    expect(quotes[0].amountOut).toBeGreaterThan(0n);
    expect(quotes[0].bridgeName).toBeDefined();
    expect(quotes[0].estimatedTimeMs).toBeGreaterThan(0);
  });

  it('should quote with bridge fees', () => {
    const { computeCrossChainQuote } = require('../src/indexer/aggregator/bridge-aggregator');
    const amountIn = BigInt(1_000_000_000);
    const quotes = computeCrossChainQuote('soroban', 'ethereum', 'USDC', amountIn);
    
    for (const q of quotes) {
      expect(q.bridgeFee).toBeGreaterThan(0n);
      expect(q.dexFee).toBeGreaterThan(0n);
      expect(q.amountOut).toBeLessThan(amountIn); // fees reduce output
    }
  });

  it('should return all bridge statuses', () => {
    const { getAllBridgeStatuses } = require('../src/indexer/aggregator/bridge-aggregator');
    const bridges = getAllBridgeStatuses();
    expect(bridges.length).toBeGreaterThan(0);
    for (const b of bridges) {
      expect(b.name).toBeDefined();
      expect(b.status).toBe('operational');
      expect(b.feePct).toBeGreaterThan(0);
    }
  });
});

// ─── 7. TWAP Oracle Tests ──────────────────────────────────────────────────

describe('TWAP Oracle', () => {
  it('should compute TWAP from price history', () => {
    const { computeTwap } = require('../src/indexer/aggregator/twap-oracle');
    const prices = [
      { price: 1.0, timestamp: new Date(Date.now() - 1000) },
      { price: 1.1, timestamp: new Date(Date.now() - 2000) },
      { price: 0.95, timestamp: new Date(Date.now() - 3000) },
      { price: 1.05, timestamp: new Date(Date.now() - 4000) },
    ];
    const twap = computeTwap(prices, 3600);
    expect(twap).toBeGreaterThan(0);
    expect(twap).toBeCloseTo(1.023, 1);
  });

  it('should return 0 for empty price history', () => {
    const { computeTwap } = require('../src/indexer/aggregator/twap-oracle');
    const twap = computeTwap([], 3600);
    expect(twap).toBe(0);
  });

  it('should aggregate TWAP from multiple sources', () => {
    const { computeAggregateTwap } = require('../src/indexer/aggregator/twap-oracle');
    const now = Date.now();
    const sources = [
      {
        source: 'dex1',
        prices: [
          { price: 1.0, timestamp: new Date(now - 1000) },
          { price: 1.02, timestamp: new Date(now - 2000) },
        ],
      },
      {
        source: 'dex2',
        prices: [
          { price: 0.98, timestamp: new Date(now - 1000) },
          { price: 1.01, timestamp: new Date(now - 2000) },
        ],
      },
    ];
    const result = computeAggregateTwap(sources, 3600);
    expect(result.price).toBeGreaterThan(0);
    expect(result.sourceCount).toBe(2);
    expect(result.confidence).toBeGreaterThan(0);
  });
});

// ─── 8. Quote Cache Tests ──────────────────────────────────────────────────

describe('Quote Cache', () => {
  it('should build correct cache key', () => {
    const { buildQuoteCacheKey } = require('../src/indexer/aggregator/quote-cache');
    const key = buildQuoteCacheKey('TOKEN_A', 'TOKEN_B', '100000');
    expect(key).toBe('TOKEN_A|TOKEN_B|100000');
  });

  it('should clear cache', () => {
    const { clearQuoteCache } = require('../src/indexer/aggregator/quote-cache');
    expect(() => clearQuoteCache()).not.toThrow();
  });

  it('should mark and check common pairs', () => {
    const { markCommonPair, isCommonPair } = require('../src/indexer/aggregator/quote-cache');
    markCommonPair('A|B');
    expect(isCommonPair('A', 'B')).toBe(true);
    expect(isCommonPair('X', 'Y')).toBe(false);
  });
});

// ─── 9. Social Trading Tests ───────────────────────────────────────────────

describe('Social Trading', () => {
  it('should simulate copy trade returns', () => {
    const { simulateCopyTrade } = require('../src/indexer/aggregator/social-trading');
    const result = simulateCopyTrade('GTRADER', BigInt(1_000_000), 0.5);
    expect(['low', 'medium', 'high']).toContain(result.riskLevel);
    expect(result.recommendation).toBeDefined();
  });
});

// ─── 10. DCA Tests ─────────────────────────────────────────────────────────

describe('DCA', () => {
  it('should have exported engine functions', async () => {
    const dca = await import('../src/indexer/aggregator/dca');
    expect(typeof dca.createDcaStrategy).toBe('function');
    expect(typeof dca.pauseDcaStrategy).toBe('function');
    expect(typeof dca.resumeDcaStrategy).toBe('function');
    expect(typeof dca.cancelDcaStrategy).toBe('function');
  });
});

// ─── 11. API Router Test ───────────────────────────────────────────────────

describe('Aggregator API Router', () => {
  it('should export aggregatorRouter', async () => {
    const { aggregatorRouter } = await import('../src/api/aggregator');
    expect(aggregatorRouter).toBeDefined();
    expect(typeof aggregatorRouter).toBe('function');
  });

  it('should have asyncHandler middleware', async () => {
    const { asyncHandler } = await import('../src/middleware/asyncHandler');
    expect(asyncHandler).toBeDefined();
  });
});

// ─── 12. Order Router Utility Tests ─────────────────────────────────────────

describe('Order Router Utilities', () => {
  it('should have exported routing algorithms', async () => {
    const router = await import('../src/indexer/aggregator/order-router');
    expect(typeof router.getOptimalRoute).toBe('function');
    expect(typeof router.findAllRoutes).toBe('function');
    expect(typeof router.getBestPrice).toBe('function');
    expect(typeof router.computeQuote).toBe('function');
  });
});

// ─── 13. CL Manager Tests ──────────────────────────────────────────────────

describe('CL Manager', () => {
  it('should have exported position management functions', async () => {
    const cl = await import('../src/indexer/aggregator/cl-manager');
    expect(typeof cl.createClPosition).toBe('function');
    expect(typeof cl.getClPosition).toBe('function');
    expect(typeof cl.listClPositions).toBe('function');
    expect(typeof cl.adjustClPosition).toBe('function');
    expect(typeof cl.claimClFees).toBe('function');
    expect(typeof cl.closeClPosition).toBe('function');
    expect(typeof cl.getRangeSuggestions).toBe('function');
  });

  it('should provide range suggestions without DB', () => {
    // getRangeSuggestions iterates over pools from getAllPools()
    // If no pools are registered, it should gracefully return empty
    const { getRangeSuggestions } = require('../src/indexer/aggregator/cl-manager');
    // This should not throw even with an empty pool registry
    expect(() => getRangeSuggestions('nonexistent', 100)).not.toThrow();
  });
});
