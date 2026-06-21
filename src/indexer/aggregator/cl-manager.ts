/**
 * Concentrated Liquidity Position Manager (Issue #334, §8)
 *
 * Manages CL positions: create, adjust ranges, claim fees, close.
 * Tracks position PnL and suggests optimal ranges.
 */

import { prismaWrite, prismaRead } from '../../db';
import { PoolInfo, getPoolById } from './pool-indexer';
import {
  calculateAmounts,
  calculateLiquidity,
  isPositionInRange,
  estimateClApr,
  suggestOptimalRange,
  sqrtPriceToTick,
  tickToSqrtPrice,
} from './cl-math';

export interface ClPositionParams {
  userAddress: string;
  poolId: string;
  tickLower: number;
  tickUpper: number;
  amountA: bigint;
  amountB: bigint;
}

export interface ClPositionInfo {
  id: string;
  userAddress: string;
  poolId: string;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  amountA: bigint;
  amountB: bigint;
  unclaimedFeesA: bigint;
  unclaimedFeesB: bigint;
  aprEstimate: number;
  status: 'active' | 'out_of_range' | 'closed';
  inRange: boolean;
}

/**
 * Create a new concentrated liquidity position.
 */
export async function createClPosition(params: ClPositionParams): Promise<string> {
  const pool = getPoolById(params.poolId);
  if (!pool) throw new Error(`Pool not found: ${params.poolId}`);

  const currentSqrtPrice = pool.sqrtPrice ?? tickToSqrtPrice(0);
  const liquidity = calculateLiquidity(
    params.amountA > params.amountB ? params.amountA : params.amountB,
    currentSqrtPrice,
    params.tickLower,
    params.tickUpper,
    params.amountA > params.amountB,
  );

  const result = await prismaWrite.clPosition.create({
    data: {
      userAddress: params.userAddress,
      poolId: params.poolId,
      tickLower: params.tickLower,
      tickUpper: params.tickUpper,
      liquidity: liquidity.toString(),
      amountA: params.amountA.toString(),
      amountB: params.amountB.toString(),
      unclaimedFeesA: '0',
      unclaimedFeesB: '0',
      aprEstimate: 0,
      status: 'active',
    },
  });

  return result.id;
}

/**
 * Get position details.
 */
export async function getClPosition(positionId: string): Promise<ClPositionInfo | null> {
  const pos = await prismaRead.clPosition.findUnique({ where: { id: positionId } });
  if (!pos) return null;

  const pool = getPoolById(pos.poolId!);
  const currentTick = pool?.sqrtPrice ? sqrtPriceToTick(pool.sqrtPrice) : 0;
  const inRange = isPositionInRange(currentTick, pos.tickLower, pos.tickUpper);

  return {
    id: pos.id,
    userAddress: pos.userAddress,
    poolId: pos.poolId!,
    tickLower: pos.tickLower,
    tickUpper: pos.tickUpper,
    liquidity: BigInt(pos.liquidity),
    amountA: BigInt(pos.amountA),
    amountB: BigInt(pos.amountB),
    unclaimedFeesA: BigInt(pos.unclaimedFeesA ?? '0'),
    unclaimedFeesB: BigInt(pos.unclaimedFeesB ?? '0'),
    aprEstimate: Number(pos.aprEstimate ?? 0),
    status: pos.status as any,
    inRange,
  };
}

/**
 * List positions for a user.
 */
export async function listClPositions(
  userAddress: string,
  status?: string,
  limit = 50,
  offset = 0,
) {
  const where: any = { userAddress };
  if (status) where.status = status;

  const [positions, total] = await Promise.all([
    prismaRead.clPosition.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    }),
    prismaRead.clPosition.count({ where }),
  ]);

  const enriched = positions.map((pos) => {
    const pool = getPoolById(pos.poolId!);
    const currentTick = pool?.sqrtPrice ? sqrtPriceToTick(pool.sqrtPrice) : 0;
    return {
      ...pos,
      amountA: pos.amountA.toString(),
      amountB: pos.amountB.toString(),
      liquidity: pos.liquidity.toString(),
      inRange: isPositionInRange(currentTick, pos.tickLower, pos.tickUpper),
    };
  });

  return { positions: enriched, total };
}

/**
 * Adjust position tick range.
 */
export async function adjustClPosition(
  positionId: string,
  newTickLower: number,
  newTickUpper: number,
): Promise<boolean> {
  const pos = await prismaRead.clPosition.findUnique({ where: { id: positionId } });
  if (!pos || pos.status === 'closed') return false;

  await prismaWrite.clPosition.update({
    where: { id: positionId },
    data: {
      tickLower: newTickLower,
      tickUpper: newTickUpper,
      updatedAt: new Date(),
    },
  });
  return true;
}

/**
 * Close a position and return remaining liquidity.
 */
export async function closeClPosition(positionId: string): Promise<boolean> {
  const pos = await prismaRead.clPosition.findUnique({ where: { id: positionId } });
  if (!pos || pos.status === 'closed') return false;

  await prismaWrite.clPosition.update({
    where: { id: positionId },
    data: {
      status: 'closed',
      amountA: '0',
      amountB: '0',
      liquidity: '0',
      updatedAt: new Date(),
    },
  });
  return true;
}

/**
 * Claim accrued fees for a position.
 */
export async function claimClFees(positionId: string): Promise<{ feeA: bigint; feeB: bigint }> {
  const pos = await prismaRead.clPosition.findUnique({ where: { id: positionId } });
  if (!pos) return { feeA: 0n, feeB: 0n };

  const feeA = BigInt(pos.unclaimedFeesA ?? '0');
  const feeB = BigInt(pos.unclaimedFeesB ?? '0');

  await prismaWrite.clPosition.update({
    where: { id: positionId },
    data: {
      unclaimedFeesA: '0',
      unclaimedFeesB: '0',
      updatedAt: new Date(),
    },
  });

  return { feeA, feeB };
}

/**
 * Get range suggestions based on current market conditions.
 */
export function getRangeSuggestions(
  poolId: string,
  volatilityBps: number = 100,
): Array<{ name: string; tickLower: number; tickUpper: number; description: string }> {
  const pool = getPoolById(poolId);
  if (!pool?.sqrtPrice) return [];

  const currentTick = sqrtPriceToTick(pool.sqrtPrice);

  return [
    {
      name: 'Narrow (±0.5%)',
      tickLower: currentTick - Math.round(0.005 / Math.log(TICK_BASE)),
      tickUpper: currentTick + Math.round(0.005 / Math.log(TICK_BASE)),
      description: 'Highest fee efficiency, most active management needed',
    },
    {
      name: 'Medium (±2%)',
      tickLower: currentTick - Math.round(0.02 / Math.log(TICK_BASE)),
      tickUpper: currentTick + Math.round(0.02 / Math.log(TICK_BASE)),
      description: 'Balanced fee earnings and range risk',
    },
    {
      name: 'Wide (±10%)',
      tickLower: currentTick - Math.round(0.1 / Math.log(TICK_BASE)),
      tickUpper: currentTick + Math.round(0.1 / Math.log(TICK_BASE)),
      description: 'Lower fees but minimal rebalancing needed',
    },
    ...suggestOptimalRange(currentTick, volatilityBps, 2)
      ? [{
          name: `Optimal (${volatilityBps / 100}% vol)`,
          tickLower: suggestOptimalRange(currentTick, volatilityBps, 2).tickLower,
          tickUpper: suggestOptimalRange(currentTick, volatilityBps, 2).tickUpper,
          description: 'AI-suggested range based on current volatility',
        }]
      : [],
  ];
}
