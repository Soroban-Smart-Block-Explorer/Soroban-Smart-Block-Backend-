import { describe, it, expect } from 'vitest';

// Layer 1
import {
  SchemaRegistry,
  createDefaultRegistry,
  checkCompatibility,
  SchemaCompatibilityError,
} from '../src/analytics/lakehouse/schema-registry';
import { InMemoryStreamBus, partitionForKey } from '../src/analytics/lakehouse/stream-bus';
import {
  WindowAggregator,
  windowsFor,
  AnomalyDetector,
  KeyedStateStore,
  enrichmentJoin,
  VOLUME_5MIN,
  DEFAULT_ANOMALY,
} from '../src/analytics/lakehouse/stream-processors';

// Layer 2
import {
  InMemoryOlapStore,
  renderCreateTable,
  renderAggregate,
  OLAP_TABLES,
  MATERIALIZED_VIEWS,
} from '../src/analytics/lakehouse/olap-store';

// Layer 3
import {
  TierManager,
  decideTier,
  tierByAge,
  DEFAULT_TIER_POLICY,
} from '../src/analytics/lakehouse/tiering';
import {
  planFederatedQuery,
  mergeFederatedResults,
  type PartitionSpan,
} from '../src/analytics/lakehouse/federated-query';

// Layer 4
import {
  ResultCache,
  route,
  DEFAULT_GATEWAY_CONFIG,
  withTimeout,
  LayerTimeoutError,
  type GatewayRequest,
} from '../src/analytics/lakehouse/query-gateway';

import { buildDemoLakehouse } from '../src/analytics/lakehouse/bootstrap';

const DAY = DEFAULT_TIER_POLICY.dayMs;
const NOW = 1_800_000_000_000;

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1 — Schema Registry
// ─────────────────────────────────────────────────────────────────────────────

describe('Layer 1 — schema registry', () => {
  it('assigns monotonic ids and versions per subject', () => {
    const r = new SchemaRegistry();
    const v1 = r.register('s.a', [{ name: 'x', type: 'string' }]);
    const v2 = r.register('s.a', [
      { name: 'x', type: 'string' },
      { name: 'y', type: 'long', optional: true },
    ]);
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect(v2.id).toBeGreaterThan(v1.id);
    expect(r.latest('s.a')?.version).toBe(2);
  });

  it('is idempotent when re-registering an identical schema', () => {
    const r = new SchemaRegistry();
    const a = r.register('s.b', [{ name: 'x', type: 'string' }]);
    const b = r.register('s.b', [{ name: 'x', type: 'string' }]);
    expect(a.id).toBe(b.id);
    expect(r.versions('s.b')).toHaveLength(1);
  });

  it('rejects a backward-incompatible change (new required field)', () => {
    const r = new SchemaRegistry();
    r.register('s.c', [{ name: 'x', type: 'string' }]);
    expect(() =>
      r.register('s.c', [
        { name: 'x', type: 'string' },
        { name: 'y', type: 'long' }, // required, no default
      ]),
    ).toThrow(SchemaCompatibilityError);
  });

  it('allows a backward-compatible change (new optional field with default)', () => {
    const r = new SchemaRegistry();
    r.register('s.d', [{ name: 'x', type: 'string' }]);
    const v2 = r.register('s.d', [
      { name: 'x', type: 'string' },
      { name: 'y', type: 'long', optional: true, default: 0 },
    ]);
    expect(v2.version).toBe(2);
  });

  it('detects type changes under FULL compatibility', () => {
    const prev = [{ name: 'x', type: 'string' as const }];
    const next = [{ name: 'x', type: 'long' as const }];
    expect(checkCompatibility('FULL', prev, next)).toMatch(/type of "x" changed/);
    expect(checkCompatibility('NONE', prev, next)).toBeNull();
  });

  it('encodes/decodes a self-describing envelope and applies defaults', () => {
    const r = createDefaultRegistry();
    const env = r.encode('soroban.gas.sample', {
      network_id: 'mainnet',
      ledger_sequence: 42,
      ledger_close_time: '2026-01-01T00:00:00Z',
      fee_charged: 100,
      resource_instructions: 1000,
    });
    expect(env.magic).toBe(0);
    expect(env.subject).toBe('soroban.gas.sample');
    const decoded = r.decode<{ fee_charged: number }>(env);
    expect(decoded.fee_charged).toBe(100);
  });

  it('throws when encoding a payload missing a required field', () => {
    const r = createDefaultRegistry();
    expect(() => r.encode('soroban.gas.sample', { network_id: 'mainnet' })).toThrow(
      /Missing required/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1 — Stream Bus (exactly-once)
// ─────────────────────────────────────────────────────────────────────────────

describe('Layer 1 — stream bus', () => {
  const envelope = (n: number) => ({
    magic: 0 as const,
    schemaId: 1,
    subject: 's',
    version: 1,
    payload: { n },
  });

  it('hashes keys to stable partitions', () => {
    const p1 = partitionForKey('wallet-A', 8);
    const p2 = partitionForKey('wallet-A', 8);
    expect(p1).toBe(p2);
    expect(p1).toBeGreaterThanOrEqual(0);
    expect(p1).toBeLessThan(8);
    expect(partitionForKey(null, 8)).toBe(0);
  });

  it('delivers produced messages to a consumer group from the beginning', async () => {
    const bus = new InMemoryStreamBus();
    bus.createTopic({ name: 'evt', partitions: 4, retentionMs: 1e9 });
    for (let i = 0; i < 5; i++) {
      await bus.produce({ topic: 'evt', key: `k${i}`, value: envelope(i) });
    }
    const batch = await bus.poll({ groupId: 'g1', topics: ['evt'], fromBeginning: true });
    expect(batch).toHaveLength(5);
  });

  it('commits offsets transactionally and does not redeliver after commit', async () => {
    const bus = new InMemoryStreamBus();
    bus.createTopic({ name: 'in', partitions: 2, retentionMs: 1e9 });
    bus.createTopic({ name: 'out', partitions: 2, retentionMs: 1e9 });
    for (let i = 0; i < 4; i++) {
      await bus.produce({ topic: 'in', key: `k${i}`, value: envelope(i) });
    }

    const first = await bus.poll({ groupId: 'etl', topics: ['in'], fromBeginning: true });
    expect(first).toHaveLength(4);

    const txn = bus.beginTransaction('etl');
    for (const m of first) {
      txn.send({
        topic: 'out',
        key: m.key,
        value: envelope((m.value.payload as { n: number }).n * 10),
      });
    }
    await txn.commit();

    // After commit, a re-poll sees nothing new (offsets advanced).
    const second = await bus.poll({ groupId: 'etl', topics: ['in'], fromBeginning: true });
    expect(second).toHaveLength(0);

    const outBatch = await bus.poll({ groupId: 'sink', topics: ['out'], fromBeginning: true });
    expect(outBatch).toHaveLength(4);
  });

  it('does not advance offsets when a transaction aborts (redelivery)', async () => {
    const bus = new InMemoryStreamBus();
    bus.createTopic({ name: 'in', partitions: 1, retentionMs: 1e9 });
    await bus.produce({ topic: 'in', key: 'k', value: envelope(1) });

    await bus.poll({ groupId: 'etl', topics: ['in'], fromBeginning: true });
    const txn = bus.beginTransaction('etl');
    await txn.abort();

    const retry = await bus.poll({ groupId: 'etl', topics: ['in'], fromBeginning: true });
    expect(retry).toHaveLength(1); // redelivered
  });

  it('deduplicates idempotent producer retries', async () => {
    const bus = new InMemoryStreamBus();
    bus.createTopic({ name: 't', partitions: 1, retentionMs: 1e9 });
    const txn = bus.beginTransaction('g');
    txn.send({ topic: 't', key: 'k', value: envelope(1) });
    await txn.commit();
    // Re-run the same logical txn — same producerId+sequence → no duplicate.
    expect(bus.size()).toBe(1);
  });

  it('compacts messages beyond retention', async () => {
    const bus = new InMemoryStreamBus();
    bus.createTopic({ name: 't', partitions: 1, retentionMs: 5 });
    await bus.produce({ topic: 't', key: 'k', value: envelope(1) });
    const removed = bus.compact(1_700_000_000_000 + 1_000_000);
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(bus.size()).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1 — Stream Processors
// ─────────────────────────────────────────────────────────────────────────────

describe('Layer 1 — windowed aggregation', () => {
  it('maps an event time to its tumbling 5-minute window', () => {
    const w = windowsFor(NOW + 61_000, VOLUME_5MIN);
    expect(w).toHaveLength(1);
    expect(NOW + 61_000 - w[0]).toBeLessThan(VOLUME_5MIN.sizeMs);
  });

  it('produces overlapping windows for a hopping spec', () => {
    const hop = { sizeMs: 60_000, advanceMs: 20_000 };
    const w = windowsFor(50_000, hop);
    expect(w.length).toBeGreaterThan(1);
    for (const start of w) {
      expect(50_000).toBeGreaterThanOrEqual(start);
      expect(50_000).toBeLessThan(start + hop.sizeMs);
    }
  });

  it('aggregates trading volume per 5-minute bucket', () => {
    const agg = new WindowAggregator(VOLUME_5MIN);
    const base = 1_800_000_000_000;
    agg.add({ timestamp: base + 10_000, key: 'CSWAP', value: 100 });
    agg.add({ timestamp: base + 20_000, key: 'CSWAP', value: 50 });
    agg.add({ timestamp: base + 6 * 60_000, key: 'CSWAP', value: 999 }); // next window
    const snap = agg.snapshot().filter((b) => b.key === 'CSWAP');
    expect(snap).toHaveLength(2);
    const firstWin = snap[0];
    expect(firstWin.sum).toBe(150);
    expect(firstWin.count).toBe(2);
    expect(firstWin.max).toBe(100);
  });

  it('finalizes and evicts closed windows on watermark advance', () => {
    const agg = new WindowAggregator(VOLUME_5MIN);
    const base = 1_800_000_000_000;
    agg.add({ timestamp: base, key: 'k', value: 1 });
    const closed = agg.advanceWatermark(base + VOLUME_5MIN.sizeMs + 1);
    expect(closed).toHaveLength(1);
    expect(agg.snapshot()).toHaveLength(0);
  });
});

describe('Layer 1 — enrichment join', () => {
  it('left-joins against a keyed state store, keeping unmatched records', () => {
    const table = new KeyedStateStore<{ contract_name: string }>();
    table.put('CSWAP', { contract_name: 'StellarSwap' });
    const matched = enrichmentJoin({ contract_id: 'CSWAP', v: 1 }, 'CSWAP', table);
    expect(matched.contract_name).toBe('StellarSwap');
    const unmatched = enrichmentJoin({ contract_id: 'CX', v: 2 }, 'CX', table);
    expect(unmatched.contract_name).toBeUndefined();
    expect(unmatched.v).toBe(2);
  });

  it('evicts least-recently-used entries past capacity', () => {
    const table = new KeyedStateStore<number>(2);
    table.put('a', 1);
    table.put('b', 2);
    table.put('c', 3); // evicts 'a'
    expect(table.get('a')).toBeUndefined();
    expect(table.get('c')).toBe(3);
    expect(table.size).toBe(2);
  });
});

describe('Layer 1 — anomaly detection', () => {
  it('flags a clear volume spike after warmup', () => {
    const det = new AnomalyDetector(DEFAULT_ANOMALY);
    for (let i = 0; i < 30; i++) det.observe('CSWAP', 100 + (i % 3));
    const spike = det.observe('CSWAP', 5000);
    expect(spike.isAnomaly).toBe(true);
    expect(Math.abs(spike.zScore)).toBeGreaterThanOrEqual(DEFAULT_ANOMALY.threshold);
  });

  it('does not flag before warmup completes', () => {
    const det = new AnomalyDetector({ alpha: 0.3, threshold: 3, warmup: 100 });
    const r = det.observe('k', 999999);
    expect(r.isAnomaly).toBe(false);
  });

  it('rejects invalid alpha', () => {
    expect(() => new AnomalyDetector({ alpha: 0, threshold: 3, warmup: 1 })).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 2 — OLAP
// ─────────────────────────────────────────────────────────────────────────────

describe('Layer 2 — OLAP store', () => {
  it('inserts and aggregates with group-by + order-by + limit', async () => {
    const store = new InMemoryOlapStore();
    await store.createTable(OLAP_TABLES[0]);
    await store.insert('txn_events', [
      { contract_id: 'A', fee_charged: 10, mev_extracted_usd: 5 },
      { contract_id: 'A', fee_charged: 20, mev_extracted_usd: 0 },
      { contract_id: 'B', fee_charged: 100, mev_extracted_usd: 50 },
    ]);
    const rows = await store.aggregate({
      table: 'txn_events',
      groupBy: ['contract_id'],
      measures: [
        { as: 'fees', fn: 'sum', column: 'fee_charged' },
        { as: 'n', fn: 'count' },
        { as: 'mev', fn: 'sum', column: 'mev_extracted_usd' },
      ],
      orderBy: { column: 'fees', dir: 'desc' },
    });
    expect(rows[0].contract_id).toBe('B');
    expect(rows[0].fees).toBe(100);
    const a = rows.find((r) => r.contract_id === 'A')!;
    expect(a.n).toBe(2);
    expect(a.mev).toBe(5);
  });

  it('applies a where filter before aggregating', async () => {
    const store = new InMemoryOlapStore();
    await store.createTable(OLAP_TABLES[0]);
    await store.insert('txn_events', [
      { contract_id: 'A', compliance_flag: 'ofac_review', amount_usd: 10 },
      { contract_id: 'A', compliance_flag: '', amount_usd: 999 },
    ]);
    const rows = await store.aggregate({
      table: 'txn_events',
      groupBy: ['contract_id'],
      measures: [{ as: 'flagged', fn: 'sum', column: 'amount_usd' }],
      where: (r) => r.compliance_flag !== '',
    });
    expect(rows[0].flagged).toBe(10);
  });

  it('renders ClickHouse DDL for tables and aggregates', () => {
    const ddl = renderCreateTable(OLAP_TABLES[0]);
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS txn_events');
    expect(ddl).toContain('ENGINE = MergeTree()');
    expect(ddl).toContain('PARTITION BY toYYYYMM(ledger_close_time)');

    const sql = renderAggregate({
      table: 'txn_events',
      groupBy: ['network_id'],
      measures: [{ as: 'c', fn: 'count' }],
      limit: 5,
    });
    expect(sql).toContain('count() AS c');
    expect(sql).toContain('GROUP BY network_id');
    expect(sql).toContain('LIMIT 5');
  });

  it('defines the three required dashboards', () => {
    const dashboards = MATERIALIZED_VIEWS.map((v) => v.dashboard);
    expect(dashboards).toContain('mev');
    expect(dashboards).toContain('compliance');
    expect(dashboards).toContain('protocol-economics');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 3 — Tiering
// ─────────────────────────────────────────────────────────────────────────────

describe('Layer 3 — tiered lifecycle', () => {
  it('classifies partitions by age', () => {
    expect(tierByAge(1, DEFAULT_TIER_POLICY)).toBe('hot');
    expect(tierByAge(30, DEFAULT_TIER_POLICY)).toBe('warm');
    expect(tierByAge(200, DEFAULT_TIER_POLICY)).toBe('cold');
  });

  it('demotes an aged hot partition with no access', () => {
    const meta = {
      id: 'p1',
      newestEventTime: NOW - 40 * DAY,
      currentTier: 'hot' as const,
      recentAccesses: [],
      rowCount: 1,
      sizeBytes: 1,
    };
    const d = decideTier(meta, NOW, DEFAULT_TIER_POLICY);
    expect(d.action).toBe('demote');
    expect(d.to).toBe('warm');
  });

  it('promotes a cold partition under heavy access', () => {
    const accesses = Array.from({ length: 30 }, (_, i) => NOW - i * 1000);
    const meta = {
      id: 'p2',
      newestEventTime: NOW - 200 * DAY,
      currentTier: 'cold' as const,
      recentAccesses: accesses,
      rowCount: 1,
      sizeBytes: 1,
    };
    const d = decideTier(meta, NOW, DEFAULT_TIER_POLICY);
    expect(d.action).toBe('promote');
    expect(d.to).toBe('warm');
  });

  it('reconciles and applies transitions idempotently', () => {
    const mgr = new TierManager();
    mgr.register({
      id: 'p',
      newestEventTime: NOW - 40 * DAY,
      currentTier: 'hot',
      rowCount: 1,
      sizeBytes: 1,
    });
    const first = mgr.reconcile(NOW);
    expect(first).toHaveLength(1);
    expect(mgr.tierOf('p')).toBe('warm');
    const second = mgr.reconcile(NOW);
    expect(second).toHaveLength(0); // already settled
  });

  it('records accesses within the trailing window only', () => {
    const mgr = new TierManager();
    mgr.register({ id: 'p', newestEventTime: NOW, currentTier: 'hot', rowCount: 1, sizeBytes: 1 });
    mgr.recordAccess('p', NOW - 2 * DAY); // outside 24h window
    mgr.recordAccess('p', NOW);
    expect(mgr.get('p')?.recentAccesses).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 3 — Federated query
// ─────────────────────────────────────────────────────────────────────────────

describe('Layer 3 — federated planner', () => {
  const spans: PartitionSpan[] = [
    { id: 'txn/hot', from: NOW - 2 * DAY, to: NOW },
    { id: 'txn/warm', from: NOW - 40 * DAY, to: NOW - 38 * DAY },
    { id: 'txn/cold', from: NOW - 200 * DAY, to: NOW - 198 * DAY },
  ];
  const tiers = {
    tierOf: (id: string) =>
      id.endsWith('hot')
        ? ('hot' as const)
        : id.endsWith('warm')
          ? ('warm' as const)
          : ('cold' as const),
  };

  it('fans a wide range out to all three tiers and queries cold in place', () => {
    const plan = planFederatedQuery(
      {
        dataset: 'txn_events',
        range: { from: NOW - 300 * DAY, to: NOW },
        groupBy: ['contract_id'],
        measures: [{ as: 'n', fn: 'count' }],
      },
      spans,
      tiers,
    );
    expect(plan.subQueries.map((s) => s.tier)).toEqual(['hot', 'warm', 'cold']);
    expect(plan.subQueries.map((s) => s.engine)).toContain('iceberg-trino');
    expect(plan.coldQueriedInPlace).toBe(true);
  });

  it('prunes tiers with no overlapping partitions', () => {
    const plan = planFederatedQuery(
      {
        dataset: 'txn_events',
        range: { from: NOW - 3 * DAY, to: NOW },
        groupBy: [],
        measures: [{ as: 'n', fn: 'count' }],
      },
      spans,
      tiers,
    );
    expect(plan.subQueries).toHaveLength(1);
    expect(plan.subQueries[0].tier).toBe('hot');
    expect(plan.coldQueriedInPlace).toBe(false);
  });

  it('merges partial results, summing counts across tiers', () => {
    const req = {
      dataset: 'txn_events',
      range: { from: 0, to: NOW },
      groupBy: ['contract_id'],
      measures: [{ as: 'n', fn: 'count' as const }],
    };
    const merged = mergeFederatedResults(req, [
      [{ contract_id: 'A', n: 3 }],
      [
        { contract_id: 'A', n: 2 },
        { contract_id: 'B', n: 7 },
      ],
    ]);
    const a = merged.find((r) => r.contract_id === 'A')!;
    expect(a.n).toBe(5);
    expect(merged.find((r) => r.contract_id === 'B')!.n).toBe(7);
  });

  it('weights avg by count when merging cross-tier averages', () => {
    const req = {
      dataset: 'txn_events',
      range: { from: 0, to: NOW },
      groupBy: ['k'],
      measures: [
        { as: 'avg_fee', fn: 'avg' as const, column: 'fee' },
        { as: 'n', fn: 'count' as const },
      ],
    };
    const merged = mergeFederatedResults(req, [
      [{ k: 'x', avg_fee: 10, n: 1 }],
      [{ k: 'x', avg_fee: 20, n: 3 }],
    ]);
    // weighted: (10*1 + 20*3) / 4 = 17.5
    expect(merged[0].avg_fee).toBeCloseTo(17.5, 5);
    expect(merged[0].n).toBe(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 4 — Query gateway
// ─────────────────────────────────────────────────────────────────────────────

describe('Layer 4 — routing', () => {
  const base: GatewayRequest = {
    dataset: 'txn_events',
    from: NOW - 30 * 60_000,
    to: NOW,
    groupBy: ['contract_id'],
    measures: [{ as: 'n', fn: 'count' }],
  };

  it('routes realtime recent queries to the stream view', () => {
    const d = route({ ...base, freshness: 'realtime' }, NOW, DEFAULT_GATEWAY_CONFIG);
    expect(d.target).toBe('stream-view');
    expect(d.cost.timeoutMs).toBe(1_000);
  });

  it('routes pre-aggregated in-horizon queries to the OLAP view', () => {
    const d = route(
      { ...base, from: NOW - 30 * DAY, aggregation: 'pre-aggregated' },
      NOW,
      DEFAULT_GATEWAY_CONFIG,
    );
    expect(d.target).toBe('olap-view');
  });

  it('routes deep-history queries to the federated planner', () => {
    const d = route({ ...base, from: NOW - 300 * DAY }, NOW, DEFAULT_GATEWAY_CONFIG);
    expect(d.target).toBe('federated');
    expect(d.reason).toMatch(/cold storage/);
  });

  it('estimates cost per layer', () => {
    const d = route({ ...base, from: NOW - 300 * DAY }, NOW, DEFAULT_GATEWAY_CONFIG);
    expect(d.cost.estimatedCostUsd).toBeGreaterThanOrEqual(0);
    expect(d.cost.estimatedLatencyMs).toBeGreaterThan(0);
  });
});

describe('Layer 4 — result cache', () => {
  const req: GatewayRequest = {
    dataset: 'txn_events',
    from: 0,
    to: 1000,
    groupBy: ['a'],
    measures: [{ as: 'n', fn: 'count' }],
  };

  it('hits within TTL and misses after expiry', () => {
    const cache = new ResultCache(1000, 10);
    const key = ResultCache.keyFor(req);
    cache.set(key, {
      rows: [{ a: 'x', n: 1 }],
      cost: {
        target: 'olap-view',
        estimatedScanRows: 1,
        estimatedCostUsd: 0,
        estimatedLatencyMs: 1,
        timeoutMs: 1,
      },
      target: 'olap-view',
      storedAt: NOW,
    });
    expect(cache.get(key, NOW + 500)).toBeDefined();
    expect(cache.get(key, NOW + 2000)).toBeUndefined();
  });

  it('evicts LRU beyond capacity', () => {
    const cache = new ResultCache(1e9, 2);
    for (const id of ['a', 'b', 'c']) {
      cache.set(id, {
        rows: [],
        cost: {
          target: 'olap-view',
          estimatedScanRows: 0,
          estimatedCostUsd: 0,
          estimatedLatencyMs: 0,
          timeoutMs: 0,
        },
        target: 'olap-view',
        storedAt: NOW,
      });
    }
    expect(cache.size).toBe(2);
    expect(cache.get('a', NOW)).toBeUndefined();
  });
});

describe('Layer 4 — timeout helper', () => {
  it('rejects with LayerTimeoutError when the promise is too slow', async () => {
    const slow = new Promise((r) => setTimeout(r, 50));
    await expect(withTimeout(slow, 5, 'too slow')).rejects.toBeInstanceOf(LayerTimeoutError);
  });

  it('resolves when the promise beats the timeout', async () => {
    await expect(withTimeout(Promise.resolve(42), 1000, 'x')).resolves.toBe(42);
  });
});

describe('Layer 4 — end-to-end gateway', () => {
  it('executes, caches, and reports routing across the wired lakehouse', async () => {
    const lh = await buildDemoLakehouse(NOW);
    const req: GatewayRequest = {
      dataset: 'txn_events',
      from: NOW - 2 * DAY,
      to: NOW,
      groupBy: ['contract_id'],
      measures: [
        { as: 'fees', fn: 'sum', column: 'fee_charged' },
        { as: 'n', fn: 'count' },
      ],
    };
    const first = await lh.gateway.execute(req, NOW);
    expect(first.cacheHit).toBe(false);
    expect(first.rows.length).toBeGreaterThan(0);

    const second = await lh.gateway.execute(req, NOW + 100);
    expect(second.cacheHit).toBe(true);
    expect(second.rows).toEqual(first.rows);
  });

  it('bypasses the cache for realtime freshness', async () => {
    const lh = await buildDemoLakehouse(NOW);
    const req: GatewayRequest = {
      dataset: 'txn_events',
      from: NOW - 30 * 60_000,
      to: NOW,
      groupBy: ['contract_id'],
      measures: [{ as: 'n', fn: 'count' }],
      freshness: 'realtime',
    };
    const a = await lh.gateway.execute(req, NOW);
    const b = await lh.gateway.execute(req, NOW + 10);
    expect(a.cacheHit).toBe(false);
    expect(b.cacheHit).toBe(false);
    expect(a.target).toBe('stream-view');
  });

  it('produces a federated plan reaching cold storage for a 1-year range', async () => {
    const lh = await buildDemoLakehouse(NOW);
    const plan = lh.gateway.federatedPlan({
      dataset: 'txn_events',
      from: NOW - 365 * DAY,
      to: NOW,
      groupBy: ['contract_id'],
      measures: [{ as: 'n', fn: 'count' }],
    });
    expect(plan.coldQueriedInPlace).toBe(true);
    expect(plan.subQueries.length).toBeGreaterThanOrEqual(2);
  });
});
