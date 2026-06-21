/**
 * Price Engine — Smart Quote & Swap Simulation (Issue #334, §1, §4)
 *
 * Computes optimal prices across all supported AMM types, with
 * slippage and price impact calculations.
 */

import { PoolInfo, getPoolsForPair, getCanonicalPairKey } from './pool-indexer';

export interface QuoteRequest {
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  slippageTolerance?: number; // 0.5 = 0.5%
  maxHops?: number;
  includeSplitRoutes?: boolean;
  gasStrategy?: 'fast' | 'standard' | 'slow';
  mevProtection?: boolean;
  receiver?: string;
}

export interface RouteHop {
  poolId: string;
  dexName: string;
  poolAddress: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  amountOut: bigint;
  priceImpact: number;
  feePaid: bigint;
}

export interface RouteQuote {
  hops: RouteHop[];
  totalAmountIn: bigint;
  totalAmountOut: bigint;
  totalPriceImpact: number;
  totalFeePaid: bigint;
  estimatedGas: bigint;
  executionPrice: number;
  midPrice: number;
  slippagePct: number;
}

export interface QuoteResult {
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  amountOut: bigint;
  routes: RouteQuote[];
  bestRoute: RouteQuote;
  priceImpact: number;
  executionPrice: number;
  midPrice: number;
  estimatedGas: bigint;
  routeCount: number;
  optimizationTimeMs: number;
}

// ── Constant Product AMM (x * y = k) ──────────────────────────────────────

const BPS = 10_000n;

export function constantProductGetAmountOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps: number,
): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const feeFactor = BPS - BigInt(feeBps);
  const amountInWithFee = amountIn * feeFactor;
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * BPS + amountInWithFee;
  return numerator / denominator;
}

export function constantProductGetAmountIn(
  amountOut: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps: number,
): bigint {
  if (amountOut <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  if (amountOut >= reserveOut) return 0n;
  const feeFactor = BPS - BigInt(feeBps);
  const numerator = reserveIn * amountOut * BPS;
  const denominator = (reserveOut - amountOut) * feeFactor;
  return numerator / denominator + 1n;
}

// ── StableSwap (Curve style) ──────────────────────────────────────────────

export function stableSwapGetAmountOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps: number,
  ampFactor: number = 100,
): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const feeFactor = BPS - BigInt(feeBps);
  const amountInWithFee = amountIn * feeFactor;
  const x = reserveIn + amountInWithFee;
  const n = 2n; // two tokens in the pool
  const A = BigInt(ampFactor);
  const sum = x + reserveOut;
  const prod = x * reserveOut;
  const D = calculateStableSwapD(n, A, [x, reserveOut]);
  const y = calculateStableSwapY(n, A, D, x);
  return reserveOut - y;
}

function calculateStableSwapD(n: bigint, A: bigint, x: bigint[]): bigint {
  let S = 0n;
  for (const xi of x) S += xi;
  if (S === 0n) return 0n;

  let D = S;
  const N = n;
  const Ann = A * N;
  for (let i = 0; i < 128; i++) {
    let D_P = D;
    for (const xi of x) {
      D_P = (D_P * D) / (xi * N);
    }
    const Dprev = D;
    D = (Ann * S + D_P * N) * D / ((Ann - 1n) * D + (N + 1n) * D_P);
    if (D > Dprev ? D - Dprev <= 1n : Dprev - D <= 1n) break;
  }
  return D;
}

function calculateStableSwapY(n: bigint, A: bigint, D: bigint, x: bigint): bigint {
  const N = n;
  const Ann = A * N;
  let y = D;
  for (let i = 0; i < 128; i++) {
    const y_prev = y;
    let yD = (y * y) / D;
    let sum = 0n;
    // sum = x (since only the other token is variable)
    const c = (yD * D) / (Ann * 2n) + D / N - x;
    const b = y + D / Ann;
    y = (b * y + c) / (y * 2n);
    if (y > y_prev ? y - y_prev <= 1n : y_prev - y <= 1n) break;
  }
  return y;
}

// ── Weighted Pool (Balancer style) ───────────────────────────────────────

export function weightedPoolGetAmountOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  weightIn: number = 0.5,
  weightOut: number = 0.5,
  feeBps: number,
): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const feeFactor = BPS - BigInt(feeBps);
  const amountInWithFee = amountIn * feeFactor / BPS;
  const newReserveIn = reserveIn + amountInWithFee * BigInt(BPS) / BPS;
  const ratioIn = Number(newReserveIn) / Number(reserveIn);
  const invariant = Number(reserveIn) ** weightIn * Number(reserveOut) ** weightOut;
  const newReserveOut = (invariant / Number(newReserveIn) ** weightIn) ** (1 / weightOut);
  const amountOut = Number(reserveOut) - newReserveOut;
  return BigInt(Math.max(0, Math.round(amountOut)));
}

// ── Concentrated Liquidity AMM (Uniswap V3 style) ────────────────────────

export function concentratedGetAmountOut(
  amountIn: bigint,
  sqrtPrice: bigint,
  liquidity: bigint,
  feeBps: number,
): bigint {
  // Simplified CL AMM pricing
  const feeFactor = BPS - BigInt(feeBps);
  const amountInWithFee = amountIn * feeFactor / BPS;
  // L * (1/sqrt(P_low) - 1/sqrt(P_high))
  // For simplicity, estimate using constant product approximation
  const price = Number(sqrtPrice) / 2 ** 64;
  const reserveA = BigInt(Math.round(Number(liquidity) / Math.sqrt(price)));
  const reserveB = BigInt(Math.round(Number(liquidity) * Math.sqrt(price)));
  return constantProductGetAmountOut(amountInWithFee, reserveA, reserveB, 0);
}

// ── Multi-type swap dispatch ─────────────────────────────────────────────

export function getAmountOutForPool(
  pool: PoolInfo,
  amountIn: bigint,
  tokenIn: string,
): bigint {
  const isTokenA = tokenIn === pool.tokenA;
  const reserveIn = isTokenA ? pool.reserveA : pool.reserveB;
  const reserveOut = isTokenA ? pool.reserveB : pool.reserveA;

  switch (pool.poolType) {
    case 'stable':
      return stableSwapGetAmountOut(amountIn, reserveIn, reserveOut, pool.feeTier);
    case 'weighted':
      return weightedPoolGetAmountOut(amountIn, reserveIn, reserveOut, 0.5, 0.5, pool.feeTier);
    case 'concentrated':
      if (pool.sqrtPrice && pool.liquidity) {
        return concentratedGetAmountOut(amountIn, pool.sqrtPrice, pool.liquidity, pool.feeTier);
      }
      return constantProductGetAmountOut(amountIn, reserveIn, reserveOut, pool.feeTier);
    case 'constant_product':
    case 'dynamic_fee':
    default:
      return constantProductGetAmountOut(amountIn, reserveIn, reserveOut, pool.feeTier);
  }
}

export function getPriceImpact(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  amountOut: bigint,
): number {
  if (amountIn <= 0n || reserveIn <= 0n) return 0;
  const midPrice = Number(reserveOut) / Number(reserveIn);
  const executionPrice = Number(amountOut) / Number(amountIn);
  if (midPrice <= 0) return 0;
  return Math.max(0, (1 - executionPrice / midPrice) * 100);
}

export function getMidPrice(pool: PoolInfo): number {
  const a = Number(pool.reserveA) / 10 ** pool.tokenADecimals;
  const b = Number(pool.reserveB) / 10 ** pool.tokenBDecimals;
  return a > 0 ? b / a : 0;
}

// ── Direct swap simulation ───────────────────────────────────────────────

export function simulateDirectSwap(
  pool: PoolInfo,
  tokenIn: string,
  amountIn: bigint,
): { amountOut: bigint; priceImpact: number; feePaid: bigint } {
  const isTokenA = tokenIn === pool.tokenA;
  const reserveIn = isTokenA ? pool.reserveA : pool.reserveB;
  const reserveOut = isTokenA ? pool.reserveB : pool.reserveA;
  const feePaid = (amountIn * BigInt(pool.feeTier)) / BPS;
  const amountOut = getAmountOutForPool(pool, amountIn, tokenIn);
  const priceImpact = getPriceImpact(amountIn, reserveIn, reserveOut, amountOut);
  return { amountOut, priceImpact, feePaid };
}

export function simulateMultiHopSwap(
  pools: PoolInfo[],
  tokenPath: string[],
  amountIn: bigint,
): { amountOut: bigint; hops: RouteHop[] } {
  let currentAmount = amountIn;
  const hops: RouteHop[] = [];

  for (let i = 0; i < pools.length; i++) {
    const pool = pools[i];
    const tokenIn = tokenPath[i];
    const tokenOut = tokenPath[i + 1];
    const isTokenA = tokenIn === pool.tokenA;
    const reserveIn = isTokenA ? pool.reserveA : pool.reserveB;
    const reserveOut = isTokenA ? pool.reserveB : pool.reserveA;
    const amountOut = getAmountOutForPool(pool, currentAmount, tokenIn);
    const priceImpact = getPriceImpact(currentAmount, reserveIn, reserveOut, amountOut);
    const feePaid = (currentAmount * BigInt(pool.feeTier)) / BPS;

    hops.push({
      poolId: pool.id,
      dexName: pool.dexName,
      poolAddress: pool.poolAddress,
      tokenIn,
      tokenOut,
      amountIn: currentAmount,
      amountOut,
      priceImpact,
      feePaid,
    });

    currentAmount = amountOut;
  }

  return { amountOut: currentAmount, hops };
}
