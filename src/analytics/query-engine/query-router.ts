/**
 * Analytics Query Engine
 *
 * Routes SQL queries to Amazon Athena (serverless, ad-hoc) or a Trino cluster
 * (always-on, dashboard / complex queries).
 *
 * Athena is called via its REST API using AWS Signature V4 — no extra SDK
 * dependency beyond the already-installed @aws-sdk/client-s3 (for S3).
 * For production, swap the fetch-based Athena calls with the official SDK.
 */

import { logger } from '../../logger';

// ── Configuration ─────────────────────────────────────────────────────────────

const GLUE_DATABASE = process.env.GLUE_DATABASE ?? 'soroban_analytics';
const ATHENA_OUTPUT_BUCKET = process.env.ATHENA_OUTPUT_BUCKET ?? 'soroban-analytics-lake';
const ATHENA_OUTPUT_PREFIX = process.env.ATHENA_OUTPUT_PREFIX ?? 'athena-results';
const ATHENA_WORKGROUP = process.env.ATHENA_WORKGROUP ?? 'primary';
const ATHENA_ENDPOINT =
  process.env.ATHENA_ENDPOINT ?? 'https://athena.us-east-1.amazonaws.com';

const TRINO_BASE_URL = process.env.TRINO_URL ?? 'http://trino:8080';
const TRINO_USER = process.env.TRINO_USER ?? 'soroban';

const COST_THRESHOLD_USD = parseFloat(process.env.ANALYTICS_COST_THRESHOLD_USD ?? '5.0');
const ATHENA_PRICE_PER_TB = 5.0;
const ATHENA_POLL_INTERVAL_MS = 1000;
const ATHENA_MAX_WAIT_MS = 300_000;

// ── Types ─────────────────────────────────────────────────────────────────────

export type QueryEngine = 'athena' | 'trino';

export interface QueryRequest {
  sql: string;
  engine?: QueryEngine;
  maxScanBytes?: number;
  timeoutMs?: number;
}

export interface QueryCostEstimate {
  estimatedScanBytes: number;
  estimatedCostUsd: number;
  exceedsThreshold: boolean;
  recommendedEngine: QueryEngine;
  reasoning: string;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, string | null>[];
  rowCount: number;
  scanBytes: number;
  executionMs: number;
  engine: QueryEngine;
  queryId: string;
}

// ── Internal Athena response shapes ──────────────────────────────────────────

interface AthenaStartResponse {
  QueryExecutionId?: string;
}

interface AthenaStatusResponse {
  QueryExecution?: {
    Status?: { State?: string; StateChangeReason?: string };
    Statistics?: { DataScannedInBytes?: number };
  };
}

interface AthenaResultsResponse {
  ResultSet?: {
    Rows?: Array<{ Data?: Array<{ VarCharValue?: string }> }>;
  };
}

// ── Cost estimation ───────────────────────────────────────────────────────────

const COMPLEX_QUERY_PATTERNS = [
  /\bJOIN\b.*\bJOIN\b/i,
  /\bWINDOW\b|\bOVER\s*\(/i,
  /\bWITH\s+\w+\s+AS\s*\(/i,
  /\bUNION\b/i,
];

function classifyQuery(sql: string): { complex: boolean; reason: string } {
  for (const pattern of COMPLEX_QUERY_PATTERNS) {
    if (pattern.test(sql)) {
      return { complex: true, reason: `Matched pattern: ${pattern.source}` };
    }
  }
  return { complex: false, reason: 'Simple SELECT' };
}

function estimateScanBytes(sql: string): number {
  const heuristics: Record<string, number> = {
    transactions: 500 * 1024 * 1024 * 1024,
    events: 800 * 1024 * 1024 * 1024,
    token_transfers: 200 * 1024 * 1024 * 1024,
    contract_calls: 150 * 1024 * 1024 * 1024,
    aggregates_daily: 1 * 1024 * 1024 * 1024,
    aggregates_weekly: 512 * 1024 * 1024,
    aggregates_monthly: 256 * 1024 * 1024,
  };

  let total = 0;
  for (const [table, bytes] of Object.entries(heuristics)) {
    if (new RegExp(`\\b${table}\\b`, 'i').test(sql)) total += bytes;
  }
  if (/WHERE.*(network_id|month|date)\s*=/.test(sql)) {
    total = Math.floor(total * 0.1);
  }
  return total || 1 * 1024 * 1024 * 1024;
}

export function estimateQueryCost(sql: string): QueryCostEstimate {
  const estimatedScanBytes = estimateScanBytes(sql);
  const estimatedCostUsd = (estimatedScanBytes / 1024 ** 4) * ATHENA_PRICE_PER_TB;
  const { complex, reason } = classifyQuery(sql);
  const recommendedEngine: QueryEngine = complex ? 'trino' : 'athena';

  return {
    estimatedScanBytes,
    estimatedCostUsd,
    exceedsThreshold: estimatedCostUsd > COST_THRESHOLD_USD,
    recommendedEngine,
    reasoning: `${reason}. Estimated ${(estimatedScanBytes / 1024 ** 3).toFixed(1)} GB ≈ $${estimatedCostUsd.toFixed(4)}.`,
  };
}

// ── Athena execution (fetch-based) ────────────────────────────────────────────

async function athenaPost<T>(action: string, body: Record<string, unknown>): Promise<T> {
  const resp = await fetch(ATHENA_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': `AmazonAthena.${action}`,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Athena ${action} failed (${resp.status}): ${text}`);
  }
  return resp.json() as Promise<T>;
}

async function runAthenaQuery(sql: string, timeoutMs: number): Promise<QueryResult> {
  const start = Date.now();

  const startResp = await athenaPost<AthenaStartResponse>('StartQueryExecution', {
    QueryString: sql,
    QueryExecutionContext: { Database: GLUE_DATABASE },
    ResultConfiguration: {
      OutputLocation: `s3://${ATHENA_OUTPUT_BUCKET}/${ATHENA_OUTPUT_PREFIX}/`,
    },
    WorkGroup: ATHENA_WORKGROUP,
    ClientRequestToken: `soroban-${Date.now()}`,
  });

  const queryId = startResp.QueryExecutionId;
  if (!queryId) throw new Error('Athena did not return a QueryExecutionId');

  const deadline = start + Math.min(timeoutMs, ATHENA_MAX_WAIT_MS);
  let scanBytes = 0;

  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, ATHENA_POLL_INTERVAL_MS));
    const statusResp = await athenaPost<AthenaStatusResponse>('GetQueryExecution', {
      QueryExecutionId: queryId,
    });
    const state = statusResp.QueryExecution?.Status?.State;
    scanBytes = statusResp.QueryExecution?.Statistics?.DataScannedInBytes ?? 0;

    if (state === 'SUCCEEDED') break;
    if (state === 'FAILED' || state === 'CANCELLED') {
      throw new Error(
        `Athena query ${queryId} ${state}: ${statusResp.QueryExecution?.Status?.StateChangeReason}`,
      );
    }
  }

  const resultsResp = await athenaPost<AthenaResultsResponse>('GetQueryResults', {
    QueryExecutionId: queryId,
  });

  const rs = resultsResp.ResultSet;
  if (!rs?.Rows?.length) {
    return { columns: [], rows: [], rowCount: 0, scanBytes, executionMs: Date.now() - start, engine: 'athena', queryId };
  }

  const header = (rs.Rows[0].Data ?? []).map((c) => c.VarCharValue ?? '');
  const rows = rs.Rows.slice(1).map((row) => {
    const record: Record<string, string | null> = {};
    (row.Data ?? []).forEach((cell, i) => {
      record[header[i]] = cell.VarCharValue ?? null;
    });
    return record;
  });

  return { columns: header, rows, rowCount: rows.length, scanBytes, executionMs: Date.now() - start, engine: 'athena', queryId };
}

// ── Trino execution ───────────────────────────────────────────────────────────

interface TrinoState {
  id: string;
  nextUri?: string;
  columns?: Array<{ name: string }>;
  data?: Array<Array<string | null>>;
  error?: { message: string };
}

async function runTrinoQuery(sql: string, timeoutMs: number): Promise<QueryResult> {
  const start = Date.now();

  const initResp = await fetch(`${TRINO_BASE_URL}/v1/statement`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
      'X-Trino-User': TRINO_USER,
      'X-Trino-Catalog': 'iceberg',
      'X-Trino-Schema': GLUE_DATABASE,
    },
    body: sql,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!initResp.ok) {
    throw new Error(`Trino query submission failed: ${initResp.status}`);
  }

  let state = (await initResp.json()) as TrinoState;
  const allData: Array<Array<string | null>> = [];
  let columns: string[] = [];

  while (state.nextUri && Date.now() - start < timeoutMs) {
    await new Promise<void>((r) => setTimeout(r, 200));
    const remaining = timeoutMs - (Date.now() - start);
    const resp = await fetch(state.nextUri, {
      headers: { 'X-Trino-User': TRINO_USER },
      signal: AbortSignal.timeout(remaining),
    });
    state = (await resp.json()) as TrinoState;

    if (state.error) throw new Error(`Trino error: ${state.error.message}`);
    if (state.columns && !columns.length) {
      columns = state.columns.map((c) => c.name);
    }
    if (state.data) allData.push(...state.data);
  }

  const rows = allData.map((row) => {
    const record: Record<string, string | null> = {};
    columns.forEach((col, i) => {
      record[col] = row[i] != null ? String(row[i]) : null;
    });
    return record;
  });

  return {
    columns,
    rows,
    rowCount: rows.length,
    scanBytes: 0,
    executionMs: Date.now() - start,
    engine: 'trino',
    queryId: state.id ?? 'unknown',
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function executeQuery(req: QueryRequest): Promise<{
  result: QueryResult;
  estimate: QueryCostEstimate;
}> {
  const estimate = estimateQueryCost(req.sql);
  const engine = req.engine ?? estimate.recommendedEngine;
  const timeoutMs = req.timeoutMs ?? 30_000;

  if (req.maxScanBytes && estimate.estimatedScanBytes > req.maxScanBytes) {
    throw new Error(
      `Query would scan ~${(estimate.estimatedScanBytes / 1024 ** 3).toFixed(1)} GB, ` +
        `exceeding limit of ${(req.maxScanBytes / 1024 ** 3).toFixed(1)} GB`,
    );
  }

  logger.info('Executing analytics query', {
    engine,
    estimatedScanGb: (estimate.estimatedScanBytes / 1024 ** 3).toFixed(1),
    estimatedCostUsd: estimate.estimatedCostUsd.toFixed(4),
  });

  const result =
    engine === 'trino'
      ? await runTrinoQuery(req.sql, timeoutMs)
      : await runAthenaQuery(req.sql, timeoutMs);

  return { result, estimate };
}
