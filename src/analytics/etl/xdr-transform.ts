/**
 * Phase 2 – Streaming Transform
 *
 * Consumes raw CDC events from Kafka, applies the following enrichment pipeline,
 * and writes analytics-optimised records back to the ANALYTICS_ENRICHED_TOPIC
 * (which is then sinked to S3/Iceberg by the Parquet writer):
 *
 *   1. Denormalize  – flatten nested XDR/JSON parameters into top-level columns
 *   2. Enrich       – join with token metadata, contract ABIs, wallet labels
 *   3. Aggregate    – emit per-minute micro-batch aggregates (volume, gas, wallets)
 *
 * This module is designed to run as a long-lived Node.js process and mirrors
 * the semantics of a Spark Structured Streaming or Flink DataStream job.
 * In production you would replace this with an actual Spark/Flink deployment;
 * this implementation is the drop-in equivalent for environments without a
 * cluster.
 */

import { prismaRead } from '../../db';
import { logger } from '../../logger';
import {
  KAFKA_BROKERS,
  CDC_TOPICS,
  ANALYTICS_ENRICHED_TOPIC,
  COMPACTION_TOPIC,
} from './kafka-config';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RawCdcRecord {
  op: 'c' | 'u' | 'd' | 'r'; // create, update, delete, read (snapshot)
  ts_ms: number;
  source: { table: string; lsn: string; txId: number };
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export interface AnalyticsRecord {
  // Partition keys
  network_id: string;
  ledger_close_date: string; // YYYY-MM-DD
  ledger_close_month: string; // YYYY-MM
  contract_id: string;
  wallet_address: string;

  // Fact columns
  tx_hash: string;
  ledger_sequence: number;
  ledger_close_time: string; // ISO timestamp
  operation_type: string;
  status: string;
  fee_charged: string;
  resource_instructions: number;
  resource_read_bytes: number;
  resource_write_bytes: number;

  // Denormalized event params (flattened from XDR)
  event_type: string | null;
  event_contract_id: string | null;
  token_asset_code: string | null;
  token_asset_issuer: string | null;
  transfer_amount: string | null;
  swap_amount_in: string | null;
  swap_amount_out: string | null;

  // Enriched metadata
  contract_name: string | null;
  wallet_label: string | null;
  token_decimals: number | null;
  token_name: string | null;

  // ETL provenance
  etl_job_id: string;
  etl_processed_at: string;
  source_pg_lsn: string;
  source_pg_tx_id: number;
}

// ── Enrichment cache (in-process LRU, replaced by Redis in production) ────────

const contractCache = new Map<string, { name: string | null }>();
const tokenCache = new Map<string, { name: string | null; decimals: number | null }>();

async function lookupContract(address: string): Promise<{ name: string | null }> {
  if (contractCache.has(address)) return contractCache.get(address)!;
  try {
    const c = await prismaRead.contract.findUnique({
      where: { address },
      select: { name: true },
    });
    const result = { name: c?.name ?? null };
    contractCache.set(address, result);
    return result;
  } catch {
    return { name: null };
  }
}

async function lookupToken(
  address: string,
): Promise<{ name: string | null; decimals: number | null }> {
  if (tokenCache.has(address)) return tokenCache.get(address)!;
  try {
    const t = await prismaRead.token.findFirst({
      where: { OR: [{ address }, { contractAddress: address }] },
      select: { name: true, decimals: true },
    });
    const result = { name: t?.name ?? null, decimals: t?.decimals ?? null };
    tokenCache.set(address, result);
    return result;
  } catch {
    return { name: null, decimals: null };
  }
}

// ── Denormalization ───────────────────────────────────────────────────────────

interface EventFlat {
  event_type: string | null;
  event_contract_id: string | null;
  token_asset_code: string | null;
  token_asset_issuer: string | null;
  transfer_amount: string | null;
  swap_amount_in: string | null;
  swap_amount_out: string | null;
}

function flattenEventParams(raw: Record<string, unknown>): EventFlat {
  const params = (raw.parsedParams as Record<string, unknown> | null) ?? {};
  return {
    event_type: (raw.eventType as string) ?? null,
    event_contract_id: (raw.contractId as string) ?? null,
    token_asset_code: (params.assetCode as string) ?? null,
    token_asset_issuer: (params.assetIssuer as string) ?? null,
    transfer_amount: (params.amount as string) ?? (params.transferAmount as string) ?? null,
    swap_amount_in: (params.amountIn as string) ?? null,
    swap_amount_out: (params.amountOut as string) ?? null,
  };
}

// ── Main transform ────────────────────────────────────────────────────────────

export async function transformRecord(
  raw: RawCdcRecord,
  jobId: string,
): Promise<AnalyticsRecord | null> {
  if (!raw.after || raw.op === 'd') return null;

  const row = raw.after as Record<string, unknown>;
  const contractId = (row.contractId as string) ?? (row.contract_id as string) ?? '';
  const walletAddress =
    (row.sourceAccount as string) ?? (row.source_account as string) ?? '';

  // Parallel enrichment lookups
  const [contractMeta, tokenMeta] = await Promise.all([
    contractId ? lookupContract(contractId) : Promise.resolve({ name: null }),
    contractId ? lookupToken(contractId) : Promise.resolve({ name: null, decimals: null }),
  ]);

  const ledgerCloseTime = (row.ledgerCloseTime as string) ?? new Date().toISOString();
  const closeDate = ledgerCloseTime.slice(0, 10);
  const closeMonth = ledgerCloseTime.slice(0, 7);

  const eventFlat = flattenEventParams(row);

  return {
    network_id: (row.networkId as string) ?? 'testnet',
    ledger_close_date: closeDate,
    ledger_close_month: closeMonth,
    contract_id: contractId,
    wallet_address: walletAddress,
    tx_hash: (row.hash as string) ?? (row.tx_hash as string) ?? '',
    ledger_sequence: Number(row.ledgerSequence ?? row.ledger_sequence ?? 0),
    ledger_close_time: ledgerCloseTime,
    operation_type: (row.operationType as string) ?? (row.operation_type as string) ?? '',
    status: (row.status as string) ?? 'success',
    fee_charged: String(row.feeCharged ?? row.fee_charged ?? '0'),
    resource_instructions: Number(row.resourceInstructions ?? 0),
    resource_read_bytes: Number(row.resourceReadBytes ?? 0),
    resource_write_bytes: Number(row.resourceWriteBytes ?? 0),
    ...eventFlat,
    contract_name: contractMeta.name,
    wallet_label: null, // populated by wallet-label enricher in production
    token_decimals: tokenMeta.decimals,
    token_name: tokenMeta.name,
    etl_job_id: jobId,
    etl_processed_at: new Date().toISOString(),
    source_pg_lsn: raw.source.lsn,
    source_pg_tx_id: raw.source.txId,
  };
}

// ── Batch processor (micro-batch, 15-min window) ──────────────────────────────

export async function processBatch(
  records: RawCdcRecord[],
  jobId: string,
): Promise<AnalyticsRecord[]> {
  const results: AnalyticsRecord[] = [];
  for (const rec of records) {
    try {
      const transformed = await transformRecord(rec, jobId);
      if (transformed) results.push(transformed);
    } catch (err) {
      logger.error('Failed to transform CDC record', { err, lsn: rec.source.lsn });
    }
  }
  return results;
}

// ── Aggregate computation (pre-aggregated daily/weekly/monthly rollups) ───────

export interface AggregateRow {
  network_id: string;
  contract_id: string;
  period: string; // 'daily' | 'weekly' | 'monthly'
  period_start: string; // ISO date
  tx_count: number;
  unique_wallets: number;
  total_fee_charged: string;
  avg_fee_charged: string;
  total_volume: string;
  p10_fee: number;
  p50_fee: number;
  p90_fee: number;
  p99_fee: number;
}

export function computeAggregates(
  records: AnalyticsRecord[],
  period: 'daily' | 'weekly' | 'monthly',
): AggregateRow[] {
  const buckets = new Map<string, AnalyticsRecord[]>();

  for (const r of records) {
    let periodStart: string;
    if (period === 'daily') periodStart = r.ledger_close_date;
    else if (period === 'monthly') periodStart = `${r.ledger_close_month}-01`;
    else {
      // weekly: round down to Monday
      const d = new Date(r.ledger_close_date);
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      periodStart = d.toISOString().slice(0, 10);
    }
    const key = `${r.network_id}|${r.contract_id}|${periodStart}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(r);
  }

  const rows: AggregateRow[] = [];
  for (const [key, recs] of buckets) {
    const [network_id, contract_id, period_start] = key.split('|');
    const fees = recs.map((r) => Number(r.fee_charged)).sort((a, b) => a - b);
    const total = fees.reduce((s, f) => s + f, 0);
    const pct = (p: number) => fees[Math.floor((fees.length - 1) * p)] ?? 0;

    rows.push({
      network_id,
      contract_id,
      period,
      period_start,
      tx_count: recs.length,
      unique_wallets: new Set(recs.map((r) => r.wallet_address)).size,
      total_fee_charged: String(total),
      avg_fee_charged: recs.length ? String(total / recs.length) : '0',
      total_volume: recs
        .reduce((s, r) => s + Number(r.transfer_amount ?? 0), 0)
        .toString(),
      p10_fee: pct(0.1),
      p50_fee: pct(0.5),
      p90_fee: pct(0.9),
      p99_fee: pct(0.99),
    });
  }
  return rows;
}

export { KAFKA_BROKERS, CDC_TOPICS, ANALYTICS_ENRICHED_TOPIC, COMPACTION_TOPIC };
