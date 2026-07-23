/**
 * Background Repair Process
 *
 * Sweeps the Ledger table for two classes of defect:
 *   1. Missing sequences — ledger numbers that never got a row (hard gaps).
 *   2. Empty ledgers    — rows that exist but have txCount=0 AND no linked
 *                         transactions/events (soft gaps from partial ingestion).
 *
 * For each gap it fires a targeted recovery job against the configured
 * archive RPC node, reusing the existing processLedgerRange engine so all
 * upsert/idempotency guarantees are preserved.
 *
 * The repair loop runs independently of the live indexer — it never touches
 * IndexerState, so the live pipeline cursor is never disturbed.
 */

import { prismaWrite as prisma } from '../db';
import { processLedgerRange } from './ledgerProcessor';
import { config } from '../config';

// ─── Config ───────────────────────────────────────────────────────────────────

/** Max ledgers to backfill in a single repair job (keeps RPC calls bounded). */
const REPAIR_CHUNK = parseInt(process.env.REPAIR_CHUNK_SIZE ?? '50');

/** Pause between sweep iterations (ms). */
const SWEEP_INTERVAL_MS = parseInt(process.env.REPAIR_SWEEP_INTERVAL_MS ?? '60000');

/** How many consecutive empty-ledger sequences to tolerate before skipping. */
const MAX_EMPTY_BATCH = parseInt(process.env.REPAIR_MAX_EMPTY_BATCH ?? '200');

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

// ─── Gap detection ────────────────────────────────────────────────────────────

/**
 * Return up to `limit` ledger sequence numbers that are absent from the
 * Ledger table but fall within [minSeq, maxSeq].
 *
 * Uses a generate_series approach via raw SQL for efficiency — avoids
 * loading the entire sequence range into JS memory.
 */
async function findMissingSequences(
  minSeq: number,
  maxSeq: number,
  limit: number,
): Promise<number[]> {
  // generate_series produces every integer in range; LEFT JOIN finds the holes.
  const rows = await prisma.$queryRaw<Array<{ seq: number }>>`
    SELECT s.seq::int
    FROM generate_series(${minSeq}::int, ${maxSeq}::int) AS s(seq)
    LEFT JOIN "Ledger" l ON l.sequence = s.seq
    WHERE l.sequence IS NULL
    ORDER BY s.seq
    LIMIT ${limit}
  `;
  return rows.map((r) => r.seq);
}

/**
 * Return up to `limit` ledger sequences that exist in the Ledger table but
 * have no associated Transaction or Event rows (soft/empty gaps).
 */
async function findEmptyLedgers(limit: number): Promise<number[]> {
  const rows = await prisma.$queryRaw<Array<{ sequence: number }>>`
    SELECT l.sequence
    FROM "Ledger" l
    WHERE NOT EXISTS (
      SELECT 1 FROM "Transaction" t WHERE t."ledgerSequence" = l.sequence
    )
    AND NOT EXISTS (
      SELECT 1 FROM "Event" e WHERE e."ledgerSequence" = l.sequence
    )
    ORDER BY l.sequence
    LIMIT ${limit}
  `;
  return rows.map((r) => r.sequence);
}

// ─── Repair job ───────────────────────────────────────────────────────────────

/**
 * Backfill a list of individual ledger sequences by grouping them into
 * contiguous chunks and calling processLedgerRange for each chunk.
 * Errors are logged per-chunk and do not abort the remaining work.
 */
async function backfill(sequences: number[]): Promise<void> {
  if (sequences.length === 0) return;

  // Group consecutive sequences into ranges to minimise RPC round-trips
  const ranges: Array<[number, number]> = [];
  let rangeStart = sequences[0];
  let prev = sequences[0];

  for (let i = 1; i < sequences.length; i++) {
    if (sequences[i] === prev + 1) {
      prev = sequences[i];
    } else {
      ranges.push([rangeStart, prev]);
      rangeStart = sequences[i];
      prev = sequences[i];
    }
  }
  ranges.push([rangeStart, prev]);

  for (const [start, end] of ranges) {
    try {
      console.log(`[repair] backfilling ledgers ${start}–${end}`);
      await processLedgerRange(start, end);
    } catch (err) {
      console.error(`[repair] backfill failed for ${start}–${end}:`, err);
    }
  }
}

// ─── Sweep ────────────────────────────────────────────────────────────────────

/**
 * One full sweep pass:
 *   1. Determine the indexed range from IndexerState + Ledger table bounds.
 *   2. Find and repair hard gaps (missing sequences).
 *   3. Find and repair soft gaps (empty ledger rows).
 *
 * Returns counts of sequences repaired.
 */
export interface RepairSweepOptions {
  dryRun?: boolean;
  fromSeq?: number;
  toSeq?: number;
}

export async function runRepairSweep(
  opts?: RepairSweepOptions,
): Promise<{ hardGaps: number; softGaps: number }> {
  const dryRun = opts?.dryRun ?? false;

  let minSeq: number | null = opts?.fromSeq ?? null;
  let maxSeq: number | null = opts?.toSeq ?? null;

  if (minSeq === null || maxSeq === null) {
    const bounds = await prisma.ledger.aggregate({
      _min: { sequence: true },
      _max: { sequence: true },
    });
    if (minSeq === null) minSeq = bounds._min.sequence;
    if (maxSeq === null) maxSeq = bounds._max.sequence;
  }

  if (minSeq === null || maxSeq === null) {
    console.log('[repair] No ledgers indexed yet — nothing to sweep.');
    return { hardGaps: 0, softGaps: 0 };
  }

  // Cap the sweep window unless an explicit upper bound was supplied
  const sweepMax =
    opts?.toSeq !== undefined ? maxSeq : Math.min(maxSeq, minSeq + MAX_EMPTY_BATCH * 10);

  console.log(`[repair] Sweeping ledgers ${minSeq}–${sweepMax}${dryRun ? ' (dry-run)' : ''}`);

  // 1. Hard gaps
  const missing = await findMissingSequences(minSeq, sweepMax, REPAIR_CHUNK);
  if (missing.length > 0) {
    console.log(`[repair] Found ${missing.length} missing sequence(s)`);
    if (!dryRun) await backfill(missing);
  }

  // 2. Soft gaps
  const empty = await findEmptyLedgers(REPAIR_CHUNK);
  if (empty.length > 0) {
    console.log(`[repair] Found ${empty.length} empty ledger(s)`);
    if (!dryRun) await backfill(empty);
  }

  console.log(
    `[repair] Sweep complete — hard: ${missing.length}, soft: ${empty.length}` +
      (dryRun ? ' (no changes written — dry-run)' : ''),
  );
  return { hardGaps: missing.length, softGaps: empty.length };
}

// ─── Continuous loop ──────────────────────────────────────────────────────────

/**
 * Run the repair sweep on a fixed interval until the process is killed.
 * Designed to run as a separate process alongside the live indexer.
 */
export async function startRepairLoop(): Promise<void> {
  console.log(
    `[repair] Starting background repair loop ` +
      `(interval=${SWEEP_INTERVAL_MS}ms, chunk=${REPAIR_CHUNK}, network=${config.stellarNetwork})`,
  );

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await runRepairSweep();
    } catch (err) {
      console.error('[repair] Sweep error:', err);
    }
    await sleep(SWEEP_INTERVAL_MS);
  }
}
