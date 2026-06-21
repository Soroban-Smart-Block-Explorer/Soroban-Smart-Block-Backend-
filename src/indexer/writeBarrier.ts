/**
 * WriteBarrier — thread-safe batched upsert layer for the ingestor.
 *
 * Problem: parallel catch-up workers process non-overlapping ledger ranges
 * concurrently. When two workers encounter the same contract address or SAC
 * mapping they race to INSERT the same row, causing unique-constraint
 * violations or deadlocks.
 *
 * Solution:
 *  - A per-key mutex (promise chain) serialises concurrent writes to the
 *    same row. Workers that arrive while a write is in-flight queue behind
 *    it and skip the redundant upsert once the lock is released.
 *  - A micro-batch collector coalesces writes that arrive within the same
 *    event-loop tick into a single Prisma `createMany` / `upsertMany`
 *    equivalent, reducing round-trips under high parallelism.
 */

import { prismaWrite as prisma } from '../db';

// ---------------------------------------------------------------------------
// Per-key mutex
// ---------------------------------------------------------------------------

/** Map from a string key → tail of the promise chain for that key. */
const locks = new Map<string, Promise<void>>();

/**
 * Acquire an exclusive lock for `key`, run `fn`, then release.
 * Concurrent callers for the same key are serialised; different keys run in
 * parallel.
 */
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  let releaseLock!: () => void;
  const next = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  locks.set(key, next);

  await prev; // wait for any in-flight write on this key
  try {
    return await fn();
  } finally {
    releaseLock();
    // Clean up the map entry once the chain is empty to avoid memory leaks
    if (locks.get(key) === next) locks.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Micro-batch collector
// ---------------------------------------------------------------------------

interface PendingUpsert<T> {
  data: T;
  resolve: () => void;
  reject: (err: unknown) => void;
}

class MicroBatch<T> {
  private queue: PendingUpsert<T>[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly flush: (items: T[]) => Promise<void>,
    private readonly delayMs = 0,
  ) {}

  enqueue(data: T): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ data, resolve, reject });
      if (!this.timer) {
        this.timer = setTimeout(() => this.drain(), this.delayMs);
      }
    });
  }

  private async drain() {
    this.timer = null;
    const batch = this.queue.splice(0);
    if (batch.length === 0) return;
    try {
      await this.flush(batch.map((b) => b.data));
      batch.forEach((b) => b.resolve());
    } catch (err) {
      batch.forEach((b) => b.reject(err));
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Upsert a Contract row, serialised per address to prevent duplicate-key races.
 */
export async function barrierUpsertContract(address: string): Promise<void> {
  await withLock(`contract:${address}`, () =>
    prisma.contract
      .upsert({
        where: { address },
        update: {},
        create: { address },
      })
      .then(() => undefined),
  );
}

/**
 * Upsert a Ledger row, serialised per sequence number.
 */
export async function barrierUpsertLedger(
  sequence: number,
  closeTime: Date,
  hash = '',
): Promise<void> {
  await withLock(`ledger:${sequence}`, () =>
    prisma.ledger
      .upsert({
        where: { sequence },
        update: {},
        create: { sequence, hash, closeTime },
      })
      .then(() => undefined),
  );
}

/**
 * Upsert a Transaction row, serialised per hash.
 * Accepts the full create payload; update is a no-op (idempotent).
 */
export async function barrierUpsertTransaction(
  hash: string,
  createData: Parameters<typeof prisma.transaction.upsert>[0]['create'],
): Promise<void> {
  await withLock(`tx:${hash}`, () =>
    prisma.transaction
      .upsert({
        where: { hash },
        update: {},
        create: createData,
      })
      .then(() => undefined),
  );
}

// Batch event upserts — coalesce within the same tick
const eventBatch = new MicroBatch<Parameters<typeof prisma.event.upsert>[0]['create']>(
  async (items) => {
    // Prisma doesn't have a native upsertMany; use individual upserts inside a
    // transaction to get atomicity while still reducing round-trips.
    await prisma.$transaction(
      items.map((item) =>
        prisma.event.upsert({
          where: { id: item.id as string },
          update: {},
          create: item,
        }),
      ),
    );
  },
);

/**
 * Upsert an Event row via the micro-batch collector.
 * Calls within the same event-loop tick are coalesced into one DB transaction.
 */
export async function barrierUpsertEvent(
  createData: Parameters<typeof prisma.event.upsert>[0]['create'],
): Promise<void> {
  await eventBatch.enqueue(createData);
}
