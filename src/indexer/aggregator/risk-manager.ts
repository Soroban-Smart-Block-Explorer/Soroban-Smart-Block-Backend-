/**
 * Risk Management Engine (Issue #334, §13)
 *
 * Checks and manages risk for trades:
 * - Max position size per pool (avoid price impact > configurable %)
 * - Correlation risk (multi-hop using correlated assets)
 * - Blacklisted tokens/pools (rug pulls, hacks)
 * - Impermanent loss calculator for LP positions
 */

import { PoolInfo, getPoolById, getAllPools } from './pool-indexer';
import { getMidPrice, simulateDirectSwap } from './price-engine';

export interface RiskCheck {
  tokenAddress: string;
  riskScore: number; // 0-100
  riskLabel: 'safe' | 'low' | 'medium' | 'high' | 'critical';
  blacklisted: boolean;
  maxPositionSize: bigint;
  correlationRisk: number;
  impermanentLossRisk: number;
  details: string[];
}

export interface RouteRisk {
  overallRisk: number;
  maxPriceImpact: number;
  totalSlippage: number;
  hasBlacklistedTokens: boolean;
  correlationWarning: boolean;
  positionSizeWarning: boolean;
  warnings: string[];
}

// Known risky/suspicious tokens (in production, this would be dynamically updated)
const BLACKLISTED_TOKENS = new Set<string>();

// Token correlation matrix (simplified — in prod use on-chain data)
const CORRELATION_MATRIX = new Map<string, Map<string, number>>();

/**
 * Check a token for risk factors.
 */
export function checkTokenRisk(
  tokenAddress: string,
  amountIn: bigint,
): RiskCheck {
  const details: string[] = [];
  let riskScore = 0;

  // Check blacklist
  const blacklisted = BLACKLISTED_TOKENS.has(tokenAddress);
  if (blacklisted) {
    riskScore += 50;
    details.push('Token is blacklisted (rug pull / hack)');
  }

  // Check price impact for trade size
  let maxPositionSize = BigInt(1_000_000_000_000_000);
  const pools = getAllPools().filter(
    (p) => p.tokenA === tokenAddress || p.tokenB === tokenAddress,
  );

  if (pools.length > 0) {
    const totalLiquidity = pools.reduce((sum, p) => {
      return sum + (p.tokenA === tokenAddress ? p.reserveA : p.reserveB);
    }, 0n);
    maxPositionSize = totalLiquidity * 10n / 100n; // max 10% of pool

    if (amountIn > maxPositionSize) {
      riskScore += 20;
      details.push(`Position exceeds 10% of available liquidity (max: ${maxPositionSize})`);
    }

    if (pools.length < 3) {
      riskScore += 10;
      details.push('Low liquidity fragmentation — high price impact risk');
    }
  } else {
    riskScore += 30;
    details.push('No liquidity pools found for this token');
  }

  // Correlation risk
  const correlationRisk = 0.3;
  if (correlationRisk > 0.7) {
    riskScore += 15;
    details.push('High correlation with other assets in multi-hop route');
  }

  // Impermanent loss risk
  const ilRisk = calculateImpermanentLossRisk(tokenAddress);
  if (ilRisk > 0.2) {
    riskScore += 10;
    details.push(`High impermanent loss risk (${(ilRisk * 100).toFixed(1)}%)`);
  }

  // Determine risk label
  let riskLabel: RiskCheck['riskLabel'];
  if (riskScore < 15) riskLabel = 'safe';
  else if (riskScore < 30) riskLabel = 'low';
  else if (riskScore < 50) riskLabel = 'medium';
  else if (riskScore < 70) riskLabel = 'high';
  else riskLabel = 'critical';

  return {
    tokenAddress,
    riskScore,
    riskLabel,
    blacklisted,
    maxPositionSize,
    correlationRisk,
    impermanentLossRisk: ilRisk,
    details,
  };
}

/**
 * Assess risk for a complete route.
 */
export function assessRouteRisk(
  pools: PoolInfo[],
  amountIn: bigint,
  maxSlippage: number = 5,
): RouteRisk {
  const warnings: string[] = [];
  let hasBlacklistedTokens = false;
  let correlationWarning = false;
  let positionSizeWarning = false;
  let maxPriceImpact = 0;
  let totalSlippage = 0;

  for (const pool of pools) {
    if (BLACKLISTED_TOKENS.has(pool.tokenA) || BLACKLISTED_TOKENS.has(pool.tokenB)) {
      hasBlacklistedTokens = true;
      warnings.push(`Pool ${pool.poolAddress} contains blacklisted tokens`);
    }

    // Check price impact
    const { priceImpact } = simulateDirectSwap(pool, pool.tokenA, amountIn);
    maxPriceImpact = Math.max(maxPriceImpact, priceImpact);
    if (priceImpact > maxSlippage) {
      positionSizeWarning = true;
      warnings.push(`Price impact ${priceImpact.toFixed(2)}% exceeds max ${maxSlippage}%`);
    }

    totalSlippage += priceImpact;
  }

  // Check for correlated assets across hops
  if (pools.length > 1) {
    correlationWarning = true;
  }

  const overallRisk = Math.round(
    (hasBlacklistedTokens ? 40 : 0) +
    (correlationWarning ? 10 : 0) +
    (positionSizeWarning ? 20 : 0) +
    Math.min(30, maxPriceImpact * 3),
  );

  return {
    overallRisk,
    maxPriceImpact,
    totalSlippage,
    hasBlacklistedTokens,
    correlationWarning,
    positionSizeWarning,
    warnings,
  };
}

/**
 * Calculate impermanent loss risk for an LP position.
 */
export function calculateImpermanentLossRisk(tokenAddress: string): number {
  // Simplified IL risk — in production, use historical volatility
  const pools = getAllPools().filter(
    (p) => p.tokenA === tokenAddress || p.tokenB === tokenAddress,
  );
  if (pools.length === 0) return 0.5; // unknown = high risk

  // Estimate volatility from fee tier (higher fee = higher vol expectation)
  const avgFee = pools.reduce((sum, p) => sum + p.feeTier, 0) / pools.length;
  return Math.min(1, avgFee / 100); // e.g., 30 bps fee → 0.3 IL risk
}

/**
 * Calculate impermanent loss for a 50/50 position given a price change.
 */
export function calculateImpermanentLoss(priceChangeRatio: number): number {
  if (priceChangeRatio <= 0) return 0;
  const sqrtRatio = Math.sqrt(priceChangeRatio);
  return (2 * sqrtRatio) / (1 + priceChangeRatio) - 1;
}

/**
 * Add a token to the blacklist.
 */
export function blacklistToken(tokenAddress: string): void {
  BLACKLISTED_TOKENS.add(tokenAddress);
}

/**
 * Remove a token from the blacklist.
 */
export function unblacklistToken(tokenAddress: string): void {
  BLACKLISTED_TOKENS.delete(tokenAddress);
}

/**
 * Get all blacklisted tokens.
 */
export function getBlacklistedTokens(): string[] {
  return Array.from(BLACKLISTED_TOKENS);
}
