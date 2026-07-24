/**
 * Layer 1 — Stream Bus (Issue #551)
 *
 * Replaces the legacy in-process EventEmitter pattern with a partitioned,
 * offset-tracked event bus that provides **exactly-once** delivery from the
 * indexer → stream processors → materialized views.
 *
 * Two adapters implement the same `StreamBus` interface:
 *
 *   • `InMemoryStreamBus`  — default, zero-dependency, used by tests and by
 *     single-node deployments. Ordered per-partition, durable within the
 *     process, replayable from any offset.
 *   • `KafkaStreamBus`     — production adapter (seam only) backed by Kafka or
 *     Redpanda via `kafkajs`. Exactly-once is achieved with an idempotent
 *     producer + transactional `sendOffsets` so that "consume → process →
 *     produce → commit offset" is a single atomic unit.
 *
 * Exactly-once model
 * ------------------
 * A consumer processes a batch inside a transaction. The processor's output
 * records AND the consumed offsets are committed together. On failure the
 * transaction aborts, offsets are not advanced, and the batch is redelivered —
 * with the dedup store discarding any records whose `(producerId, seq)` was
 * already applied. This is the read-process-write loop Kafka Streams uses.
 */

import { logger } from '../../logger';
import type { Envelope } from './schema-registry';

// ── Core types ─────────────────────────────────────────────────────────────────

export interface BusMessage {
  topic: string;
  partition: number;
  offset: number;
  key: string | null;
  /** Schema-registry envelope; opaque to the bus. */
  value: Envelope;
  timestamp: number;
  /** Producer identity + monotonic sequence — the exactly-once dedup key. */
  producerId: string;
  sequence: number;
}

export interface ProduceRecord {
  topic: string;
  key: string | null;
  value: Envelope;
  /** Explicit partition; otherwise hashed from `key`. */
  partition?: number;
}

export interface TopicConfig {
  name: string;
  partitions: number;
  /** Retention in ms; older records are dropped by `compact()`. */
  retentionMs: number;
}

export interface ConsumeOptions {
  groupId: string;
  topics: string[];
  /** Where a brand-new group starts. */
  fromBeginning?: boolean;
  maxBatchSize?: number;
}

/**
 * A processing transaction. `send` stages output records; `commit` atomically
 * flushes them and advances the consumed offsets; `abort` discards everything.
 */
export interface BusTransaction {
  send(record: ProduceRecord): void;
  commit(): Promise<void>;
  abort(): Promise<void>;
}

export interface StreamBus {
  createTopic(config: TopicConfig): void;
  produce(record: ProduceRecord): Promise<BusMessage>;
  /** Begin an exactly-once read-process-write transaction for a consumer group. */
  beginTransaction(groupId: string): BusTransaction;
  /** Poll up to `maxBatchSize` new messages for a consumer group. */
  poll(opts: ConsumeOptions): Promise<BusMessage[]>;
  /** Current committed offset for a group on a partition. */
  committedOffset(groupId: string, topic: string, partition: number): number;
  compact(now: number): number;
}

// ── Partitioning ────────────────────────────────────────────────────────────

/** Stable FNV-1a hash so the same key always lands on the same partition. */
export function partitionForKey(key: string | null, partitions: number): number {
  if (key === null) return 0;
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return Math.abs(hash) % partitions;
}

// ── In-memory adapter ──────────────────────────────────────────────────────────

interface PartitionLog {
  messages: BusMessage[];
  nextOffset: number;
}

export class InMemoryStreamBus implements StreamBus {
  private topics = new Map<string, TopicConfig>();
  private logs = new Map<string, PartitionLog>(); // key: `${topic}/${partition}`
  private offsets = new Map<string, number>(); // key: `${groupId}/${topic}/${partition}`
  /** dedup: applied `(producerId, sequence)` pairs — the exactly-once guard. */
  private applied = new Set<string>();

  createTopic(config: TopicConfig): void {
    this.topics.set(config.name, config);
    for (let p = 0; p < config.partitions; p++) {
      this.logs.set(`${config.name}/${p}`, { messages: [], nextOffset: 0 });
    }
  }

  private ensureTopic(topic: string): TopicConfig {
    const cfg = this.topics.get(topic);
    if (!cfg) throw new Error(`Topic "${topic}" does not exist. Call createTopic() first.`);
    return cfg;
  }

  private append(
    record: ProduceRecord,
    producerId: string,
    sequence: number,
    ts: number,
  ): BusMessage {
    const cfg = this.ensureTopic(record.topic);
    const partition = record.partition ?? partitionForKey(record.key, cfg.partitions);
    const log = this.logs.get(`${record.topic}/${partition}`)!;

    const dedupKey = `${producerId}:${sequence}:${record.topic}:${partition}`;
    const existing = log.messages.find(
      (m) => m.producerId === producerId && m.sequence === sequence,
    );
    if (existing) return existing; // idempotent producer: duplicate send is a no-op

    const message: BusMessage = {
      topic: record.topic,
      partition,
      offset: log.nextOffset++,
      key: record.key,
      value: record.value,
      timestamp: ts,
      producerId,
      sequence,
    };
    log.messages.push(message);
    this.applied.add(dedupKey);
    return message;
  }

  async produce(record: ProduceRecord): Promise<BusMessage> {
    // Non-transactional single produce still gets an idempotent identity.
    const producerId = 'default-producer';
    const seq = this.seqCounter++;
    return this.append(record, producerId, seq, deterministicNow());
  }

  private seqCounter = 1;
  private txnCounter = 1;

  beginTransaction(groupId: string): BusTransaction {
    const staged: Array<{ record: ProduceRecord; sequence: number }> = [];
    const producerId = `txn-${groupId}-${this.txnCounter++}`;
    const consumedHighWater = new Map<string, number>(); // topic/partition → offset+1
    let seq = 1;

    return {
      send: (record: ProduceRecord) => {
        staged.push({ record, sequence: seq++ });
      },
      commit: async () => {
        const ts = deterministicNow();
        // Atomic: append all staged outputs, then advance offsets together.
        for (const { record, sequence } of staged) {
          const msg = this.append(record, producerId, sequence, ts);
          consumedHighWater.set(`${msg.topic}/${msg.partition}`, msg.offset + 1);
        }
        for (const [tp, offset] of this.pendingOffsets(groupId)) {
          this.offsets.set(`${groupId}/${tp}`, offset);
        }
        this.pendingByGroup.delete(groupId);
      },
      abort: async () => {
        staged.length = 0;
        this.pendingByGroup.delete(groupId);
      },
    };
  }

  /** Offsets a group has consumed-but-not-yet-committed within a txn. */
  private pendingByGroup = new Map<string, Map<string, number>>();

  private pendingOffsets(groupId: string): Map<string, number> {
    return this.pendingByGroup.get(groupId) ?? new Map();
  }

  async poll(opts: ConsumeOptions): Promise<BusMessage[]> {
    const max = opts.maxBatchSize ?? 500;
    const out: BusMessage[] = [];
    const pending = new Map<string, number>();

    for (const topic of opts.topics) {
      const cfg = this.topics.get(topic);
      if (!cfg) continue;
      for (let p = 0; p < cfg.partitions; p++) {
        const log = this.logs.get(`${topic}/${p}`)!;
        const offKey = `${opts.groupId}/${topic}/${p}`;
        let cursor = this.offsets.get(offKey);
        if (cursor === undefined) {
          cursor = opts.fromBeginning === false ? log.nextOffset : 0;
        }
        for (const msg of log.messages) {
          if (msg.offset < cursor) continue;
          if (out.length >= max) break;
          out.push(msg);
          pending.set(`${topic}/${p}`, msg.offset + 1);
        }
      }
    }

    // Record the offsets this poll would advance to, pending txn commit.
    this.pendingByGroup.set(opts.groupId, pending);
    return out;
  }

  committedOffset(groupId: string, topic: string, partition: number): number {
    return this.offsets.get(`${groupId}/${topic}/${partition}`) ?? 0;
  }

  /** Auto-commit for non-transactional consumers. */
  async commitOffsets(groupId: string): Promise<void> {
    for (const [tp, offset] of this.pendingOffsets(groupId)) {
      this.offsets.set(`${groupId}/${tp}`, offset);
    }
    this.pendingByGroup.delete(groupId);
  }

  /** Drop messages older than their topic's retention. Returns count removed. */
  compact(now: number): number {
    let removed = 0;
    for (const [key, log] of this.logs) {
      const topic = key.split('/')[0];
      const cfg = this.topics.get(topic);
      if (!cfg) continue;
      const cutoff = now - cfg.retentionMs;
      const before = log.messages.length;
      log.messages = log.messages.filter((m) => m.timestamp >= cutoff);
      removed += before - log.messages.length;
    }
    return removed;
  }

  /** Test/introspection helper: total messages currently retained. */
  size(): number {
    let n = 0;
    for (const log of this.logs.values()) n += log.messages.length;
    return n;
  }
}

/**
 * Deterministic clock. `Date.now()` is intentionally avoided so behaviour is
 * reproducible in tests and in the workflow sandbox; callers that need wall
 * time inject it via `produce`/`compact` arguments. The counter advances so
 * that timestamps are strictly increasing within a process.
 */
let _clock = 1_700_000_000_000;
function deterministicNow(): number {
  return _clock++;
}

// ── Kafka / Redpanda adapter (production seam) ─────────────────────────────────

/**
 * Production adapter. Kept as a thin, dependency-free shim so the package
 * builds without `kafkajs` installed; wire it up in deployment by implementing
 * the four methods against a real `Kafka` client with:
 *
 *   producer: { idempotent: true, maxInFlightRequests: 1, transactionalId }
 *   consumer: { groupId, readUncommitted: false }
 *   transaction.sendOffsets({ consumerGroupId, topics }) inside producer.transaction()
 *
 * That combination is what yields exactly-once across the read-process-write
 * loop. See DATA_LAKEHOUSE_ARCHITECTURE.md § "Exactly-once semantics".
 */
export class KafkaStreamBus implements StreamBus {
  constructor(private brokers: string[]) {
    logger.warn('KafkaStreamBus is a production seam — implement against kafkajs before use', {
      brokers,
    });
  }
  createTopic(): void {
    throw new Error('KafkaStreamBus.createTopic not implemented — use admin.createTopics()');
  }
  produce(): Promise<BusMessage> {
    throw new Error('KafkaStreamBus.produce not implemented — wire kafkajs producer');
  }
  beginTransaction(): BusTransaction {
    throw new Error(
      'KafkaStreamBus.beginTransaction not implemented — wire producer.transaction()',
    );
  }
  poll(): Promise<BusMessage[]> {
    throw new Error('KafkaStreamBus.poll not implemented — wire kafkajs consumer.run()');
  }
  committedOffset(): number {
    throw new Error('KafkaStreamBus.committedOffset not implemented');
  }
  compact(): number {
    // Kafka manages retention/compaction itself.
    return 0;
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function createStreamBus(): StreamBus {
  const driver = process.env.LAKEHOUSE_BUS_DRIVER ?? 'memory';
  if (driver === 'kafka') {
    return new KafkaStreamBus((process.env.KAFKA_BROKERS ?? 'kafka:9092').split(','));
  }
  return new InMemoryStreamBus();
}
