/**
 * DCA (Dollar-Cost Averaging) Engine (Issue #334, §6)
 *
 * Manages DCA strategy lifecycle: create, execute, pause, resume, cancel.
 * Executes trades at regular intervals at the current market price.
 */

import { prismaWrite, prismaRead } from '../../db';
import { placeLimitOrder } from './orders';

export interface DcaParams {
  userAddress: string;
  tokenIn: string;
  tokenOut: string;
  amountPerInterval: bigint;
  intervalHours: number;
  totalIntervals?: number;
}

export interface DcaInfo {
  id: string;
  userAddress: string;
  tokenIn: string;
  tokenOut: string;
  amountPerInterval: bigint;
  intervalHours: number;
  totalIntervals: number | null;
  intervalsExecuted: number;
  status: 'active' | 'paused' | 'completed' | 'cancelled';
  nextExecution: Date;
  totalSpent: bigint;
  totalReceived: bigint;
  avgPrice: number;
}

/**
 * Create a new DCA strategy.
 */
export async function createDcaStrategy(params: DcaParams): Promise<string> {
  const now = new Date();
  const nextExecution = new Date(now.getTime() + params.intervalHours * 3600000);

  const result = await prismaWrite.dcaStrategy.create({
    data: {
      userAddress: params.userAddress,
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      amountPerInterval: params.amountPerInterval.toString(),
      intervalHours: params.intervalHours,
      totalIntervals: params.totalIntervals ?? null,
      intervalsExecuted: 0,
      status: 'active',
      nextExecution,
      totalSpent: '0',
      totalReceived: '0',
      avgPrice: '0',
      createdAt: now,
      updatedAt: now,
    },
  });

  return result.id;
}

/**
 * Execute a single DCA interval (swap at market price).
 */
export async function executeDcaInterval(strategyId: string): Promise<boolean> {
  const strategy = await prismaRead.dcaStrategy.findUnique({ where: { id: strategyId } });
  if (!strategy || strategy.status !== 'active') return false;

  const now = new Date();
  if (strategy.nextExecution > now) return false; // not yet time

  const amountIn = BigInt(strategy.amountPerInterval);

  // Place a market order
  const orderId = await placeLimitOrder({
    userAddress: strategy.userAddress,
    tokenIn: strategy.tokenIn,
    tokenOut: strategy.tokenOut,
    amountIn,
    amountOutMin: 0n,
    priceLimit: 0,
    orderType: 'market',
    fillStrategy: 'immediate_or_cancel',
  });

  // Update strategy
  const newIntervalsExecuted = strategy.intervalsExecuted + 1;
  const newTotalSpent = BigInt(strategy.totalSpent) + amountIn;
  const avgPrice = newTotalSpent > 0n
    ? Number(newTotalSpent) / (newIntervalsExecuted)
    : 0;

  const isComplete = strategy.totalIntervals != null && newIntervalsExecuted >= strategy.totalIntervals;
  const nextExecution = new Date(now.getTime() + strategy.intervalHours * 3600000);

  await prismaWrite.dcaStrategy.update({
    where: { id: strategyId },
    data: {
      intervalsExecuted: newIntervalsExecuted,
      status: isComplete ? 'completed' : 'active',
      nextExecution,
      totalSpent: newTotalSpent.toString(),
      avgPrice: avgPrice.toString(),
      updatedAt: now,
    },
  });

  return true;
}

/**
 * Process all due DCA strategies.
 */
export async function processDcaStrategies(): Promise<number> {
  const now = new Date();
  const dueStrategies = await prismaRead.dcaStrategy.findMany({
    where: {
      status: 'active',
      nextExecution: { lte: now },
    },
  });

  let executed = 0;
  for (const strategy of dueStrategies) {
    try {
      await executeDcaInterval(strategy.id);
      executed++;
    } catch (err) {
      console.error(`[DCA] Failed to execute strategy ${strategy.id}:`, err);
    }
  }

  return executed;
}

/**
 * Pause a DCA strategy.
 */
export async function pauseDcaStrategy(strategyId: string): Promise<boolean> {
  const strategy = await prismaRead.dcaStrategy.findUnique({ where: { id: strategyId } });
  if (!strategy || strategy.status !== 'active') return false;

  await prismaWrite.dcaStrategy.update({
    where: { id: strategyId },
    data: { status: 'paused', updatedAt: new Date() },
  });
  return true;
}

/**
 * Resume a paused DCA strategy.
 */
export async function resumeDcaStrategy(strategyId: string): Promise<boolean> {
  const strategy = await prismaRead.dcaStrategy.findUnique({ where: { id: strategyId } });
  if (!strategy || strategy.status !== 'paused') return false;

  const nextExecution = new Date(Date.now() + strategy.intervalHours * 3600000);

  await prismaWrite.dcaStrategy.update({
    where: { id: strategyId },
    data: {
      status: 'active',
      nextExecution,
      updatedAt: new Date(),
    },
  });
  return true;
}

/**
 * Cancel a DCA strategy.
 */
export async function cancelDcaStrategy(strategyId: string): Promise<boolean> {
  const strategy = await prismaRead.dcaStrategy.findUnique({ where: { id: strategyId } });
  if (!strategy) return false;

  await prismaWrite.dcaStrategy.update({
    where: { id: strategyId },
    data: { status: 'cancelled', updatedAt: new Date() },
  });
  return true;
}

/**
 * Get DCA strategy details.
 */
export async function getDcaDetails(strategyId: string): Promise<DcaInfo | null> {
  const strategy = await prismaRead.dcaStrategy.findUnique({ where: { id: strategyId } });
  if (!strategy) return null;

  return {
    id: strategy.id,
    userAddress: strategy.userAddress,
    tokenIn: strategy.tokenIn,
    tokenOut: strategy.tokenOut,
    amountPerInterval: BigInt(strategy.amountPerInterval),
    intervalHours: strategy.intervalHours,
    totalIntervals: strategy.totalIntervals,
    intervalsExecuted: strategy.intervalsExecuted,
    status: strategy.status as any,
    nextExecution: strategy.nextExecution,
    totalSpent: BigInt(strategy.totalSpent),
    totalReceived: BigInt(strategy.totalReceived),
    avgPrice: Number(strategy.avgPrice),
  };
}

/**
 * List DCA strategies for a user.
 */
export async function listUserDcaStrategies(
  userAddress: string,
  status?: string,
  limit = 50,
  offset = 0,
) {
  const where: any = { userAddress };
  if (status) where.status = status;

  const [strategies, total] = await Promise.all([
    prismaRead.dcaStrategy.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    }),
    prismaRead.dcaStrategy.count({ where }),
  ]);

  return { strategies, total };
}
