/**
 * Discover Indexer Runner — Issue #335
 *
 * Background service that monitors for new token deployments, liquidity events,
 * airdrop distributions, and evaluates alert conditions in real-time.
 */

import { prismaWrite as prisma } from '../db';
import { prismaRead } from '../db';
import { config } from '../config';
import { logger } from '../logger';
import { processDetectedToken, fetchInitialHolders } from '../discover/token-detector';
import { scanForLiquidityEvents, processLiquidityEvent } from '../discover/liquidity-monitor';
import { detectMassDistribution, processAirdrop } from '../discover/airdrop-detector';
import { evaluateAlertConditions } from '../discover/alert-engine';
import { classifyToken } from '../discover/trending';

const POLL_INTERVAL_MS = 30_000; // 30 seconds
const LIQUIDITY_SCAN_INTERVAL_MS = 60_000; // 1 minute
const AIRDROP_SCAN_INTERVAL_MS = 120_000; // 2 minutes
const ALERT_EVAL_INTERVAL_MS = 60_000; // 1 minute

let lastLedger = 0;
let isRunning = false;

/**
 * Get the last processed ledger for the discover indexer.
 */
async function getLastProcessedLedger(): Promise<number> {
  // Use a dedicated key or fall back to the main indexer state
  const state = await prisma.indexerState.findUnique({
    where: { id: 'singleton' },
  });
  return state?.lastLedger ?? 0;
}

/**
 * Start the discover indexer background service.
 */
export async function startDiscoverIndexer(): Promise<void> {
  if (isRunning) {
    logger.warn('Discover indexer is already running');
    return;
  }

  isRunning = true;
  lastLedger = await getLastProcessedLedger();

  logger.info('Starting discover indexer', {
    startLedger: lastLedger,
    pollInterval: POLL_INTERVAL_MS,
  });

  // Main poll loop for new token detection
  runPollLoop().catch((err) => {
    logger.error('Discover indexer poll loop failed', { error: String(err) });
    isRunning = false;
  });

  // Liquidity events scanner
  runLiquidityScanner().catch((err) => {
    logger.error('Liquidity scanner failed', { error: String(err) });
  });

  // Airdrop detector
  runAirdropDetector().catch((err) => {
    logger.error('Airdrop detector failed', { error: String(err) });
  });

  // Alert evaluator
  runAlertEvaluator().catch((err) => {
    logger.error('Alert evaluator failed', { error: String(err) });
  });
}

/**
 * Main poll loop — checks for new contract deployments.
 */
async function runPollLoop(): Promise<void> {
  while (isRunning) {
    try {
      await scanNewContracts();
    } catch (err) {
      logger.error('Error in discover poll loop', { error: String(err) });
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * Scan for new contract deployments.
 */
async function scanNewContracts(): Promise<void> {
  // Get recent transactions that deployed contracts
  const recentContracts = await prisma.contract.findMany({
    where: {
      createdAt: {
        gte: new Date(Date.now() - POLL_INTERVAL_MS * 2),
      },
    },
    select: {
      address: true,
      createdAt: true,
      tokenSymbol: true,
      tokenName: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  for (const contract of recentContracts) {
    // Check if already processed
    const existing = await prismaRead.detectedToken.findUnique({
      where: { contractAddress: contract.address },
    });
    if (existing) continue;

    // Find deployment transaction
    const deployTx = await prismaRead.transaction.findFirst({
      where: { contractAddress: contract.address },
      orderBy: { ledgerSequence: 'asc' },
      select: {
        hash: true,
        sourceAccount: true,
        ledgerSequence: true,
        ledgerCloseTime: true,
      },
    });

    if (!deployTx) continue;

    await processDetectedToken({
      contractAddress: contract.address,
      deployerAddress: deployTx.sourceAccount,
      deployTxHash: deployTx.hash,
      deployBlock: deployTx.ledgerSequence,
      detectedAt: deployTx.ledgerCloseTime,
    });

    // Fetch initial holders
    const { holders, count } = await fetchInitialHolders(
      contract.address,
      deployTx.ledgerSequence,
    );

    if (holders.length > 0) {
      const token = await prismaRead.detectedToken.findUnique({
        where: { contractAddress: contract.address },
        select: { id: true },
      });

      if (token) {
        // Compute total supply
        const totalSupply = await prismaRead.detectedToken.findUnique({
          where: { contractAddress: contract.address },
          select: { totalSupply: true },
        });

        const supply = totalSupply?.totalSupply ? Number(totalSupply.totalSupply) : 0;

        for (const holder of holders) {
          const pct = supply > 0 ? parseFloat(((Number(holder.balance) / supply) * 100).toFixed(6)) : 0;

          await prisma.tokenHolder.create({
            data: {
              tokenId: token.id,
              holderAddress: holder.address,
              balance: BigInt(holder.balance),
              percentage: BigInt(Math.round(pct * 1000000)),
              firstAcquisition: new Date(),
            },
          }).catch(() => {
            // Ignore duplicate holder entries
          });
        }

        // Update holder count
        await prisma.detectedToken.update({
          where: { id: token.id },
          data: { initialHolderCount: holders.length },
        });

        // Auto-classify token
        try {
          await classifyToken(token.id, contract.address);
        } catch {
          // Classification is optional
        }
      }
    }
  }
}

/**
 * Run liquidity event scanner on a schedule.
 */
async function runLiquidityScanner(): Promise<void> {
  let lastScannedLedger = await getLastProcessedLedger();

  while (isRunning) {
    try {
      const latestLedger = await prismaRead.ledger.findFirst({
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      });

      if (!latestLedger) {
        await sleep(LIQUIDITY_SCAN_INTERVAL_MS);
        continue;
      }

      if (latestLedger.sequence > lastScannedLedger) {
        const events = await scanForLiquidityEvents(
          lastScannedLedger + 1,
          latestLedger.sequence,
        );

        for (const event of events) {
          await processLiquidityEvent(event);
        }

        lastScannedLedger = latestLedger.sequence;
      }
    } catch (err) {
      logger.error('Error in liquidity scanner', { error: String(err) });
    }

    await sleep(LIQUIDITY_SCAN_INTERVAL_MS);
  }
}

/**
 * Run airdrop detector on a schedule.
 */
async function runAirdropDetector(): Promise<void> {
  let lastScannedLedger = await getLastProcessedLedger();

  while (isRunning) {
    try {
      const latestLedger = await prismaRead.ledger.findFirst({
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      });

      if (!latestLedger) {
        await sleep(AIRDROP_SCAN_INTERVAL_MS);
        continue;
      }

      if (latestLedger.sequence > lastScannedLedger) {
        // Find all tokens that might have airdrops
        const tokens = await prismaRead.detectedToken.findMany({
          where: { status: { not: 'blacklisted' } },
          select: { contractAddress: true },
          take: 50,
        });

        for (const token of tokens) {
          const airdrops = await detectMassDistribution(
            token.contractAddress,
            lastScannedLedger + 1,
            latestLedger.sequence,
          );

          for (const airdrop of airdrops) {
            await processAirdrop(airdrop);
          }
        }

        lastScannedLedger = latestLedger.sequence;
      }
    } catch (err) {
      logger.error('Error in airdrop detector', { error: String(err) });
    }

    await sleep(AIRDROP_SCAN_INTERVAL_MS);
  }
}

/**
 * Evaluate alert conditions on a schedule.
 */
async function runAlertEvaluator(): Promise<void> {
  while (isRunning) {
    try {
      await evaluateAlertConditions();
    } catch (err) {
      logger.error('Error in alert evaluator', { error: String(err) });
    }

    await sleep(ALERT_EVAL_INTERVAL_MS);
  }
}

/**
 * Stop the discover indexer.
 */
export function stopDiscoverIndexer(): void {
  isRunning = false;
  logger.info('Discover indexer stopped');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
