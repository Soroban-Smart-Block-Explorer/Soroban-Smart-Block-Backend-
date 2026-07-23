import { Request, Response, NextFunction } from 'express';

const RECENT_LEDGER_COUNT = parseInt(process.env.RECENT_LEDGER_COUNT ?? '10000');
let currentLedger = 0;

interface ColdStorageConfig {
  recentLedgerCount: number;
  coldStorageType: 'parquet' | 'glacier' | 'archive';
  coldStoragePath?: string;
}

const coldStorageConfig: ColdStorageConfig = {
  recentLedgerCount: RECENT_LEDGER_COUNT,
  coldStorageType:
    (process.env.COLD_STORAGE_TYPE as 'parquet' | 'glacier' | 'archive') ?? 'parquet',
  coldStoragePath: process.env.COLD_STORAGE_PATH,
};

function getRecentLedgerThreshold(): number {
  return Math.max(0, currentLedger - coldStorageConfig.recentLedgerCount);
}

export function setCurrentLedger(ledger: number): void {
  currentLedger = ledger;
}

export function coldStorageRouter(req: Request, res: Response, next: NextFunction): void {
  // Extract ledger sequence from query or path
  const ledgerSeq = extractLedgerSequence(req);
  if (!ledgerSeq) {
    return next();
  }

  // Check if this is a deep history request
  const isDeepHistory = currentLedger > 0 && ledgerSeq < getRecentLedgerThreshold();

  if (isDeepHistory) {
    // Mark request for cold storage routing
    req.coldStorage = {
      enabled: true,
      type: coldStorageConfig.coldStorageType,
      path: coldStorageConfig.coldStoragePath,
      ledgerSeq,
    };

    // Add cache headers for cold storage (longer TTL)
    res.set('Cache-Control', 'public, max-age=31536000'); // 1 year
    res.set('X-Storage-Tier', 'cold');
  } else {
    // Recent ledger — use hot storage (main DB)
    res.set('Cache-Control', 'public, max-age=300'); // 5 minutes
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
  // Try path params: /api/v1/transactions/:hash or /api/v1/ledgers/:sequence
  const pathSeq = req.params.sequence || req.params.ledger;
  if (pathSeq && !isNaN(Number(pathSeq))) {
    return Number(pathSeq);
  }

  // Try query params: ?ledger=123 or ?ledgerSeq=123
  const querySeq = req.query.ledger || req.query.ledgerSeq || req.query.sequence;
  if (querySeq && !isNaN(Number(querySeq))) {
    return Number(querySeq);
  }

  // Try from transaction hash lookup (would need DB query, skip for now)
  return null;
}

/**
 * Fetch data from cold storage (Parquet, Glacier, etc.)
 * In production, this would interface with S3, GCS, or local Parquet files
 */
export async function fetchFromColdStorage(
  storageType: string,
  ledgerSeq: number,
  dataType: 'transactions' | 'events',
): Promise<any[]> {
  console.log(`[ColdStorage] Fetching ${dataType} for ledger ${ledgerSeq} from ${storageType}`);

  switch (storageType) {
    case 'parquet':
      return fetchFromParquet(ledgerSeq, dataType);
    case 'glacier':
      return fetchFromGlacier(ledgerSeq, dataType);
    case 'archive':
      return fetchFromArchive(ledgerSeq, dataType);
    default:
      throw new Error(`Unknown cold storage type: ${storageType}`);
  }
}

async function fetchFromParquet(ledgerSeq: number, dataType: string): Promise<any[]> {
  // In production: use parquetjs or arrow to read Parquet files
  // For now, return empty array (would be populated from actual Parquet store)
  console.log(`[ColdStorage] Reading ${dataType} from Parquet for ledger ${ledgerSeq}`);
  return [];
}

async function fetchFromGlacier(ledgerSeq: number, dataType: string): Promise<any[]> {
  // In production: use AWS SDK to retrieve from Glacier
  // This would typically be async and require job submission
  console.log(`[ColdStorage] Retrieving ${dataType} from Glacier for ledger ${ledgerSeq}`);
  return [];
}

async function fetchFromArchive(ledgerSeq: number, dataType: string): Promise<any[]> {
  // In production: read from local archive storage or tape
  console.log(`[ColdStorage] Reading ${dataType} from archive for ledger ${ledgerSeq}`);
  return [];
}
