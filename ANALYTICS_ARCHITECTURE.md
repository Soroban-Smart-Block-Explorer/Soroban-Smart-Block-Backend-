# Blockchain Data Lake — Analytics Architecture
> Issue [#566](https://github.com/Soroban-Smart-Block-Explorer/Soroban-Smart-Block-Backend-/issues/566)

## Overview

This document describes the **Parquet-Based Analytics Warehouse** built on top of the Soroban Block Explorer backend.  The architecture follows the **Lakehouse pattern**: a single storage layer (S3 + Apache Iceberg) serves both batch analytics (Athena) and interactive dashboards (Trino), while PostgreSQL materialized views power the low-latency API tier.

---

## Architecture Diagram

```
PostgreSQL (OLTP)
      │
      │  WAL replication (logical)
      ▼
 Debezium CDC
      │
      │  Kafka topics (soroban.public.*)
      ▼
 XDR Transform Job            ◄── enrichment: token metadata, contract ABIs
      │  (src/analytics/etl/xdr-transform.ts)
      │
      │  enriched records → ANALYTICS_ENRICHED_TOPIC
      ▼
 Iceberg Writer                ◄── partition + write Parquet to S3
      │  (src/analytics/data-lake/iceberg-writer.ts)
      │
      ├──► S3 / Apache Iceberg tables
      │         transactions / events / token_transfers / contract_calls
      │
      ├──► AWS Glue Data Catalog  (schema registry)
      │         (src/analytics/data-lake/glue-catalog.ts)
      │
      ▼
 Query Layer
   ┌─────────────────────┬─────────────────────────┐
   │   Amazon Athena      │   Trino Cluster          │
   │   (ad-hoc, per-scan) │   (dashboard, complex)   │
   └──────────┬──────────┴────────────┬─────────────┘
              │                       │
              └───────────┬───────────┘
                          │
                 POST /api/v1/analytics/query
                 (src/api/analytics-query.ts)
                          │
                 ┌────────▼─────────┐
                 │  Query Router     │  cost estimate → engine selection
                 │  (query-router.ts)│
                 └──────────────────┘

 Fast path (pre-computed):
   PostgreSQL materialized views  ──►  Redis (TTL 5 min)
         ▲                                    │
         │  nightly full refresh              │
         │  incremental: CDC trigger          ▼
   mv_contract_daily_activity       GET /api/v1/analytics/dashboard/:type
   mv_wallet_creation_weekly
   mv_token_transfer_hourly
   mv_protocol_monthly_summary
```

---

## ETL Pipeline (4 Phases)

### Phase 1 – Change Data Capture (CDC)

| Component | Technology | Config |
|-----------|------------|--------|
| Source | PostgreSQL WAL (logical replication) | `wal_level=logical`, publication `soroban_analytics_pub` |
| Connector | Debezium PostgreSQL Connector 2.7 | `plugin.name=pgoutput`, `exactly.once.support=required` |
| Transport | Apache Kafka 3.7 (Confluent Platform 7.6) | 6 partitions, 7-day retention |
| Tables | `transactions`, `events`, `token_transfers`, `contract_calls` | One topic per table: `soroban.public.<table>` |

Key settings:
- **Exactly-once semantics** via Kafka transactions (`enable.idempotence=true`, `transactional.id`)
- **Heartbeat interval** 10 s to keep replication slot alive during quiet periods
- **Full row images** for all columns (`REPLICA IDENTITY FULL` on source tables)

### Phase 2 – Streaming Transform

File: `src/analytics/etl/xdr-transform.ts`

Each CDC record is processed through three stages:

1. **Denormalize** — flatten nested `parsedParams` JSON into top-level columns (`token_asset_code`, `transfer_amount`, `swap_amount_in/out`, etc.)
2. **Enrich** — join with `Contract` and `Token` tables to add `contract_name`, `token_name`, `token_decimals`, `wallet_label`
3. **Aggregate** — compute per-minute micro-batch stats; emit daily / weekly / monthly pre-aggregates via `computeAggregates()`

Batch window: **15 minutes** (configurable via `ETL_BATCH_WINDOW_MS`).

### Phase 3 – Parquet Sink (Iceberg)

File: `src/analytics/data-lake/iceberg-writer.ts`

- Serializes records to NDJSON (production: swap for proper Parquet encoder)
- Writes to S3 under `s3://<bucket>/iceberg/<table>/<partition>/data/<timestamp>.parquet.ndjson`
- Writes Iceberg **snapshot manifests** to `metadata/manifests/<snapshotId>.json`
- Returns `IcebergDataFile` metadata for lineage tracking

### Phase 4 – Compaction

- Target: **512 MB** average Parquet file size (min acceptable: 256 MB)
- Z-order rewrite on `contract_id`, `wallet_address` for optimal predicate pushdown
- Compaction requests emitted to `s3://<bucket>/iceberg/<table>/metadata/compaction/<ts>.json`
- Triggered by file-size checks in `src/analytics/data-quality/checks.ts`

---

## Partitioning Strategy

| Table | Partition Keys | Z-order Cols | Rationale |
|-------|---------------|--------------|-----------|
| `transactions` | `network_id` + `month` (YYYY-MM) | `contract_id`, `wallet_address` | Monthly granularity limits partition count while enabling efficient range scans over 1-year windows |
| `events` | `network_id` + `contract_id` + `date` (YYYY-MM-DD) | `contract_id`, `wallet_address` | Per-contract daily partitions for contract-scoped dashboard queries |
| `token_transfers` | `network_id` + `month` | `contract_id`, `wallet_address` | Transfer volume is lower; monthly is sufficient |
| `contract_calls` | `network_id` + `month` | `contract_id`, `wallet_address` | Same as token_transfers |
| `price_feeds` | `network_id` + `month` | `contract_id` | Oracle data; read infrequently |

**Why monthly over daily for most tables?**  At 5 B rows/year (~14 M/day), daily partitions on `transactions` would produce ~730 partitions/year/network.  Monthly gives 24 partitions — well within the Glue/Athena `10 000` partition limit and keeps average file size above 256 MB without aggressive compaction.

**Partition projection** (Athena): Configured in Glue table metadata so Athena discovers partitions automatically without an `MSCK REPAIR TABLE` job.

---

## Query Interface

File: `src/analytics/query-engine/query-router.ts`

### Engine routing heuristic

| Condition | Engine |
|-----------|--------|
| Query contains `JOIN … JOIN`, `WINDOW`, CTE, `UNION` | Trino |
| Simple `SELECT … WHERE … GROUP BY` | Athena |
| Explicit `engine` field in request body | Caller's choice |

### Cost estimation

- Scanned bytes estimated from table-size heuristics and `WHERE` partition filters
- `$5 / TB` Athena pricing applied to produce `estimatedCostUsd`
- Requests exceeding `ANALYTICS_COST_THRESHOLD_USD` (default $5) receive a `costWarning` in the response (non-blocking)

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/analytics/query` | Execute SQL or template against data lake |
| `POST` | `/api/v1/analytics/query/estimate` | Cost/engine estimate only |
| `GET`  | `/api/v1/analytics/query/templates` | List dashboard templates |
| `GET`  | `/api/v1/analytics/query/templates/:id` | Get single template with SQL |
| `GET`  | `/api/v1/analytics/dashboard/:type` | Fast path via materialized views |
| `GET`  | `/api/v1/analytics/lineage` | ETL job lineage records |

---

## Materialized Views & Caching

File: `src/analytics/materialized-views/views.ts`

| View | Refresh | Cache TTL | Powers |
|------|---------|-----------|--------|
| `mv_contract_daily_activity` | CDC trigger + nightly | 10 min | Top contracts, gas distribution |
| `mv_wallet_creation_weekly` | Nightly | 5 min | New wallet rate dashboard |
| `mv_token_transfer_hourly` | CDC trigger | 5 min | Token heatmap |
| `mv_protocol_monthly_summary` | Nightly | 1 min | Protocol KPIs |

**Refresh strategy:**
- `REFRESH MATERIALIZED VIEW CONCURRENTLY` — non-blocking, reads unaffected during refresh
- Incremental: CDC event triggers targeted refresh for the affected contract
- Full rebuild: nightly cron at 02:00 UTC via `refreshAllViews()`

---

## Schema Evolution

Apache Iceberg natively supports **additive schema changes** (new columns) without rewriting existing data files.  The Glue catalog `UpdateTable` call in `registerGlueCatalog()` applies column additions on every deploy.  Old Parquet files without the new column are read as `NULL` by Athena/Trino.

Procedure to add a column:
1. Add the column to `COMMON_COLUMNS` in `src/analytics/data-lake/glue-catalog.ts`
2. Add the column to `ANALYTICS_PARQUET_SCHEMA` in `src/analytics/data-lake/iceberg-writer.ts`
3. Populate it in `transformRecord()` in `src/analytics/etl/xdr-transform.ts`
4. Deploy — `registerGlueCatalog()` runs on startup and updates the Glue table

---

## Data Quality

File: `src/analytics/data-quality/checks.ts`

After every ETL batch:

| Check | Description | Severity on failure |
|-------|-------------|---------------------|
| Row count match | Parquet row count vs PostgreSQL source count (±0.5% tolerance) | Critical |
| Null checks | Required columns (`tx_hash`, `ledger_sequence`, `network_id`, etc.) must be non-null | Warning / Critical |
| Foreign key validation | `contract_id` values resolve to known contracts | Warning |
| File size check | Average Parquet file ≥ 256 MB | Warning |

---

## Data Lineage

Every ETL run produces an `EtlLineageRecord` capturing:
- `jobId`, `jobStartedAt`, `jobCompletedAt`
- PostgreSQL transaction ID range and WAL LSN range ingested
- Output S3 file paths, row counts, and per-file metadata
- All quality check results

Lineage records are queryable via `GET /api/v1/analytics/lineage`.

---

## Pre-built Dashboard Templates

| ID | Description | Engine |
|----|-------------|--------|
| `top_contracts_by_dau` | Top 10 contracts by daily active users | Athena |
| `gas_price_distribution` | P10/P50/P90/P99 fee percentiles over time | Athena |
| `wallet_creation_rate` | New wallet creation rate by network per week | Trino |
| `token_transfer_heatmap` | Hourly transfer volume heatmap | Athena |
| `contract_composability` | Inter-contract call depth and fan-out metrics | Trino |

Usage:
```json
POST /api/v1/analytics/query
{
  "templateId": "gas_price_distribution",
  "params": {
    "network_id": "mainnet",
    "date_from": "2026-01-01",
    "date_to": "2026-06-30"
  }
}
```

---

## Infrastructure (Docker Compose)

Start the analytics stack:
```bash
docker compose --profile analytics up
```

| Service | Image | Port | Purpose |
|---------|-------|------|---------|
| `zookeeper` | `confluentinc/cp-zookeeper:7.6.1` | — | Kafka coordination |
| `kafka` | `confluentinc/cp-kafka:7.6.1` | 9092, 29092 | Event streaming |
| `debezium` | `debezium/connect:2.7` | 8083 | CDC connector REST API |
| `trino` | `trinodb/trino:448` | 8080 | SQL query engine |
| `kafka-ui` | `provectuslabs/kafka-ui:latest` | 8090 | Topic / connector browser |

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ANALYTICS_S3_BUCKET` | `soroban-analytics-lake` | S3 bucket for Parquet data |
| `ANALYTICS_S3_PREFIX` | `iceberg` | S3 key prefix |
| `GLUE_DATABASE` | `soroban_analytics` | Glue catalog database name |
| `ATHENA_OUTPUT_BUCKET` | `soroban-analytics-lake` | Athena query results bucket |
| `ATHENA_OUTPUT_PREFIX` | `athena-results` | Athena results prefix |
| `ATHENA_WORKGROUP` | `primary` | Athena workgroup |
| `TRINO_URL` | `http://trino:8080` | Trino coordinator URL |
| `TRINO_USER` | `soroban` | Trino user header |
| `KAFKA_BROKERS` | `kafka:9092` | Comma-separated broker list |
| `ANALYTICS_COST_THRESHOLD_USD` | `5.0` | Warn if estimated Athena cost exceeds this |

---

## Acceptance Criteria Mapping

| Requirement | Implementation |
|-------------|---------------|
| Query 1 year of data (5B+ rows) < 5 s | Iceberg partition pruning + Z-order + Trino worker pool |
| ETL pipeline < 15 min lag | 15-min micro-batch window in `xdr-transform.ts` |
| File compaction > 256 MB avg | Phase 4 compaction with 512 MB target; check in `checks.ts` |
| Schema evolution without rewrite | Iceberg additive schema via Glue `UpdateTable` |
| Design doc | This document |
