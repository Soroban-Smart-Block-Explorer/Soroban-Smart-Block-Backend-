import { prismaWrite as prisma } from '../db';
import { Prisma } from '@prisma/client';

const MAX_RETRIES = 3;

export interface FailedItemInput {
  itemType: 'transaction' | 'event';
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

  if (existing) {
    const retryCount = existing.retryCount + 1;
    await prisma.failedItem.update({
      where: { id: existing.id },
      data: {
        errorMsg: err.message,
        errorStack: err.stack ?? null,
        retryCount,
        dead: retryCount >= MAX_RETRIES,
        lastTriedAt: new Date(),
      },
    });
  } else {
    await prisma.failedItem.create({
      data: {
        itemType: item.itemType,
        itemId: item.itemId,
        ledger: item.ledger,
        rawXdr: item.rawXdr ?? null,
        errorMsg: err.message,
        errorStack: err.stack ?? null,
        context: item.context != null ? (item.context as Prisma.InputJsonValue) : Prisma.JsonNull,
        retryCount: 0,
        dead: false,
      },
    });
  }

  console.error(
    `[errorQueue] ${item.itemType} ${item.itemId} (ledger ${item.ledger}) failed: ${err.message}`,
  );
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
      console.log(`[errorQueue] Retry succeeded for ${item.itemType} ${item.itemId}`);
    } catch (err) {
      await enqueueFailure({
        itemType: item.itemType as 'transaction' | 'event',
        itemId: item.itemId,
        ledger: item.ledger,
        rawXdr: item.rawXdr ?? undefined,
        error: err,
        context: item.context as Record<string, unknown> | undefined,
      });
    }
  }
}
