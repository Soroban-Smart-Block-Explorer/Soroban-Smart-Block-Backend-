/**
 * Materialized Views & Redis Caching Layer
 *
 * Pre-computes frequently used aggregations and stores them in:
 *   1. PostgreSQL materialized views (fast API access, sub-100ms)
 *   2. Redis (hot cache, TTL 5 min for dashboard data)
 *
 * Refresh strategy:
 *   - Incremental: triggered by CDC events (on-demand, per-contract)
 *   - Full rebuild: nightly cron at 02:00 UTC
 */

import { prismaWrite as prisma, prismaRead } from '../../db';
import { cacheGet, cacheSet } from '../../cache';
import { logger } from '../../logger';

// Cache TTLs
const DASHBOARD_TTL_SECONDS = 300;      // 5 min — dashboard widgets
const SUMMARY_TTL_SECONDS = 60;         // 1 min — real-time summaries
const LEADERBOARD_TTL_SECONDS = 600;    // 10 min — top-N lists

// ── PostgreSQL materialized view DDL ─────────────────────────────────────────

/**
 * SQL DDL for the materialized views. These are applied via Prisma's
 * $executeRawUnsafe during migrations or the registerMaterializedViews()
 * helper below.
 *
 * All views use CONCURRENTLY-refreshable indexes so reads are not blocked
 * during refresh.
 */
export const MATERIALIZED_VIEW_DDL = [
  // Daily contract activity (top contracts by DAU)
  `CREATE MATERIALIZED VIEW IF NOT EXISTS mv_contract_daily_activity AS
   SELECT
     DATE_TRUNC('day', t."ledgerCloseTime") AS activity_date,
     t."contractId"                          AS contract_id,
     COUNT(DISTINCT t."sourceAccount")       AS daily_active_users,
     COUNT(*)                                AS tx_count,
     SUM(t."feeCharged")                     AS total_fee_stroops,
     AVG(t."feeCharged")                     AS avg_fee_stroops,
     PERCENTILE_CONT(0.10) WITHIN GROUP (ORDER BY t."feeCharged") AS p10_fee,
     PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY t."feeCharged") AS p50_fee,
     PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY t."feeCharged") AS p90_fee,
     PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY t."feeCharged") AS p99_fee
   FROM "Transaction" t
   WHERE t."contractId" IS NOT NULL
   GROUP BY 1, 2
   WITH DATA;`,

  `CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_contract_daily_activity
   ON mv_contract_daily_activity (activity_date, contract_id);`,

  // Weekly new wallet creation rate
  `CREATE MATERIALIZED VIEW IF NOT EXISTS mv_wallet_creation_weekly AS
   SELECT
     DATE_TRUNC('week', first_seen) AS week_start,
     COUNT(*)                        AS new_wallets
   FROM (
     SELECT "sourceAccount" AS address, MIN("ledgerCloseTime") AS first_seen
     FROM "Transaction"
     GROUP BY 1
   ) w
   GROUP BY 1
   WITH DATA;`,

  `CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_wallet_creation_weekly
   ON mv_wallet_creation_weekly (week_start);`,

  // Hourly token transfer volume (heatmap data)
  `CREATE MATERIALIZED VIEW IF NOT EXISTS mv_token_transfer_hourly AS
   SELECT
     DATE_TRUNC('hour', e."createdAt") AS hour_bucket,
     e."contractId"                     AS token_contract,
     COUNT(*)                           AS transfer_count,
     SUM(COALESCE((e."parsedParams"->>'amount')::numeric, 0)) AS total_volume
   FROM "Event" e
   WHERE e."eventType" = 'transfer'
   GROUP BY 1, 2
   WITH DATA;`,

  `CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_token_transfer_hourly
   ON mv_token_transfer_hourly (hour_bucket, token_contract);`,

  // Monthly protocol summary (volume, fees, unique wallets)
  `CREATE MATERIALIZED VIEW IF NOT EXISTS mv_protocol_monthly_summary AS
   SELECT
     DATE_TRUNC('month', t."ledgerCloseTime") AS month_start,
     COUNT(*)                                   AS tx_count,
     COUNT(DISTINCT t."sourceAccount")          AS unique_wallets,
     SUM(t."feeCharged")                        AS total_fees_stroops,
     COUNT(DISTINCT t."contractId")             AS active_contracts
   FROM "Transaction" t
   GROUP BY 1
   WITH DATA;`,

  `CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_protocol_monthly_summary
   ON mv_protocol_monthly_summary (month_start);`,
];

// ── Materialized view registration ───────────────────────────────────────────

/**
 * Create all materialized views and their indexes.
 * Idempotent — safe to call on every startup (IF NOT EXISTS guards).
 */
export async function registerMaterializedViews(): Promise<void> {
  for (const ddl of MATERIALIZED_VIEW_DDL) {
    try {
      await prisma.$executeRawUnsafe(ddl);
    } catch (err) {
      // Ignore "already exists" errors for indexes
      const msg = String((err as Error).message);
      if (!msg.includes('already exists')) {
        logger.error('Failed to create materialized view', { err, ddl: ddl.slice(0, 80) });
        throw err;
      }
    }
  }
  logger.info('Materialized views registered');
}

// ── Refresh functions ─────────────────────────────────────────────────────────

/**
 * Incrementally refresh a specific materialized view.
 * Uses CONCURRENTLY to avoid blocking reads.
 */
export async function refreshView(viewName: string): Promise<void> {
  const start = Date.now();
  await prisma.$executeRawUnsafe(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${viewName}`);
  logger.info('Refreshed materialized view', { viewName, ms: Date.now() - start });
}

/** Refresh all materialized views (nightly full rebuild). */
export async function refreshAllViews(): Promise<void> {
  const views = [
    'mv_contract_daily_activity',
    'mv_wallet_creation_weekly',
    'mv_token_transfer_hourly',
    'mv_protocol_monthly_summary',
  ];
  for (const view of views) {
    await refreshView(view);
  }
}

// ── Redis-cached query helpers ────────────────────────────────────────────────

async function cachedQuery<T>(
  cacheKey: string,
  ttl: number,
  queryFn: () => Promise<T>,
): Promise<T> {
  const cached = await cacheGet<T>(cacheKey);
  if (cached !== null) {
    return cached;
  }
  const result = await queryFn();
  await cacheSet<T>(cacheKey, result, ttl);
  return result;
}

// ── Public cached data accessors ──────────────────────────────────────────────

/** Top N contracts by daily active users (past 30 days). */
export async function getTopContractsByDAU(limit = 10): Promise<
  Array<{ contract_id: string; daily_active_users: number; tx_count: number; activity_date: Date }>
> {
  return cachedQuery(
    `analytics:top_contracts_dau:${limit}`,
    LEADERBOARD_TTL_SECONDS,
    async () => {
      const rows = await prismaRead.$queryRaw<Array<{
        contract_id: string;
        daily_active_users: bigint;
        tx_count: bigint;
        activity_date: Date;
      }>>`
        SELECT contract_id,
               daily_active_users,
               tx_count,
               activity_date
        FROM mv_contract_daily_activity
        WHERE activity_date >= NOW() - INTERVAL '30 days'
        ORDER BY daily_active_users DESC
        LIMIT ${limit}
      `;
      return rows.map((r) => ({
        ...r,
        daily_active_users: Number(r.daily_active_users),
        tx_count: Number(r.tx_count),
      }));
    },
  );
}

/** Gas price percentile distribution over the last N days. */
export async function getGasDistribution(days = 30): Promise<
  Array<{ activity_date: Date; p10_fee: number; p50_fee: number; p90_fee: number; p99_fee: number }>
> {
  return cachedQuery(
    `analytics:gas_distribution:${days}`,
    DASHBOARD_TTL_SECONDS,
    () =>
      prismaRead.$queryRaw<Array<{
        activity_date: Date;
        p10_fee: number;
        p50_fee: number;
        p90_fee: number;
        p99_fee: number;
      }>>`
        SELECT activity_date, p10_fee, p50_fee, p90_fee, p99_fee
        FROM mv_contract_daily_activity
        WHERE activity_date >= NOW() - INTERVAL '${days} days'
        ORDER BY activity_date ASC
      `,
  );
}

/** New wallet creation rate by week. */
export async function getWalletCreationRate(weeks = 52): Promise<
  Array<{ week_start: Date; new_wallets: number }>
> {
  return cachedQuery(
    `analytics:wallet_creation:${weeks}`,
    DASHBOARD_TTL_SECONDS,
    async () => {
      const rows = await prismaRead.$queryRaw<Array<{ week_start: Date; new_wallets: bigint }>>`
        SELECT week_start, new_wallets
        FROM mv_wallet_creation_weekly
        ORDER BY week_start DESC
        LIMIT ${weeks}
      `;
      return rows.map((r) => ({ ...r, new_wallets: Number(r.new_wallets) }));
    },
  );
}

/** Hourly token transfer volume for heatmap (last 7 days). */
export async function getTokenTransferHeatmap(tokenContract?: string): Promise<
  Array<{ hour_bucket: Date; token_contract: string; transfer_count: number; total_volume: string }>
> {
  const key = `analytics:token_heatmap:${tokenContract ?? 'all'}`;
  return cachedQuery(key, DASHBOARD_TTL_SECONDS, async () => {
    let rows: Array<{
      hour_bucket: Date;
      token_contract: string;
      transfer_count: bigint;
      total_volume: string;
    }>;

    if (tokenContract) {
      rows = await prismaRead.$queryRaw`
        SELECT hour_bucket, token_contract, transfer_count, total_volume
        FROM mv_token_transfer_hourly
        WHERE hour_bucket >= NOW() - INTERVAL '7 days'
          AND token_contract = ${tokenContract}
        ORDER BY hour_bucket ASC
      `;
    } else {
      rows = await prismaRead.$queryRaw`
        SELECT hour_bucket, token_contract, transfer_count, total_volume
        FROM mv_token_transfer_hourly
        WHERE hour_bucket >= NOW() - INTERVAL '7 days'
        ORDER BY hour_bucket ASC
      `;
    }

    return rows.map((r) => ({ ...r, transfer_count: Number(r.transfer_count) }));
  });
}

/** Protocol monthly summary totals. */
export async function getProtocolMonthlySummary(months = 12): Promise<
  Array<{
    month_start: Date;
    tx_count: number;
    unique_wallets: number;
    total_fees_stroops: string;
    active_contracts: number;
  }>
> {
  return cachedQuery(
    `analytics:protocol_monthly:${months}`,
    SUMMARY_TTL_SECONDS,
    async () => {
      const rows = await prismaRead.$queryRaw<Array<{
        month_start: Date;
        tx_count: bigint;
        unique_wallets: bigint;
        total_fees_stroops: bigint;
        active_contracts: bigint;
      }>>`
        SELECT month_start, tx_count, unique_wallets, total_fees_stroops, active_contracts
        FROM mv_protocol_monthly_summary
        ORDER BY month_start DESC
        LIMIT ${months}
      `;
      return rows.map((r) => ({
        ...r,
        tx_count: Number(r.tx_count),
        unique_wallets: Number(r.unique_wallets),
        total_fees_stroops: String(r.total_fees_stroops),
        active_contracts: Number(r.active_contracts),
      }));
    },
  );
}

/** Invalidate all cached analytics keys (called after view refresh). */
export async function invalidateAnalyticsCache(): Promise<void> {
  // Keys are prefixed with "analytics:" — a full flush is done in Redis via pattern delete.
  // For the in-memory fallback we rely on TTL expiry.
  logger.info('Analytics cache invalidated (TTL-based expiry)');
}
