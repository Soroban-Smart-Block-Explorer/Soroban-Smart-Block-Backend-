/**
 * Institutional DEX Analytics — pure pool mathematics.
 *
 * Every function here is deterministic and side-effect free so the analytics
 * (TVL, slippage, impermanent loss, liquidity depth, APR) are fully unit
 * testable without a database or live chain. Exact swap math uses BigInt to
 * preserve token-base-unit precision; the higher-level analytics use floats,
 * which is appropriate for USD-denominated reporting.
 */

// ── Constant-product swap math (exact, BigInt) ──────────────────────────────

const BPS = 10_000n;

/**
 * Constant-product (x*y=k) output for an exact-input swap, charging `feeBps`
 * on the input. Mirrors the Uniswap-v2 / Soroswap getAmountOut formula.
 */
export function getAmountOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps: number,
): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const feeFactor = BPS - BigInt(Math.round(feeBps));
  const amountInWithFee = amountIn * feeFactor;
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * BPS + amountInWithFee;
  return numerator / denominator;
}

/**
 * Constant-product input required to receive exactly `amountOut`, charging
 * `feeBps` on the input. Returns 0 when the pool cannot satisfy the output.
 */
export function getAmountIn(
  amountOut: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps: number,
): bigint {
  if (amountOut <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  if (amountOut >= reserveOut) return 0n; // drains the pool — not satisfiable
  const feeFactor = BPS - BigInt(Math.round(feeBps));
  const numerator = reserveIn * amountOut * BPS;
  const denominator = (reserveOut - amountOut) * feeFactor;
  return numerator / denominator + 1n; // round up
}

// ── Human-unit helpers ──────────────────────────────────────────────────────

/** Convert a base-unit amount to a human float using `decimals`. */
export function toHuman(amount: bigint | string | number, decimals: number): number {
  const big = typeof amount === 'bigint' ? amount : BigInt(Math.trunc(Number(amount)) || 0);
  const sign = big < 0n ? -1 : 1;
  const abs = big < 0n ? -big : big;
  const divisor = 10 ** decimals;
  // Split to avoid precision loss on very large integers.
  const whole = Number(abs / BigInt(10 ** Math.min(decimals, 18)));
  if (decimals <= 15) return (sign * Number(abs)) / divisor;
  return sign * whole;
}

// ── Slippage / price-impact simulation ──────────────────────────────────────

export interface SwapSimulation {
  amountIn: number;
  amountOut: number;
  /** Marginal (spot) price of OUT per IN before the trade. */
  midPrice: number;
  /** Realised average price OUT per IN for this trade. */
  executionPrice: number;
  /** % the execution price is worse than mid (includes the fee). */
  slippagePct: number;
  /** % shift in the marginal price after the trade (depth-only impact). */
  priceImpactPct: number;
  /** Fee paid, in IN-token human units. */
  feePaid: number;
}

/**
 * Simulate a constant-product swap of `amountIn` (human units) against pools
 * with `reserveIn`/`reserveOut` (human units), returning slippage and price
 * impact. Operates in floats — intended for USD/price-impact reporting, not
 * for settling base-unit amounts (use {@link getAmountOut} for that).
 */
export function simulateSwap(
  amountIn: number,
  reserveIn: number,
  reserveOut: number,
  feeBps: number,
): SwapSimulation {
  const midPrice = reserveIn > 0 ? reserveOut / reserveIn : 0;
  if (amountIn <= 0 || reserveIn <= 0 || reserveOut <= 0) {
    return { amountIn, amountOut: 0, midPrice, executionPrice: 0, slippagePct: 0, priceImpactPct: 0, feePaid: 0 };
  }

  const fee = feeBps / 10_000;
  const amountInAfterFee = amountIn * (1 - fee);
  const amountOut = (amountInAfterFee * reserveOut) / (reserveIn + amountInAfterFee);

  const executionPrice = amountOut / amountIn;
  const slippagePct = midPrice > 0 ? Math.max(0, (1 - executionPrice / midPrice) * 100) : 0;

  // Marginal price after the trade (reserves move along the invariant).
  const newReserveIn = reserveIn + amountInAfterFee;
  const newReserveOut = reserveOut - amountOut;
  const newMid = newReserveOut / newReserveIn;
  const priceImpactPct = midPrice > 0 ? Math.max(0, (1 - newMid / midPrice) * 100) : 0;

  return {
    amountIn,
    amountOut,
    midPrice,
    executionPrice,
    slippagePct,
    priceImpactPct,
    feePaid: amountIn * fee,
  };
}

/** Slippage curve: simulate a range of trade sizes against the same reserves. */
export function slippageCurve(
  reserveIn: number,
  reserveOut: number,
  feeBps: number,
  sizes: number[],
): SwapSimulation[] {
  return sizes.map((size) => simulateSwap(size, reserveIn, reserveOut, feeBps));
}

/**
 * Default trade sizes for a slippage curve: fractions of the input reserve so
 * the curve is meaningful regardless of pool size.
 */
export function defaultCurveSizes(reserveIn: number): number[] {
  const fractions = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5];
  return fractions.map((f) => reserveIn * f);
}

// ── Liquidity depth ─────────────────────────────────────────────────────────

export interface DepthLevel {
  /** Target marginal price impact, e.g. 0.01 for 1%. */
  priceImpact: number;
  /** Max input (human units) that keeps marginal impact at/under the target. */
  amountIn: number;
  /** That input valued in USD, when a price is supplied. */
  amountInUsd?: number;
}

/**
 * Liquidity depth: the trade size that moves the marginal price by each target
 * impact level. For constant product, marginal impact p solves
 * (reserveIn + x)^2 = reserveIn^2 / (1 - p), giving a clean closed form.
 */
export function liquidityDepth(
  reserveIn: number,
  impactLevels: number[] = [0.005, 0.01, 0.02, 0.05, 0.1],
  priceInUsd?: number,
): DepthLevel[] {
  return impactLevels.map((p) => {
    const amountIn = reserveIn > 0 && p > 0 && p < 1 ? reserveIn * (1 / Math.sqrt(1 - p) - 1) : 0;
    return {
      priceImpact: p,
      amountIn,
      amountInUsd: priceInUsd != null ? amountIn * priceInUsd : undefined,
    };
  });
}

// ── Impermanent loss ────────────────────────────────────────────────────────

/**
 * Impermanent loss for a 50/50 constant-product LP versus holding, given the
 * price ratio `priceRatio = priceNow / priceAtEntry` of one asset against the
 * other. Returns a non-positive percentage (0 at ratio 1).
 *
 * IL = 2*sqrt(r)/(1+r) - 1. Known checkpoints: r=2 → -5.72%, r=4 → -20%.
 */
export function impermanentLossPct(priceRatio: number): number {
  if (priceRatio <= 0) return 0;
  const il = (2 * Math.sqrt(priceRatio)) / (1 + priceRatio) - 1;
  return il * 100;
}

/**
 * Classify IL severity for warnings. Thresholds are on the magnitude of loss.
 */
export function impermanentLossSeverity(ilPct: number): 'none' | 'low' | 'moderate' | 'high' | 'severe' {
  const m = Math.abs(ilPct);
  if (m < 0.5) return 'none';
  if (m < 2) return 'low';
  if (m < 5) return 'moderate';
  if (m < 15) return 'high';
  return 'severe';
}

// ── Valuation ───────────────────────────────────────────────────────────────

/** Total value locked in USD from human-unit reserves and per-token prices. */
export function tvlUsd(
  reserveAHuman: number,
  priceAUsd: number | null | undefined,
  reserveBHuman: number,
  priceBUsd: number | null | undefined,
): number {
  let tvl = 0;
  let priced = 0;
  if (priceAUsd != null) {
    tvl += reserveAHuman * priceAUsd;
    priced++;
  }
  if (priceBUsd != null) {
    tvl += reserveBHuman * priceBUsd;
    priced++;
  }
  // If only one side is priced, a balanced AMM pool's two sides are equal in
  // value, so double the known half for a best-effort TVL.
  if (priced === 1) tvl *= 2;
  return tvl;
}

/** Annualised fee APR (%) from trailing-24h fees over current TVL. */
export function aprPct(fees24hUsd: number, tvlUsdValue: number): number {
  if (tvlUsdValue <= 0) return 0;
  return ((fees24hUsd * 365) / tvlUsdValue) * 100;
}

/** Spot price of token B in terms of token A from human-unit reserves. */
export function spotPrice(reserveA: number, reserveB: number): number {
  return reserveB > 0 ? reserveA / reserveB : 0;
}
