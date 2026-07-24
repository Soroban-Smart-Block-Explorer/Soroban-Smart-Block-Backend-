/**
 * Layer 4 — Unified Query Gateway (Issue #551)
 *
 * A single entry point that routes an analytics request to the correct layer
 * based on three signals:
 *
 *   • time range        — recent data lives hot; historical data warm/cold.
 *   • aggregation level  — pre-aggregated requests hit materialized views.
 *   • freshness need     — "realtime" bypasses the cache and the cold path.
 *
 * The gateway also owns cross-layer concerns the individual engines should not:
 * per-layer cost estimation, per-layer timeouts, and a freshness-aware result
 * cache keyed on the normalized request.
 */

import { logger } from '../../logger';
import { planFederatedQuery, type FederatedRequest, type PartitionSpan } from './federated-query';
import type { TierManager } from './tiering';

// ── Request / response types ───────────────────────────────────────────────────

export type Freshness = 'realtime' | 'near-realtime' | 'batch';
export type Aggregation = 'raw' | 'pre-aggregated';

export interface GatewayRequest {
  dataset: string;
  from: number;
  to: number;
  groupBy: string[];
  measures: FederatedRequest['measures'];
  freshness?: Freshness;
  aggregation?: Aggregation;
  /** Caller-supplied hard timeout across all layers (ms). */
  timeoutMs?: number;
}

export type RouteTarget =
  | 'stream-view' // Layer 1 materialized view — freshest, sub-second
  | 'olap-view' // Layer 2 ClickHouse materialized view — pre-aggregated
  | 'federated'; // Layer 3 planner — hot + warm + cold

export interface LayerCost {
  target: RouteTarget;
  estimatedScanRows: number;
  estimatedCostUsd: number;
  estimatedLatencyMs: number;
  timeoutMs: number;
}

export interface RoutingDecision {
  target: RouteTarget;
  reason: string;
  cost: LayerCost;
}

export interface GatewayResult {
  rows: Record<string, string | number>[];
  target: RouteTarget;
  cacheHit: boolean;
  cost: LayerCost;
  executionMs: number;
}

// ── Configuration ──────────────────────────────────────────────────────────────

export interface GatewayConfig {
  /** Data newer than this (ms) can be served by the stream view. */
  streamHorizonMs: number;
  /** Requests entirely within this window prefer hot/warm over cold. */
  olapHorizonMs: number;
  perLayerTimeoutMs: Record<RouteTarget, number>;
  /** Cost per million rows scanned, per target. */
  costPerMillionRows: Record<RouteTarget, number>;
  cacheTtlMs: number;
  cacheMaxEntries: number;
}

export const DEFAULT_GATEWAY_CONFIG: GatewayConfig = {
  streamHorizonMs: 60 * 60 * 1000, // 1h
  olapHorizonMs: 90 * 24 * 60 * 60 * 1000, // 90d
  perLayerTimeoutMs: {
    'stream-view': 1_000,
    'olap-view': 5_000,
    federated: 30_000,
  },
  costPerMillionRows: {
    'stream-view': 0,
    'olap-view': 0.0001,
    federated: 0.005,
  },
  cacheTtlMs: 30_000,
  cacheMaxEntries: 1_000,
};

// ── Result cache (freshness-aware, LRU + TTL) ──────────────────────────────────

interface CacheEntry {
  rows: Record<string, string | number>[];
  cost: LayerCost;
  target: RouteTarget;
  storedAt: number;
}

export class ResultCache {
  private entries = new Map<string, CacheEntry>();
  constructor(
    private ttlMs: number,
    private maxEntries: number,
  ) {}

  static keyFor(req: GatewayRequest): string {
    return JSON.stringify({
      d: req.dataset,
      f: req.from,
      t: req.to,
      g: [...req.groupBy].sort(),
      m: req.measures.map((x) => `${x.fn}:${x.column ?? ''}:${x.as}`).sort(),
      a: req.aggregation ?? 'raw',
    });
  }

  get(key: string, now: number): CacheEntry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (now - entry.storedAt > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    // LRU touch.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  set(key: string, entry: CacheEntry): void {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

// ── Routing ────────────────────────────────────────────────────────────────────

/**
 * Choose a target layer. `now` anchors the freshness window.
 *
 *   realtime + recent window            → stream-view (Layer 1)
 *   pre-aggregated + within OLAP horizon → olap-view  (Layer 2)
 *   everything else                      → federated  (Layer 3)
 */
export function route(req: GatewayRequest, now: number, cfg: GatewayConfig): RoutingDecision {
  const freshness = req.freshness ?? 'batch';
  const aggregation = req.aggregation ?? 'raw';
  const spanMs = req.to - req.from;
  const ageOfNewestMs = now - req.to;
  const rangeRows = estimateRows(spanMs, req.groupBy.length);

  let target: RouteTarget;
  let reason: string;

  const withinStreamHorizon =
    ageOfNewestMs <= cfg.streamHorizonMs && req.from >= now - cfg.streamHorizonMs;
  const withinOlapHorizon = req.from >= now - cfg.olapHorizonMs;

  if (freshness === 'realtime' && withinStreamHorizon) {
    target = 'stream-view';
    reason = 'realtime freshness within stream horizon — served by Layer 1 windowed view';
  } else if (aggregation === 'pre-aggregated' && withinOlapHorizon) {
    target = 'olap-view';
    reason = 'pre-aggregated request within OLAP horizon — served by ClickHouse materialized view';
  } else {
    target = 'federated';
    reason = withinOlapHorizon
      ? 'raw/batch request — federated across hot + warm tiers'
      : 'range extends into cold storage — federated across hot + warm + cold (in place)';
  }

  const cost = costFor(target, rangeRows, cfg);
  return { target, reason, cost };
}

/** Rough row-count estimate: ~1 row/sec of span, divided by group cardinality. */
function estimateRows(spanMs: number, groupCols: number): number {
  const base = Math.max(1, Math.floor(spanMs / 1000));
  const groupingFactor = Math.max(1, groupCols * 2);
  return Math.floor(base / groupingFactor) || base;
}

export function costFor(target: RouteTarget, scanRows: number, cfg: GatewayConfig): LayerCost {
  const estimatedCostUsd = (scanRows / 1_000_000) * cfg.costPerMillionRows[target];
  const latencyByTarget: Record<RouteTarget, number> = {
    'stream-view': 20,
    'olap-view': 200,
    federated: 800,
  };
  return {
    target,
    estimatedScanRows: scanRows,
    estimatedCostUsd,
    estimatedLatencyMs: latencyByTarget[target] + Math.floor(scanRows / 10_000),
    timeoutMs: cfg.perLayerTimeoutMs[target],
  };
}

// ── Executor abstraction ───────────────────────────────────────────────────────

/**
 * The gateway does not talk to engines directly — it delegates to executors so
 * the routing/cost/cache logic is testable in isolation and the engines can be
 * swapped. Register one executor per target.
 */
export interface LayerExecutor {
  execute(
    req: GatewayRequest,
    decision: RoutingDecision,
  ): Promise<Record<string, string | number>[]>;
}

export class QueryGateway {
  private cache: ResultCache;
  private executors = new Map<RouteTarget, LayerExecutor>();

  constructor(
    private cfg: GatewayConfig = DEFAULT_GATEWAY_CONFIG,
    /** Optional catalog + tier manager for the federated planner. */
    private catalog?: { spans(dataset: string): PartitionSpan[]; tiers: TierManager },
  ) {
    this.cache = new ResultCache(cfg.cacheTtlMs, cfg.cacheMaxEntries);
  }

  registerExecutor(target: RouteTarget, executor: LayerExecutor): void {
    this.executors.set(target, executor);
  }

  /** Expose routing for dry-run / cost-preview endpoints. */
  plan(req: GatewayRequest, now: number): RoutingDecision {
    return route(req, now, this.cfg);
  }

  /** Build the federated plan for a request (Layer 3 introspection). */
  federatedPlan(req: GatewayRequest) {
    if (!this.catalog) throw new Error('No catalog configured for federated planning');
    const fr: FederatedRequest = {
      dataset: req.dataset,
      range: { from: req.from, to: req.to },
      groupBy: req.groupBy,
      measures: req.measures,
    };
    return planFederatedQuery(fr, this.catalog.spans(req.dataset), this.catalog.tiers);
  }

  async execute(req: GatewayRequest, now: number): Promise<GatewayResult> {
    const decision = route(req, now, this.cfg);

    // realtime requests must never be served stale.
    const cacheable = (req.freshness ?? 'batch') !== 'realtime';
    const cacheKey = ResultCache.keyFor(req);

    if (cacheable) {
      const hit = this.cache.get(cacheKey, now);
      if (hit) {
        return {
          rows: hit.rows,
          target: hit.target,
          cacheHit: true,
          cost: hit.cost,
          executionMs: 0,
        };
      }
    }

    const executor = this.executors.get(decision.target);
    if (!executor) {
      throw new Error(`No executor registered for target "${decision.target}"`);
    }

    const timeoutMs = Math.min(req.timeoutMs ?? decision.cost.timeoutMs, decision.cost.timeoutMs);

    const rows = await withTimeout(
      executor.execute(req, decision),
      timeoutMs,
      `Query to ${decision.target} exceeded ${timeoutMs}ms`,
    );

    if (cacheable) {
      this.cache.set(cacheKey, {
        rows,
        cost: decision.cost,
        target: decision.target,
        storedAt: now,
      });
    }

    logger.info('Gateway query executed', {
      target: decision.target,
      reason: decision.reason,
      rows: rows.length,
      estimatedCostUsd: decision.cost.estimatedCostUsd,
    });

    return {
      rows,
      target: decision.target,
      cacheHit: false,
      cost: decision.cost,
      // `now` anchors an injected clock; report the modelled layer latency.
      executionMs: decision.cost.estimatedLatencyMs,
    };
  }

  invalidateCache(): void {
    this.cache.clear();
  }

  get cacheSize(): number {
    return this.cache.size;
  }
}

// ── Timeout helper ─────────────────────────────────────────────────────────────

export class LayerTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LayerTimeoutError';
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new LayerTimeoutError(message)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
