/**
 * #220 — High-Throughput Batch-Settlement Event Compact Engine
 *
 * Groups large volumes of settlement events hitting a single enterprise banking
 * contract into compact SettlementBatchSummary rows, preventing index bloat
 * during high-volume institutional trade-clearing windows.
 *
 * Strategy:
 *  - Runs on a configurable interval (default 60 s).
 *  - Scans Event rows of type "settlement" that have not yet been compacted.
 *  - Groups by (contractAddress, windowKey) where windowKey = ledger / WINDOW_SIZE.
 *  - For each group with >= MIN_EVENTS events, writes one SettlementBatchSummary
 *    and marks the source events as compacted.
 */

import { prismaWrite as prisma } from '../db';

const WINDOW_SIZE = Number(process.env.COMPACTOR_WINDOW_SIZE ?? 100); // ledgers per window
const MIN_EVENTS = Number(process.env.COMPACTOR_MIN_EVENTS ?? 10); // min events to compact
const INTERVAL_MS = Number(process.env.COMPACTOR_INTERVAL_MS ?? 60_000);
const BATCH_LIMIT = Number(process.env.COMPACTOR_BATCH_LIMIT ?? 5_000); // max events per run

let timer: ReturnType<typeof setInterval> | null = null;

export function scheduleSettlementCompactor(): void {
  if (timer) return;
  console.log('[compactor] settlement compactor scheduled every', INTERVAL_MS, 'ms');
  // Run once immediately, then on interval
  runCompactor().catch((e) => console.error('[compactor] run error:', e));
  timer = setInterval(() => {
    runCompactor().catch((e) => console.error('[compactor] run error:', e));
  }, INTERVAL_MS);
}

export async function runCompactor(): Promise<void> {
  // Fetch uncompacted settlement events in ledger order
  const events = await prisma.event.findMany({
    where: {
      eventType: 'settlement',
      compacted: false,
    },
    orderBy: { ledgerSequence: 'asc' },
    take: BATCH_LIMIT,
    select: {
      id: true,
      contractAddress: true,
      ledgerSequence: true,
      ledgerCloseTime: true,
      decoded: true,
    },
  });

  if (!events.length) return;

  // Group by (contractAddress, windowKey)
  type GroupKey = string;
  const groups = new Map<GroupKey, typeof events>();

  for (const ev of events) {
    const windowKey = Math.floor(ev.ledgerSequence / WINDOW_SIZE);
    const key: GroupKey = `${ev.contractAddress}::${windowKey}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(ev);
  }

  let compacted = 0;

  for (const [key, batch] of groups) {
    if (batch.length < MIN_EVENTS) continue;

    const [contractAddress, windowKeyStr] = key.split('::');
    const windowKey = Number(windowKeyStr);
    const ledgerMin = windowKey * WINDOW_SIZE;
    const ledgerMax = ledgerMin + WINDOW_SIZE - 1;

    // Aggregate totals from decoded payloads
    let totalAmount = BigInt(0);
    const uniqueParties = new Set<string>();

    for (const ev of batch) {
      const d = ev.decoded as Record<string, unknown> | null;
      if (!d) continue;
      // Accept common field names used by settlement events
      const amt = d['amount'] ?? d['settlement_amount'] ?? d['value'];
      if (typeof amt === 'string' || typeof amt === 'number') {
        try {
          totalAmount += BigInt(String(amt).replace(/[^0-9]/g, '') || '0');
        } catch {
          /* skip */
        }
      }
      for (const field of ['from', 'to', 'seller', 'buyer', 'sender', 'receiver']) {
        if (typeof d[field] === 'string') uniqueParties.add(d[field] as string);
      }
    }

    const windowStart = batch[0].ledgerCloseTime;
    const windowEnd = batch[batch.length - 1].ledgerCloseTime;

    await prisma.$transaction(async (tx) => {
      await tx.settlementBatchSummary.upsert({
        where: { contractAddress_windowKey: { contractAddress, windowKey } },
        update: {
          eventCount: batch.length,
          totalAmount: totalAmount.toString(),
          uniqueParties: uniqueParties.size,
          ledgerMin,
          ledgerMax,
          windowEnd,
          updatedAt: new Date(),
        },
        create: {
          contractAddress,
          windowKey,
          ledgerMin,
          ledgerMax,
          windowStart,
          windowEnd,
          eventCount: batch.length,
          totalAmount: totalAmount.toString(),
          uniqueParties: uniqueParties.size,
        },
      });

      // Mark events as compacted
      await tx.event.updateMany({
        where: { id: { in: batch.map((e) => e.id) } },
        data: { compacted: true },
      });
    });

    compacted += batch.length;
  }

  if (compacted > 0) {
    console.log(`[compactor] compacted ${compacted} settlement events into batch summaries`);
  }
}
