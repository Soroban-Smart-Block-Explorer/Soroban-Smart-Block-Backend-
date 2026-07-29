import { PrismaClient, Prisma } from '@prisma/client';
import { config } from './config';

const logLevel: Prisma.LogLevel[] =
  config.nodeEnv === 'development' ? ['error', 'warn'] : ['error'];

// Default statement timeout (ms) applied to every connection — stops a single
// slow/hung query from blocking a connection (and a request) indefinitely.
const DEFAULT_QUERY_TIMEOUT_MS = parseInt(process.env.DB_QUERY_TIMEOUT_MS ?? '15000', 10);
const BACKFILL_QUERY_TIMEOUT_MS = parseInt(
  process.env.DB_BACKFILL_QUERY_TIMEOUT_MS ?? '300000',
  10,
);
const DB_POOL_SIZE = parseInt(process.env.DB_POOL_SIZE ?? '10', 10);
const DB_POOL_TIMEOUT = parseInt(process.env.DB_POOL_TIMEOUT ?? '30', 10);

const transactionOptions = {
  timeout: DEFAULT_QUERY_TIMEOUT_MS,
  maxWait: Math.min(DEFAULT_QUERY_TIMEOUT_MS, 5000),
};

/**
 * Appends a Postgres `statement_timeout` (ms) to a connection URL via the
 * libpq `options` startup parameter, unless the URL already sets one.
 */
function withStatementTimeout(url: string, timeoutMs: number): string {
  if (!url || /[?&]options=/.test(url)) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}options=${encodeURIComponent(`-c statement_timeout=${timeoutMs}`)}`;
}

/**
 * Appends connection pool parameters to a Postgres connection URL.
 */
function withPoolConfig(url: string): string {
  if (!url) return url;
  const params = new URLSearchParams();
  params.set('connection_limit', String(DB_POOL_SIZE));
  params.set('pool_timeout', String(DB_POOL_TIMEOUT));
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}${params.toString()}`;
}

/** Primary write client — uses the active profile's database cluster. */
export const prismaWrite = new PrismaClient({
  log: logLevel,
  datasources: {
    db: { url: withPoolConfig(withStatementTimeout(config.databaseUrl, DEFAULT_QUERY_TIMEOUT_MS)) },
  },
  transactionOptions,
});

/** Read-replica client — uses the active profile's replica (falls back to primary). */
export const prismaRead = new PrismaClient({
  log: logLevel,
  datasources: {
    db: { url: withPoolConfig(withStatementTimeout(config.readReplicaUrl, DEFAULT_QUERY_TIMEOUT_MS)) },
  },
  transactionOptions,
});

/**
 * Read client with a much longer statement timeout, reserved for
 * long-running scans (e.g. feed backfill exports) that legitimately need
 * more than the default per-query budget.
 */
export const prismaBackfill = new PrismaClient({
  log: logLevel,
  datasources: {
    db: { url: withPoolConfig(withStatementTimeout(config.readReplicaUrl, BACKFILL_QUERY_TIMEOUT_MS)) },
  },
});
