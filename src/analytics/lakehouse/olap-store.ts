/**
 * Layer 2 — OLAP Analytics Engine (Issue #551)
 *
 * A columnar analytics store abstraction. The production driver targets
 * ClickHouse over its HTTP interface (`clickhouse://` / port 8123); an
 * in-memory columnar engine implements the same `OlapStore` interface for
 * tests and single-node use.
 *
 * The CDC pipeline (PostgreSQL → Kafka via Debezium → OLAP) lands rows into
 * the raw tables; ClickHouse `MATERIALIZED VIEW`s roll them up into the three
 * dashboards the issue calls for:
 *
 *   • MEV analytics          (sandwiches, backruns, extracted value per block)
 *   • Compliance trends       (flagged-address exposure over time)
 *   • Protocol economics      (fees, revenue, active users — monthly)
 *
 * The DDL is emitted as SQL strings so it can be applied by a migration runner
 * against a real cluster; the in-memory engine interprets a small subset of
 * SQL-like aggregation for tests.
 */

import { logger } from '../../logger';

// ── Store interface ────────────────────────────────────────────────────────────

export interface OlapColumn {
  name: string;
  type: 'String' | 'UInt64' | 'Int64' | 'Float64' | 'DateTime' | 'Date';
}

export interface OlapTableSpec {
  name: string;
  columns: OlapColumn[];
  /** ClickHouse ORDER BY / primary key — drives columnar locality. */
  orderBy: string[];
  /** Partition expression, e.g. `toYYYYMM(ledger_close_time)`. */
  partitionBy?: string;
  engine?: 'MergeTree' | 'ReplacingMergeTree' | 'SummingMergeTree' | 'AggregatingMergeTree';
}

export type OlapRow = Record<string, string | number>;

export interface OlapStore {
  createTable(spec: OlapTableSpec): Promise<void>;
  insert(table: string, rows: OlapRow[]): Promise<number>;
  /** Aggregate query — see `AggregateQuery`. */
  aggregate(q: AggregateQuery): Promise<OlapRow[]>;
  count(table: string): Promise<number>;
}

export interface AggregateQuery {
  table: string;
  /** Columns to group by. */
  groupBy: string[];
  /** Aggregations to compute. */
  measures: Array<{ as: string; fn: 'sum' | 'count' | 'avg' | 'min' | 'max'; column?: string }>;
  /** Optional row filter. */
  where?: (row: OlapRow) => boolean;
  orderBy?: { column: string; dir: 'asc' | 'desc' };
  limit?: number;
}

// ── In-memory columnar engine ──────────────────────────────────────────────────

export class InMemoryOlapStore implements OlapStore {
  private tables = new Map<string, { spec: OlapTableSpec; rows: OlapRow[] }>();

  async createTable(spec: OlapTableSpec): Promise<void> {
    if (!this.tables.has(spec.name)) {
      this.tables.set(spec.name, { spec, rows: [] });
    }
  }

  async insert(table: string, rows: OlapRow[]): Promise<number> {
    const t = this.tables.get(table);
    if (!t) throw new Error(`OLAP table "${table}" does not exist`);
    t.rows.push(...rows);
    return rows.length;
  }

  async count(table: string): Promise<number> {
    return this.tables.get(table)?.rows.length ?? 0;
  }

  async aggregate(q: AggregateQuery): Promise<OlapRow[]> {
    const t = this.tables.get(q.table);
    if (!t) throw new Error(`OLAP table "${q.table}" does not exist`);

    const source = q.where ? t.rows.filter(q.where) : t.rows;
    const groups = new Map<string, OlapRow[]>();

    for (const row of source) {
      const gkey = q.groupBy.map((c) => String(row[c])).join('\u0001');
      const arr = groups.get(gkey);
      if (arr) arr.push(row);
      else groups.set(gkey, [row]);
    }

    let out: OlapRow[] = [];
    for (const [, rows] of groups) {
      const result: OlapRow = {};
      for (const col of q.groupBy) result[col] = rows[0][col];
      for (const m of q.measures) {
        result[m.as] = applyMeasure(m.fn, m.column, rows);
      }
      out.push(result);
    }

    if (q.orderBy) {
      const { column, dir } = q.orderBy;
      out.sort((a, b) => {
        const av = a[column];
        const bv = b[column];
        const cmp =
          typeof av === 'number' && typeof bv === 'number'
            ? av - bv
            : String(av).localeCompare(String(bv));
        return dir === 'desc' ? -cmp : cmp;
      });
    }
    if (q.limit !== undefined) out = out.slice(0, q.limit);
    return out;
  }
}

function applyMeasure(
  fn: AggregateQuery['measures'][number]['fn'],
  column: string | undefined,
  rows: OlapRow[],
): number {
  if (fn === 'count') return rows.length;
  const col = column;
  if (!col) throw new Error(`measure "${fn}" requires a column`);
  const nums = rows.map((r) => Number(r[col])).filter((n) => !Number.isNaN(n));
  if (nums.length === 0) return 0;
  switch (fn) {
    case 'sum':
      return nums.reduce((a, b) => a + b, 0);
    case 'avg':
      return nums.reduce((a, b) => a + b, 0) / nums.length;
    case 'min':
      return Math.min(...nums);
    case 'max':
      return Math.max(...nums);
    default:
      return 0;
  }
}

// ── ClickHouse HTTP adapter (production seam) ──────────────────────────────────

export class ClickHouseOlapStore implements OlapStore {
  private url: string;
  constructor(url = process.env.CLICKHOUSE_URL ?? 'http://clickhouse:8123') {
    this.url = url;
  }

  private async exec(sql: string): Promise<string> {
    const resp = await fetch(this.url, { method: 'POST', body: sql });
    if (!resp.ok) throw new Error(`ClickHouse error ${resp.status}: ${await resp.text()}`);
    return resp.text();
  }

  async createTable(spec: OlapTableSpec): Promise<void> {
    await this.exec(renderCreateTable(spec));
  }

  async insert(table: string, rows: OlapRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    const body = rows.map((r) => JSON.stringify(r)).join('\n');
    await this.exec(`INSERT INTO ${table} FORMAT JSONEachRow\n${body}`);
    return rows.length;
  }

  async count(table: string): Promise<number> {
    const out = await this.exec(`SELECT count() FROM ${table} FORMAT TabSeparated`);
    return parseInt(out.trim(), 10) || 0;
  }

  async aggregate(q: AggregateQuery): Promise<OlapRow[]> {
    const out = await this.exec(renderAggregate(q) + ' FORMAT JSONEachRow');
    return out
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as OlapRow);
  }
}

// ── SQL rendering (used by the ClickHouse adapter and migration runner) ────────

export function renderCreateTable(spec: OlapTableSpec): string {
  const cols = spec.columns.map((c) => `  ${c.name} ${c.type}`).join(',\n');
  const engine = spec.engine ?? 'MergeTree';
  const parts = [
    `CREATE TABLE IF NOT EXISTS ${spec.name} (`,
    cols,
    `) ENGINE = ${engine}()`,
    spec.partitionBy ? `PARTITION BY ${spec.partitionBy}` : '',
    `ORDER BY (${spec.orderBy.join(', ')})`,
  ];
  return parts.filter(Boolean).join('\n');
}

export function renderAggregate(q: AggregateQuery): string {
  const measures = q.measures.map((m) =>
    m.fn === 'count' ? `count() AS ${m.as}` : `${m.fn}(${m.column}) AS ${m.as}`,
  );
  const select = [...q.groupBy, ...measures].join(', ');
  const parts = [`SELECT ${select} FROM ${q.table}`];
  parts.push(`GROUP BY ${q.groupBy.join(', ')}`);
  if (q.orderBy) parts.push(`ORDER BY ${q.orderBy.column} ${q.orderBy.dir.toUpperCase()}`);
  if (q.limit !== undefined) parts.push(`LIMIT ${q.limit}`);
  return parts.join(' ');
}

// ── Raw table specs (CDC targets) ──────────────────────────────────────────────

export const OLAP_TABLES: OlapTableSpec[] = [
  {
    name: 'txn_events',
    engine: 'MergeTree',
    partitionBy: 'toYYYYMM(ledger_close_time)',
    orderBy: ['network_id', 'contract_id', 'ledger_close_time'],
    columns: [
      { name: 'network_id', type: 'String' },
      { name: 'tx_hash', type: 'String' },
      { name: 'ledger_sequence', type: 'UInt64' },
      { name: 'ledger_close_time', type: 'DateTime' },
      { name: 'contract_id', type: 'String' },
      { name: 'wallet_address', type: 'String' },
      { name: 'operation_type', type: 'String' },
      { name: 'fee_charged', type: 'UInt64' },
      { name: 'resource_instructions', type: 'UInt64' },
      { name: 'amount_usd', type: 'Float64' },
      { name: 'mev_extracted_usd', type: 'Float64' },
      { name: 'compliance_flag', type: 'String' },
    ],
  },
];

// ── Materialized views for the three dashboards ────────────────────────────────

export interface MaterializedViewSpec {
  name: string;
  dashboard: 'mev' | 'compliance' | 'protocol-economics';
  /** The aggregate query the view maintains. */
  query: AggregateQuery;
  /** ClickHouse DDL for the incremental MATERIALIZED VIEW. */
  ddl: string;
}

export const MATERIALIZED_VIEWS: MaterializedViewSpec[] = [
  {
    name: 'mv_mev_per_block',
    dashboard: 'mev',
    query: {
      table: 'txn_events',
      groupBy: ['network_id', 'ledger_sequence'],
      measures: [
        { as: 'mev_usd', fn: 'sum', column: 'mev_extracted_usd' },
        { as: 'tx_count', fn: 'count' },
      ],
      orderBy: { column: 'mev_usd', dir: 'desc' },
    },
    ddl: `CREATE MATERIALIZED VIEW IF NOT EXISTS mv_mev_per_block
ENGINE = SummingMergeTree()
PARTITION BY intDiv(ledger_sequence, 100000)
ORDER BY (network_id, ledger_sequence)
AS SELECT network_id, ledger_sequence,
          sum(mev_extracted_usd) AS mev_usd,
          count() AS tx_count
   FROM txn_events
   GROUP BY network_id, ledger_sequence`,
  },
  {
    name: 'mv_compliance_daily',
    dashboard: 'compliance',
    query: {
      table: 'txn_events',
      groupBy: ['network_id', 'compliance_flag'],
      measures: [
        { as: 'flagged_volume_usd', fn: 'sum', column: 'amount_usd' },
        { as: 'tx_count', fn: 'count' },
      ],
    },
    ddl: `CREATE MATERIALIZED VIEW IF NOT EXISTS mv_compliance_daily
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(ledger_close_time)
ORDER BY (network_id, compliance_flag, toDate(ledger_close_time))
AS SELECT network_id, compliance_flag, toDate(ledger_close_time) AS day,
          sum(amount_usd) AS flagged_volume_usd,
          count() AS tx_count
   FROM txn_events
   WHERE compliance_flag != ''
   GROUP BY network_id, compliance_flag, day`,
  },
  {
    name: 'mv_protocol_economics_monthly',
    dashboard: 'protocol-economics',
    query: {
      table: 'txn_events',
      groupBy: ['network_id', 'contract_id'],
      measures: [
        { as: 'total_fees', fn: 'sum', column: 'fee_charged' },
        { as: 'active_txns', fn: 'count' },
        { as: 'avg_instructions', fn: 'avg', column: 'resource_instructions' },
      ],
      orderBy: { column: 'total_fees', dir: 'desc' },
    },
    ddl: `CREATE MATERIALIZED VIEW IF NOT EXISTS mv_protocol_economics_monthly
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(ledger_close_time)
ORDER BY (network_id, contract_id, toStartOfMonth(ledger_close_time))
AS SELECT network_id, contract_id, toStartOfMonth(ledger_close_time) AS month,
          sum(fee_charged) AS total_fees,
          count() AS active_txns,
          avg(resource_instructions) AS avg_instructions
   FROM txn_events
   GROUP BY network_id, contract_id, month`,
  },
];

// ── Bootstrap ───────────────────────────────────────────────────────────────

/** Create the raw tables and (for real ClickHouse) apply the view DDL. */
export async function bootstrapOlap(store: OlapStore): Promise<void> {
  for (const spec of OLAP_TABLES) {
    await store.createTable(spec);
  }
  if (store instanceof ClickHouseOlapStore) {
    for (const mv of MATERIALIZED_VIEWS) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (store as any).exec(mv.ddl);
    }
  }
  logger.info('OLAP store bootstrapped', {
    tables: OLAP_TABLES.length,
    views: MATERIALIZED_VIEWS.length,
  });
}

export function createOlapStore(): OlapStore {
  const driver = process.env.LAKEHOUSE_OLAP_DRIVER ?? 'memory';
  return driver === 'clickhouse' ? new ClickHouseOlapStore() : new InMemoryOlapStore();
}
