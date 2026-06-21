/**
 * On-Chain TWAP Oracle (Issue #334, §15)
 *
 * Time-Weighted Average Price oracle from aggregator data.
 * Provides manipulation-resistant TWAP prices from multi-source aggregation.
 */

import { prismaWrite, prismaRead } from '../../db';
import { PoolInfo, getPoolById, getAllPools, getPoolPriceHistory } from './pool-indexer';

export interface TwapPrice {
  tokenA: string;
  tokenB: string;
  twapPrice: number;
  windowSeconds: number;
  blockNumber: bigint;
  timestamp: Date;
  confidence: number;
}

export interface TwapHistoryPoint {
  timestamp: Date;
  twapPrice: number;
  blockNumber: bigint;
}

/**
 * Compute TWAP from pool price history.
 * Uses geometric mean for manipulation resistance.
 */
export function computeTwap(
  prices: Array<{ price: number; timestamp: Date }>,
  windowSeconds: number,
): number {
  const cutoff = Date.now() - windowSeconds * 1000;
  const windowPrices = prices.filter((p) => p.timestamp.getTime() >= cutoff);

  if (windowPrices.length === 0) return 0;

  // Geometric mean (more manipulation-resistant than arithmetic)
  let logSum = 0;
  for (const p of windowPrices) {
    if (p.price > 0) logSum += Math.log(p.price);
  }
  return Math.exp(logSum / windowPrices.length);
}

/**
 * Get TWAP price for a token pair.
 */
export async function getTwapPrice(
  tokenA: string,
  tokenB: string,
  windowSeconds: number = 3600, // default 1 hour
): Promise<TwapPrice | null> {
  // Check if we have a cached TWAP in the oracle table
  try {
    const cached = await prismaRead.$queryRaw<any[]>`
      SELECT twap_price, window_seconds, block_number, timestamp
      FROM twap_oracle_prices
      WHERE token_a = ${tokenA}
        AND token_b = ${tokenB}
        AND window_seconds = ${windowSeconds}
      ORDER BY block_number DESC
      LIMIT 1
    `;
    if (cached.length > 0) {
      const row = cached[0];
      const ageSecs = (Date.now() - new Date(row.timestamp).getTime()) / 1000;
      if (ageSecs < windowSeconds + 60) { // allow 1 min stale
        return {
          tokenA,
          tokenB,
          twapPrice: Number(row.twap_price),
          windowSeconds,
          blockNumber: BigInt(row.block_number),
          timestamp: row.timestamp,
          confidence: calculateConfidence(ageSecs, windowSeconds),
        };
      }
    }
  } catch {
    // Table may not exist yet
  }

  // Compute from pool data
  const pools = getAllPools().filter(
    (p) => (p.tokenA === tokenA && p.tokenB === tokenB) ||
           (p.tokenA === tokenB && p.tokenB === tokenA),
  );

  if (pools.length === 0) return null;

  const allPrices: Array<{ price: number; timestamp: Date }> = [];
  for (const pool of pools) {
    const history = await getPoolPriceHistory(pool.id, 100);
    for (const point of history) {
      allPrices.push({ price: point.price, timestamp: point.timestamp });
    }
  }

  if (allPrices.length === 0) return null;

  const twapPrice = computeTwap(allPrices, windowSeconds);
  const latestPrice = allPrices[allPrices.length - 1];
  const blockNumber = BigInt(Math.floor(latestPrice.timestamp.getTime() / 2500)); // approximate

  if (twapPrice <= 0) return null;

  // Store for future
  try {
    await prismaWrite.$executeRaw`
      INSERT INTO twap_oracle_prices (token_a, token_b, twap_price, window_seconds, block_number, timestamp)
      VALUES (${tokenA}, ${tokenB}, ${twapPrice}, ${windowSeconds}, ${blockNumber}, NOW())
      ON CONFLICT (token_a, token_b, window_seconds, block_number) DO NOTHING
    `;
  } catch {
    // table may not exist
  }

  const ageSecs = (Date.now() - latestPrice.timestamp.getTime()) / 1000;
  return {
    tokenA,
    tokenB,
    twapPrice,
    windowSeconds,
    blockNumber,
    timestamp: latestPrice.timestamp,
    confidence: calculateConfidence(ageSecs, windowSeconds),
  };
}

/**
 * Get historical TWAP data.
 */
export async function getTwapHistory(
  tokenA: string,
  tokenB: string,
  windowSeconds: number = 3600,
  limit: number = 100,
): Promise<TwapHistoryPoint[]> {
  try {
    const rows = await prismaRead.$queryRaw<any[]>`
      SELECT twap_price, window_seconds, block_number, timestamp
      FROM twap_oracle_prices
      WHERE token_a = ${tokenA}
        AND token_b = ${tokenB}
        AND window_seconds = ${windowSeconds}
      ORDER BY timestamp DESC
      LIMIT ${limit}
    `;
    return rows.map((r) => ({
      timestamp: r.timestamp,
      twapPrice: Number(r.twap_price),
      blockNumber: BigInt(r.block_number),
    }));
  } catch {
    return [];
  }
}

/**
 * Calculate confidence score for a TWAP price (0-1).
 */
function calculateConfidence(ageSeconds: number, windowSeconds: number): number {
  // Fresher data = higher confidence
  const ageRatio = Math.min(1, ageSeconds / windowSeconds);
  return Math.max(0.5, 1 - ageRatio * 0.5);
}

/**
 * Compute TWAP from multiple sources for manipulation resistance.
 */
export function computeAggregateTwap(
  sources: Array<{ source: string; prices: Array<{ price: number; timestamp: Date }> }>,
  windowSeconds: number,
): { price: number; confidence: number; sourceCount: number } {
  if (sources.length === 0) return { price: 0, confidence: 0, sourceCount: 0 };

  const twaps = sources
    .map((s) => ({
      source: s.source,
      twap: computeTwap(s.prices, windowSeconds),
    }))
    .filter((t) => t.twap > 0);

  if (twaps.length === 0) return { price: 0, confidence: 0, sourceCount: 0 };

  // Median across sources for manipulation resistance
  twaps.sort((a, b) => a.twap - b.twap);
  const median = twaps.length % 2 === 0
    ? (twaps[twaps.length / 2 - 1].twap + twaps[twaps.length / 2].twap) / 2
    : twaps[Math.floor(twaps.length / 2)].twap;

  // Variance as confidence measure
  const mean = twaps.reduce((s, t) => s + t.twap, 0) / twaps.length;
  const variance = twaps.reduce((s, t) => s + (t.twap - mean) ** 2, 0) / twaps.length;
  const confidence = Math.max(0.3, Math.min(1, 1 - variance));

  return {
    price: median,
    confidence,
    sourceCount: twaps.length,
  };
}
