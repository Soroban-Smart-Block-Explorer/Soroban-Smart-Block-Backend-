/**
 * Verifies issue #631: cold storage fetchers return real data
 * (not empty stub arrays) from Parquet, Glacier/S3, and local archive.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { gzipSync } from 'zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ParquetSchema, ParquetWriter } from 'parquetjs-lite';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-fetch-'));
const parquetDir = path.join(tmpRoot, 'parquet');
const archiveDir = path.join(tmpRoot, 'archive');

process.env.PARQUET_DIR = parquetDir;
process.env.ARCHIVE_DIR = archiveDir;
process.env.ARCHIVE_INDEX_PATH = path.join(archiveDir, 'index.json');
process.env.COLD_READ_TIMEOUT_MS = '10000';
process.env.COLD_CB_THRESHOLD = '10';
process.env.COLD_S3_PREFIX = 'cold';
process.env.ARCHIVE_S3_BUCKET = 'test-cold-bucket';
process.env.AWS_REGION = 'us-east-1';

const { s3Send } = vi.hoisted(() => ({
  s3Send: vi.fn(),
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(() => ({ send: s3Send })),
  GetObjectCommand: vi.fn((input: unknown) => ({ __type: 'GetObject', input })),
  HeadObjectCommand: vi.fn((input: unknown) => ({ __type: 'HeadObject', input })),
  RestoreObjectCommand: vi.fn((input: unknown) => ({ __type: 'RestoreObject', input })),
  ListObjectsV2Command: vi.fn((input: unknown) => ({ __type: 'ListObjectsV2', input })),
}));

vi.mock('../src/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/middleware/errorHandler', () => {
  class AppError extends Error {
    statusCode: number;
    constructor(statusCode: number, message: string) {
      super(message);
      this.name = 'AppError';
      this.statusCode = statusCode;
    }
  }
  return { AppError };
});

vi.mock('prom-client', () => {
  const make = () => ({ observe: vi.fn(), inc: vi.fn(), set: vi.fn() });
  return {
    Histogram: vi.fn(make),
    Counter: vi.fn(make),
    Gauge: vi.fn(make),
    register: { registerMetric: vi.fn() },
  };
});

type ColdStorageModule = typeof import('../src/middleware/coldStorageRouter');

let fetchFromColdStorage: ColdStorageModule['fetchFromColdStorage'];
let initializeColdStorage: ColdStorageModule['initializeColdStorage'];
let __resetColdStorageStateForTests: ColdStorageModule['__resetColdStorageStateForTests'];

const LEDGER = 42_000;
const SAMPLE_TX = {
  hash: 'abc123',
  ledgerSequence: LEDGER,
  ledgerCloseTime: '2024-01-01T00:00:00Z',
  sourceAccount: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
  contractAddress: 'CCONTRACTADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  functionName: 'transfer',
  functionArgs: '[]',
  status: 'SUCCESS',
  feeCharged: '100',
  humanReadable: 'transfer()',
};

async function writeParquetFixture(): Promise<void> {
  const dir = path.join(parquetDir, 'transactions');
  fs.mkdirSync(dir, { recursive: true });
  const rangeStart = Math.floor(LEDGER / 10000) * 10000;
  const rangeEnd = rangeStart + 9999;
  const filePath = path.join(
    dir,
    `ledger_${String(rangeStart).padStart(7, '0')}_${String(rangeEnd).padStart(7, '0')}.parquet`,
  );

  const schema = new ParquetSchema({
    hash: { type: 'UTF8' },
    ledgerSequence: { type: 'INT32' },
    ledgerCloseTime: { type: 'UTF8' },
    sourceAccount: { type: 'UTF8', optional: true },
    contractAddress: { type: 'UTF8', optional: true },
    functionName: { type: 'UTF8', optional: true },
    functionArgs: { type: 'UTF8', optional: true },
    status: { type: 'UTF8', optional: true },
    feeCharged: { type: 'UTF8', optional: true },
    humanReadable: { type: 'UTF8', optional: true },
  });

  const writer = await ParquetWriter.openFile(schema, filePath);
  await writer.appendRow(SAMPLE_TX);
  await writer.appendRow({
    ...SAMPLE_TX,
    hash: 'other',
    ledgerSequence: LEDGER + 1,
  });
  await writer.close();
}

async function writeArchiveFixture(): Promise<void> {
  const dir = path.join(archiveDir, 'events');
  fs.mkdirSync(dir, { recursive: true });
  const payload = [
    { id: 'evt-1', ledgerSequence: LEDGER, type: 'contract' },
    { id: 'evt-2', ledgerSequence: LEDGER, type: 'diagnostic' },
  ];
  fs.writeFileSync(path.join(dir, `${LEDGER}.json`), JSON.stringify(payload));

  const gzDir = path.join(archiveDir, 'transactions');
  fs.mkdirSync(gzDir, { recursive: true });
  fs.writeFileSync(path.join(gzDir, `${LEDGER}.json.gz`), gzipSync(JSON.stringify([SAMPLE_TX])));
}

beforeAll(async () => {
  await writeParquetFixture();
  await writeArchiveFixture();

  // Dynamic import AFTER env vars are set (static imports are hoisted).
  const cold = await import('../src/middleware/coldStorageRouter');
  fetchFromColdStorage = cold.fetchFromColdStorage;
  initializeColdStorage = cold.initializeColdStorage;
  __resetColdStorageStateForTests = cold.__resetColdStorageStateForTests;

  await initializeColdStorage();
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  __resetColdStorageStateForTests();
  s3Send.mockReset();
});

describe('fetchFromParquet (via fetchFromColdStorage)', () => {
  it('returns ledger rows from a real parquet file (not an empty stub)', async () => {
    const rows = await fetchFromColdStorage('parquet', LEDGER, 'transactions');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].hash).toBe(SAMPLE_TX.hash);
    expect(Number(rows[0].ledgerSequence)).toBe(LEDGER);
  });

  it('returns [] when no parquet file exists for the ledger range', async () => {
    const rows = await fetchFromColdStorage('parquet', 1, 'transactions');
    expect(rows).toEqual([]);
  });
});

describe('fetchFromGlacier (via fetchFromColdStorage)', () => {
  it('returns records from S3/Glacier when object is available', async () => {
    const body = JSON.stringify([SAMPLE_TX]);
    s3Send.mockImplementation(async (cmd: { __type?: string }) => {
      if (cmd.__type === 'HeadObject') {
        return { StorageClass: 'STANDARD' };
      }
      if (cmd.__type === 'GetObject') {
        return { Body: { transformToString: async () => body } };
      }
      throw new Error(`unexpected command ${cmd.__type}`);
    });

    const rows = await fetchFromColdStorage('glacier', LEDGER, 'transactions');
    expect(rows).toHaveLength(1);
    expect(rows[0].hash).toBe(SAMPLE_TX.hash);
  });

  it('returns [] when S3 HeadObject reports NotFound', async () => {
    s3Send.mockImplementation(async () => {
      const err = new Error('Not Found');
      (err as any).name = 'NotFound';
      (err as any).$metadata = { httpStatusCode: 404 };
      throw err;
    });

    const rows = await fetchFromColdStorage('glacier', LEDGER, 'transactions');
    expect(rows).toEqual([]);
  });

  it('initiates restore and returns 503 when object is in Glacier unrestored', async () => {
    s3Send.mockImplementation(async (cmd: { __type?: string }) => {
      if (cmd.__type === 'HeadObject') {
        return { StorageClass: 'GLACIER' };
      }
      if (cmd.__type === 'RestoreObject') {
        return {};
      }
      throw new Error(`unexpected command ${cmd.__type}`);
    });

    await expect(fetchFromColdStorage('glacier', LEDGER, 'transactions')).rejects.toMatchObject({
      name: 'AppError',
      statusCode: 503,
    });
    expect(s3Send.mock.calls.some((c) => c[0]?.__type === 'RestoreObject')).toBe(true);
  });
});

describe('fetchFromArchive (via fetchFromColdStorage)', () => {
  it('returns events from a local archive JSON file', async () => {
    const rows = await fetchFromColdStorage('archive', LEDGER, 'events');
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe('evt-1');
  });

  it('returns transactions from a gzipped archive file', async () => {
    const rows = await fetchFromColdStorage('archive', LEDGER, 'transactions');
    expect(rows).toHaveLength(1);
    expect(rows[0].hash).toBe(SAMPLE_TX.hash);
  });

  it('returns [] when archive file is missing', async () => {
    const rows = await fetchFromColdStorage('archive', 999_999_999, 'events');
    expect(rows).toEqual([]);
  });
});

describe('fetchFromColdStorage("all")', () => {
  it('returns first non-empty tier result', async () => {
    s3Send.mockImplementation(async () => {
      const err = new Error('Not Found');
      (err as any).name = 'NotFound';
      throw err;
    });

    const rows = await fetchFromColdStorage('all', LEDGER, 'transactions');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].hash).toBe(SAMPLE_TX.hash);
  });
});
