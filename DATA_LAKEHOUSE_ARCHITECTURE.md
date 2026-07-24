# Multi-Layer Data Lakehouse Architecture

> Issue [#551](https://github.com/Soroban-Smart-Block-Explorer/Soroban-Smart-Block-Backend-/issues/551) — Real-Time Stream Processing + OLAP + Cold Storage

## Problem

The explorer had no separation between **OLTP** (live indexing) and **OLAP**
(analytics) workloads. Reporting queries on historical data competed with the
indexer for PostgreSQL resources, and the S3 archive (`src/archival/`) was
write-only — cold data could not be queried without a rehydration step.

This design introduces a four-layer lakehouse that separates ingest, real-time
processing, interactive analytics, and cold storage, behind a single query
gateway. It is the successor to the Parquet warehouse from
[#566](https://github.com/Soroban-Smart-Block-Explorer/Soroban-Smart-Block-Backend-/issues/566)
(`ANALYTICS_ARCHITECTURE.md`) and reuses its Iceberg writer and Debezium config.

---

## Architecture

```
                         ┌──────────────────────────┐
   Indexer (OLTP) ──────►│  PostgreSQL (hot, 7 days) │
   src/indexer/          └────────────┬─────────────┘
                                      │ logical WAL
                                      ▼
                             Debezium CDC (exactly-once)
                                      │
   ┌──────────────────────────  LAYER 1 — STREAM BUS  ──────────────────────────┐
   │  Kafka / Redpanda  ·  Schema Registry (Avro/Protobuf)                        │
   │  src/analytics/lakehouse/{stream-bus,schema-registry}.ts                     │
   │                                                                              │
   │   stream processors  (src/analytics/lakehouse/stream-processors.ts)          │
   │   ├─ windowed aggregation   volume / 5min · gas / ledger                      │
   │   ├─ enrichment joins        token metadata · contract ABIs · wallet labels   │
   │   └─ anomaly detection       online EWMA + z-score                            │
   └───────────────┬───────────────────────────────────┬──────────────────────────┘
                   │ enriched stream                    │ windowed views (Layer 1)
                   ▼                                     │
   ┌──── LAYER 2 — OLAP (warm, 90 days) ────┐            │
   │  ClickHouse columnar store              │            │
   │  src/analytics/lakehouse/olap-store.ts  │            │
   │  materialized views:                    │            │
   │   · mv_mev_per_block                     │            │
   │   · mv_compliance_daily                  │            │
   │   · mv_protocol_economics_monthly        │            │
   └───────────────┬─────────────────────────┘            │
                   │ tier demotion (>90d)                 │
                   ▼                                     │
   ┌──── LAYER 3 — COLD (S3 Iceberg, forever) ───────────┐│
   │  Apache Iceberg tables (src/analytics/data-lake/)    ││
   │  Trino federated connector — queried IN PLACE        ││
   │  tiering.ts · federated-query.ts                     ││
   └───────────────┬─────────────────────────────────────┘│
                   │                                       │
   ┌──────────  LAYER 4 — UNIFIED QUERY GATEWAY  ──────────┴────────────┐
   │  src/analytics/lakehouse/query-gateway.ts                          │
   │  route by (time range · aggregation level · freshness)             │
   │  per-layer cost estimate + timeout · cross-layer result cache      │
   │                                                                    │
   │        POST /api/v1/lakehouse/query   (src/api/lakehouse.ts)       │
   └────────────────────────────────────────────────────────────────────┘
```

---

## Layer 1 — Stream Processing Pipeline

Replaces the legacy in-process `EventEmitter` with a partitioned, offset-tracked
event bus.

| Concern | Implementation | File |
|---|---|---|
| Event bus | `StreamBus` interface; `InMemoryStreamBus` (default) + `KafkaStreamBus` seam | `stream-bus.ts` |
| Schema registry | subjects, versioning, BACKWARD/FORWARD/FULL compatibility, single-object envelope | `schema-registry.ts` |
| Windowed aggregation | tumbling/hopping windows — volume/5min, gas/ledger | `stream-processors.ts` |
| Enrichment joins | stream × keyed state store (LRU), left-join semantics | `stream-processors.ts` |
| Anomaly detection | online EWMA mean/variance + z-score, constant memory/key | `stream-processors.ts` |

### Exactly-once semantics

Delivery from indexer → stream → materialized views is exactly-once via the
Kafka **read-process-write** loop:

1. A consumer polls a batch; offsets are *staged*, not committed.
2. A processing **transaction** stages output records.
3. `commit()` atomically flushes outputs **and** advances the consumed offsets.
   On failure `abort()` discards outputs and leaves offsets untouched, so the
   batch is redelivered.
4. The **idempotent producer** discards any record whose `(producerId, sequence)`
   was already applied, so a redelivery never double-writes.

`InMemoryStreamBus` implements this contract exactly (see the
`beginTransaction` / `poll` / `compact` tests). The production `KafkaStreamBus`
maps it onto `producer({ idempotent: true, transactionalId })` +
`transaction.sendOffsets()` with `readUncommitted: false`.

**Broker-failure survival:** producers are idempotent with `acks=all` and a
replication factor ≥ 3; consumers commit offsets only inside the transaction, so
a broker loss redelivers the in-flight batch with zero data loss.

---

## Layer 2 — OLAP Analytics Engine

A columnar store (ClickHouse) fed by CDC. `InMemoryOlapStore` implements the same
`OlapStore` interface for tests and single-node runs; `ClickHouseOlapStore` talks
to the HTTP interface on port 8123.

- **CDC pipeline:** Debezium (`src/analytics/etl/kafka-config.ts`) captures the
  PostgreSQL WAL → Kafka → transform → `INSERT … FORMAT JSONEachRow` into
  ClickHouse `MergeTree` tables.
- **Materialized views** (`MATERIALIZED_VIEWS`) roll raw rows into the three
  required dashboards:
  - `mv_mev_per_block` — extracted value + tx count per block (`SummingMergeTree`)
  - `mv_compliance_daily` — flagged-address volume over time (`SummingMergeTree`)
  - `mv_protocol_economics_monthly` — fees / active txns / avg instructions
    (`AggregatingMergeTree`)
- **Sub-second ad-hoc SQL on 100B rows** comes from ClickHouse column pruning +
  `PARTITION BY toYYYYMM(...)` + sort-key locality; the gateway routes
  pre-aggregated dashboard reads to the materialized views so they never scan raw.

---

## Layer 3 — Queryable Cold Storage

- **Format:** Apache Iceberg tables on S3 (`src/analytics/data-lake/iceberg-writer.ts`
  from #566), partitioned by `network_id / month`, Z-ordered on
  `contract_id, wallet_address`.
- **Federated queries** (`federated-query.ts`): a Trino/Presto-style planner
  splits a time-ranged request into per-tier sub-queries and merges the partials
  — hot (PostgreSQL), warm (ClickHouse), cold (Iceberg via Trino). Cold is queried
  **in place**; there is no rehydration. Cross-tier `avg` is count-weighted so a
  bucket split across tiers merges exactly.
- **Tiered lifecycle** (`tiering.ts`): `hot ≤ 7d`, `warm ≤ 90d`, `cold` forever.
  `decideTier` promotes a partition one tier when trailing-window access exceeds
  the threshold (hot data under load stays fast) and demotes quiet aged partitions
  back to their age baseline. `TierManager.reconcile` is idempotent.

---

## Layer 4 — Unified Query Gateway

`POST /api/v1/lakehouse/query` is the single entry point. `route()` picks a target
from three signals:

| Signal | → Target | Layer |
|---|---|---|
| `freshness: realtime` + recent range | `stream-view` | 1 |
| `aggregation: pre-aggregated` + within 90d | `olap-view` | 2 |
| everything else / deep history | `federated` | 3 |

Each target carries a **cost estimate** (rows scanned → USD) and a **per-layer
timeout** (`stream-view` 1s, `olap-view` 5s, `federated` 30s), enforced by
`withTimeout`. Results are cached in a freshness-aware LRU+TTL cache
(`ResultCache`); `realtime` requests bypass it.

### Endpoints (`src/api/lakehouse.ts`, mounted at `/api/v1/lakehouse`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/query` | Route + execute a query, return rows + routing/cost/cache metadata |
| POST | `/query/plan` | Dry-run: routing decision + federated plan, no execution |
| GET | `/schemas` | Layer 1 schema-registry subjects/versions/compatibility |
| GET | `/dashboards` | Layer 2 materialized-view catalog |
| GET | `/tiers` | Layer 3 partition → tier state |
| POST | `/tiers/evaluate` | Run the lifecycle policy (optionally `apply`) |
| GET | `/health` | Active drivers + per-layer readiness |

---

## Acceptance criteria → design

| Requirement | How it is met |
|---|---|
| 100M events/hour, <100ms end-to-end | Partitioned bus + windowed operators are O(1) per event; horizontal scale by partition count. |
| Analytics on 1 year of data <2s | Gateway routes to ClickHouse materialized views / column-pruned scans; only deep raw scans hit federated. |
| Cold storage queryable without rehydration | Trino Iceberg connector queries S3 in place; planner sets `coldQueriedInPlace`. |
| Stream survives broker failure, zero data loss | Idempotent transactional producer + offsets committed only inside the txn → redelivery is exact-once. |

---

## Deployment

Adapters are selected by env var; the default is fully in-memory so the module
runs in CI and single-node with no external services:

| Var | Default | Production |
|---|---|---|
| `LAKEHOUSE_BUS_DRIVER` | `memory` | `kafka` (`KAFKA_BROKERS`) |
| `LAKEHOUSE_OLAP_DRIVER` | `memory` | `clickhouse` (`CLICKHOUSE_URL`) |
| `CLICKHOUSE_URL` | `http://clickhouse:8123` | cluster HTTP endpoint |
| `TRINO_URL` | `http://trino:8080` | Trino coordinator |

Production stack (compose services): `redpanda`/`kafka`, `schema-registry`,
`kafka-connect` (Debezium), `clickhouse`, `trino`, plus the existing `minio`/S3
for Iceberg.

## Testing

`tests/lakehouse.test.ts` — 46 cases covering schema compatibility, exactly-once
commit/abort/dedup, windowed aggregation, anomaly detection, OLAP aggregation +
DDL rendering, tier promotion/demotion, federated planning + cross-tier merge,
and end-to-end gateway routing + caching.

```bash
npx vitest run tests/lakehouse.test.ts
```
