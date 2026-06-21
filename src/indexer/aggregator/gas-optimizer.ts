/**
 * Gas Optimization Engine (Issue #334, §11)
 *
 * Estimates and optimizes gas costs for multi-hop routes.
 * Integrates with gas price oracle for dynamic pricing.
 */

import { PoolInfo, getPoolById } from './pool-indexer';
import { RouteHop, RouteQuote } from './price-engine';

// Base gas costs in stroops (approximate)
const GAS_BASE = BigInt(10_000);
const GAS_PER_SWAP = BigInt(45_000);
const GAS_PER_POOL_READ = BigInt(5_000);
const GAS_PER_XFER = BigInt(15_000);
const GAS_PER_HOP_OVERHEAD = BigInt(8_000);

// Gas price tiers (in stroops per unit)
const GAS_PRICES = {
  fast: 100,
  standard: 50,
  slow: 25,
};

export interface GasEstimate {
  totalGas: bigint;
  totalFee: bigint; // in stroops
  gasPerHop: bigint[];
  gasPricePriority: 'fast' | 'standard' | 'slow';
  gasPrice: number;
}

export interface GasOptimization {
  originalRoute: RouteQuote;
  optimizedRoute: RouteQuote;
  gasSavings: bigint;
  outputLoss: bigint;
  netBenefit: bigint; // gas savings - output loss
  recommendation: 'use_original' | 'use_optimized' | 'neutral';
}

/**
 * Estimate gas for a single swap hop.
 */
export function estimateHopGas(pool: PoolInfo): bigint {
  let gas = GAS_BASE + GAS_PER_SWAP + GAS_PER_POOL_READ;

  // Different pool types have different gas costs
  switch (pool.poolType) {
    case 'stable':
      gas += GAS_PER_HOP_OVERHEAD * 2n; // more complex math
      break;
    case 'weighted':
      gas += GAS_PER_HOP_OVERHEAD * 3n;
      break;
    case 'concentrated':
      gas += GAS_PER_HOP_OVERHEAD * 4n; // most complex
      break;
    default:
      gas += GAS_PER_HOP_OVERHEAD;
  }

  return gas;
}

/**
 * Estimate total gas for a route.
 */
export function estimateRouteGas(
  hops: RouteHop[],
  gasPricePriority: 'fast' | 'standard' | 'slow' = 'standard',
): GasEstimate {
  const gasPerHop = hops.map((hop) => {
    const pool = getPoolById(hop.poolId);
    return pool ? estimateHopGas(pool) : GAS_PER_SWAP;
  });

  const totalGas = gasPerHop.reduce((sum, g) => sum + g, 0n) + GAS_PER_XFER;
  const gasPrice = GAS_PRICES[gasPricePriority];
  const totalFee = totalGas * BigInt(gasPrice);

  return {
    totalGas,
    totalFee,
    gasPerHop,
    gasPricePriority,
    gasPrice,
  };
}

/**
 * Optimize a route for gas consumption.
 * May suggest skipping high-gas hops if the output loss is minimal.
 */
export function optimizeForGas(route: RouteQuote): GasOptimization {
  const originalGas = estimateRouteGas(route.hops);
  const originalOutput = route.totalAmountOut;

  // Try to find gas savings by identifying expensive hops
  let optimizedHops = [...route.hops];

  // Remove hops with very high gas relative to their output contribution
  if (optimizedHops.length > 1) {
    for (let i = optimizedHops.length - 1; i >= 0; i--) {
      const hop = optimizedHops[i];
      const hopGas = estimateHopGas(getPoolById(hop.poolId) ?? {
        id: '',
        dexName: '',
        poolAddress: '',
        poolType: 'constant_product',
        tokenA: '',
        tokenB: '',
        tokenADecimals: 7,
        tokenBDecimals: 7,
        feeTier: 30,
        reserveA: 0n,
        reserveB: 0n,
        lastUpdated: new Date(),
        volume24h: 0n,
        fees24h: 0n,
      });
      const ratio = Number(hopGas) / Math.max(1, Number(hop.amountOut));
      if (ratio > 0.1) {
        // This hop is gas-inefficient
        optimizedHops.splice(i, 1);
      }
    }
  }

  const optimizedGas = estimateRouteGas(optimizedHops);
  const gasSavings = originalGas.totalFee - optimizedGas.totalFee;

  // Estimate output loss from removing hops
  const outputLoss = originalOutput - route.totalAmountOut;
  const netBenefit = gasSavings - outputLoss;

  let recommendation: 'use_original' | 'use_optimized' | 'neutral';
  if (netBenefit > 0) recommendation = 'use_optimized';
  else if (netBenefit < -gasSavings) recommendation = 'use_original';
  else recommendation = 'neutral';

  return {
    originalRoute: route,
    optimizedRoute: { ...route, hops: optimizedHops, estimatedGas: optimizedGas.totalGas },
    gasSavings,
    outputLoss,
    netBenefit,
    recommendation,
  };
}

/**
 * Get current gas prices.
 */
export function getGasPrices(): {
  fast: number;
  standard: number;
  slow: number;
} {
  // In production, read from an oracle
  return {
    fast: GAS_PRICES.fast,
    standard: GAS_PRICES.standard,
    slow: GAS_PRICES.slow,
  };
}
