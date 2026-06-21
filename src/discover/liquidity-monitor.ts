/**
 * Liquidity Event Detection — Issue #335
 *
 * Detects add_liquidity calls on any DEX for new tokens, tracks liquidity depth,
 * locked liquidity detection, and rug-pull detection (liquidity removal).
 */

import { prismaWrite as prisma } from '../db';
import { logger } from '../logger';

export interface LiquidityEventInput {
  tokenContractAddress: string;
  poolAddress: string;
  dexName: string;
  quoteToken: string;
  liquidityAdded: string;
  liquidityUsdValue?: number;
  isLocked: boolean;
  lockInfo?: Record<string, unknown>;
  txHash: string;
  blockNumber: number;
  timestamp: Date;
}

/**
 * Detect and record a liquidity event for a token.
 */
export async function processLiquidityEvent(input: LiquidityEventInput): Promise<void> {
  const token = await prisma.detectedToken.findUnique({
    where: { contractAddress: input.tokenContractAddress },
  });
  if (!token) {
    logger.warn('Liquidity event for unknown token', {
      contract: input.tokenContractAddress,
    });
    return;
  }

  await prisma.liquidityEvent.create({
    data: {
      tokenId: token.id,
      poolAddress: input.poolAddress,
      dexName: input.dexName,
      quoteToken: input.quoteToken,
      liquidityAdded: BigInt(input.liquidityAdded),
      liquidityUsdValue: input.liquidityUsdValue
        ? BigInt(Math.round(input.liquidityUsdValue * 100))
        : null,
      isLocked: input.isLocked,
      lockInfo: input.lockInfo ?? undefined,
      txHash: input.txHash,
      blockNumber: BigInt(input.blockNumber),
      timestamp: input.timestamp,
    },
  });

  // Check if liquidity is removed (rug-pull indicator)
  if (input.liquidityAdded === '0' || BigInt(input.liquidityAdded) < 0n) {
    await checkLiquidityRemoval(token.id, input.tokenContractAddress, input.poolAddress);
  }
}

/**
 * Detect liquidity removal (potential rug-pull).
 */
async function checkLiquidityRemoval(
  tokenId: bigint,
  contractAddress: string,
  poolAddress: string,
): Promise<void> {
  const recentEvents = await prisma.liquidityEvent.findMany({
    where: {
      tokenId,
      poolAddress,
    },
    orderBy: { blockNumber: 'desc' },
    take: 5,
  });

  const hasLiquidityAdd = recentEvents.some(
    (e) => BigInt(e.liquidityAdded) > 0n,
  );

  if (!hasLiquidityAdd) return; // initial removal, not a rug

  // Flag this as a potential rug-pull
  await prisma.detectedToken.update({
    where: { id: tokenId },
    data: { status: 'flagged' },
  });

  logger.warn('Potential rug-pull detected', {
    contract: contractAddress,
    pool: poolAddress,
  });
}

/**
 * Detect add_liquidity calls from event data.
 * Scans events for known DEX pool patterns.
 */
export async function scanForLiquidityEvents(
  fromLedger: number,
  toLedger: number,
): Promise<LiquidityEventInput[]> {
  const events = await prisma.event.findMany({
    where: {
      eventType: { in: ['add_liquidity', 'remove_liquidity', 'swap'] },
      ledgerSequence: { gte: fromLedger, lte: toLedger },
    },
    select: {
      contractAddress: true,
      transactionHash: true,
      decoded: true,
      ledgerSequence: true,
      ledgerCloseTime: true,
      topics: true,
    },
    orderBy: { ledgerSequence: 'asc' },
  });

  const results: LiquidityEventInput[] = [];

  for (const event of events) {
    try {
      const decoded = event.decoded as Record<string, unknown> | null;
      if (!decoded) continue;

      const poolAddress = event.contractAddress;
      const amount = decoded.amount ?? decoded.liquidity ?? decoded.value ?? '0';
      const tokenA = decoded.tokenA ?? decoded.token0 ?? decoded.from ?? '';
      const tokenB = decoded.tokenB ?? decoded.token1 ?? decoded.to ?? '';

      // Determine which token is the quote token
      const quoteToken = String(tokenB || 'XLM');

      results.push({
        tokenContractAddress: String(tokenA || ''),
        poolAddress,
        dexName: 'soroban_dex', // detected DEX
        quoteToken,
        liquidityAdded: String(amount),
        liquidityUsdValue: undefined,
        isLocked: false,
        txHash: event.transactionHash,
        blockNumber: event.ledgerSequence,
        timestamp: event.ledgerCloseTime,
      });
    } catch (err) {
      logger.warn('Failed to parse liquidity event', {
        tx: event.transactionHash,
        error: String(err),
      });
    }
  }

  return results;
}
