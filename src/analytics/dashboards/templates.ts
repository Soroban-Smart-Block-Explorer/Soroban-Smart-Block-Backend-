/**
 * Pre-built Dashboard SQL Templates
 *
 * These SQL templates target the Iceberg/Athena data lake (via Trino or Athena).
 * Each template accepts named parameters that are interpolated server-side
 * before execution.  All templates are read-only SELECT statements.
 *
 * Templates:
 *   1. top_contracts_by_dau      — Top 10 contracts by daily active users
 *   2. gas_price_distribution    — Gas price percentiles (p10/p50/p90/p99) over time
 *   3. wallet_creation_rate      — New wallet creation rate by network
 *   4. token_transfer_heatmap    — Token transfer volume heatmap (hourly)
 *   5. contract_composability    — Contract composability network metrics
 */

export interface DashboardTemplate {
  id: string;
  name: string;
  description: string;
  /** SQL template with :param placeholders. */
  sql: string;
  /** Default parameter values. */
  defaultParams: Record<string, string | number>;
  /** Expected query engine for this template. */
  preferredEngine: 'athena' | 'trino';
  /** Estimated typical execution time. */
  typicalLatencyMs: number;
}

// ── Template library ──────────────────────────────────────────────────────────

export const DASHBOARD_TEMPLATES: DashboardTemplate[] = [
  {
    id: 'top_contracts_by_dau',
    name: 'Top 10 Contracts by Daily Active Users',
    description:
      'Ranks contracts by the number of unique wallet addresses that interacted with them each day.',
    sql: `
SELECT
    contract_id,
    contract_name,
    ledger_close_date                       AS activity_date,
    COUNT(DISTINCT wallet_address)          AS daily_active_users,
    COUNT(*)                                AS tx_count,
    SUM(CAST(fee_charged AS DOUBLE))        AS total_fee_stroops,
    AVG(CAST(fee_charged AS DOUBLE))        AS avg_fee_stroops
FROM transactions
WHERE network_id    = :network_id
  AND ledger_close_date BETWEEN :date_from AND :date_to
GROUP BY contract_id, contract_name, ledger_close_date
ORDER BY daily_active_users DESC
LIMIT :limit
    `.trim(),
    defaultParams: {
      network_id: 'mainnet',
      date_from: '2026-01-01',
      date_to: '2026-12-31',
      limit: 10,
    },
    preferredEngine: 'athena',
    typicalLatencyMs: 3000,
  },

  {
    id: 'gas_price_distribution',
    name: 'Gas Price Distribution Over Time',
    description:
      'P10/P50/P90/P99 gas (fee) distribution per day.  Use to spot fee spikes and anomalies.',
    sql: `
SELECT
    ledger_close_date                                                 AS date,
    COUNT(*)                                                          AS tx_count,
    APPROX_PERCENTILE(CAST(fee_charged AS DOUBLE), 0.10)             AS p10_fee_stroops,
    APPROX_PERCENTILE(CAST(fee_charged AS DOUBLE), 0.50)             AS p50_fee_stroops,
    APPROX_PERCENTILE(CAST(fee_charged AS DOUBLE), 0.90)             AS p90_fee_stroops,
    APPROX_PERCENTILE(CAST(fee_charged AS DOUBLE), 0.99)             AS p99_fee_stroops,
    MIN(CAST(fee_charged AS DOUBLE))                                  AS min_fee_stroops,
    MAX(CAST(fee_charged AS DOUBLE))                                  AS max_fee_stroops
FROM transactions
WHERE network_id = :network_id
  AND ledger_close_date BETWEEN :date_from AND :date_to
GROUP BY ledger_close_date
ORDER BY date ASC
    `.trim(),
    defaultParams: {
      network_id: 'mainnet',
      date_from: '2026-01-01',
      date_to: '2026-12-31',
    },
    preferredEngine: 'athena',
    typicalLatencyMs: 4000,
  },

  {
    id: 'wallet_creation_rate',
    name: 'New Wallet Creation Rate by Network',
    description:
      'Counts wallets that appear for the first time in each week, grouped by network.',
    sql: `
WITH first_seen AS (
    SELECT
        network_id,
        wallet_address,
        MIN(ledger_close_date) AS first_activity_date
    FROM transactions
    WHERE ledger_close_date BETWEEN :date_from AND :date_to
    GROUP BY network_id, wallet_address
)
SELECT
    network_id,
    DATE_TRUNC('week', CAST(first_activity_date AS DATE))  AS week_start,
    COUNT(DISTINCT wallet_address)                          AS new_wallets
FROM first_seen
GROUP BY network_id, DATE_TRUNC('week', CAST(first_activity_date AS DATE))
ORDER BY week_start ASC
    `.trim(),
    defaultParams: {
      date_from: '2026-01-01',
      date_to: '2026-12-31',
    },
    preferredEngine: 'trino',
    typicalLatencyMs: 6000,
  },

  {
    id: 'token_transfer_heatmap',
    name: 'Token Transfer Volume Heatmap (Hourly)',
    description:
      'Hour-of-day × day-of-week heatmap of transfer volume for a given token contract.',
    sql: `
SELECT
    EXTRACT(DOW  FROM CAST(ledger_close_time AS TIMESTAMP))  AS day_of_week,  -- 0=Sun
    EXTRACT(HOUR FROM CAST(ledger_close_time AS TIMESTAMP))  AS hour_of_day,
    COUNT(*)                                                   AS transfer_count,
    SUM(CAST(COALESCE(transfer_amount, '0') AS DOUBLE))        AS total_volume
FROM token_transfers
WHERE network_id  = :network_id
  AND contract_id = :token_contract
  AND ledger_close_date BETWEEN :date_from AND :date_to
GROUP BY 1, 2
ORDER BY 1, 2
    `.trim(),
    defaultParams: {
      network_id: 'mainnet',
      token_contract: '',
      date_from: '2026-01-01',
      date_to: '2026-12-31',
    },
    preferredEngine: 'athena',
    typicalLatencyMs: 3500,
  },

  {
    id: 'contract_composability',
    name: 'Contract Composability Network Metrics',
    description:
      'Measures inter-contract call depth and fan-out — useful for dependency and risk analysis.',
    sql: `
SELECT
    contract_id                                       AS caller_contract,
    contract_name                                     AS caller_name,
    event_contract_id                                 AS callee_contract,
    COUNT(*)                                          AS call_count,
    COUNT(DISTINCT wallet_address)                    AS unique_initiators,
    AVG(CAST(fee_charged AS DOUBLE))                  AS avg_fee_stroops,
    MIN(ledger_close_date)                            AS first_seen_date,
    MAX(ledger_close_date)                            AS last_seen_date
FROM contract_calls
WHERE network_id         = :network_id
  AND event_contract_id IS NOT NULL
  AND contract_id       != event_contract_id
  AND ledger_close_date BETWEEN :date_from AND :date_to
GROUP BY contract_id, contract_name, event_contract_id
ORDER BY call_count DESC
LIMIT :limit
    `.trim(),
    defaultParams: {
      network_id: 'mainnet',
      date_from: '2026-01-01',
      date_to: '2026-12-31',
      limit: 50,
    },
    preferredEngine: 'trino',
    typicalLatencyMs: 5000,
  },
];

// ── Template lookup helpers ───────────────────────────────────────────────────

export function getTemplate(id: string): DashboardTemplate | undefined {
  return DASHBOARD_TEMPLATES.find((t) => t.id === id);
}

/**
 * Interpolate :param placeholders in a SQL template with provided values.
 * Values are escaped: strings are single-quoted, numbers are unquoted.
 * Only alphanumeric parameter names are accepted to prevent injection.
 */
export function interpolateTemplate(
  template: DashboardTemplate,
  params: Record<string, string | number>,
): string {
  const merged = { ...template.defaultParams, ...params };
  let sql = template.sql;

  for (const [key, value] of Object.entries(merged)) {
    // Only accept safe parameter names
    if (!/^\w+$/.test(key)) continue;
    const placeholder = new RegExp(`:${key}\\b`, 'g');
    const safe =
      typeof value === 'number'
        ? String(value)
        : `'${String(value).replace(/'/g, "''")}'`;
    sql = sql.replace(placeholder, safe);
  }

  return sql;
}
