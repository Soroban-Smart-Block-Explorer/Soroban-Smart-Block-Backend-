import { prismaWrite as prisma } from '../db';
import { Prisma } from '@prisma/client';
import { logger } from '../logger';
import { indexerErrorQueueDepth, indexerErrorRetriesTotal, indexerErrorDlqTotal } from '../metrics';
import { parseFailureReasonFromString } from './failure-parser';

const MAX_RETRIES = 3;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_CONCURRENCY = 5;

export interface FailedItemInput {
  itemType: 'transaction' | 'event' | 'ledger';
  itemId: string;
  ledger: number;
  rawXdr?: string;
  error: unknown;
  context?: Record<string, unknown>;
}

export interface RetryOptions {
  batchSize?: number;
  concurrency?: number;
}

/**
 * Detect non-retryable or poison errors (e.g. corrupted XDR, schema violations, syntax errors)
 */
export function isPoisonError(error: unknown): boolean {
  if (!error) return false;
  const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  const stack = error instanceof Error ? (error.stack ?? '').toLowerCase() : '';

  const poisonIndicators = [
    'invalid xdr',
    'corrupted xdr',
    'syntaxerror',
    'schemavalidationfailed',
    'unparseable',
    'malformed xdr',
    'typeerror: cannot read',
    'poison',
  ];

  return poisonIndicators.some((indicator) => msg.includes(indicator) || stack.includes(indicator));
}

/**
 * #912 — derive a bounded, low-cardinality reason label for DLQ/retry metrics
 * from a raw error. Uses failure-parser.ts's translation layer where possible
 * (so labels reflect the parsed failure category) but buckets into a fixed set
 * to keep Prometheus label cardinality under control.
 */
export function classifyFailureReason(error: unknown): string {
  if (isPoisonError(error)) return 'poison';

  const msg = error instanceof Error ? error.message : String(error ?? '');
  const parsed = parseFailureReasonFromString(msg).toLowerCase();

  if (/parse|malformed|xdr|decode|unparseable/i.test(parsed)) return 'parse_error';
  if (/timeout|timed out/i.test(parsed)) return 'timeout';
  if (/rate limit|429/i.test(parsed)) return 'rate_limit';
  if (/network|econn|socket|fetch failed|enotfound/i.test(parsed)) return 'network';
  if (/budget|resource limit/i.test(parsed)) return 'resource_limit';
  if (/auth|unauthorized/i.test(parsed)) return 'auth';
  return 'other';
}

/** Persist a failed decode item. Idempotent — increments retryCount on conflict. */
export async function enqueueFailure(item: FailedItemInput): Promise<void> {
  const err = item.error instanceof Error ? item.error : new Error(String(item.error));
  const poisonDetected = isPoisonError(item.error);

  const existing = await prisma.failedItem.findFirst({
    where: { itemId: item.itemId, itemType: item.itemType },
  });

  let isDead = poisonDetected;
  let currentRetryCount = 0;

  if (existing) {
    currentRetryCount = existing.retryCount + 1;
    // #912 — each re-enqueue is one retry; count it per item type.
    indexerErrorRetriesTotal.inc({ type: item.itemType });
    if (currentRetryCount >= MAX_RETRIES || poisonDetected) {
      isDead = true;
    }
    await prisma.failedItem.update({
      where: { id: existing.id },
      data: {
        errorMsg: err.message,
        errorStack: err.stack ?? null,
        retryCount: currentRetryCount,
        dead: isDead,
        lastTriedAt: new Date(),
      },
    });
  } else {
    currentRetryCount = 0;
    if (poisonDetected) {
      isDead = true;
    }
    await prisma.failedItem.create({
      data: {
        itemType: item.itemType,
        itemId: item.itemId,
        ledger: item.ledger,
        rawXdr: item.rawXdr ?? null,
        errorMsg: err.message,
        errorStack: err.stack ?? null,
        context:
          item.context != null
            ? ({ ...item.context, isPoison: poisonDetected } as Prisma.InputJsonValue)
            : ({ isPoison: poisonDetected } as Prisma.InputJsonValue),
        retryCount: currentRetryCount,
        dead: isDead,
      },
    });
  }

  if (isDead) {
    const reason = poisonDetected
      ? `Poison message detected (${err.message})`
      : `Reached max retries (${MAX_RETRIES})`;

    logger.error(
      `🚨 [POISON ISOLATION / DLQ] Item ${item.itemType}:${item.itemId} (ledger ${item.ledger}): ${reason}. Isolating to DeadLetterItem queue.`,
    );

    await moveToDeadLetter({
      itemType: item.itemType,
      itemId: item.itemId,
      ledger: item.ledger,
      hash: item.rawXdr ?? null,
      errorMsg: err.message,
      errorStack: err.stack ?? null,
      retryCount: currentRetryCount,
      reason: poisonDetected ? 'poison' : 'retry_exhausted',
      payload: { ...item.context, isPoison: poisonDetected, isolationReason: reason },
    });
  } else {
    logger.error(
      `[errorQueue] ${item.itemType} ${item.itemId} (ledger ${item.ledger}) failed: ${err.message}`,
    );
  }
}

/** Move an unprocessable item into the durable DeadLetterItem queue */
export async function moveToDeadLetter(dlData: {
  itemType: string;
  itemId: string;
  ledger: number;
  hash?: string | null;
  errorMsg: string;
  errorStack?: string | null;
  retryCount: number;
  /** Bounded reason label for metrics (defaults to classifyFailureReason(errorMsg)). */
  reason?: string;
  payload?: Record<string, unknown> | null;
}): Promise<void> {
  // #912 — dead-letter events are permanent failures; count them by reason so
  // operators can see poison-vs-exhaustion mix and alert on DLQ rate.
  indexerErrorDlqTotal.inc({ reason: dlData.reason ?? classifyFailureReason(dlData.errorMsg) });
  await prisma.deadLetterItem.create({
    data: {
      itemType: dlData.itemType,
      itemId: dlData.itemId,
      ledger: dlData.ledger,
      hash: dlData.hash ?? null,
      errorMsg: dlData.errorMsg,
      errorStack: dlData.errorStack ?? null,
      retryCount: dlData.retryCount,
      payload: dlData.payload != null ? (dlData.payload as Prisma.InputJsonValue) : Prisma.JsonNull,
    },
  });
}

/** Fetch dead letter items for admin inspection */
export async function getDeadLetterItems(limit = 50, offset = 0) {
  const [items, total] = await Promise.all([
    prisma.deadLetterItem.findMany({
      take: Math.min(limit, 200),
      skip: offset,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.deadLetterItem.count(),
  ]);
  return { items, total, limit, offset };
}

/** Reprocess (retry) dead letter items */
export async function reprocessDeadLetterItem(id: string): Promise<boolean> {
  const dlItem = await prisma.deadLetterItem.findUnique({ where: { id } });
  if (!dlItem) return false;

  const existingFailed = await prisma.failedItem.findFirst({
    where: { itemId: dlItem.itemId, itemType: dlItem.itemType },
  });

  if (existingFailed) {
    await prisma.failedItem.update({
      where: { id: existingFailed.id },
      data: { dead: false, retryCount: 0 },
    });
  }

  await prisma.deadLetterItem.delete({ where: { id } });
  logger.info(`[deadLetter] Reprocess triggered for ${dlItem.itemType}:${dlItem.itemId}`);
  return true;
}

/** Purge dead letter items */
export async function purgeDeadLetterItems(ids?: string[]): Promise<number> {
  if (ids && ids.length > 0) {
    const deleted = await prisma.deadLetterItem.deleteMany({
      where: { id: { in: ids } },
    });
    return deleted.count;
  }
  const deleted = await prisma.deadLetterItem.deleteMany({});
  return deleted.count;
}

/**
 * #912 — refresh the indexer_error_queue_depth gauges from the database.
 * Called from getQueueBackpressureStatus() and at the end of every
 * retryFailures() cycle so /metrics reflects queue reality between scans.
 */
export async function updateErrorQueueMetrics(): Promise<void> {
  const [pendingCount, deadCount] = await Promise.all([
    prisma.failedItem.count({ where: { dead: false } }),
    prisma.deadLetterItem.count(),
  ]);

  indexerErrorQueueDepth.set({ queue: 'pending' }, pendingCount);
  indexerErrorQueueDepth.set({ queue: 'dead' }, deadCount);
}

/** Get queue depth and backpressure status metrics */
export async function getQueueBackpressureStatus() {
  const [pendingCount, deadCount] = await Promise.all([
    prisma.failedItem.count({ where: { dead: false } }),
    prisma.deadLetterItem.count(),
  ]);

  // #912 — keep the depth gauges in sync with every backpressure read.
  indexerErrorQueueDepth.set({ queue: 'pending' }, pendingCount);
  indexerErrorQueueDepth.set({ queue: 'dead' }, deadCount);

  return {
    pendingCount,
    deadCount,
    isOverloaded: pendingCount > 500,
  };
}

/**
 * Retry non-dead failed items with backpressure batching and worker-pool concurrency control.
 * Healthy items are processed concurrently; poison items are isolated immediately.
 */
export async function retryFailures(
  handler: (item: {
    itemType: string;
    itemId: string;
    ledger: number;
    rawXdr: string | null;
    context: unknown;
  }) => Promise<void>,
  options: RetryOptions = {},
): Promise<{ processed: number; succeeded: number; failed: number }> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;

  // 1. Fetch capped batch of non-dead failed items (backpressure control)
  const pending = await prisma.failedItem.findMany({
    where: { dead: false },
    take: batchSize,
    orderBy: { createdAt: 'asc' },
  });

  if (pending.length === 0) {
    return { processed: 0, succeeded: 0, failed: 0 };
  }

  logger.info(
    `[errorQueue] Retrying ${pending.length} failed items (batchSize: ${batchSize}, concurrency: ${concurrency})`,
  );

  let succeeded = 0;
  let failed = 0;

  // 2. Process batch in worker pool chunks up to max concurrency
  for (let i = 0; i < pending.length; i += concurrency) {
    const chunk = pending.slice(i, i + concurrency);
    await Promise.all(
      chunk.map(async (item) => {
        try {
          // If poison error is detected in metadata upfront, isolate immediately
          if (isPoisonError(item.errorMsg)) {
            logger.warn(
              `🚨 [POISON ISOLATION] Fast isolating pre-identified poison item ${item.itemType}:${item.itemId}`,
            );
            await prisma.failedItem.update({
              where: { id: item.id },
              data: { dead: true },
            });
            await moveToDeadLetter({
              itemType: item.itemType,
              itemId: item.itemId,
              ledger: item.ledger,
              hash: item.rawXdr ?? null,
              errorMsg: item.errorMsg,
              errorStack: item.errorStack ?? null,
              retryCount: item.retryCount,
              reason: 'poison',
              payload: { context: item.context, isPoison: true },
            });
            failed += 1;
            return;
          }

          await handler(item);
          await prisma.failedItem.delete({ where: { id: item.id } });
          succeeded += 1;
          logger.info(`[errorQueue] Retry succeeded for ${item.itemType} ${item.itemId}`);
        } catch (err) {
          failed += 1;
          await enqueueFailure({
            itemType: item.itemType as 'transaction' | 'event' | 'ledger',
            itemId: item.itemId,
            ledger: item.ledger,
            rawXdr: item.rawXdr ?? undefined,
            error: err,
            context: item.context as Record<string, unknown> | undefined,
          });
        }
      }),
    );
  }

  // #912 — refresh depth gauges at the end of each retry-scan cycle.
  await updateErrorQueueMetrics();

  return { processed: pending.length, succeeded, failed };
}
