import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();

// Collect default Node.js metrics (CPU, memory, event loop, etc.)
collectDefaultMetrics({ register: registry });

// ── API latency ──────────────────────────────────────────────────────────────
export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const httpRequestTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [registry],
});

// ── HTTP Errors (global error handler) ───────────────────────────────────────
export const httpErrorsTotal = new Counter({
  name: 'http_errors_total',
  help: 'Total number of HTTP errors by classification code',
  labelNames: ['code', 'severity', 'route'],
  registers: [registry],
});

// ── 5xx Error Surge Alerting ─────────────────────────────────────────────────
export const http5xxSurge = new Gauge({
  name: 'http_5xx_surge_ratio',
  help: 'Ratio of 5xx errors to total requests over 5min window (>0.01 triggers alert)',
  registers: [registry],
});

// ── Indexer / ingestion ──────────────────────────────────────────────────────
export const indexerLastLedger = new Gauge({
  name: 'indexer_last_ledger',
  help: 'Last ledger sequence number processed by the indexer',
  registers: [registry],
});

export const indexerIngestionLag = new Gauge({
  name: 'indexer_ingestion_lag_ledgers',
  help: 'Number of ledgers behind the chain tip',
  registers: [registry],
});

export const indexerLedgersProcessed = new Counter({
  name: 'indexer_ledgers_processed_total',
  help: 'Total number of ledgers processed',
  registers: [registry],
});

export const indexerProcessingDuration = new Histogram({
  name: 'indexer_ledger_processing_duration_seconds',
  help: 'Time to process a batch of ledgers',
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
});

export const indexerErrors = new Counter({
  name: 'indexer_errors_total',
  help: 'Total number of indexer errors',
  labelNames: ['type'],
  registers: [registry],
});

export const indexerPipelineStageDuration = new Histogram({
  name: 'indexer_pipeline_stage_duration_seconds',
  help: 'Latency duration of individual indexer pipeline stages',
  labelNames: ['stage'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const indexerPipelineStageLag = new Gauge({
  name: 'indexer_pipeline_stage_lag_ledgers',
  help: 'Ledger distance lag for each indexer pipeline stage',
  labelNames: ['stage'],
  registers: [registry],
});

export const indexerPipelineStageProcessedTotal = new Counter({
  name: 'indexer_pipeline_stage_processed_total',
  help: 'Total processed items/events per indexer pipeline stage',
  labelNames: ['stage', 'status'],
  registers: [registry],
});

// ── Database health ──────────────────────────────────────────────────────────
export const dbQueryDuration = new Histogram({
  name: 'db_query_duration_seconds',
  help: 'Duration of database queries in seconds',
  labelNames: ['operation'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
  registers: [registry],
});

export const dbConnectionStatus = new Gauge({
  name: 'db_connection_status',
  help: 'Database connection status (1 = healthy, 0 = unhealthy)',
  registers: [registry],
});

// ── Cache health ─────────────────────────────────────────────────────────────
export const cacheBackendStatus = new Gauge({
  name: 'cache_backend_status',
  help: 'Cache backend in use: 1 = Redis connected, 0 = in-memory fallback',
  registers: [registry],
});

// ── Replica lag ──────────────────────────────────────────────────────────────
export const replicaLagCheckErrors = new Counter({
  name: 'replica_lag_check_errors_total',
  help: 'Total number of replica lag-check failures (forces primary selection)',
  registers: [registry],
});

// ── Outbound RPC / Horizon calls (#910) ──────────────────────────────────────
// The indexer's primary external dependency is the Stellar RPC node (and
// Horizon as a REST fallback). These metrics track outbound call latency,
// error rates, and retry activity so RPC degradation is distinguishable
// from DB write speed, and retry storms (each retry = another RPC call,
// burning quota) are countable.
export const rpcCallDuration = new Histogram({
  name: 'rpc_call_duration_seconds',
  help: 'Duration of outbound Stellar RPC calls in seconds',
  labelNames: ['operation', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});

export const rpcCallErrorsTotal = new Counter({
  name: 'rpc_call_errors_total',
  help: 'Total number of outbound Stellar RPC call errors',
  labelNames: ['operation', 'type'],
  registers: [registry],
});

export const rpcCallRetriesTotal = new Counter({
  name: 'rpc_call_retries_total',
  help: 'Total number of RPC call retries performed (rate-limit backoff)',
  labelNames: ['operation'],
  registers: [registry],
});

export const horizonCallDuration = new Histogram({
  name: 'horizon_call_duration_seconds',
  help: 'Duration of outbound Horizon REST API calls in seconds',
  labelNames: ['operation', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});

export const horizonCallErrorsTotal = new Counter({
  name: 'horizon_call_errors_total',
  help: 'Total number of outbound Horizon REST API call errors',
  labelNames: ['operation', 'type'],
  registers: [registry],
});

// ── Background job / cron metrics (#911) ─────────────────────────────────────
// Recurring jobs (price updates, audit pipeline, key rotation, aggregation
// snapshots) previously exposed no per-job metrics — job health was only
// visible in logs. These make silently failing jobs detectable and feed the
// worker health check so /health reflects reality.
export const cronJobRunsTotal = new Counter({
  name: 'cron_job_runs_total',
  help: 'Total number of cron job executions by job and outcome',
  labelNames: ['job', 'status'],
  registers: [registry],
});

export const cronJobDurationSeconds = new Histogram({
  name: 'cron_job_duration_seconds',
  help: 'Duration of cron job executions in seconds',
  labelNames: ['job'],
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 900],
  registers: [registry],
});

export const cronJobLastSuccessTimestamp = new Gauge({
  name: 'cron_job_last_success_timestamp',
  help: 'Unix timestamp (seconds) of the last successful run of each cron job',
  labelNames: ['job'],
  registers: [registry],
});

// ── Indexer error queue / DLQ (#912) ─────────────────────────────────────────
// Failed ledgers/transactions are retried through the error queue; without
// these, a ledger failing 50 times is indistinguishable from a one-off error.
// Gauges expose queue depth for backpressure decisions; counters expose
// retry activity and permanent (dead-lettered) failures by reason.
export const indexerErrorQueueDepth = new Gauge({
  name: 'indexer_error_queue_depth',
  help: 'Number of items currently in the indexer error queue by queue type',
  labelNames: ['queue'],
  registers: [registry],
});

export const indexerErrorRetriesTotal = new Counter({
  name: 'indexer_error_retries_total',
  help: 'Total number of retries performed for failed indexer items',
  labelNames: ['type'],
  registers: [registry],
});

export const indexerErrorDlqTotal = new Counter({
  name: 'indexer_error_dlq_total',
  help: 'Total number of items dead-lettered by reason',
  labelNames: ['reason'],
  registers: [registry],
});
