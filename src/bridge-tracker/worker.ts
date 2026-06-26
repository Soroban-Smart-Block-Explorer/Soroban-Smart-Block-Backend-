import { BridgeEvent, Chain } from './types';
import { ALERT_CONFIG } from './config';
import {
  resolveBridgeTransaction,
  storeBridgeTransaction,
  pollAndResolvePending,
} from './resolver';
import { checkFinality, updateTransactionFinality, getStaleTransactions } from './finality';
import { aggregateVolumeSnapshot } from './liquidity';
import { checkLargeTransfer, checkMonitoredAddressActivity, runAlertChecks } from './alerts';
import { prismaWrite as prisma } from '../db';
import { logger } from '../logger';

let isRunning = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;

export async function processBridgeEvent(event: BridgeEvent): Promise<void> {
  try {
    // Resolve cross-chain status
    const resolved = await resolveBridgeTransaction(event);

    // Store in database
    await storeBridgeTransaction(event, resolved);

    // Check finality
    const finality = await checkFinality(
      event.transactionHash,
      event.sourceChain,
      event.destinationChain,
    );
    await updateTransactionFinality(event.transactionHash, finality);

    // Alert checks
    const [largeTransferAlert, addressAlerts] = await Promise.all([
      checkLargeTransfer(
        event.protocol,
        event.sourceChain,
        event.asset,
        event.amount,
        event.sender,
        event.recipient,
        event.transactionHash,
      ),
      checkMonitoredAddressActivity(
        event.transactionHash,
        event.sender,
        event.recipient,
        event.sourceChain,
        event.protocol,
        event.amount,
        event.asset,
      ),
    ]);

    logger.info('Bridge event processed', {
      txHash: event.transactionHash,
      protocol: event.protocol,
      status: finality.status,
      alerts: (largeTransferAlert ? 1 : 0) + addressAlerts.length,
    });
  } catch (err) {
    logger.error('Failed to process bridge event', {
      txHash: event.transactionHash,
      error: String(err),
    });
  }
}

async function pollCycle(): Promise<void> {
  try {
    // Resolve pending transactions
    const resolved = await pollAndResolvePending(50);

    // Check finality on active transactions
    const active = await prisma.bridgeTransaction.findMany({
      where: { status: { in: ['pending', 'detected', 'bridging'] } },
      take: 100,
    });

    for (const tx of active) {
      try {
        const finality = await checkFinality(
          tx.transactionHash,
          tx.sourceChain as Chain,
          tx.destinationChain as Chain,
        );
        if (finality.status !== tx.status) {
          await updateTransactionFinality(tx.transactionHash, finality);
        }
      } catch (err) {
        logger.debug('Finality check failed', { txHash: tx.transactionHash, error: String(err) });
      }
    }

    // Check for reorgs
    const staleTxs = await getStaleTransactions(2);
    if (staleTxs.length > 0) {
      logger.warn(`Found ${staleTxs.length} potentially stalled transactions`);
    }

    // Run alert checks
    const alertCount = await runAlertChecks();

    // Aggregate volume snapshot (less frequent)
    if (Math.random() < 0.1) {
      await aggregateVolumeSnapshot();
    }

    if (resolved > 0 || alertCount > 0) {
      logger.debug('Bridge worker poll cycle complete', { resolved, alerts: alertCount });
    }
  } catch (err) {
    logger.error('Bridge worker poll cycle failed', { error: String(err) });
  }
}

export function startBridgeWorker(): void {
  if (isRunning) {
    logger.warn('Bridge worker already running');
    return;
  }

  const interval = ALERT_CONFIG.pollIntervalMs;
  logger.info('Starting bridge worker', { pollIntervalMs: interval });

  isRunning = true;
  // Run first cycle immediately
  pollCycle().catch((err) =>
    logger.error('Bridge worker first cycle failed', { error: String(err) }),
  );
  pollTimer = setInterval(pollCycle, interval);
}

export function stopBridgeWorker(): void {
  if (!isRunning) return;

  logger.info('Stopping bridge worker');
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  isRunning = false;
}

export function isBridgeWorkerRunning(): boolean {
  return isRunning;
}
