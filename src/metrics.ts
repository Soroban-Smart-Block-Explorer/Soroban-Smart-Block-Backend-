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
