/**
 * DX03 — GraphQL subscriptions: unit, fault-injection and end-to-end (SSE)
 * coverage for src/graphql/subscriptionGateway.ts and src/graphql/subscriptions.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPubSub } from 'graphql-yoga';

vi.mock('../src/db', () => ({
  prismaRead: {
    transaction: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn() },
    event: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn() },
    contract: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn() },
  },
  prismaWrite: {},
}));

vi.mock('../src/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
  LedgerHeadTracker,
  SubscriptionErrorCode,
  SubscriptionLimiter,
  matchesAlert,
  matchesContractActivity,
  matchesEvent,
  matchesTransaction,
  readSubscriptionLimits,
  toLedgerHead,
  toSubscriptionAlert,
  toSubscriptionEvent,
  toSubscriptionTransaction,
  validateAccountAddress,
  validateContractAddress,
  validateToken,
  withRelease,
  type LedgerHead,
} from '../src/graphql/subscriptionGateway';
import {
  bridgeRealtimeMessage,
  createSubscriptionResolvers,
  ledgerHeadTracker,
  pubSub,
  startGraphqlEventBridge,
  stopGraphqlEventBridge,
  subscriptionLimiter,
} from '../src/graphql/subscriptions';
import { eventBus, EventNames } from '../src/events/eventBus';

const CONTRACT = 'C' + 'A'.repeat(55);
const OTHER_CONTRACT = 'C' + 'B'.repeat(55);
const ACCOUNT = 'G' + 'A'.repeat(55);

function feedTx(overrides: Record<string, unknown> = {}) {
  return {
    type: 'transaction',
    schemaVersion: 1,
    hash: 'abc123',
    ledgerSequence: 100,
    timestamp: '2026-01-01T00:00:00.000Z',
    sourceAccount: ACCOUNT,
    contractAddress: CONTRACT,
    functionName: 'transfer',
    status: 'success',
    fee: 100,
    footprint: { read: [] },
    ...overrides,
  };
}

function feedEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: 'event',
    schemaVersion: 1,
    id: 'abc123-1',
    transactionHash: 'abc123',
    contractAddress: CONTRACT,
    eventType: 'contract',
    topicSymbol: 'transfer',
    decoded: { amount: '1' },
    ledgerSequence: 101,
    timestamp: '2026-01-01T00:00:05.000Z',
    ...overrides,
  };
}

function freshPubSub() {
  return createPubSub() as unknown as typeof pubSub;
}

// ── Validation ───────────────────────────────────────────────────────────────

describe('argument validation', () => {
  it('accepts well-formed strkeys and tokens, passes through null/undefined', () => {
    expect(validateContractAddress('contract', CONTRACT)).toBe(CONTRACT);
    expect(validateAccountAddress('account', ACCOUNT)).toBe(ACCOUNT);
    expect(validateAccountAddress('account', 'M' + 'A'.repeat(55))).toBeDefined();
    expect(validateToken('topic', 'transfer')).toBe('transfer');
    expect(validateContractAddress('contract', null)).toBeUndefined();
    expect(validateToken('topic', undefined)).toBeUndefined();
  });

  it.each([
    ['contract', () => validateContractAddress('contract', ACCOUNT)],
    ['contract', () => validateContractAddress('contract', 'C123')],
    ['contract', () => validateContractAddress('contract', 42)],
    ['account', () => validateAccountAddress('account', CONTRACT)],
    ['topic', () => validateToken('topic', 'a'.repeat(65))],
    ['topic', () => validateToken('topic', "x'; DROP TABLE")],
  ])('rejects invalid %s with INVALID_SUBSCRIPTION_ARGUMENT', (field, fn) => {
    try {
      fn();
      expect.unreachable();
    } catch (err) {
      const e = err as { extensions: Record<string, unknown> };
      expect(e.extensions.code).toBe(SubscriptionErrorCode.InvalidArgument);
      expect(e.extensions.field).toBe(field);
    }
  });
});

// ── Limits ───────────────────────────────────────────────────────────────────

describe('SubscriptionLimiter', () => {
  it('enforces per-client and global caps and releases idempotently', () => {
    const limiter = new SubscriptionLimiter(() => ({ maxPerClient: 2, maxGlobal: 3 }));
    const r1 = limiter.acquire('a', 'ledgerHead');
    const r2 = limiter.acquire('a', 'ledgerHead');
    expect(() => limiter.acquire('a', 'ledgerHead')).toThrow(/Too many concurrent/);
    const r3 = limiter.acquire('b', 'ledgerHead');
    try {
      limiter.acquire('c', 'ledgerHead');
      expect.unreachable();
    } catch (err) {
      expect((err as { extensions: { code: string } }).extensions.code).toBe(
        SubscriptionErrorCode.GlobalLimit,
      );
    }
    r1();
    r1();
    expect(limiter.activeFor('a')).toBe(1);
    expect(limiter.activeTotal()).toBe(2);
    r2();
    r3();
    expect(limiter.activeTotal()).toBe(0);
    expect(limiter.activeFor('a')).toBe(0);
  });

  it('reads limits from env with safe fallbacks', () => {
    vi.stubEnv('GQL_SUBSCRIPTION_MAX_PER_CLIENT', '3');
    vi.stubEnv('GQL_SUBSCRIPTION_MAX_GLOBAL', 'nope');
    expect(readSubscriptionLimits()).toEqual({ maxPerClient: 3, maxGlobal: 5000 });
    vi.stubEnv('GQL_SUBSCRIPTION_MAX_PER_CLIENT', '-1');
    expect(readSubscriptionLimits().maxPerClient).toBe(10);
    vi.unstubAllEnvs();
  });
});

describe('withRelease', () => {
  async function* gen() {
    yield 1;
    yield 2;
  }

  it('releases on normal completion', async () => {
    const release = vi.fn();
    const out: number[] = [];
    for await (const v of withRelease(gen(), release)) out.push(v);
    expect(out).toEqual([1, 2]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases when the client disconnects before the first next()', async () => {
    const release = vi.fn();
    const it = withRelease(gen(), release);
    await it.return?.(undefined);
    await it.return?.(undefined);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases when the source throws, and on throw()', async () => {
    const release = vi.fn();
    const failing: AsyncIterable<number> = {
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('boom')) }),
    };
    await expect(withRelease(failing, release).next()).rejects.toThrow('boom');
    expect(release).toHaveBeenCalledTimes(1);

    const release2 = vi.fn();
    const it = withRelease(gen(), release2);
    await expect(it.throw?.(new Error('x'))).rejects.toThrow('x');
    expect(release2).toHaveBeenCalledTimes(1);
  });

  it('handles sources without return/throw', async () => {
    const release = vi.fn();
    const bare: AsyncIterable<number> = {
      [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
    };
    const it = withRelease(bare, release);
    expect(await it.return?.(7)).toEqual({ done: true, value: 7 });
    const it2 = withRelease(bare, vi.fn());
    await expect(it2.throw?.(new Error('t'))).rejects.toThrow('t');
    expect(it[Symbol.asyncIterator]()).toBe(it);
  });
});

// ── Mapping ──────────────────────────────────────────────────────────────────

describe('payload mapping', () => {
  it('maps the feed transaction shape onto the GraphQL Transaction type', () => {
    const tx = toSubscriptionTransaction(feedTx());
    expect(tx).toMatchObject({
      hash: 'abc123',
      ledgerSequence: 100,
      sourceAccount: ACCOUNT,
      contractAddress: CONTRACT,
      feeCharged: '100',
      sorobanResources: { read: [] },
    });
    expect(tx?.ledgerCloseTime.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('maps the direct (Prisma row) transaction shape', () => {
    const tx = toSubscriptionTransaction({
      hash: 'h',
      ledgerSequence: '7',
      ledgerCloseTime: new Date(0),
      sourceAccount: ACCOUNT,
      status: 'failed',
      feeCharged: null,
    });
    expect(tx?.ledgerSequence).toBe(7);
    expect(tx?.feeCharged).toBeNull();
    expect(tx?.contractAddress).toBeNull();
  });

  it.each([
    null,
    'string',
    {},
    feedTx({ hash: '' }),
    feedTx({ ledgerSequence: -1 }),
    feedTx({ timestamp: 'not-a-date' }),
    feedTx({ timestamp: undefined }),
  ])('rejects malformed transaction %#', (raw) => {
    expect(toSubscriptionTransaction(raw)).toBeNull();
  });

  it('maps events, ledgers and alerts; rejects malformed ones', () => {
    expect(toSubscriptionEvent(feedEvent())?.topics).toEqual([]);
    expect(toSubscriptionEvent(feedEvent({ timestamp: undefined }))).toBeNull();
    expect(toSubscriptionEvent({ id: 'x' })).toBeNull();

    expect(
      toLedgerHead({ sequence: 5, hash: 'h', closeTime: '2026-01-01T00:00:00Z', txCount: 3 }),
    ).toMatchObject({ sequence: 5, hash: 'h', txCount: 3, source: 'LEDGER_FEED' });
    expect(toLedgerHead({ sequence: 5 })).toBeNull();
    expect(toLedgerHead({ sequence: 'x' })).toBeNull();

    expect(toSubscriptionAlert({ id: 1, severity: 'HIGH', title: 't' })).toMatchObject({
      id: '1',
      severity: 'HIGH',
    });
    expect(toSubscriptionAlert({ id: 1 })).toBeNull();
  });
});

describe('filters', () => {
  const tx = toSubscriptionTransaction(feedTx())!;
  const ev = toSubscriptionEvent(feedEvent())!;

  it('filters transactions by contract and account', () => {
    expect(matchesTransaction(tx, {})).toBe(true);
    expect(matchesTransaction(tx, { contract: CONTRACT, account: ACCOUNT })).toBe(true);
    expect(matchesTransaction(tx, { contract: OTHER_CONTRACT })).toBe(false);
    expect(matchesTransaction(tx, { account: 'G' + 'B'.repeat(55) })).toBe(false);
  });

  it('filters events by contract, type and topic', () => {
    expect(matchesEvent(ev, { contract: CONTRACT, eventType: 'contract', topic: 'transfer' })).toBe(
      true,
    );
    expect(matchesEvent(ev, { contract: OTHER_CONTRACT })).toBe(false);
    expect(matchesEvent(ev, { eventType: 'system' })).toBe(false);
    expect(matchesEvent(ev, { topic: 'mint' })).toBe(false);
  });

  it('filters alerts by severity case-insensitively and contract activity by kind', () => {
    const alert = toSubscriptionAlert({ id: 'a', severity: 'High', title: 't' })!;
    expect(matchesAlert(alert)).toBe(true);
    expect(matchesAlert(alert, 'HIGH')).toBe(true);
    expect(matchesAlert(alert, 'low')).toBe(false);
    const act = {
      kind: 'EVENT' as const,
      contractAddress: CONTRACT,
      ledgerSequence: 1,
      occurredAt: new Date(),
      transaction: null,
      event: ev,
    };
    expect(matchesContractActivity(act, CONTRACT, ['EVENT'])).toBe(true);
    expect(matchesContractActivity(act, CONTRACT, ['TRANSACTION'])).toBe(false);
    expect(matchesContractActivity(act, OTHER_CONTRACT, ['EVENT'])).toBe(false);
  });
});

describe('LedgerHeadTracker', () => {
  const head = (sequence: number, source: LedgerHead['source']): LedgerHead => ({
    sequence,
    closeTime: new Date(0),
    hash: source === 'LEDGER_FEED' ? 'h' : null,
    txCount: null,
    source,
  });

  it('is monotonic and lets a LEDGER_FEED head upgrade a DERIVED one once', () => {
    const t = new LedgerHeadTracker();
    expect(t.observe(head(10, 'DERIVED'))?.sequence).toBe(10);
    expect(t.observe(head(10, 'DERIVED'))).toBeNull();
    expect(t.observe(head(9, 'LEDGER_FEED'))).toBeNull();
    expect(t.observe(head(10, 'LEDGER_FEED'))?.hash).toBe('h');
    expect(t.observe(head(10, 'LEDGER_FEED'))).toBeNull();
    expect(t.observe(head(11, 'DERIVED'))?.sequence).toBe(11);
    expect(t.head?.sequence).toBe(11);
    t.reset();
    expect(t.head).toBeNull();
  });
});

// ── Bridge + fault injection ─────────────────────────────────────────────────

describe('bridgeRealtimeMessage', () => {
  beforeEach(() => ledgerHeadTracker.reset());

  it('fans a feed transaction out to transactionAdded, contractActivity and ledgerHead', () => {
    const target = freshPubSub();
    const spy = vi.spyOn(target, 'publish');
    expect(bridgeRealtimeMessage('transactions', feedTx(), target)).toBe(true);
    expect(spy.mock.calls.map((c) => c[0])).toEqual([
      'TRANSACTION_ADDED',
      'TRANSACTION_BY_CONTRACT',
      'CONTRACT_ACTIVITY',
      'LEDGER_HEAD',
    ]);
    // keyed copies carry the contract address as the routing id
    expect(spy.mock.calls[1][1]).toBe(CONTRACT);
    expect(spy.mock.calls[2][1]).toBe(CONTRACT);
  });

  it('skips contractActivity for transactions without a contract', () => {
    const target = freshPubSub();
    const spy = vi.spyOn(target, 'publish');
    bridgeRealtimeMessage('transactions', feedTx({ contractAddress: null }), target);
    expect(spy.mock.calls.map((c) => c[0])).toEqual(['TRANSACTION_ADDED', 'LEDGER_HEAD']);
  });

  it('bridges events, ledgers and alerts; ignores channels with no GraphQL topic', () => {
    const target = freshPubSub();
    const spy = vi.spyOn(target, 'publish');
    expect(bridgeRealtimeMessage('events', feedEvent(), target)).toBe(true);
    expect(
      bridgeRealtimeMessage(
        'ledgers',
        { sequence: 500, hash: 'h', closeTime: '2026-01-01T00:00:00Z', txCount: 1 },
        target,
      ),
    ).toBe(true);
    expect(bridgeRealtimeMessage('alerts', { id: 1, severity: 'high', title: 't' }, target)).toBe(
      true,
    );
    expect(bridgeRealtimeMessage('trades', { any: 1 }, target)).toBe(false);
    expect(spy.mock.calls.map((c) => c[0])).toEqual([
      'EVENT_EMITTED',
      'EVENT_BY_CONTRACT',
      'CONTRACT_ACTIVITY',
      'LEDGER_HEAD',
      'LEDGER_HEAD',
      'ALERT_TRIGGERED',
    ]);
  });

  it('drops corrupt payloads on every channel without throwing', () => {
    const target = freshPubSub();
    const spy = vi.spyOn(target, 'publish');
    for (const channel of ['transactions', 'events', 'ledgers', 'alerts']) {
      expect(bridgeRealtimeMessage(channel, { garbage: true }, target)).toBe(false);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('fault injection: a failing pub/sub is contained and the bridge recovers', () => {
    const target = freshPubSub();
    const original = target.publish.bind(target);
    let failures = 1;
    vi.spyOn(target, 'publish').mockImplementation(((...args: Parameters<typeof original>) => {
      if (failures-- > 0) throw new Error('pubsub down');
      return original(...args);
    }) as typeof original);
    expect(bridgeRealtimeMessage('events', feedEvent(), target)).toBe(false);
    expect(bridgeRealtimeMessage('events', feedEvent({ id: 'next' }), target)).toBe(true);
  });

  it('bus wiring: feed.message and graphql.* events reach GraphQL pub/sub; malformed envelopes are dropped', async () => {
    stopGraphqlEventBridge();
    startGraphqlEventBridge();
    startGraphqlEventBridge(); // idempotent
    const spy = vi.spyOn(pubSub, 'publish');
    try {
      await eventBus.publish(EventNames.FeedMessage, { channelName: 'events', data: feedEvent() });
      await eventBus.publish(EventNames.FeedMessage, null);
      await eventBus.publish(EventNames.FeedMessage, { channelName: 42 });
      await eventBus.publish(EventNames.GraphqlTransaction, feedTx({ hash: 'direct' }));
      await eventBus.publish(EventNames.GraphqlEvent, feedEvent({ id: 'direct' }));
      await eventBus.publish(EventNames.GraphqlAlert, { id: 'a', severity: 'low', title: 't' });
      const topics = spy.mock.calls.map((c) => c[0]);
      expect(topics.filter((t) => t === 'EVENT_EMITTED')).toHaveLength(2);
      expect(topics.filter((t) => t === 'EVENT_BY_CONTRACT')).toHaveLength(2);
      expect(topics).toContain('TRANSACTION_ADDED');
      expect(topics).toContain('ALERT_TRIGGERED');
    } finally {
      spy.mockRestore();
      stopGraphqlEventBridge();
    }
  });
});

// ── Resolver admission ───────────────────────────────────────────────────────

describe('createSubscriptionResolvers admission', () => {
  const ctx = { req: { ip: '10.0.0.1', apiKey: { id: 'k1', developerId: 'd1' } } };

  it('rejects when the feature flag is off, with a fallback hint', () => {
    const isEnabled = vi.fn().mockReturnValue(false);
    const r = createSubscriptionResolvers({
      pubSub: freshPubSub(),
      limiter: new SubscriptionLimiter(),
      isEnabled,
    });
    try {
      r.ledgerHead.subscribe(undefined, {}, ctx);
      expect.unreachable();
    } catch (err) {
      const e = err as { extensions: Record<string, unknown> };
      expect(e.extensions.code).toBe(SubscriptionErrorCode.Disabled);
      expect(e.extensions.fallback).toBe('/api/v1/feed/sse');
    }
    expect(isEnabled).toHaveBeenCalledWith('d1');
  });

  it('validates before admitting so invalid input never consumes a slot', () => {
    const limiter = new SubscriptionLimiter();
    const r = createSubscriptionResolvers({
      pubSub: freshPubSub(),
      limiter,
      isEnabled: () => true,
    });
    expect(() => r.transactionAdded.subscribe(undefined, { contract: 'bad' }, ctx)).toThrow();
    expect(() => r.eventEmitted.subscribe(undefined, { topic: '!!' }, ctx)).toThrow();
    expect(() => r.alertTriggered.subscribe(undefined, { severity: '' + '#' }, ctx)).toThrow();
    expect(() => r.contractActivity.subscribe(undefined, { address: '' }, ctx)).toThrow(
      /Invalid address/,
    );
    expect(() =>
      r.contractActivity.subscribe(undefined, { address: null as unknown as string }, ctx),
    ).toThrow(/address is required/);
    expect(limiter.activeTotal()).toBe(0);
  });

  it('keys anonymous clients by IP and filters contractActivity by kinds', async () => {
    const target = freshPubSub();
    const limiter = new SubscriptionLimiter();
    const r = createSubscriptionResolvers({ pubSub: target, limiter, isEnabled: () => true });
    const it = r.contractActivity.subscribe(
      undefined,
      { address: CONTRACT, kinds: ['EVENT'] },
      { req: { ip: '1.2.3.4' } },
    );
    expect(limiter.activeFor('ip:1.2.3.4')).toBe(1);
    const next = it.next();
    ledgerHeadTracker.reset();
    bridgeRealtimeMessage('transactions', feedTx(), target);
    bridgeRealtimeMessage('events', feedEvent({ id: 'wanted' }), target);
    const got = await next;
    expect(r.contractActivity.resolve(got.value as never)).toMatchObject({
      kind: 'EVENT',
      event: { id: 'wanted' },
    });
    await it.return?.(undefined);
    expect(limiter.activeTotal()).toBe(0);
  });

  it('delivers filtered transactions, events, alerts and ledger heads', async () => {
    const target = freshPubSub();
    const r = createSubscriptionResolvers({
      pubSub: target,
      limiter: new SubscriptionLimiter(),
      isEnabled: () => true,
    });
    const txIt = r.transactionAdded.subscribe(undefined, { account: ACCOUNT }, ctx);
    const evIt = r.eventEmitted.subscribe(undefined, { eventType: 'contract' }, ctx);
    const alIt = r.alertTriggered.subscribe(undefined, { severity: 'critical' }, ctx);
    const lhIt = r.ledgerHead.subscribe(undefined, {}, ctx);
    const pending = [txIt.next(), evIt.next(), alIt.next(), lhIt.next()];
    ledgerHeadTracker.reset();
    bridgeRealtimeMessage('transactions', feedTx({ sourceAccount: 'G' + 'Z'.repeat(55) }), target);
    bridgeRealtimeMessage('transactions', feedTx({ hash: 'mine' }), target);
    bridgeRealtimeMessage('events', feedEvent(), target);
    bridgeRealtimeMessage('alerts', { id: 'x', severity: 'low', title: 'no' }, target);
    bridgeRealtimeMessage('alerts', { id: 'y', severity: 'CRITICAL', title: 'yes' }, target);
    const [txNext, ev, al, lh] = await Promise.all(pending);
    expect(r.transactionAdded.resolve(txNext.value as never).hash).toBe('mine');
    expect(r.eventEmitted.resolve(ev.value as never).id).toBe('abc123-1');
    expect(r.alertTriggered.resolve(al.value as never).id).toBe('y');
    expect(r.ledgerHead.resolve(lh.value as never).sequence).toBe(100);
    await Promise.all([txIt, evIt, alIt, lhIt].map((i) => i.return?.(undefined)));
  });
});

// ── End-to-end over the real GraphQL server (SSE transport) ──────────────────

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  pred: (text: string) => boolean,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  while (!pred(text)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

describe('GraphQL subscriptions over SSE (end-to-end)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function subscribe(query: string, variables: Record<string, unknown> = {}) {
    const { default: yoga } = await import('../src/graphql');
    return yoga.fetch('http://localhost/api/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ query, variables }),
    });
  }

  it('streams contractActivity for a contract and releases the slot on disconnect', async () => {
    const res = await subscribe(
      `subscription($a: String!) { contractActivity(address: $a) { kind contractAddress ledgerSequence transaction { hash functionName } } }`,
      { a: CONTRACT },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const firstRead = readUntil(reader, (t) => t.includes('"hash":"e2e"'));
    await waitFor(() => subscriptionLimiter.activeTotal() === 1);
    bridgeRealtimeMessage('transactions', feedTx({ contractAddress: OTHER_CONTRACT }));
    bridgeRealtimeMessage('transactions', feedTx({ hash: 'e2e' }));
    const text = await firstRead;
    expect(text).toContain('"kind":"TRANSACTION"');
    expect(text).not.toContain(OTHER_CONTRACT);
    await reader.cancel();
    await waitFor(() => subscriptionLimiter.activeTotal() === 0);
  });

  it('streams ledgerHead advances', async () => {
    ledgerHeadTracker.reset();
    const res = await subscribe(`subscription { ledgerHead { sequence source hash } }`);
    const reader = res.body!.getReader();
    const read = readUntil(reader, (t) => t.includes('"sequence":900'));
    await waitFor(() => subscriptionLimiter.activeTotal() === 1);
    bridgeRealtimeMessage('ledgers', {
      sequence: 900,
      hash: 'lh',
      closeTime: '2026-01-01T00:00:00Z',
      txCount: 2,
    });
    expect(await read).toContain('"source":"LEDGER_FEED"');
    await reader.cancel();
    await waitFor(() => subscriptionLimiter.activeTotal() === 0);
  });

  it('kill switch: ENABLE_GRAPHQL_SUBSCRIPTIONS=false yields SUBSCRIPTIONS_DISABLED', async () => {
    vi.stubEnv('ENABLE_GRAPHQL_SUBSCRIPTIONS', 'false');
    const res = await subscribe(`subscription { ledgerHead { sequence } }`);
    const text = await res.text();
    expect(text).toContain(SubscriptionErrorCode.Disabled);
    expect(subscriptionLimiter.activeTotal()).toBe(0);
  });

  it('per-client limit yields SUBSCRIPTION_LIMIT_EXCEEDED for the extra stream', async () => {
    vi.stubEnv('GQL_SUBSCRIPTION_MAX_PER_CLIENT', '1');
    const first = await subscribe(`subscription { ledgerHead { sequence } }`);
    const reader = first.body!.getReader();
    void reader.read();
    await waitFor(() => subscriptionLimiter.activeTotal() === 1);
    const second = await subscribe(`subscription { ledgerHead { sequence } }`);
    expect(await second.text()).toContain(SubscriptionErrorCode.ClientLimit);
    await reader.cancel();
    await waitFor(() => subscriptionLimiter.activeTotal() === 0);
  });

  it('rejects invalid arguments with INVALID_SUBSCRIPTION_ARGUMENT', async () => {
    const res = await subscribe(`subscription { transactionAdded(contract: "nope") { hash } }`);
    expect(await res.text()).toContain(SubscriptionErrorCode.InvalidArgument);
  });
});
