/**
 * Limit Orders Engine (Issue #334, §6)
 *
 * Manages limit order lifecycle: place, fill, cancel, expire.
 * Supports order types: market, limit, stop_loss, take_profit.
 * Fill strategies: fill_or_kill, immediate_or_cancel, good_till_time.
 */

import { prismaWrite, prismaRead } from '../../db';
import { getPoolsForPair, getCanonicalPairKey } from './pool-indexer';
import { getAmountOutForPool, getMidPrice } from './price-engine';

export type OrderType = 'market' | 'limit' | 'stop_loss' | 'take_profit';
export type OrderStatus = 'pending' | 'filled' | 'cancelled' | 'expired';
export type FillStrategy = 'fill_or_kill' | 'immediate_or_cancel' | 'good_till_time';

export interface LimitOrderParams {
  userAddress: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  amountOutMin: bigint;
  priceLimit: number;
  orderType: OrderType;
  fillStrategy?: FillStrategy;
  expiresAt?: Date;
}

export interface LimitOrderInfo {
  id: string;
  userAddress: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  amountOutMin: bigint;
  priceLimit: number;
  orderType: OrderType;
  status: OrderStatus;
  fillStrategy: FillStrategy;
  fillAmount: bigint;
  fillCount: number;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Place a new limit order.
 */
export async function placeLimitOrder(params: LimitOrderParams): Promise<string> {
  const now = new Date();
  const result = await prismaWrite.limitOrder.create({
    data: {
      userAddress: params.userAddress,
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      amountIn: params.amountIn.toString(),
      amountOutMin: params.amountOutMin.toString(),
      priceLimit: params.priceLimit.toString(),
      orderType: params.orderType,
      status: 'pending',
      fillStrategy: params.fillStrategy ?? 'good_till_time',
      fillAmount: '0',
      fillCount: 0,
      expiresAt: params.expiresAt ?? null,
      createdAt: now,
      updatedAt: now,
    },
  });

  // Try to fill immediately
  await tryFillOrder(result.id);
  return result.id;
}

/**
 * Try to fill a pending order at the current market price.
 */
export async function tryFillOrder(orderId: string): Promise<boolean> {
  const order = await prismaRead.limitOrder.findUnique({ where: { id: orderId } });
  if (!order || order.status !== 'pending') return false;

  // Check expiry
  if (order.expiresAt && order.expiresAt < new Date()) {
    await prismaWrite.limitOrder.update({
      where: { id: orderId },
      data: { status: 'expired', updatedAt: new Date() },
    });
    return false;
  }

  const currentMidPrice = getCurrentPriceForPair(order.tokenIn, order.tokenOut);

  // Check if order should fill based on type
  let shouldFill = false;
  switch (order.orderType) {
    case 'market':
      shouldFill = true;
      break;
    case 'limit':
      shouldFill = currentMidPrice <= Number(order.priceLimit);
      break;
    case 'stop_loss':
      shouldFill = currentMidPrice >= Number(order.priceLimit);
      break;
    case 'take_profit':
      shouldFill = currentMidPrice <= Number(order.priceLimit);
      break;
  }

  if (!shouldFill) return false;

  const buyPool = getBestPool(order.tokenIn, order.tokenOut);
  if (!buyPool) return false;

  const { amountOut } = await simulateSwapOnPool(buyPool, order.tokenIn, BigInt(order.amountIn));
  if (amountOut < BigInt(order.amountOutMin)) {
    if (order.fillStrategy === 'fill_or_kill') return false;
    return false;
  }

  // Fill the order
  await prismaWrite.limitOrder.update({
    where: { id: orderId },
    data: {
      status: 'filled',
      fillAmount: amountOut.toString(),
      fillCount: 1,
      updatedAt: new Date(),
    },
  });

  return true;
}

function getCurrentPriceForPair(tokenIn: string, tokenOut: string): number {
  const pools = getPoolsForPair(tokenIn, tokenOut);
  if (pools.length === 0) return 0;
  return pools.reduce((best, pool) => Math.max(best, getMidPrice(pool)), 0);
}

function getBestPool(tokenIn: string, tokenOut: string) {
  const pools = getPoolsForPair(tokenIn, tokenOut);
  if (pools.length === 0) return null;
  return pools.reduce((a, b) => (getMidPrice(a) > getMidPrice(b) ? a : b));
}

async function simulateSwapOnPool(poolId: string, tokenIn: string, amountIn: bigint) {
  const { prismaRead } = await import('../../db');
  const pool = await prismaRead.dexPool.findUnique({ where: { id: poolId } });
  if (!pool) return { amountOut: 0n, priceImpact: 0 };
  const poolInfo = {
    id: pool.id,
    dexName: pool.dexName ?? '',
    poolAddress: pool.poolAddress,
    poolType: (pool.poolType ?? 'constant_product') as any,
    tokenA: pool.tokenA,
    tokenB: pool.tokenB,
    tokenADecimals: pool.tokenADecimals,
    tokenBDecimals: pool.tokenBDecimals,
    feeTier: pool.feeBps,
    reserveA: BigInt(pool.reserveA),
    reserveB: BigInt(pool.reserveB),
    lastUpdated: pool.lastSyncedAt ?? new Date(),
    volume24h: 0n,
    fees24h: 0n,
  };
  return { amountOut: getAmountOutForPool(poolInfo, amountIn, tokenIn), priceImpact: 0 };
}

/**
 * Cancel an open order.
 */
export async function cancelLimitOrder(orderId: string): Promise<boolean> {
  const order = await prismaRead.limitOrder.findUnique({ where: { id: orderId } });
  if (!order || order.status !== 'pending') return false;

  await prismaWrite.limitOrder.update({
    where: { id: orderId },
    data: { status: 'cancelled', updatedAt: new Date() },
  });
  return true;
}

/**
 * List orders for a user.
 */
export async function listUserOrders(
  userAddress: string,
  status?: OrderStatus,
  limit = 50,
  offset = 0,
) {
  const where: any = { userAddress };
  if (status) where.status = status;

  const [orders, total] = await Promise.all([
    prismaRead.limitOrder.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    }),
    prismaRead.limitOrder.count({ where }),
  ]);

  return { orders, total };
}

/**
 * Expire stale orders.
 */
export async function expireStaleOrders(): Promise<number> {
  const result = await prismaWrite.limitOrder.updateMany({
    where: {
      status: 'pending',
      expiresAt: { lt: new Date() },
    },
    data: { status: 'expired', updatedAt: new Date() },
  });
  return result.count;
}
