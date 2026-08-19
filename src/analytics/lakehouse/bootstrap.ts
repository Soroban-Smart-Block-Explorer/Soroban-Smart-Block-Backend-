/**
 * Lakehouse wiring (Issue #551)
 *
 * Assembles the four layers into a single working instance and registers layer
 * executors on the gateway. The default build uses the in-memory adapters so it
 * runs anywhere (tests, single-node, the API demo endpoints); switching the
 * `LAKEHOUSE_*_DRIVER` env vars swaps in Kafka / ClickHouse / Trino without
 * touching this file.
 *
 * The three gateway executors all resolve against the OLAP store here for a
 * self-contained demo. In production the `stream-view` executor reads Layer 1
 * windowed state, `olap-view` reads a ClickHouse materialized view, and
 * `federated` drives the Layer 3 planner across PostgreSQL + ClickHouse + Trino.
 */

import { createDefaultRegistry, type SchemaRegistry } from './schema-registry';
import { InMemoryOlapStore, bootstrapOlap, type OlapRow, type OlapStore } from './olap-store';
import { TierManager, DEFAULT_TIER_POLICY, type Tier } from './tiering';
import type { PartitionSpan } from './federated-query';
import {
  QueryGateway,
  DEFAULT_GATEWAY_CONFIG,
  type GatewayRequest,
  type RoutingDecision,
  type LayerExecutor,
} from './query-gateway';

export interface Lakehouse {
  registry: SchemaRegistry;
  olap: OlapStore;
  tiers: TierManager;
  gateway: QueryGateway;
  catalog: { spans(dataset: string): PartitionSpan[]; tiers: TierManager };
}

const DAY = DEFAULT_TIER_POLICY.dayMs;

/** Executor that aggregates the in-memory OLAP store for a request's range. */
function olapExecutor(store: OlapStore): LayerExecutor {
  return {
    async execute(req: GatewayRequest, _decision: RoutingDecision): Promise<OlapRow[]> {
      return store.aggregate({
        table: req.dataset,
        groupBy: req.groupBy,
        measures: req.measures,
        where: (row) => {
          const t = Number(row.event_time);
          return t >= req.from && t <= req.to;
        },
      });
    },
  };
}

/**
 * Build a fully-wired in-memory lakehouse seeded with `now`-relative demo data
 * spanning hot (today), warm (30d ago) and cold (200d ago) tiers so the
 * federated planner and tier manager have something to classify.
 */
export async function buildDemoLakehouse(now: number): Promise<Lakehouse> {
  const registry = createDefaultRegistry();
  const olap = new InMemoryOlapStore();
  await bootstrapOlap(olap);

  const seed: OlapRow[] = [];
  const tierAges: Array<{ tier: Tier; ageDays: number; ledger: number }> = [
    { tier: 'hot', ageDays: 1, ledger: 5_000_000 },
    { tier: 'warm', ageDays: 30, ledger: 4_800_000 },
    { tier: 'cold', ageDays: 200, ledger: 3_000_000 },
  ];

  for (const { ageDays, ledger } of tierAges) {
    const eventTime = now - ageDays * DAY;
    for (let i = 0; i < 10; i++) {
      seed.push({
        network_id: 'mainnet',
        tx_hash: `hash-${ledger}-${i}`,
        ledger_sequence: ledger + i,
        ledger_close_time: eventTime,
        event_time: eventTime,
        contract_id: i % 2 === 0 ? 'CSWAP' : 'CLEND',
        wallet_address: `G${i}`,
        operation_type: 'invoke',
        fee_charged: 100 + i,
        resource_instructions: 1_000 + i * 10,
        amount_usd: 500 + i * 25,
        mev_extracted_usd: i % 3 === 0 ? 12.5 : 0,
        compliance_flag: i % 5 === 0 ? 'ofac_review' : '',
      });
    }
  }
  await olap.insert('txn_events', seed);

  // Tier manager: one partition per age bucket.
  const tiers = new TierManager();
  for (const { tier, ageDays, ledger } of tierAges) {
    tiers.register({
      id: `txn_events/${ledger}`,
      newestEventTime: now - ageDays * DAY,
      currentTier: tier,
      rowCount: 10,
      sizeBytes: 10 * 512,
    });
  }

  const catalog = {
    tiers,
    spans(dataset: string): PartitionSpan[] {
      if (dataset !== 'txn_events') return [];
      return tierAges.map(({ ageDays, ledger }) => {
        const eventTime = now - ageDays * DAY;
        return { id: `txn_events/${ledger}`, from: eventTime - DAY, to: eventTime + DAY };
      });
    },
  };

  const gateway = new QueryGateway(DEFAULT_GATEWAY_CONFIG, catalog);
  const exec = olapExecutor(olap);
  gateway.registerExecutor('stream-view', exec);
  gateway.registerExecutor('olap-view', exec);
  gateway.registerExecutor('federated', exec);

  return { registry, olap, tiers, gateway, catalog };
}
