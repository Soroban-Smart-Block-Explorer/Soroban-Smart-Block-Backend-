import { prismaWrite as prisma } from '../db';
import { Prisma } from '@prisma/client';
import { logger } from '../logger';

const MAX_RETRIES = 3;

export interface FailedItemInput {
  itemType: 'transaction' | 'event' | 'ledger';
  itemId: string;
  ledger: number;
  rawXdr?: string;
  error: unknown;
  context?: Record<string, unknown>;
}

/** Persist a failed decode item. Idempotent — increments retryCount on conflict. */
export async function enqueueFailure(item: FailedItemInput): Promise<void> {
  const err = item.error instanceof Error ? item.error : new Error(String(item.error));
  const existing = await prisma.failedItem.findFirst({
    where: { itemId: item.itemId, itemType: item.itemType },
  });

  let isDead = false;
  let currentRetryCount = 0;

  if (existing) {
    currentRetryCount = existing.retryCount + 1;
    isDead = currentRetryCount >= MAX_RETRIES;
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
    isDead = currentRetryCount >= MAX_RETRIES;
    await prisma.failedItem.create({
      data: {
        itemType: item.itemType,
        itemId: item.itemId,
        ledger: item.ledger,
        rawXdr: item.rawXdr ?? null,
        errorMsg: err.message,
        errorStack: err.stack ?? null,
        context: item.context != null ? (item.context as Prisma.InputJsonValue) : Prisma.JsonNull,
        retryCount: currentRetryCount,
        dead: isDead,
      },
    });
  }

  if (isDead) {
    logger.error(
      `🚨 [DEAD LETTER] Item ${item.itemType}:${item.itemId} reached ${MAX_RETRIES} retries. Moving to DeadLetterItem queue.`,
    );
    await moveToDeadLetter({
      itemType: item.itemType,
      itemId: item.itemId,
      ledger: item.ledger,
      hash: item.rawXdr ?? null,
      errorMsg: err.message,
      errorStack: err.stack ?? null,
      retryCount: currentRetryCount,
      payload: item.context ?? null,
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
  payload?: Record<string, unknown> | null;
}): Promise<void> {
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

  // Reset corresponding FailedItem to non-dead and retry count 0 so it gets retried
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
 * Retry all non-dead failed items by calling the provided handler.
 * Items that succeed are deleted; items that fail again are re-enqueued.
 */
export async function retryFailures(
  handler: (item: {
    itemType: string;
    itemId: string;
    ledger: number;
    rawXdr: string | null;
    context: unknown;
  }) => Promise<void>,
): Promise<void> {
  const pending = await prisma.failedItem.findMany({
    where: { dead: false },
    orderBy: { createdAt: 'asc' },
  });

  for (const item of pending) {
    try {
      await handler(item);
      await prisma.failedItem.delete({ where: { id: item.id } });
      logger.info(`[errorQueue] Retry succeeded for ${item.itemType} ${item.itemId}`);
    } catch (err) {
      await enqueueFailure({
        itemType: item.itemType as 'transaction' | 'event' | 'ledger',
        itemId: item.itemId,
        ledger: item.ledger,
        rawXdr: item.rawXdr ?? undefined,
        error: err,
        context: item.context as Record<string, unknown> | undefined,
      });
    }
  }
}
