/**
 * Data Quality Checks & ETL Lineage Tracking
 *
 * After each ETL run this module:
 *   1. Verifies row counts match the PostgreSQL source
 *   2. Checks for nulls in key columns
 *   3. Validates foreign key relationships
 *   4. Tracks which ETL job produced which Parquet files (lineage)
 *   5. Emits structured quality alerts via logger
 */

import { prismaRead } from '../../db';
import { logger } from '../../logger';
import type { IcebergDataFile } from '../data-lake/iceberg-writer';

// ── Types ─────────────────────────────────────────────────────────────────────

export type QualityCheckSeverity = 'info' | 'warning' | 'critical';

export interface QualityCheckResult {
  checkName: string;
  passed: boolean;
  severity: QualityCheckSeverity;
  message: string;
  details: Record<string, unknown>;
  checkedAt: string;
}

export interface EtlLineageRecord {
  jobId: string;
  jobStartedAt: string;
  jobCompletedAt: string;
  sourceTables: string[];
  /** PostgreSQL transaction ID range ingested. */
  pgTxIdRange: { min: number; max: number };
  /** WAL LSN range ingested. */
  lsnRange: { min: string; max: string };
  outputFiles: IcebergDataFile[];
  rowsProduced: number;
  rowsRejected: number;
  qualityResults: QualityCheckResult[];
  status: 'success' | 'partial' | 'failed';
}

// ── In-memory lineage store (backed by S3 in production) ─────────────────────

const lineageStore = new Map<string, EtlLineageRecord>();

export function recordLineage(rec: EtlLineageRecord): void {
  lineageStore.set(rec.jobId, rec);
  logger.info('ETL lineage recorded', {
    jobId: rec.jobId,
    rowsProduced: rec.rowsProduced,
    rowsRejected: rec.rowsRejected,
    files: rec.outputFiles.length,
    status: rec.status,
  });
}

export function getLineage(jobId: string): EtlLineageRecord | undefined {
  return lineageStore.get(jobId);
}

export function listLineage(limit = 50): EtlLineageRecord[] {
  const all = [...lineageStore.values()].sort(
    (a, b) => b.jobStartedAt.localeCompare(a.jobStartedAt),
  );
  return all.slice(0, limit);
}

// ── Row count verification ────────────────────────────────────────────────────

/**
 * Compare the number of rows in a Parquet batch against the source PostgreSQL
 * table for the same time window.
 */
export async function checkRowCountMatch(
  tableName: string,
  dateFilter: { from: Date; to: Date },
  parquetRowCount: number,
): Promise<QualityCheckResult> {
  const checkName = `row_count_match:${tableName}`;

  try {
    let pgCount = 0;

    if (tableName === 'transactions') {
      const result = await prismaRead.$queryRaw<[{ count: bigint }]>`
        SELECT COUNT(*) AS count FROM "Transaction"
        WHERE "ledgerCloseTime" BETWEEN ${dateFilter.from} AND ${dateFilter.to}
      `;
      pgCount = Number(result[0].count);
    } else if (tableName === 'events') {
      const result = await prismaRead.$queryRaw<[{ count: bigint }]>`
        SELECT COUNT(*) AS count FROM "Event"
        WHERE "createdAt" BETWEEN ${dateFilter.from} AND ${dateFilter.to}
      `;
      pgCount = Number(result[0].count);
    } else {
      // Unknown table — skip
      return {
        checkName,
        passed: true,
        severity: 'info',
        message: `Skipped: unknown table ${tableName}`,
        details: {},
        checkedAt: new Date().toISOString(),
      };
    }

    const tolerance = 0.005; // 0.5% tolerance for in-flight records
    const diff = Math.abs(pgCount - parquetRowCount);
    const pct = pgCount > 0 ? diff / pgCount : 0;
    const passed = pct <= tolerance;

    return {
      checkName,
      passed,
      severity: passed ? 'info' : 'critical',
      message: passed
        ? `Row counts match within tolerance: PG=${pgCount}, Parquet=${parquetRowCount}`
        : `Row count mismatch: PG=${pgCount}, Parquet=${parquetRowCount}, diff=${diff} (${(pct * 100).toFixed(2)}%)`,
      details: { pgCount, parquetRowCount, diff, pctDiff: pct },
      checkedAt: new Date().toISOString(),
    };
  } catch (err) {
    return {
      checkName,
      passed: false,
      severity: 'warning',
      message: `Could not verify row count: ${(err as Error).message}`,
      details: { error: String(err) },
      checkedAt: new Date().toISOString(),
    };
  }
}

// ── Null checks ───────────────────────────────────────────────────────────────

const REQUIRED_COLUMNS: Record<string, string[]> = {
  transactions: ['tx_hash', 'ledger_sequence', 'ledger_close_time', 'network_id'],
  events: ['event_contract_id', 'ledger_sequence', 'ledger_close_time', 'network_id'],
  token_transfers: ['tx_hash', 'transfer_amount', 'network_id'],
  contract_calls: ['contract_id', 'wallet_address', 'network_id'],
};

export function checkNullsInBatch(
  tableName: string,
  records: Array<Record<string, unknown>>,
): QualityCheckResult {
  const checkName = `null_check:${tableName}`;
  const requiredCols = REQUIRED_COLUMNS[tableName] ?? [];
  const violations: Array<{ column: string; rowIndex: number }> = [];

  for (let i = 0; i < records.length; i++) {
    for (const col of requiredCols) {
      if (records[i][col] === null || records[i][col] === undefined || records[i][col] === '') {
        violations.push({ column: col, rowIndex: i });
        if (violations.length >= 100) break; // cap report size
      }
    }
    if (violations.length >= 100) break;
  }

  const passed = violations.length === 0;
  return {
    checkName,
    passed,
    severity: passed ? 'info' : violations.length > 10 ? 'critical' : 'warning',
    message: passed
      ? `No nulls found in required columns for ${tableName}`
      : `Found ${violations.length} null(s) in required columns`,
    details: { violations: violations.slice(0, 20), totalRows: records.length },
    checkedAt: new Date().toISOString(),
  };
}

// ── Foreign key validation ────────────────────────────────────────────────────

/**
 * Validate that contract_id values in a batch exist in the Contract table.
 * Returns a sample of unresolved IDs (max 20).
 */
export async function checkForeignKeys(
  contractIds: string[],
): Promise<QualityCheckResult> {
  const checkName = 'foreign_key_check:contract_id';
  const unique = [...new Set(contractIds.filter(Boolean))];

  if (!unique.length) {
    return {
      checkName,
      passed: true,
      severity: 'info',
      message: 'No contract IDs to validate',
      details: {},
      checkedAt: new Date().toISOString(),
    };
  }

  try {
    const existing = await prismaRead.contract.findMany({
      where: { address: { in: unique } },
      select: { address: true },
    });
    const existingSet = new Set(existing.map((c) => c.address));
    const missing = unique.filter((id) => !existingSet.has(id));
    const passed = missing.length === 0;

    return {
      checkName,
      passed,
      severity: passed ? 'info' : 'warning',
      message: passed
        ? 'All contract IDs resolve to known contracts'
        : `${missing.length} unresolved contract ID(s) (new contracts — expected for fresh deployments)`,
      details: { total: unique.length, missing: missing.slice(0, 20) },
      checkedAt: new Date().toISOString(),
    };
  } catch (err) {
    return {
      checkName,
      passed: false,
      severity: 'warning',
      message: `FK check failed: ${(err as Error).message}`,
      details: { error: String(err) },
      checkedAt: new Date().toISOString(),
    };
  }
}

// ── File size / compaction health check ──────────────────────────────────────

export function checkFileSizes(files: IcebergDataFile[]): QualityCheckResult {
  const checkName = 'file_size_check';
  const TARGET_BYTES = 256 * 1024 * 1024; // 256 MB minimum

  if (!files.length) {
    return {
      checkName,
      passed: true,
      severity: 'info',
      message: 'No files to check',
      details: {},
      checkedAt: new Date().toISOString(),
    };
  }

  const avgSize = files.reduce((s, f) => s + f.fileSizeBytes, 0) / files.length;
  const smallFiles = files.filter((f) => f.fileSizeBytes < TARGET_BYTES);
  const passed = avgSize >= TARGET_BYTES;

  return {
    checkName,
    passed,
    severity: passed ? 'info' : smallFiles.length > files.length / 2 ? 'warning' : 'info',
    message: passed
      ? `Average file size ${(avgSize / 1024 / 1024).toFixed(1)} MB meets target`
      : `Average file size ${(avgSize / 1024 / 1024).toFixed(1)} MB below 256 MB target — compaction recommended`,
    details: { avgSizeMb: (avgSize / 1024 / 1024).toFixed(1), smallFileCount: smallFiles.length, totalFiles: files.length },
    checkedAt: new Date().toISOString(),
  };
}

// ── Run all checks for an ETL batch ──────────────────────────────────────────

export async function runQualityChecks(
  tableName: string,
  records: Array<Record<string, unknown>>,
  files: IcebergDataFile[],
  dateFilter?: { from: Date; to: Date },
): Promise<QualityCheckResult[]> {
  const results: QualityCheckResult[] = [];

  results.push(checkNullsInBatch(tableName, records));

  const contractIds = records.map((r) => r['contract_id'] as string).filter(Boolean);
  if (contractIds.length) {
    results.push(await checkForeignKeys(contractIds));
  }

  if (dateFilter) {
    results.push(await checkRowCountMatch(tableName, dateFilter, records.length));
  }

  results.push(checkFileSizes(files));

  const failures = results.filter((r) => !r.passed);
  if (failures.length) {
    logger.warn('Data quality checks failed', { tableName, failedChecks: failures.map((f) => f.checkName) });
  } else {
    logger.info('All data quality checks passed', { tableName, checks: results.length });
  }

  return results;
}
