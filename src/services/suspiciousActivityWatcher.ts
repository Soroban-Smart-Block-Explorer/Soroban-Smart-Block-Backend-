/**
 * Indexed-activity watcher for the suspicious activity alert service.
 *
 * Bridges persisted `Event` / `Transaction` rows into the alert engine. Call it
 * from the indexer pipeline right after events are written, or run the periodic
 * watcher to back-stop anything the pipeline missed.
 */

import { prismaRead } from '../db';
import { logger } from '../logger';
import {
  fromIndexedEvent,
  fromIndexedTransaction,
  getSuspiciousActivityAlertService,
} from './suspiciousActivityAlerts';

const DEFAULT_LOOKBACK_MS = 5 * 60 * 1000;
const DEFAULT_SCAN_INTERVAL_MS = 60 * 1000;
const SCAN_BATCH_LIMIT = 1_000;

export interface ScanOptions {
  /** Only consider activity closed at/after this instant. */
  since?: Date;
  limit?: number;
  tenantId?: string;
}

/**
 * Pull recent events + transactions from the database and feed them to the
 * alert engine. Returns the number of activities evaluated.
 */
export async function scanIndexedActivity(options: ScanOptions = {}): Promise<number> {
  const since = options.since ?? new Date(Date.now() - DEFAULT_LOOKBACK_MS);
  const limit = options.limit ?? SCAN_BATCH_LIMIT;
  const tenantId = options.tenantId ?? 'default';
  const service = getSuspiciousActivityAlertService();

  let evaluated = 0;

  try {
    const [events, transactions] = await Promise.all([
      prismaRead.event.findMany({
        where: { ledgerCloseTime: { gte: since } },
        orderBy: { ledgerSequence: 'asc' },
        take: limit,
        select: {
          id: true,
          transactionHash: true,
          contractAddress: true,
          eventType: true,
          topicSymbol: true,
          decoded: true,
          ledgerSequence: true,
          ledgerCloseTime: true,
        },
      }),
      prismaRead.transaction.findMany({
        where: { ledgerCloseTime: { gte: since } },
        orderBy: { ledgerSequence: 'asc' },
        take: limit,
        select: {
          id: true,
          hash: true,
          contractAddress: true,
          sourceAccount: true,
          functionName: true,
          functionArgs: true,
          ledgerSequence: true,
          ledgerCloseTime: true,
        },
      }),
    ]);

    const activities = [
      ...transactions.map((tx) => fromIndexedTransaction(tx)),
      ...events.map((ev) => fromIndexedEvent(ev)),
    ].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    for (const activity of activities) {
      await service.ingest(activity, tenantId);
      evaluated++;
    }
  } catch (err) {
    logger.warn('[suspicious-alerts] indexed activity scan failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  return evaluated;
}

let watcherTimer: NodeJS.Timeout | null = null;

/**
 * Start the periodic watcher. Returns the interval handle so callers can stop
 * it; only one watcher runs per process.
 */
export function startSuspiciousActivityWatcher(
  intervalMs = DEFAULT_SCAN_INTERVAL_MS,
): NodeJS.Timeout {
  if (watcherTimer) return watcherTimer;

  const tick = () => {
    void scanIndexedActivity();
  };

  tick();
  watcherTimer = setInterval(tick, intervalMs);
  if (typeof watcherTimer.unref === 'function') watcherTimer.unref();
  logger.info('[suspicious-alerts] activity watcher started', { intervalMs });
  return watcherTimer;
}

export function stopSuspiciousActivityWatcher(): void {
  if (watcherTimer) {
    clearInterval(watcherTimer);
    watcherTimer = null;
  }
}
