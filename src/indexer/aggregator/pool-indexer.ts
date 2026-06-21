/**
 * DEX Integration & Pool Indexer (Issue #334, §1)
 *
 * Indexes all AMM pool types across supported DEX protocols:
 * - Constant Product AMM (Uniswap V2 style): x * y = k
 * - Concentrated Liquidity AMM (Uniswap V3 style): ticks, positions, ranges
 * - StableSwap (Curve style): stableswap invariant
 * - Weighted Pools (Balancer style): multi-token pools with weights
 * - Dynamic Fee AMMs (fee varies by volatility/utilization)
 *
 * Provides both in-memory pool state for fast routing and DB persistence.
 */

import { prismaWrite, prismaRead } from '../../db';

export type PoolType = 'constant_product' | 'concentrated' | 'stable' | 'weighted' | 'dynamic_fee';

export interface PoolInfo {
  id: string;
  dexName: string;
  poolAddress: string;
  poolType: PoolType;
  tokenA: string;
  tokenB: string;
  tokenASymbol?: string;
  tokenBSymbol?: string;
  tokenADecimals: number;
  tokenBDecimals: number;
  feeTier: number;
  tickSpacing?: number;
  reserveA: bigint;
  reserveB: bigint;
  sqrtPrice?: bigint;
  liquidity?: bigint;
  volume24h: bigint;
  fees24h: bigint;
  lastUpdated: Date;
}

export interface PoolPricePoint {
  poolId: string;
  price: number;
  reserveA: bigint;
  reserveB: bigint;
  blockNumber: bigint;
  timestamp: Date;
}

// In-memory pool registry for fast routing lookups
const poolRegistry = new Map<string, PoolInfo>();
const poolByPair = new Map<string, PoolInfo[]>();

export function getCanonicalPairKey(tokenA: string, tokenB: string): string {
  return tokenA <= tokenB ? `${tokenA}|${tokenB}` : `${tokenB}|${tokenA}`;
}

export function getPoolsForPair(tokenA: string, tokenB: string): PoolInfo[] {
  const key = getCanonicalPairKey(tokenA, tokenB);
  return poolByPair.get(key) ?? [];
}

export function getPoolById(id: string): PoolInfo | undefined {
  return poolRegistry.get(id);
}

export function getAllPools(): PoolInfo[] {
  return Array.from(poolRegistry.values());
}

export function getPoolCountByType(): Record<PoolType, number> {
  const counts: Record<PoolType, number> = {
    constant_product: 0,
    concentrated: 0,
    stable: 0,
    weighted: 0,
    dynamic_fee: 0,
  };
  for (const pool of poolRegistry.values()) {
    counts[pool.poolType]++;
  }
  return counts;
}

/**
 * Load all pools from DB into the in-memory registry.
 */
export async function refreshPoolRegistry(): Promise<void> {
  poolRegistry.clear();
  poolByPair.clear();

  const pools = await prismaRead.dexPool.findMany({
    select: {
      id: true,
      dexName: true,
      poolAddress: true,
      poolType: true,
      tokenA: true,
      tokenB: true,
      tokenASymbol: true,
      tokenBSymbol: true,
      tokenADecimals: true,
      tokenBDecimals: true,
      feeBps: true,
      tickSpacing: true,
      reserveA: true,
      reserveB: true,
      sqrtPrice: true,
      liquidity: true,
      volume24h: true,
      fees24h: true,
      lastSyncedAt: true,
    },
  });

  // Also read from new aggregator pools if available
  let newPools: any[] = [];
  try {
    // @ts-ignore - may not exist in schema yet
    newPools = await prismaRead.$queryRaw`SELECT * FROM dex_pools`;
  } catch {
    // New table may not exist yet
  }

  for (const pool of pools) {
    const info: PoolInfo = {
      id: pool.id,
      dexName: pool.dexName ?? 'soroswap',
      poolAddress: pool.poolAddress,
      poolType: (pool.poolType as PoolType) ?? 'constant_product',
      tokenA: pool.tokenA,
      tokenB: pool.tokenB,
      tokenASymbol: pool.tokenASymbol ?? undefined,
      tokenBSymbol: pool.tokenBSymbol ?? undefined,
      tokenADecimals: pool.tokenADecimals,
      tokenBDecimals: pool.tokenBDecimals,
      feeTier: pool.feeBps,
      tickSpacing: pool.tickSpacing ?? undefined,
      reserveA: BigInt(pool.reserveA),
      reserveB: BigInt(pool.reserveB),
      sqrtPrice: pool.sqrtPrice ? BigInt(pool.sqrtPrice) : undefined,
      liquidity: pool.liquidity ? BigInt(pool.liquidity) : undefined,
      volume24h: BigInt(pool.volume24h ?? 0),
      fees24h: BigInt(pool.fees24h ?? 0),
      lastUpdated: pool.lastSyncedAt ?? new Date(),
    };
    poolRegistry.set(pool.id, info);

    const pairKey = getCanonicalPairKey(pool.tokenA, pool.tokenB);
    const existing = poolByPair.get(pairKey) ?? [];
    existing.push(info);
    poolByPair.set(pairKey, existing);
  }
}

/**
 * Upsert a pool in the DB and update in-memory registry.
 */
export async function upsertPool(pool: {
  dexName: string;
  poolAddress: string;
  poolType: PoolType;
  tokenA: string;
  tokenB: string;
  tokenASymbol?: string;
  tokenBSymbol?: string;
  tokenADecimals?: number;
  tokenBDecimals?: number;
  feeTier?: number;
  tickSpacing?: number;
}): Promise<PoolInfo> {
  const existing = await prismaWrite.dexPool.upsert({
    where: { poolAddress: pool.poolAddress },
    create: {
      poolAddress: pool.poolAddress,
      dexName: pool.dexName,
      poolType: pool.poolType,
      tokenA: pool.tokenA,
      tokenB: pool.tokenB,
      tokenASymbol: pool.tokenASymbol ?? null,
      tokenBSymbol: pool.tokenBSymbol ?? null,
      tokenADecimals: pool.tokenADecimals ?? 7,
      tokenBDecimals: pool.tokenBDecimals ?? 7,
      feeBps: pool.feeTier ?? 30,
      tickSpacing: pool.tickSpacing ?? null,
      reserveA: '0',
      reserveB: '0',
      firstSeenLedger: 0,
    },
    update: {
      dexName: pool.dexName,
      poolType: pool.poolType,
      tokenASymbol: pool.tokenASymbol ?? null,
      tokenBSymbol: pool.tokenBSymbol ?? null,
      tokenADecimals: pool.tokenADecimals ?? 7,
      tokenBDecimals: pool.tokenBDecimals ?? 7,
      feeBps: pool.feeTier ?? 30,
      tickSpacing: pool.tickSpacing ?? null,
    },
  });

  const info: PoolInfo = {
    id: existing.id,
    dexName: existing.dexName ?? pool.dexName,
    poolAddress: existing.poolAddress,
    poolType: pool.poolType,
    tokenA: existing.tokenA,
    tokenB: existing.tokenB,
    tokenASymbol: existing.tokenASymbol ?? undefined,
    tokenBSymbol: existing.tokenBSymbol ?? undefined,
    tokenADecimals: existing.tokenADecimals,
    tokenBDecimals: existing.tokenBDecimals,
    feeTier: existing.feeBps,
    tickSpacing: existing.tickSpacing ?? undefined,
    reserveA: BigInt(existing.reserveA),
    reserveB: BigInt(existing.reserveB),
    volume24h: BigInt(existing.volume24h ?? 0),
    fees24h: BigInt(existing.fees24h ?? 0),
    lastUpdated: existing.lastSyncedAt ?? new Date(),
  };

  poolRegistry.set(info.id, info);
  const pairKey = getCanonicalPairKey(pool.tokenA, pool.tokenB);
  const arr = poolByPair.get(pairKey) ?? [];
  const idx = arr.findIndex((p) => p.id === info.id);
  if (idx >= 0) arr[idx] = info;
  else arr.push(info);
  poolByPair.set(pairKey, arr);

  return info;
}

/**
 * Update reserves for a pool (called by the price monitor).
 */
export async function updatePoolReserves(
  poolId: string,
  reserveA: bigint,
  reserveB: bigint,
  blockNumber: bigint,
): Promise<void> {
  const pool = poolRegistry.get(poolId);
  if (!pool) return;

  pool.reserveA = reserveA;
  pool.reserveB = reserveB;
  pool.lastUpdated = new Date();

  await prismaWrite.dexPool.update({
    where: { id: poolId },
    data: {
      reserveA: reserveA.toString(),
      reserveB: reserveB.toString(),
      lastSyncedAt: new Date(),
    },
  });

  // Record price history
  const priceAHuman = Number(reserveA) / 10 ** pool.tokenADecimals;
  const priceBHuman = Number(reserveB) / 10 ** pool.tokenBDecimals;
  const price = priceAHuman > 0 ? priceBHuman / priceAHuman : 0;

  try {
    await prismaWrite.$executeRaw`
      INSERT INTO pool_price_history (pool_id, price, reserve_a, reserve_b, block_number, timestamp)
      VALUES (${poolId}, ${price}, ${reserveA.toString()}, ${reserveB.toString()}, ${blockNumber}, NOW())
      ON CONFLICT (pool_id, block_number) DO NOTHING
    `;
  } catch {
    // Table might not exist yet
  }
}

/**
 * Get pool price history from DB.
 */
export async function getPoolPriceHistory(
  poolId: string,
  limit = 100,
): Promise<PoolPricePoint[]> {
  try {
    const rows = await prismaRead.$queryRaw<any[]>`
      SELECT pool_id, price, reserve_a, reserve_b, block_number, timestamp
      FROM pool_price_history
      WHERE pool_id = ${poolId}
      ORDER BY block_number DESC
      LIMIT ${limit}
    `;
    return rows.map((r) => ({
      poolId: r.pool_id,
      price: Number(r.price),
      reserveA: BigInt(r.reserve_a),
      reserveB: BigInt(r.reserve_b),
      blockNumber: BigInt(r.block_number),
      timestamp: r.timestamp,
    }));
  } catch {
    return [];
  }
}
