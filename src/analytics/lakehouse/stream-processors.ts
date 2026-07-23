/**
 * Layer 1 — Stream Processors (Issue #551)
 *
 * Kafka-Streams / Flink-style operators implemented as pure, testable
 * functions plus stateful operator classes. Three processors are provided:
 *
 *   1. Windowed aggregation  — tumbling & sliding windows for trading volume
 *      per 5-minute bucket and gas price per ledger.
 *   2. Enrichment join       — stream-table join against a keyed lookup
 *      (token metadata, contract labels), with a bounded state store.
 *   3. Anomaly detection      — online EWMA + z-score detector for volume /
 *      gas spikes, no full-history retention required.
 *
 * All operators are deterministic given their input sequence, so a replay of
 * the bus reproduces identical materialized-view state — a prerequisite for
 * exactly-once end-to-end.
 */

// ── Windowed aggregation ───────────────────────────────────────────────────────

export interface WindowSpec {
  /** Window size in ms (e.g. 300_000 for 5 minutes). */
  sizeMs: number;
  /** Advance in ms. Equal to sizeMs → tumbling; smaller → sliding/hopping. */
  advanceMs: number;
}

export interface AggInput {
  /** Event time in ms. */
  timestamp: number;
  /** Grouping key, e.g. contract_id or "network:ledger". */
  key: string;
  /** Numeric measure to aggregate (volume, fee, …). */
  value: number;
}

export interface WindowedAgg {
  key: string;
  windowStart: number;
  windowEnd: number;
  count: number;
  sum: number;
  min: number;
  max: number;
  avg: number;
}

/** Enumerate the window-start timestamps a given event time belongs to. */
export function windowsFor(ts: number, spec: WindowSpec): number[] {
  const { sizeMs, advanceMs } = spec;
  if (advanceMs <= 0 || sizeMs <= 0) throw new Error('window sizes must be positive');
  const starts: number[] = [];
  // Earliest window whose [start, start+size) still contains ts.
  const earliest = Math.floor((ts - sizeMs + advanceMs) / advanceMs) * advanceMs;
  for (let start = earliest; start <= ts; start += advanceMs) {
    if (ts >= start && ts < start + sizeMs) starts.push(start);
  }
  return starts;
}

/**
 * Stateful windowed aggregator. Emits/updates one bucket per (key, window).
 * `advanceWatermark` finalizes and returns windows that closed before the
 * watermark so downstream sinks can flush them and free memory.
 */
export class WindowAggregator {
  private buckets = new Map<string, WindowedAgg>();

  constructor(private spec: WindowSpec) {}

  private id(key: string, windowStart: number): string {
    return `${key}\u001f${windowStart}`;
  }

  add(input: AggInput): void {
    for (const start of windowsFor(input.timestamp, this.spec)) {
      const id = this.id(input.key, start);
      const existing = this.buckets.get(id);
      if (!existing) {
        this.buckets.set(id, {
          key: input.key,
          windowStart: start,
          windowEnd: start + this.spec.sizeMs,
          count: 1,
          sum: input.value,
          min: input.value,
          max: input.value,
          avg: input.value,
        });
      } else {
        existing.count += 1;
        existing.sum += input.value;
        existing.min = Math.min(existing.min, input.value);
        existing.max = Math.max(existing.max, input.value);
        existing.avg = existing.sum / existing.count;
      }
    }
  }

  /** Snapshot of all currently-open buckets. */
  snapshot(): WindowedAgg[] {
    return [...this.buckets.values()].sort(
      (a, b) => a.windowStart - b.windowStart || a.key.localeCompare(b.key),
    );
  }

  /** Return and evict all windows that have fully closed by `watermark`. */
  advanceWatermark(watermark: number): WindowedAgg[] {
    const closed: WindowedAgg[] = [];
    for (const [id, bucket] of this.buckets) {
      if (bucket.windowEnd <= watermark) {
        closed.push(bucket);
        this.buckets.delete(id);
      }
    }
    return closed.sort((a, b) => a.windowStart - b.windowStart || a.key.localeCompare(b.key));
  }
}

// ── Enrichment join (stream × table) ───────────────────────────────────────────

export interface LookupTable<V> {
  get(key: string): V | undefined;
}

/**
 * Bounded key/value state store with LRU eviction — the local materialization
 * of a compacted "table" topic (token metadata, contract ABIs, wallet labels).
 */
export class KeyedStateStore<V> implements LookupTable<V> {
  private map = new Map<string, V>();
  constructor(private maxEntries = 100_000) {}

  put(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  get(key: string): V | undefined {
    return this.map.get(key);
  }

  get size(): number {
    return this.map.size;
  }
}

/**
 * Left-join a stream record against a lookup table. Missing lookups do not drop
 * the record (left-join semantics) — enrichment fields are simply left null.
 */
export function enrichmentJoin<
  S extends Record<string, unknown>,
  V extends Record<string, unknown>,
>(record: S, joinKey: string, table: LookupTable<V>): S & Partial<V> {
  const enrichment = table.get(joinKey);
  return { ...record, ...(enrichment ?? {}) } as S & Partial<V>;
}

// ── Anomaly detection (online EWMA + z-score) ──────────────────────────────────

export interface AnomalyConfig {
  /** Smoothing factor (0,1]; higher reacts faster. */
  alpha: number;
  /** z-score threshold for flagging. */
  threshold: number;
  /** Minimum samples before the detector is armed. */
  warmup: number;
}

export interface AnomalyResult {
  key: string;
  value: number;
  mean: number;
  stddev: number;
  zScore: number;
  isAnomaly: boolean;
}

/**
 * Streaming anomaly detector maintaining an exponentially-weighted mean and
 * variance per key (Welford-style EWMA). Constant memory per key, no history.
 */
export class AnomalyDetector {
  private state = new Map<string, { mean: number; variance: number; n: number }>();

  constructor(private cfg: AnomalyConfig) {
    if (cfg.alpha <= 0 || cfg.alpha > 1) throw new Error('alpha must be in (0,1]');
  }

  observe(key: string, value: number): AnomalyResult {
    const s = this.state.get(key) ?? { mean: value, variance: 0, n: 0 };
    const { alpha } = this.cfg;

    // Score the incoming point against the model learned SO FAR (prior mean /
    // stddev) — scoring against the post-update stats would let a large spike
    // inflate its own baseline and mask itself.
    const priorStddev = Math.sqrt(s.variance);
    const zScore = priorStddev > 0 ? (value - s.mean) / priorStddev : 0;
    const armed = s.n >= this.cfg.warmup;
    const isAnomaly = armed && Math.abs(zScore) >= this.cfg.threshold;

    // EWMA mean/variance update (West, 1979).
    const diff = value - s.mean;
    const incr = alpha * diff;
    const newMean = s.mean + incr;
    const newVariance = (1 - alpha) * (s.variance + diff * incr);
    this.state.set(key, { mean: newMean, variance: newVariance, n: s.n + 1 });

    return {
      key,
      value,
      mean: newMean,
      stddev: Math.sqrt(newVariance),
      zScore,
      isAnomaly,
    };
  }

  reset(key: string): void {
    this.state.delete(key);
  }
}

// ── Convenience specs matching the issue's requirements ────────────────────────

/** Trading volume per 5-minute tumbling window. */
export const VOLUME_5MIN: WindowSpec = { sizeMs: 5 * 60_000, advanceMs: 5 * 60_000 };

/** 1-minute hopping window advancing every 20s — for near-real-time dashboards. */
export const VOLUME_1MIN_HOP: WindowSpec = { sizeMs: 60_000, advanceMs: 20_000 };

export const DEFAULT_ANOMALY: AnomalyConfig = { alpha: 0.3, threshold: 3.0, warmup: 10 };
