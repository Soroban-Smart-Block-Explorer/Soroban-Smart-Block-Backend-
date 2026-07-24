/**
 * AWS Glue Data Catalog – table definitions and partitioning strategy.
 *
 * This module contains:
 *   - Glue CreateTable inputs for each Iceberg table
 *   - Partition projection configurations (auto-discovery by Athena)
 *   - Helper to register all tables in the Glue catalog on startup
 *
 * Partitioning strategy (from issue requirements):
 *   transactions    → network_id + ledger_close_time (monthly)
 *   events          → network_id + contract_id + date
 *   token_transfers → network_id + month
 *   contract_calls  → network_id + month
 *   price_feeds     → network_id + month
 *
 * Z-order sort columns: contract_id, wallet_address (applied at compaction)
 */

import {
  GlueClient,
  CreateTableCommand,
  GetTableCommand,
  UpdateTableCommand,
  type TableInput,
  type StorageDescriptor,
} from '@aws-sdk/client-glue';
import { logger } from '../../logger';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const GLUE_DATABASE = process.env.GLUE_DATABASE ?? 'soroban_analytics';
const BUCKET = process.env.ANALYTICS_S3_BUCKET ?? 'soroban-analytics-lake';
const PREFIX = process.env.ANALYTICS_S3_PREFIX ?? 'iceberg';

const glue = new GlueClient({ region: REGION });

// ── Column definitions ────────────────────────────────────────────────────────

const COMMON_COLUMNS = [
  { Name: 'network_id', Type: 'string', Comment: 'testnet | mainnet' },
  { Name: 'ledger_close_date', Type: 'string', Comment: 'YYYY-MM-DD' },
  { Name: 'ledger_close_month', Type: 'string', Comment: 'YYYY-MM' },
  { Name: 'contract_id', Type: 'string', Comment: 'Soroban contract address' },
  { Name: 'wallet_address', Type: 'string', Comment: 'Source account (Stellar strkey)' },
  { Name: 'tx_hash', Type: 'string' },
  { Name: 'ledger_sequence', Type: 'bigint' },
  { Name: 'ledger_close_time', Type: 'timestamp', Comment: 'UTC close time of the ledger' },
  { Name: 'operation_type', Type: 'string' },
  { Name: 'status', Type: 'string' },
  { Name: 'fee_charged', Type: 'string', Comment: 'Stroops, stored as string to avoid overflow' },
  { Name: 'resource_instructions', Type: 'bigint' },
  { Name: 'resource_read_bytes', Type: 'bigint' },
  { Name: 'resource_write_bytes', Type: 'bigint' },
  { Name: 'event_type', Type: 'string' },
  { Name: 'event_contract_id', Type: 'string' },
  { Name: 'token_asset_code', Type: 'string' },
  { Name: 'token_asset_issuer', Type: 'string' },
  { Name: 'transfer_amount', Type: 'string' },
  { Name: 'swap_amount_in', Type: 'string' },
  { Name: 'swap_amount_out', Type: 'string' },
  { Name: 'contract_name', Type: 'string' },
  { Name: 'wallet_label', Type: 'string' },
  { Name: 'token_decimals', Type: 'int' },
  { Name: 'token_name', Type: 'string' },
  { Name: 'etl_job_id', Type: 'string' },
  { Name: 'etl_processed_at', Type: 'timestamp' },
  { Name: 'source_pg_lsn', Type: 'string' },
  { Name: 'source_pg_tx_id', Type: 'bigint' },
];

// ── StorageDescriptor factory ─────────────────────────────────────────────────

function makeStorage(location: string): StorageDescriptor {
  return {
    Columns: COMMON_COLUMNS,
    Location: location,
    InputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
    OutputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
    SerdeInfo: {
      SerializationLibrary: 'org.openx.data.jsonserde.JsonSerDe',
      Parameters: {
        'serialization.format': '1',
        'ignore.malformed.json': 'TRUE',
      },
    },
    Parameters: {
      'classification': 'json',
      'compressionType': 'none',
      'iceberg.catalog': 'glue',
      'write.format.default': 'parquet',
      'write.target-file-size-bytes': String(512 * 1024 * 1024),
      'write.distribution-mode': 'hash',
      'write.wap.enabled': 'true',
    },
  };
}

// ── Table definitions ─────────────────────────────────────────────────────────

export const GLUE_TABLE_DEFINITIONS: TableInput[] = [
  {
    Name: 'transactions',
    Description: 'Soroban transactions partitioned by network_id + month. Z-order: contract_id, wallet_address.',
    StorageDescriptor: makeStorage(`s3://${BUCKET}/${PREFIX}/transactions`),
    PartitionKeys: [
      { Name: 'network_id', Type: 'string' },
      { Name: 'month', Type: 'string', Comment: 'YYYY-MM' },
    ],
    Parameters: {
      'projection.enabled': 'true',
      'projection.network_id.type': 'enum',
      'projection.network_id.values': 'testnet,mainnet',
      'projection.month.type': 'date',
      'projection.month.format': 'yyyy-MM',
      'projection.month.range': '2020-01,NOW',
      'projection.month.interval': '1',
      'projection.month.interval.unit': 'MONTHS',
      'storage.location.template': `s3://${BUCKET}/${PREFIX}/transactions/network_id=$\{network_id}/month=$\{month}`,
      'table_type': 'ICEBERG',
      'format': 'parquet',
    },
  },
  {
    Name: 'events',
    Description: 'Soroban events partitioned by network_id + contract_id + date. Z-order: contract_id, wallet_address.',
    StorageDescriptor: makeStorage(`s3://${BUCKET}/${PREFIX}/events`),
    PartitionKeys: [
      { Name: 'network_id', Type: 'string' },
      { Name: 'contract_id', Type: 'string' },
      { Name: 'date', Type: 'string', Comment: 'YYYY-MM-DD' },
    ],
    Parameters: {
      'projection.enabled': 'true',
      'projection.network_id.type': 'enum',
      'projection.network_id.values': 'testnet,mainnet',
      'projection.contract_id.type': 'injected',
      'projection.date.type': 'date',
      'projection.date.format': 'yyyy-MM-dd',
      'projection.date.range': '2020-01-01,NOW',
      'projection.date.interval': '1',
      'projection.date.interval.unit': 'DAYS',
      'storage.location.template': `s3://${BUCKET}/${PREFIX}/events/network_id=$\{network_id}/contract_id=$\{contract_id}/date=$\{date}`,
      'table_type': 'ICEBERG',
      'format': 'parquet',
    },
  },
  {
    Name: 'token_transfers',
    Description: 'SEP-41 token transfers partitioned by network_id + month.',
    StorageDescriptor: makeStorage(`s3://${BUCKET}/${PREFIX}/token_transfers`),
    PartitionKeys: [
      { Name: 'network_id', Type: 'string' },
      { Name: 'month', Type: 'string' },
    ],
    Parameters: {
      'projection.enabled': 'true',
      'projection.network_id.type': 'enum',
      'projection.network_id.values': 'testnet,mainnet',
      'projection.month.type': 'date',
      'projection.month.format': 'yyyy-MM',
      'projection.month.range': '2020-01,NOW',
      'projection.month.interval': '1',
      'projection.month.interval.unit': 'MONTHS',
      'storage.location.template': `s3://${BUCKET}/${PREFIX}/token_transfers/network_id=$\{network_id}/month=$\{month}`,
      'table_type': 'ICEBERG',
      'format': 'parquet',
    },
  },
  {
    Name: 'contract_calls',
    Description: 'Contract invocations partitioned by network_id + month.',
    StorageDescriptor: makeStorage(`s3://${BUCKET}/${PREFIX}/contract_calls`),
    PartitionKeys: [
      { Name: 'network_id', Type: 'string' },
      { Name: 'month', Type: 'string' },
    ],
    Parameters: {
      'projection.enabled': 'true',
      'projection.network_id.type': 'enum',
      'projection.network_id.values': 'testnet,mainnet',
      'projection.month.type': 'date',
      'projection.month.format': 'yyyy-MM',
      'projection.month.range': '2020-01,NOW',
      'projection.month.interval': '1',
      'projection.month.interval.unit': 'MONTHS',
      'storage.location.template': `s3://${BUCKET}/${PREFIX}/contract_calls/network_id=$\{network_id}/month=$\{month}`,
      'table_type': 'ICEBERG',
      'format': 'parquet',
    },
  },
];

// ── Catalog registration ──────────────────────────────────────────────────────

/**
 * Idempotently create or update all Glue tables.
 * Safe to call on every deploy; existing tables are updated in-place (additive
 * schema evolution — Iceberg supports new columns without rewriting data).
 */
export async function registerGlueCatalog(): Promise<void> {
  for (const tableInput of GLUE_TABLE_DEFINITIONS) {
    try {
      await glue.send(new GetTableCommand({ DatabaseName: GLUE_DATABASE, Name: tableInput.Name! }));
      // Table exists — update to pick up any new columns (additive only)
      await glue.send(
        new UpdateTableCommand({ DatabaseName: GLUE_DATABASE, TableInput: tableInput }),
      );
      logger.info('Updated Glue catalog table', { table: tableInput.Name });
    } catch (err: unknown) {
      const code = (err as { name?: string }).name;
      if (code === 'EntityNotFoundException') {
        await glue.send(
          new CreateTableCommand({ DatabaseName: GLUE_DATABASE, TableInput: tableInput }),
        );
        logger.info('Created Glue catalog table', { table: tableInput.Name });
      } else {
        logger.error('Failed to register Glue table', { err, table: tableInput.Name });
        throw err;
      }
    }
  }
}
