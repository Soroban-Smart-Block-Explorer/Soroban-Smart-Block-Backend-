/**
 * Kafka producer/consumer configuration for the CDC-based ETL pipeline.
 *
 * Phase 1 – CDC: Debezium captures PostgreSQL WAL changes and publishes
 * to Kafka topics. This module exports topic names, producer defaults,
 * and consumer group settings used by the streaming transforms.
 */

export const KAFKA_BROKERS = (process.env.KAFKA_BROKERS ?? 'kafka:9092').split(',');

/** Topics written by Debezium (one per source table). */
export const CDC_TOPICS = {
  transactions: 'soroban.public.transactions',
  events: 'soroban.public.events',
  tokenTransfers: 'soroban.public.token_transfers',
  contractCalls: 'soroban.public.contract_calls',
} as const;

/** Topic that receives analytics-optimised, enriched records ready for Parquet sink. */
export const ANALYTICS_ENRICHED_TOPIC = 'soroban.analytics.enriched';

/** Topic used by the compaction job to signal S3 file-compaction requests. */
export const COMPACTION_TOPIC = 'soroban.analytics.compaction';

/** Topic used for data-quality alert events. */
export const DQ_ALERT_TOPIC = 'soroban.analytics.dq-alerts';

export const PRODUCER_CONFIG = {
  brokers: KAFKA_BROKERS,
  clientId: 'soroban-analytics-producer',
  retry: {
    initialRetryTime: 300,
    retries: 8,
  },
} as const;

export const CONSUMER_CONFIG = {
  brokers: KAFKA_BROKERS,
  clientId: 'soroban-analytics-consumer',
  groupId: 'soroban-analytics-etl',
} as const;

/** Debezium connector configuration posted to the Connect REST API on startup. */
export const DEBEZIUM_CONNECTOR_CONFIG = {
  name: 'soroban-pg-connector',
  config: {
    'connector.class': 'io.debezium.connector.postgresql.PostgresConnector',
    'plugin.name': 'pgoutput',
    'database.hostname': process.env.POSTGRES_HOST ?? 'db-testnet',
    'database.port': process.env.POSTGRES_PORT ?? '5432',
    'database.user': process.env.POSTGRES_USER ?? 'postgres',
    'database.password': process.env.POSTGRES_PASSWORD ?? '',
    'database.dbname': process.env.POSTGRES_DB ?? 'soroban_testnet',
    'database.server.name': 'soroban',
    'table.include.list':
      'public.transactions,public.events,public.token_transfers,public.contract_calls',
    'publication.name': 'soroban_analytics_pub',
    'slot.name': 'soroban_analytics_slot',
    // Exactly-once delivery: Kafka transactions
    'exactly.once.support': 'required',
    'producer.override.enable.idempotence': 'true',
    'producer.override.transactional.id': 'soroban-debezium-txn',
    // Emit full row images for all columns
    'tombstones.on.delete': 'false',
    'decimal.handling.mode': 'string',
    // Heartbeat keeps replication slot alive during low-traffic periods
    'heartbeat.interval.ms': '10000',
    'topic.prefix': 'soroban',
  },
};

/** Register the Debezium connector via the Connect REST API. */
export async function registerDebeziumConnector(connectUrl: string): Promise<void> {
  const url = `${connectUrl}/connectors`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(DEBEZIUM_CONNECTOR_CONFIG),
  });

  if (!response.ok && response.status !== 409) {
    // 409 = connector already exists – safe to ignore
    const body = await response.text();
    throw new Error(`Failed to register Debezium connector: ${response.status} ${body}`);
  }
}
