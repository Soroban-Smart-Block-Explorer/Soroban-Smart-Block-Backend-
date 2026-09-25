/**
 * GraphQL subscription gateway (DX03).
 *
 * Owns everything between the realtime feed bus and a GraphQL subscriber:
 *
 *  - Admission control: feature flag (`graphqlSubscriptions`), per-client and
 *    global concurrent-stream caps. Rejections are typed GraphQLErrors whose
 *    `extensions.code` is part of the documented error taxonomy
 *    (docs/graphql-subscriptions/api-reference.md#errors).
 *  - Argument validation: every filter argument is validated before a stream
 *    is opened; invalid input never reaches the pub/sub layer.
 *  - Payload normalisation: feed-bus messages (the same messages that drive the
 *    `/api/v1/feed/sse` and `/ws/v1/feed` transports) are validated and mapped
 *    onto the GraphQL types. Malformed payloads are dropped and counted, never
 *    forwarded — a corrupt message cannot crash a subscriber.
 *  - Ledger head tracking: a monotonic head derived from the ledgers channel
 *    and, as graceful degradation when that channel is silent, from the ledger
 *    sequence carried by transactions and events.
 *
 * The module has no module-level side effects beyond metric registration, so
 * it can be unit tested without a server.
 */

import type { GraphQLError } from 'graphql';
import { createGraphQLError } from 'graphql-yoga';
import { z } from 'zod';
import { Counter, Gauge, Histogram } from 'prom-client';
import { registry } from '../metrics';

// ── Error taxonomy ────────────────────────────────────────────────────────────

export const SubscriptionErrorCode = {
  Disabled: 'SUBSCRIPTIONS_DISABLED',
  ClientLimit: 'SUBSCRIPTION_LIMIT_EXCEEDED',
  GlobalLimit: 'SUBSCRIPTION_CAPACITY_EXHAUSTED',
  InvalidArgument: 'INVALID_SUBSCRIPTION_ARGUMENT',
} as const;

export type SubscriptionErrorCode =
  (typeof SubscriptionErrorCode)[keyof typeof SubscriptionErrorCode];

export function subscriptionError(
  code: SubscriptionErrorCode,
  message: string,
  extra: Record<string, unknown> = {},
): GraphQLError {
  // createGraphQLError binds to the graphql instance graphql-yoga executes
  // with, so yoga's error masking recognises it and forwards `extensions`.
  return createGraphQLError(message, { extensions: { code, ...extra } });
}

// ── Topics ────────────────────────────────────────────────────────────────────

export const SUBSCRIPTION_TOPICS = [
  'transactionAdded',
  'eventEmitted',
  'alertTriggered',
  'ledgerHead',
  'contractActivity',
] as const;

export type SubscriptionTopic = (typeof SUBSCRIPTION_TOPICS)[number];

// ── Metrics ───────────────────────────────────────────────────────────────────

function getOrCreate<T>(name: string, create: () => T): T {
  const existing = registry.getSingleMetric(name);
  return (existing as unknown as T) ?? create();
}

export const gqlSubscriptionsActive = getOrCreate(
  'graphql_subscriptions_active',
  () =>
    new Gauge({
      name: 'graphql_subscriptions_active',
      help: 'Open GraphQL subscription streams by topic',
      labelNames: ['topic'],
      registers: [registry],
    }),
);

export const gqlSubscriptionAdmissions = getOrCreate(
  'graphql_subscription_admissions_total',
  () =>
    new Counter({
      name: 'graphql_subscription_admissions_total',
      help: 'GraphQL subscription admission decisions by topic and outcome',
      labelNames: ['topic', 'outcome'],
      registers: [registry],
    }),
);

export const gqlSubscriptionMessages = getOrCreate(
  'graphql_subscription_messages_total',
  () =>
    new Counter({
      name: 'graphql_subscription_messages_total',
      help: 'Messages bridged from the feed bus into GraphQL pub/sub by topic',
      labelNames: ['topic'],
      registers: [registry],
    }),
);

export const gqlSubscriptionDropped = getOrCreate(
  'graphql_subscription_bridge_dropped_total',
  () =>
    new Counter({
      name: 'graphql_subscription_bridge_dropped_total',
      help: 'Feed-bus messages the GraphQL bridge refused to forward, by reason',
      labelNames: ['reason'],
      registers: [registry],
    }),
);

export const gqlSubscriptionBridgeDuration = getOrCreate(
  'graphql_subscription_bridge_duration_seconds',
  () =>
    new Histogram({
      name: 'graphql_subscription_bridge_duration_seconds',
      help: 'Time to validate, map and publish one feed-bus message into GraphQL pub/sub',
      buckets: [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1],
      registers: [registry],
    }),
);

// ── Configuration ─────────────────────────────────────────────────────────────

export interface SubscriptionLimits {
  maxPerClient: number;
  maxGlobal: number;
}

export const DEFAULT_SUBSCRIPTION_LIMITS: SubscriptionLimits = {
  maxPerClient: 10,
  maxGlobal: 5000,
};

function positiveIntFromEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Read limits at call time so operators can tune them per-process via env. */
export function readSubscriptionLimits(): SubscriptionLimits {
  return {
    maxPerClient: positiveIntFromEnv(
      'GQL_SUBSCRIPTION_MAX_PER_CLIENT',
      DEFAULT_SUBSCRIPTION_LIMITS.maxPerClient,
    ),
    maxGlobal: positiveIntFromEnv(
      'GQL_SUBSCRIPTION_MAX_GLOBAL',
      DEFAULT_SUBSCRIPTION_LIMITS.maxGlobal,
    ),
  };
}

// ── Admission control ─────────────────────────────────────────────────────────

/**
 * Tracks concurrent streams per client key and globally. `acquire` either
 * returns an idempotent release function or throws a typed GraphQLError.
 */
export class SubscriptionLimiter {
  private readonly perClient = new Map<string, number>();
  private total = 0;

  constructor(private readonly limits: () => SubscriptionLimits = readSubscriptionLimits) {}

  acquire(clientKey: string, topic: SubscriptionTopic): () => void {
    const { maxPerClient, maxGlobal } = this.limits();
    if (this.total >= maxGlobal) {
      gqlSubscriptionAdmissions.inc({ topic, outcome: 'rejected_capacity' });
      throw subscriptionError(
        SubscriptionErrorCode.GlobalLimit,
        'Subscription capacity exhausted on this instance; retry with backoff',
        { retryAfterSeconds: 5 },
      );
    }
    const current = this.perClient.get(clientKey) ?? 0;
    if (current >= maxPerClient) {
      gqlSubscriptionAdmissions.inc({ topic, outcome: 'rejected_limit' });
      throw subscriptionError(
        SubscriptionErrorCode.ClientLimit,
        `Too many concurrent subscriptions (limit ${maxPerClient} per client)`,
        { limit: maxPerClient },
      );
    }
    this.perClient.set(clientKey, current + 1);
    this.total += 1;
    gqlSubscriptionsActive.inc({ topic });
    gqlSubscriptionAdmissions.inc({ topic, outcome: 'accepted' });

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (this.perClient.get(clientKey) ?? 1) - 1;
      if (n <= 0) this.perClient.delete(clientKey);
      else this.perClient.set(clientKey, n);
      this.total = Math.max(0, this.total - 1);
      gqlSubscriptionsActive.dec({ topic });
    };
  }

  activeFor(clientKey: string): number {
    return this.perClient.get(clientKey) ?? 0;
  }

  activeTotal(): number {
    return this.total;
  }
}

/**
 * Wrap an async iterable so `release` runs exactly once when the stream ends
 * for any reason: normal completion, error, or client disconnect (`return()`),
 * including a disconnect that happens before the first `next()`.
 */
export function withRelease<T>(
  source: AsyncIterable<T>,
  release: () => void,
): AsyncIterableIterator<T> {
  const iterator = source[Symbol.asyncIterator]();
  let done = false;
  const finish = () => {
    if (!done) {
      done = true;
      release();
    }
  };
  const wrapped: AsyncIterableIterator<T> = {
    async next() {
      try {
        const result = await iterator.next();
        if (result.done) finish();
        return result;
      } catch (err) {
        finish();
        throw err;
      }
    },
    async return(value?: unknown) {
      finish();
      if (iterator.return) return iterator.return(value);
      return { done: true, value: value as T };
    },
    async throw(err?: unknown) {
      finish();
      if (iterator.throw) return iterator.throw(err);
      throw err;
    },
    [Symbol.asyncIterator]() {
      return wrapped;
    },
  };
  return wrapped;
}

// ── Argument validation ───────────────────────────────────────────────────────

const STRKEY_CONTRACT = /^C[A-Z2-7]{55}$/;
const STRKEY_ACCOUNT = /^[GM][A-Z2-7]{55}$/;
const TOKEN = /^[A-Za-z0-9_:.-]{1,64}$/;

function invalid(field: string, reason: string): GraphQLError {
  return subscriptionError(SubscriptionErrorCode.InvalidArgument, `Invalid ${field}: ${reason}`, {
    field,
  });
}

export function validateContractAddress(field: string, value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !STRKEY_CONTRACT.test(value)) {
    throw invalid(field, 'expected a Stellar contract strkey (C…, 56 chars)');
  }
  return value;
}

export function validateAccountAddress(field: string, value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !STRKEY_ACCOUNT.test(value)) {
    throw invalid(field, 'expected a Stellar account strkey (G… or M…, 56 chars)');
  }
  return value;
}

export function validateToken(field: string, value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !TOKEN.test(value)) {
    throw invalid(field, 'expected 1-64 characters of [A-Za-z0-9_:.-]');
  }
  return value;
}

export const CONTRACT_ACTIVITY_KINDS = ['TRANSACTION', 'EVENT'] as const;
export type ContractActivityKind = (typeof CONTRACT_ACTIVITY_KINDS)[number];

// ── Payload shapes (GraphQL-facing) ───────────────────────────────────────────

export interface SubscriptionTransaction {
  hash: string;
  ledgerSequence: number;
  ledgerCloseTime: Date;
  sourceAccount: string;
  contractAddress: string | null;
  functionName: string | null;
  functionArgs: unknown;
  status: string;
  humanReadable: string | null;
  feeCharged: string | null;
  sorobanResources: unknown;
  failureReason: string | null;
}

export interface SubscriptionEvent {
  id: string;
  transactionHash: string;
  contractAddress: string;
  eventType: string;
  topicSymbol: string | null;
  topics: unknown;
  data: unknown;
  decoded: unknown;
  ledgerSequence: number;
  ledgerCloseTime: Date;
}

export interface LedgerHead {
  sequence: number;
  closeTime: Date;
  hash: string | null;
  txCount: number | null;
  source: 'LEDGER_FEED' | 'DERIVED';
}

export interface ContractActivity {
  kind: ContractActivityKind;
  contractAddress: string;
  ledgerSequence: number;
  occurredAt: Date;
  transaction: SubscriptionTransaction | null;
  event: SubscriptionEvent | null;
}

export interface SubscriptionAlert {
  id: string;
  severity: string;
  title: string;
  description: string | null;
  txHash: string | null;
  contractAddress: string | null;
  createdAt: Date;
}

// ── Payload validation / mapping ──────────────────────────────────────────────

const dateLike = z.union([z.string(), z.number(), z.date()]).transform((v, ctx) => {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid date' });
    return z.NEVER;
  }
  return d;
});

const ledgerSeq = z.coerce.number().int().nonnegative();
const optStr = z
  .string()
  .nullish()
  .transform((v) => v ?? null);

const transactionSchema = z.object({
  hash: z.string().min(1).max(128),
  ledgerSequence: ledgerSeq,
  ledgerCloseTime: dateLike.optional(),
  timestamp: dateLike.optional(),
  sourceAccount: z.string().min(1).max(128),
  contractAddress: optStr,
  functionName: optStr,
  functionArgs: z.unknown().optional(),
  status: z.string().min(1).max(32),
  humanReadable: optStr,
  feeCharged: z.union([z.string(), z.number()]).nullish(),
  fee: z.union([z.string(), z.number()]).nullish(),
  sorobanResources: z.unknown().optional(),
  footprint: z.unknown().optional(),
  failureReason: optStr,
});

const eventSchema = z.object({
  id: z.string().min(1).max(256),
  transactionHash: z.string().min(1).max(128),
  contractAddress: z.string().min(1).max(128),
  eventType: z.string().min(1).max(64),
  topicSymbol: optStr,
  topics: z.unknown().optional(),
  data: z.unknown().optional(),
  decoded: z.unknown().optional(),
  ledgerSequence: ledgerSeq,
  ledgerCloseTime: dateLike.optional(),
  timestamp: dateLike.optional(),
});

const ledgerSchema = z.object({
  sequence: ledgerSeq,
  hash: optStr,
  closeTime: dateLike.optional(),
  timestamp: dateLike.optional(),
  txCount: z.coerce.number().int().nonnegative().nullish(),
});

const alertSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  severity: z.string().min(1).max(32),
  title: z.string().min(1).max(512),
  description: optStr,
  txHash: optStr,
  contractAddress: optStr,
  createdAt: dateLike.optional(),
});

export function toSubscriptionTransaction(raw: unknown): SubscriptionTransaction | null {
  const parsed = transactionSchema.safeParse(raw);
  if (!parsed.success) return null;
  const t = parsed.data;
  const closeTime = t.ledgerCloseTime ?? t.timestamp;
  if (!closeTime) return null;
  const fee = t.feeCharged ?? t.fee;
  return {
    hash: t.hash,
    ledgerSequence: t.ledgerSequence,
    ledgerCloseTime: closeTime,
    sourceAccount: t.sourceAccount,
    contractAddress: t.contractAddress,
    functionName: t.functionName,
    functionArgs: t.functionArgs ?? null,
    status: t.status,
    humanReadable: t.humanReadable,
    feeCharged: fee === undefined || fee === null ? null : String(fee),
    sorobanResources: t.sorobanResources ?? t.footprint ?? null,
    failureReason: t.failureReason,
  };
}

export function toSubscriptionEvent(raw: unknown): SubscriptionEvent | null {
  const parsed = eventSchema.safeParse(raw);
  if (!parsed.success) return null;
  const e = parsed.data;
  const closeTime = e.ledgerCloseTime ?? e.timestamp;
  if (!closeTime) return null;
  return {
    id: e.id,
    transactionHash: e.transactionHash,
    contractAddress: e.contractAddress,
    eventType: e.eventType,
    topicSymbol: e.topicSymbol,
    topics: e.topics ?? [],
    data: e.data ?? null,
    decoded: e.decoded ?? null,
    ledgerSequence: e.ledgerSequence,
    ledgerCloseTime: closeTime,
  };
}

export function toLedgerHead(raw: unknown): LedgerHead | null {
  const parsed = ledgerSchema.safeParse(raw);
  if (!parsed.success) return null;
  const l = parsed.data;
  const closeTime = l.closeTime ?? l.timestamp;
  if (!closeTime) return null;
  return {
    sequence: l.sequence,
    closeTime,
    hash: l.hash,
    txCount: l.txCount ?? null,
    source: 'LEDGER_FEED',
  };
}

export function toSubscriptionAlert(raw: unknown): SubscriptionAlert | null {
  const parsed = alertSchema.safeParse(raw);
  if (!parsed.success) return null;
  const a = parsed.data;
  return {
    id: a.id,
    severity: a.severity,
    title: a.title,
    description: a.description,
    txHash: a.txHash,
    contractAddress: a.contractAddress,
    createdAt: a.createdAt ?? new Date(),
  };
}

// ── Ledger head tracking ──────────────────────────────────────────────────────

/**
 * Monotonic ledger head. Returns the head to publish, or null when the
 * observation does not advance the head. A LEDGER_FEED observation may
 * upgrade a DERIVED head for the same sequence exactly once (it carries the
 * hash and tx count the derived head lacks).
 */
export class LedgerHeadTracker {
  private current: LedgerHead | null = null;

  observe(head: LedgerHead): LedgerHead | null {
    const cur = this.current;
    if (
      cur === null ||
      head.sequence > cur.sequence ||
      (head.sequence === cur.sequence && cur.source === 'DERIVED' && head.source === 'LEDGER_FEED')
    ) {
      this.current = head;
      return head;
    }
    return null;
  }

  get head(): LedgerHead | null {
    return this.current;
  }

  reset(): void {
    this.current = null;
  }
}

// ── Filters ───────────────────────────────────────────────────────────────────

export interface TransactionFilter {
  contract?: string;
  account?: string;
}

export interface EventFilter {
  contract?: string;
  eventType?: string;
  topic?: string;
}

export function matchesTransaction(tx: SubscriptionTransaction, f: TransactionFilter): boolean {
  if (f.contract && tx.contractAddress !== f.contract) return false;
  if (f.account && tx.sourceAccount !== f.account) return false;
  return true;
}

export function matchesEvent(ev: SubscriptionEvent, f: EventFilter): boolean {
  if (f.contract && ev.contractAddress !== f.contract) return false;
  if (f.eventType && ev.eventType !== f.eventType) return false;
  if (f.topic && ev.topicSymbol !== f.topic) return false;
  return true;
}

export function matchesAlert(alert: SubscriptionAlert, severity?: string): boolean {
  if (!severity) return true;
  return alert.severity.toLowerCase() === severity.toLowerCase();
}

export function matchesContractActivity(
  activity: ContractActivity,
  address: string,
  kinds: readonly ContractActivityKind[],
): boolean {
  return activity.contractAddress === address && kinds.includes(activity.kind);
}
