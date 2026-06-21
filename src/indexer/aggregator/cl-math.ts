/**
 * Concentrated Liquidity AMM Math (Issue #334, §8)
 *
 * Core math for Uniswap V3 style concentrated liquidity pools:
 * - Tick math (sqrtPrice ↔ tick conversions)
 * - Liquidity calculations
 * - Swap amount calculations within tick ranges
 * - Fee accrual
 */

import { PoolInfo } from './pool-indexer';

// Tick constants (Soroban V3 compatible)
export const TICK_BASE = 1.0001;
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const MIN_SQRT_RATIO = 4295128739n;
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

// Q64.64 fixed point representation
const Q64 = 2n ** 64n;
const Q128 = 2n ** 128n;

/**
 * Convert sqrt price to tick.
 * sqrtPrice is in Q64.64 format.
 */
export function sqrtPriceToTick(sqrtPrice: bigint): number {
  const price = Number(sqrtPrice) / Number(Q64);
  const tick = Math.log(price) / Math.log(TICK_BASE);
  return Math.round(tick);
}

/**
 * Convert tick to sqrt price.
 * Returns Q64.64 format.
 */
export function tickToSqrtPrice(tick: number): bigint {
  const price = TICK_BASE ** tick;
  const sqrtPrice = Math.sqrt(price);
  return BigInt(Math.round(sqrtPrice * Number(Q64)));
}

/**
 * Calculate liquidity for a given amount and price range.
 */
export function calculateLiquidity(
  amount: bigint,
  currentSqrtPrice: bigint,
  tickLower: number,
  tickUpper: number,
  isTokenA: boolean,
): bigint {
  const sqrtPriceA = tickToSqrtPrice(tickLower);
  const sqrtPriceB = tickToSqrtPrice(tickUpper);

  if (isTokenA) {
    // Token A (base token)
    const numerator = amount * sqrtPriceA * sqrtPriceB;
    const denominator = Q64 * (sqrtPriceB - sqrtPriceA);
    return numerator / denominator;
  } else {
    // Token B (quote token)
    const numerator = amount * Q64;
    const denominator = sqrtPriceB - sqrtPriceA;
    return numerator / denominator;
  }
}

/**
 * Calculate token amounts for a given liquidity and price range.
 */
export function calculateAmounts(
  liquidity: bigint,
  currentSqrtPrice: bigint,
  tickLower: number,
  tickUpper: number,
): { amountA: bigint; amountB: bigint } {
  const sqrtPriceA = tickToSqrtPrice(tickLower);
  const sqrtPriceB = tickToSqrtPrice(tickUpper);

  let amountA = 0n;
  let amountB = 0n;

  if (currentSqrtPrice <= sqrtPriceA) {
    // Price below range → all liquidity in token A
    amountA = liquidity * (sqrtPriceB - sqrtPriceA) * Q64 / (sqrtPriceA * sqrtPriceB);
    amountA = amountA / Q64;
  } else if (currentSqrtPrice >= sqrtPriceB) {
    // Price above range → all liquidity in token B
    amountB = liquidity * (sqrtPriceB - sqrtPriceA) / Q64;
  } else {
    // Price in range → mixed
    amountA = liquidity * Q64 * (sqrtPriceB - currentSqrtPrice) / (currentSqrtPrice * sqrtPriceB);
    amountA = amountA / Q64;
    amountB = liquidity * (currentSqrtPrice - sqrtPriceA) / Q64;
  }

  return { amountA, amountB };
}

/**
 * Calculate fee accrued for a position.
 */
export function calculateFees(
  liquidity: bigint,
  feeGrowthGlobal: bigint,
  feeGrowthLower: bigint,
  feeGrowthUpper: bigint,
): bigint {
  const feeGrowthBelow = feeGrowthGlobal - feeGrowthLower;
  const feeGrowthAbove = feeGrowthGlobal - feeGrowthUpper;
  return liquidity * (feeGrowthBelow - feeGrowthAbove) / Q128;
}

/**
 * Determine if a CL position is in range.
 */
export function isPositionInRange(
  currentTick: number,
  tickLower: number,
  tickUpper: number,
): boolean {
  return currentTick >= tickLower && currentTick < tickUpper;
}

/**
 * Estimate APR for a CL position based on fee tier and volume.
 */
export function estimateClApr(
  feeTier: number,
  volume24h: bigint,
  tvl: bigint,
  utilization: number = 0.5,
): number {
  if (tvl <= 0n) return 0;
  const feesPerYear = Number(volume24h) * 365 * (feeTier / 10_000) * utilization;
  return (feesPerYear / Number(tvl)) * 100;
}

/**
 * Suggest optimal tick range based on current price and volatility.
 */
export function suggestOptimalRange(
  currentTick: number,
  volatilityBps: number = 100, // 1% daily volatility
  widthMultiplier: number = 2,
): { tickLower: number; tickUpper: number } {
  const halfWidth = Math.round(volatilityBps * widthMultiplier / 10_000 / Math.log(TICK_BASE));
  return {
    tickLower: currentTick - halfWidth,
    tickUpper: currentTick + halfWidth,
  };
}
