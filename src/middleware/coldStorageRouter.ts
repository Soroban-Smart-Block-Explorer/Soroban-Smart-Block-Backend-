import { Request, Response, NextFunction } from 'express';
import { readFile, readdir, access, constants } from 'fs/promises';
import { gunzip as gunzipCb } from 'zlib';
import { promisify } from 'util';
import * as path from 'path';
import { Histogram, Counter, Gauge, register } from 'prom-client';
import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  RestoreObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { AppError } from './errorHandler';
import { logger } from '../logger';
import * as parquetjs from 'parquetjs-lite';

const RECENT_LEDGER_DAYS = parseInt(process.env.RECENT_LEDGER_DAYS ?? '30');
const RECENT_LEDGER_THRESHOLD = Math.floor(
  (Date.now() - RECENT_LEDGER_DAYS * 24 * 60 * 60 * 1000) / 1000,
);

interface ColdStorageConfig {
  recentThresholdSeconds: number;
  coldStorageType: 'parquet' | 'glacier' | 'archive';
  coldStoragePath?: string;
}

const coldStorageConfig: ColdStorageConfig = {
  recentThresholdSeconds: RECENT_LEDGER_THRESHOLD,
  coldStorageType:
    (process.env.COLD_STORAGE_TYPE as 'parquet' | 'glacier' | 'archive') ?? 'parquet',
  coldStoragePath: process.env.COLD_STORAGE_PATH,
};

const PARQUET_DIR = process.env.PARQUET_DIR ?? process.env.COLD_STORAGE_PATH ?? './data/parquet';
const ARCHIVE_DIR = process.env.ARCHIVE_DIR ?? process.env.COLD_STORAGE_PATH ?? './data/archive';
const S3_BUCKET = process.env.ARCHIVE_S3_BUCKET ?? 'soroban-xdr-archive';
const S3_PREFIX = process.env.COLD_S3_PREFIX ?? 'cold';

const L2_CACHE_TTL_MS = parseInt(process.env.COLD_L2_CACHE_TTL_MS ?? '3600000');
const L2_CACHE_MAX_SIZE = parseInt(process.env.COLD_L2_CACHE_SIZE ?? '1000');
const CB_THRESHOLD = parseInt(process.env.COLD_CB_THRESHOLD ?? '3');
const CB_COOLDOWN_MS = parseInt(process.env.COLD_CB_COOLDOWN_MS ?? '30000');
const COLD_READ_TIMEOUT_MS = parseInt(process.env.COLD_READ_TIMEOUT_MS ?? '2000');
const ARCHIVE_INDEX_PATH = process.env.ARCHIVE_INDEX_PATH ?? path.join(ARCHIVE_DIR, 'index.json');

const s3 = new S3Client({
  region: process.env.AWS_REGION ?? 'us-east-1',
  ...(process.env.AWS_ENDPOINT_URL ? { endpoint: process.env.AWS_ENDPOINT_URL } : {}),
});

export { coldStorageConfig };

// ── Prometheus metrics ────────────────────────────────────────────────

const coldStorageLatency = new Histogram({
  name: 'cold_storage_read_duration_seconds',
  help: 'Latency of cold storage reads per tier',
  labelNames: ['tier', 'data_type', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [register],
});

const coldStorageErrors = new Counter({
  name: 'cold_storage_errors_total',
  help: 'Total cold storage errors by tier',
  labelNames: ['tier', 'error_type'],
  registers: [register],
});

const coldStorageCircuitBreakerState = new Gauge({
  name: 'cold_storage_circuit_breaker_state',
  help: 'Circuit breaker state per tier: 0=closed 1=open 2=half-open',
  labelNames: ['tier'],
  registers: [register],
});

const coldStorageL2CacheHits = new Counter({
  name: 'cold_storage_l2_cache_hits_total',
  help: 'L2 cache hits',
  labelNames: ['tier'],
  registers: [register],
});

const coldStorageL2CacheMisses = new Counter({
  name: 'cold_storage_l2_cache_misses_total',
  help: 'L2 cache misses',
  labelNames: ['tier'],
  registers: [register],
});

const coldStorageL2CacheSize = new Gauge({
  name: 'cold_storage_l2_cache_entries',
  help: 'Number of entries in L2 cache',
  registers: [register],
});

// ── L2 Cache ──────────────────────────────────────────────────────────

interface L2CacheEntry {
  data: any[];
  expiresAt: number;
}

class L2Cache {
  private store = new Map<string, L2CacheEntry>();
  private hits = 0;
  private misses = 0;

  get(tier: string, key: string): any[] | null {
    const entry = this.store.get(key);
    if (!entry) {
      this.misses++;
      coldStorageL2CacheMisses.inc({ tier });
      return null;
    }
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      this.misses++;
      coldStorageL2CacheMisses.inc({ tier });
      return null;
    }
    this.hits++;
    coldStorageL2CacheHits.inc({ tier });
    return entry.data;
  }

  set(key: string, data: any[]): void {
    if (this.store.size >= L2_CACHE_MAX_SIZE) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { data, expiresAt: Date.now() + L2_CACHE_TTL_MS });
    coldStorageL2CacheSize.set(this.store.size);
  }

  hitRate(): number {
    const total = this.hits + this.misses;
    return total === 0 ? 1 : this.hits / total;
  }
}

const l2Cache = new L2Cache();

// ── Circuit Breaker ───────────────────────────────────────────────────

type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface BreakerState {
  state: CircuitState;
  failures: number;
  lastFailure: number;
}

const breakerStates = new Map<string, BreakerState>();

function getBreaker(tier: string): BreakerState {
  if (!breakerStates.has(tier)) {
    breakerStates.set(tier, { state: 'CLOSED', failures: 0, lastFailure: 0 });
  }
  return breakerStates.get(tier)!;
}

function recordSuccess(tier: string): void {
  const b = getBreaker(tier);
  b.failures = 0;
  b.state = 'CLOSED';
  coldStorageCircuitBreakerState.set({ tier }, 0);
}

function recordFailure(tier: string): void {
  const b = getBreaker(tier);
  b.failures++;
  b.lastFailure = Date.now();
  if (b.failures >= CB_THRESHOLD) {
    b.state = 'OPEN';
    coldStorageCircuitBreakerState.set({ tier }, 1);
    logger.warn('[ColdStorage] Circuit breaker opened', { tier, failures: b.failures });
  }
}

function isCircuitOpen(tier: string): boolean {
  const b = getBreaker(tier);
  if (b.state === 'CLOSED') return false;
  if (b.state === 'OPEN' && Date.now() - b.lastFailure > CB_COOLDOWN_MS) {
    b.state = 'HALF_OPEN';
    coldStorageCircuitBreakerState.set({ tier }, 2);
    return false;
  }
  return true;
}

// ── Archive Index ─────────────────────────────────────────────────────

interface ArchiveIndex {
  version: number;
  entries: Record<number, { path: string; compression: 'gzip' | 'none' | 'zstd' }>;
}

class ArchiveIndexManager {
  private index: ArchiveIndex = { version: 1, entries: {} };
  private loaded = false;

  async load(): Promise<void> {
    try {
      const raw = await readFile(ARCHIVE_INDEX_PATH, 'utf-8');
      this.index = JSON.parse(raw);
      this.loaded = true;
      logger.info('[ColdStorage] Archive index loaded', {
        entries: Object.keys(this.index.entries).length,
      });
    } catch {
      this.loaded = true;
      logger.info('[ColdStorage] No archive index found, scanning directory');
      await this.scanAndBuild();
    }
  }

  private async scanAndBuild(): Promise<void> {
    try {
      const entries: Record<number, { path: string; compression: 'gzip' | 'none' | 'zstd' }> = {};
      const dataTypes = ['transactions', 'events'];
      for (const dt of dataTypes) {
        const dir = path.join(ARCHIVE_DIR, dt);
        try {
          const files = await readdir(dir);
          for (const file of files) {
            const match = file.match(/^(\d+)\.(json|json\.gz|json\.zst)$/);
            if (match) {
              const seq = parseInt(match[1], 10);
              const ext = match[2];
              const compression = ext === 'json.gz' ? 'gzip' : ext === 'json.zst' ? 'zstd' : 'none';
              entries[seq] = { path: path.join(dir, file), compression };
            }
          }
        } catch {
          /* dir may not exist */
        }
      }
      this.index = { version: 1, entries };
      await this.save();
    } catch (err) {
      logger.error('[ColdStorage] Failed to scan archive directory', { error: String(err) });
    }
  }

  private async save(): Promise<void> {
    try {
      const { mkdir, writeFile } = await import('fs/promises');
      await mkdir(path.dirname(ARCHIVE_INDEX_PATH), { recursive: true });
      await writeFile(ARCHIVE_INDEX_PATH, JSON.stringify(this.index, null, 2));
    } catch {
      /* best effort */
    }
  }

  lookup(ledgerSeq: number): { path: string; compression: 'gzip' | 'none' | 'zstd' } | null {
    return this.index.entries[ledgerSeq] ?? null;
  }
}

const archiveIndex = new ArchiveIndexManager();

// ── Parquet Schema Registry ───────────────────────────────────────────

interface SchemaField {
  name: string;
  type: string;
  required: boolean;
}

interface SchemaDefinition {
  version: number;
  fields: SchemaField[];
}

const PARQUET_SCHEMAS: SchemaDefinition[] = [
  {
    version: 1,
    fields: [
      { name: 'hash', type: 'UTF8', required: true },
      { name: 'ledgerSequence', type: 'INT32', required: true },
      { name: 'ledgerCloseTime', type: 'UTF8', required: true },
      { name: 'sourceAccount', type: 'UTF8', required: false },
      { name: 'contractAddress', type: 'UTF8', required: false },
      { name: 'functionName', type: 'UTF8', required: false },
      { name: 'functionArgs', type: 'UTF8', required: false },
      { name: 'status', type: 'UTF8', required: false },
      { name: 'feeCharged', type: 'UTF8', required: false },
      { name: 'humanReadable', type: 'UTF8', required: false },
    ],
  },
  {
    version: 2,
    fields: [
      { name: 'hash', type: 'UTF8', required: true },
      { name: 'ledgerSequence', type: 'INT32', required: true },
      { name: 'ledgerCloseTime', type: 'UTF8', required: true },
      { name: 'sourceAccount', type: 'UTF8', required: false },
      { name: 'contractAddress', type: 'UTF8', required: false },
      { name: 'functionName', type: 'UTF8', required: false },
      { name: 'functionArgs', type: 'UTF8', required: false },
      { name: 'status', type: 'UTF8', required: false },
      { name: 'feeCharged', type: 'UTF8', required: false },
      { name: 'humanReadable', type: 'UTF8', required: false },
      { name: 'sorobanResources', type: 'UTF8', required: false },
      { name: 'failureReason', type: 'UTF8', required: false },
    ],
  },
];

function getSchemaVersion(filePath: string): number {
  const match = path.basename(filePath).match(/v(\d+)\.parquet$/);
  return match ? parseInt(match[1], 10) : 1;
}

function validateAgainstSchema(records: any[], version: number): any[] {
  const schema =
    PARQUET_SCHEMAS.find((s) => s.version === version) ??
    PARQUET_SCHEMAS[PARQUET_SCHEMAS.length - 1];
  const requiredFields = schema.fields.filter((f) => f.required).map((f) => f.name);
  return records.filter((r) => requiredFields.every((f) => r[f] !== undefined && r[f] !== null));
}

// ── Parquet Reader ────────────────────────────────────────────────────

function findParquetFile(ledgerSeq: number, dataType: string): string | null {
  const baseDir = path.join(PARQUET_DIR, dataType);
  const RANGE_SIZE = parseInt(process.env.PARQUET_RANGE_SIZE ?? '10000');
  const rangeStart = Math.floor(ledgerSeq / RANGE_SIZE) * RANGE_SIZE;
  const rangeEnd = rangeStart + RANGE_SIZE - 1;
  const paddedStart = String(rangeStart).padStart(7, '0');
  const paddedEnd = String(rangeEnd).padStart(7, '0');
  const patterns = [
    path.join(baseDir, `ledger_${paddedStart}_${paddedEnd}.parquet`),
    path.join(baseDir, `ledger_${rangeStart}_${rangeEnd}.parquet`),
    path.join(baseDir, `ledger_${paddedStart}_${paddedEnd}_v2.parquet`),
    path.join(baseDir, `ledger_${rangeStart}_${rangeEnd}_v2.parquet`),
  ];
  for (const fp of patterns) {
    try {
      access(fp, constants.R_OK);
      return fp;
    } catch {
      continue;
    }
  }
  return null;
}

async function readParquetFile(filePath: string, ledgerSeq: number): Promise<any[]> {
  let parquetReader: any;
  try {
    parquetReader = await parquetjs.ParquetReader.openFile(filePath);
    const schemaVersion = getSchemaVersion(filePath);
    const cursor = parquetReader.getCursor();
    const rows: any[] = [];
    let row: any;
    while ((row = await cursor.next()) !== null) {
      rows.push(row);
    }
    const filtered = rows.filter((r: any) => Number(r.ledgerSequence) === ledgerSeq);
    const validated = validateAgainstSchema(filtered, schemaVersion);
    return validated;
  } finally {
    if (parquetReader?.close) {
      try {
        await parquetReader.close();
      } catch {
        /* ignore */
      }
    }
  }
}

// ── Glacier / S3 Reader ───────────────────────────────────────────────

function buildS3Key(ledgerSeq: number, dataType: string): string {
  return `${S3_PREFIX}/${dataType}/${ledgerSeq}.json`;
}

async function initiateGlacierRestore(key: string): Promise<void> {
  await s3.send(
    new RestoreObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      RestoreRequest: {
        Days: 7,
        GlacierJobParameters: { Tier: 'Standard' },
      },
    }),
  );
  logger.info('[ColdStorage] Glacier restore initiated', { key });
}

async function pollRestoreComplete(key: string, maxRetries = 30): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    const head = await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    const restoreStatus = head.Restore;
    if (restoreStatus && restoreStatus.includes('ongoing-request="false"')) {
      return;
    }
    const delay = Math.min(1000 * Math.pow(1.5, i), 30000);
    await new Promise((r) => setTimeout(r, delay));
  }
  throw new AppError(503, 'Glacier restore did not complete within timeout');
}

async function readFromS3(key: string): Promise<any[]> {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    const storageClass = head.StorageClass ?? 'STANDARD';
    if (storageClass === 'GLACIER' || storageClass === 'DEEP_ARCHIVE') {
      const restoreStatus = head.Restore;
      if (!restoreStatus || restoreStatus.includes('ongoing-request="true"')) {
        await initiateGlacierRestore(key);
        await pollRestoreComplete(key);
      }
    }
    const res = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    const body = await res.Body!.transformToString();
    return JSON.parse(body);
  } catch (err: any) {
    if (err.name === 'NoSuchKey') {
      return [];
    }
    if (err.name === 'InvalidObjectState') {
      await initiateGlacierRestore(key);
      await pollRestoreComplete(key);
      const res = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
      const body = await res.Body!.transformToString();
      return JSON.parse(body);
    }
    throw err;
  }
}

async function _listS3ObjectsByPrefix(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const result = await s3.send(
      new ListObjectsV2Command({
        Bucket: S3_BUCKET,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    if (result.Contents) {
      for (const obj of result.Contents) {
        if (obj.Key) keys.push(obj.Key);
      }
    }
    continuationToken = result.NextContinuationToken;
  } while (continuationToken);
  return keys;
}

// ── Archive Reader (local) ─────────────────────────────────────────────

const gunzipAsync = promisify(gunzipCb);

async function decompressGzip(buffer: Buffer): Promise<Buffer> {
  return gunzipAsync(buffer);
}

async function readArchiveFile(
  filePath: string,
  compression: 'gzip' | 'none' | 'zstd',
): Promise<any[]> {
  const raw = await readFile(filePath);
  let data: Buffer;
  if (compression === 'gzip') {
    data = await decompressGzip(raw);
  } else if (compression === 'zstd') {
    try {
      const init = (globalThis as any).ZstdInit;
      if (init) {
        const zstd = await init();
        data = Buffer.from(zstd.decompress(raw));
      } else {
        throw new Error('zstd not available, falling back to gzip');
      }
    } catch {
      data = await decompressGzip(raw);
    }
  } else {
    data = raw;
  }
  return JSON.parse(data.toString('utf-8'));
}

// ── fetchFromColdStorage (exported) ───────────────────────────────────

async function fetchWithCircuitBreaker<T>(
  tier: string,
  fn: () => Promise<T>,
  timeoutMs: number = COLD_READ_TIMEOUT_MS,
): Promise<T> {
  if (isCircuitOpen(tier)) {
    coldStorageErrors.inc({ tier, error_type: 'circuit_open' });
    throw new AppError(503, `Cold storage ${tier} is unavailable (circuit breaker open)`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(new AppError(503, `Cold storage ${tier} read timed out after ${timeoutMs}ms`));
        });
      }),
    ]);
    recordSuccess(tier);
    return result;
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 503) {
      recordFailure(tier);
      throw err;
    }
    if (!(err instanceof AppError)) {
      recordFailure(tier);
      coldStorageErrors.inc({ tier, error_type: 'error' });
      throw new AppError(503, `Cold storage ${tier} read failed: ${(err as Error).message}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFromParquet(ledgerSeq: number, dataType: string): Promise<any[]> {
  const cacheKey = `parquet:${dataType}:${ledgerSeq}`;
  const cached = l2Cache.get('parquet', cacheKey);
  if (cached) return cached;

  const filePath = findParquetFile(ledgerSeq, dataType);
  if (!filePath) {
    logger.debug('[ColdStorage] No parquet file found', { ledgerSeq, dataType });
    return [];
  }
  const data = await readParquetFile(filePath, ledgerSeq);
  l2Cache.set(cacheKey, data);
  return data;
}

async function fetchFromGlacier(ledgerSeq: number, dataType: string): Promise<any[]> {
  const cacheKey = `glacier:${dataType}:${ledgerSeq}`;
  const cached = l2Cache.get('glacier', cacheKey);
  if (cached) return cached;

  const key = buildS3Key(ledgerSeq, dataType);
  const data = await readFromS3(key);
  l2Cache.set(cacheKey, data);
  return data;
}

async function fetchFromArchive(ledgerSeq: number, dataType: string): Promise<any[]> {
  const cacheKey = `archive:${dataType}:${ledgerSeq}`;
  const cached = l2Cache.get('archive', cacheKey);
  if (cached) return cached;

  const entry = archiveIndex.lookup(ledgerSeq);
  if (!entry) {
    const dirPath = path.join(ARCHIVE_DIR, dataType);
    const filePath = path.join(dirPath, `${ledgerSeq}.json`);
    try {
      await access(filePath, constants.R_OK);
      const data = await readArchiveFile(filePath, 'none');
      l2Cache.set(cacheKey, data);
      return data;
    } catch {
      const gzPath = path.join(dirPath, `${ledgerSeq}.json.gz`);
      try {
        await access(gzPath, constants.R_OK);
        const data = await readArchiveFile(gzPath, 'gzip');
        l2Cache.set(cacheKey, data);
        return data;
      } catch {
        logger.debug('[ColdStorage] No archive file found', { ledgerSeq, dataType });
        return [];
      }
    }
  }
  const data = await readArchiveFile(entry.path, entry.compression);
  l2Cache.set(cacheKey, data);
  return data;
}

export async function fetchFromColdStorage(
  storageType: string,
  ledgerSeq: number,
  dataType: 'transactions' | 'events',
): Promise<any[]> {
  const startTime = Date.now();
  logger.info('[ColdStorage] Fetching data', { storageType, ledgerSeq, dataType });

  try {
    const tiers =
      storageType === 'all'
        ? (['parquet', 'glacier', 'archive'] as const)
        : ([storageType] as const);

    const fetchers = tiers.map((tier) => {
      const fn = async () => {
        switch (tier) {
          case 'parquet':
            return fetchFromParquet(ledgerSeq, dataType);
          case 'glacier':
            return fetchFromGlacier(ledgerSeq, dataType);
          case 'archive':
            return fetchFromArchive(ledgerSeq, dataType);
          default:
            return [] as any[];
        }
      };
      return fetchWithCircuitBreaker(tier, fn);
    });

    if (tiers.length === 1) {
      const result = await fetchers[0];
      coldStorageLatency.observe(
        { tier: tiers[0], data_type: dataType, status: 'success' },
        (Date.now() - startTime) / 1000,
      );
      return result;
    }

    const results = await Promise.allSettled(fetchers);
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.length > 0) {
        coldStorageLatency.observe(
          { tier: 'all', data_type: dataType, status: 'success' },
          (Date.now() - startTime) / 1000,
        );
        return r.value;
      }
    }
    coldStorageLatency.observe(
      { tier: 'all', data_type: dataType, status: 'empty' },
      (Date.now() - startTime) / 1000,
    );
    return [];
  } catch (err) {
    coldStorageLatency.observe(
      { tier: storageType, data_type: dataType, status: 'error' },
      (Date.now() - startTime) / 1000,
    );
    if (err instanceof AppError) throw err;
    throw new AppError(503, `Cold storage read failed: ${(err as Error).message}`);
  }
}

export async function fetchFromAllTiers(
  ledgerSeq: number,
  dataType: 'transactions' | 'events',
): Promise<any[]> {
  return fetchFromColdStorage('all', ledgerSeq, dataType);
}

// ── Express middleware ─────────────────────────────────────────────────

export function coldStorageRouter(req: Request, res: Response, next: NextFunction): void {
  const ledgerSeq = extractLedgerSequence(req);
  if (!ledgerSeq) {
    return next();
  }

  const isDeepHistory = ledgerSeq < coldStorageConfig.recentThresholdSeconds;

  if (isDeepHistory) {
    req.coldStorage = {
      enabled: true,
      type: coldStorageConfig.coldStorageType,
      path: coldStorageConfig.coldStoragePath,
      ledgerSeq,
    };
    res.set('Cache-Control', 'public, max-age=31536000');
    res.set('X-Storage-Tier', 'cold');
  } else {
    res.set('Cache-Control', 'public, max-age=300');
    res.set('X-Storage-Tier', 'hot');
  }

  next();
}

export function getColdStorageConfig(): ColdStorageConfig {
  return coldStorageConfig;
}

export function isColdStorageRequest(req: Request): boolean {
  return req.coldStorage?.enabled ?? false;
}

export function getColdStorageType(req: Request): string {
  return req.coldStorage?.type ?? 'hot';
}

function extractLedgerSequence(req: Request): number | null {
  const pathSeq = req.params.sequence || req.params.ledger;
  if (pathSeq && !isNaN(Number(pathSeq))) {
    return Number(pathSeq);
  }
  const querySeq = req.query.ledger || req.query.ledgerSeq || req.query.sequence;
  if (querySeq && !isNaN(Number(querySeq))) {
    return Number(querySeq);
  }
  return null;
}

export async function initializeColdStorage(): Promise<void> {
  await archiveIndex.load();
  logger.info('[ColdStorage] Initialized', {
    parquetDir: PARQUET_DIR,
    archiveDir: ARCHIVE_DIR,
    s3Bucket: S3_BUCKET,
    l2CacheSize: L2_CACHE_MAX_SIZE,
    circuitBreakerThreshold: CB_THRESHOLD,
  });
}
