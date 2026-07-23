/**
 * CSV Export Worker
 *
 * Converts large transaction / event history tables into CSV files using
 * database cursor streaming so the full result set is never held in RAM.
 * Each export is tracked as an ExportJob row; the worker processes one job
 * at a time and writes the file incrementally.
 */

import fs from 'fs';
import path from 'path';
import { Writable } from 'stream';
import { Prisma } from '@prisma/client';
import { prismaRead, prismaWrite } from '../db';
import { config } from '../config';

function getExportDir(): string {
  return process.env.EXPORT_DIR ?? config.exportDir;
}

const BATCH_SIZE = 500; // rows fetched per DB round-trip

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

function escapeCsv(val: unknown): string {
  if (val === null || val === undefined) return '';
  const s = typeof val === 'object' ? JSON.stringify(val) : String(val);
  // Wrap in quotes if the value contains comma, quote, or newline
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowToCsv(headers: string[], obj: Record<string, unknown>): string {
  return headers.map((h) => escapeCsv(obj[h])).join(',');
}

// ---------------------------------------------------------------------------
// Export implementations
// ---------------------------------------------------------------------------

const TX_HEADERS = [
  'hash',
  'ledgerSequence',
  'ledgerCloseTime',
  'sourceAccount',
  'contractAddress',
  'functionName',
  'status',
  'humanReadable',
  'feeCharged',
  'createdAt',
];

const EVENT_HEADERS = [
  'id',
  'transactionHash',
  'contractAddress',
  'eventType',
  'topics',
  'data',
  'decoded',
  'ledgerSequence',
  'ledgerCloseTime',
  'createdAt',
];

async function streamTransactions(
  filters: Record<string, unknown>,
  out: Writable,
): Promise<number> {
  out.write(TX_HEADERS.join(',') + '\n');

  const where = buildTxWhere(filters);
  let cursor: string | undefined;
  let total = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const rows = await prismaRead.transaction.findMany({
      where,
      orderBy: [{ ledgerSequence: 'asc' }, { id: 'asc' }],
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: BATCH_SIZE,
    });

    if (rows.length === 0) break;

    for (const row of rows) {
      out.write(rowToCsv(TX_HEADERS, row as any) + '\n');
    }

    total += rows.length;
    cursor = rows[rows.length - 1].id;

    if (rows.length < BATCH_SIZE) break;
  }

  return total;
}

async function streamEvents(filters: Record<string, unknown>, out: Writable): Promise<number> {
  out.write(EVENT_HEADERS.join(',') + '\n');

  const where = buildEventWhere(filters);
  let cursor: string | undefined;
  let total = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const rows = await prismaRead.event.findMany({
      where,
      orderBy: [{ ledgerSequence: 'asc' }, { id: 'asc' }],
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: BATCH_SIZE,
    });

    if (rows.length === 0) break;

    for (const row of rows) {
      out.write(rowToCsv(EVENT_HEADERS, row as any) + '\n');
    }

    total += rows.length;
    cursor = rows[rows.length - 1].id;

    if (rows.length < BATCH_SIZE) break;
  }

  return total;
}

// ---------------------------------------------------------------------------
// Filter builders
// ---------------------------------------------------------------------------

function buildTxWhere(f: Record<string, unknown>) {
  const where: Record<string, unknown> = {};
  if (f.contract) where.contractAddress = String(f.contract);
  if (f.account) where.sourceAccount = String(f.account);
  if (f.status) where.status = String(f.status);
  if (f.ledgerMin !== undefined || f.ledgerMax !== undefined) {
    where.ledgerSequence = {
      ...(f.ledgerMin !== undefined && { gte: Number(f.ledgerMin) }),
      ...(f.ledgerMax !== undefined && { lte: Number(f.ledgerMax) }),
    };
  }
  return where;
}

function buildEventWhere(f: Record<string, unknown>) {
  const where: Record<string, unknown> = {};
  if (f.contract) where.contractAddress = String(f.contract);
  if (f.eventType) where.eventType = String(f.eventType);
  if (f.ledgerMin !== undefined || f.ledgerMax !== undefined) {
    where.ledgerSequence = {
      ...(f.ledgerMin !== undefined && { gte: Number(f.ledgerMin) }),
      ...(f.ledgerMax !== undefined && { lte: Number(f.ledgerMax) }),
    };
  }
  return where;
}

// ---------------------------------------------------------------------------
// Job runner
// ---------------------------------------------------------------------------

const WALLET_HISTORY_HEADERS = [
  'type',
  'hash',
  'ledgerSequence',
  'ledgerCloseTime',
  'contractAddress',
  'functionName',
  'status',
  'humanReadable',
  'feeCharged',
  'createdAt',
];

async function streamWalletHistory(
  filters: Record<string, unknown>,
  out: Writable,
): Promise<number> {
  const address = String(filters.account ?? '');
  if (!address) throw new Error('account filter is required for wallet history export');

  out.write(WALLET_HISTORY_HEADERS.join(',') + '\n');

  const where = {
    sourceAccount: address,
    ...((filters.ledgerMin !== undefined || filters.ledgerMax !== undefined) && {
      ledgerSequence: {
        ...(filters.ledgerMin !== undefined && { gte: Number(filters.ledgerMin) }),
        ...(filters.ledgerMax !== undefined && { lte: Number(filters.ledgerMax) }),
      },
    }),
  };

  let cursor: string | undefined;
  let total = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const rows = await prismaRead.transaction.findMany({
      where,
      orderBy: [{ ledgerSequence: 'asc' }, { id: 'asc' }],
      take: BATCH_SIZE,
      select: {
        id: true,
        hash: true,
        ledgerSequence: true,
        ledgerCloseTime: true,
        contractAddress: true,
        functionName: true,
        status: true,
        humanReadable: true,
        feeCharged: true,
        createdAt: true,
      },
    });

    if (rows.length === 0) break;

    for (const row of rows) {
      const record = { type: 'soroban', ...row };
      out.write(rowToCsv(WALLET_HISTORY_HEADERS, record as any) + '\n');
    }

    total += rows.length;
    cursor = rows[rows.length - 1].id;

    if (rows.length < BATCH_SIZE) break;
  }

  return total;
}

/**
 * Enqueue a new export job and return its id.
 */
export async function enqueueExport(
  exportType: 'transactions' | 'events' | 'wallet_history',
  filters: Record<string, unknown> = {},
  developerId: string,
): Promise<string> {
  const job = await prismaWrite.exportJob.create({
    data: {
      exportType,
      filters: filters as Prisma.InputJsonValue,
      status: 'pending',
      developerId,
    },
  });
  // Fire-and-forget; caller can poll job status
  runExportJob(job.id).catch((err) => console.error(`[csv-exporter] job ${job.id} failed:`, err));
  return job.id;
}

/**
 * Process a single export job to completion.
 */
export async function runExportJob(jobId: string): Promise<void> {
  const job = await prismaWrite.exportJob.findUnique({ where: { id: jobId } });
  if (!job || job.status !== 'pending') return;

  await prismaWrite.exportJob.update({ where: { id: jobId }, data: { status: 'running' } });

  try {
    const exportDir = getExportDir();
    fs.mkdirSync(exportDir, { recursive: true });
    const fileName = `${job.exportType}-${jobId}.csv`;
    const absPath = path.join(exportDir, fileName);
    const fileStream = fs.createWriteStream(absPath);

    const filters = (job.filters as Record<string, unknown>) ?? {};
    let rowCount: number;

    if (job.exportType === 'transactions') {
      rowCount = await streamTransactions(filters, fileStream);
    } else if (job.exportType === 'wallet_history') {
      rowCount = await streamWalletHistory(filters, fileStream);
    } else {
      rowCount = await streamEvents(filters, fileStream);
    }

    await new Promise<void>((resolve, reject) => {
      fileStream.end((err: Error | null | undefined) => (err ? reject(err) : resolve()));
    });

    await prismaWrite.exportJob.update({
      where: { id: jobId },
      data: { status: 'done', filePath: fileName, rowCount },
    });
  } catch (err) {
    await prismaWrite.exportJob.update({
      where: { id: jobId },
      data: { status: 'failed', errorMsg: String(err) },
    });
    throw err;
  }
}
