/**
 * DX03 — property and performance-budget tests for the GraphQL subscription
 * bridge. Budgets are hard CI limits (see docs/graphql-subscriptions/design.md
 * §Performance budgets); they are set with ~5× headroom over the numbers
 * measured on a GitHub-hosted ubuntu-latest runner so they catch order-of-
 * magnitude regressions without flaking.
 */
import { describe, it, expect, vi } from 'vitest';
import { createPubSub } from 'graphql-yoga';

vi.mock('../src/db', () => ({ prismaRead: {}, prismaWrite: {} }));
vi.mock('../src/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
  bridgeRealtimeMessage,
  createSubscriptionResolvers,
  ledgerHeadTracker,
  pubSub,
} from '../src/graphql/subscriptions';
import { SubscriptionLimiter } from '../src/graphql/subscriptionGateway';

export const BUDGETS = {
  /** Validate + map + publish N messages with no subscribers. */
  bridgeMessages: 20_000,
  bridgeMs: 2_500,
  /** Filtered fan-out: S subscribers × M messages, zero loss. */
  fanoutSubscribers: 500,
  fanoutMessages: 1_000,
  fanoutMs: 5_000,
  /** Property test iterations. */
  propertyCases: 5_000,
};

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const CONTRACTS = Array.from(
  { length: 50 },
  (_, i) => 'C' + ALPHA[Math.floor(i / 26)] + ALPHA[i % 26] + 'A'.repeat(53),
);

function freshPubSub() {
  return createPubSub() as unknown as typeof pubSub;
}

describe('bridge property: arbitrary input never throws and never forwards invalid data', () => {
  it(`holds for ${BUDGETS.propertyCases} generated payloads`, () => {
    const rand = mulberry32(0xdecaf);
    const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
    const values: unknown[] = [
      null,
      undefined,
      '',
      'x',
      -1,
      0,
      1.5,
      2 ** 53,
      NaN,
      true,
      [],
      {},
      '2026-01-01T00:00:00Z',
      'not a date',
      new Date(0),
      { nested: { deep: [1, 2, 3] } },
      'C'.repeat(56),
      'a'.repeat(10_000),
    ];
    const keys = [
      'hash',
      'id',
      'ledgerSequence',
      'sequence',
      'timestamp',
      'ledgerCloseTime',
      'closeTime',
      'sourceAccount',
      'contractAddress',
      'transactionHash',
      'eventType',
      'status',
      'severity',
      'title',
      'fee',
    ];
    const channels = ['transactions', 'events', 'ledgers', 'alerts', 'trades', ''];
    const target = freshPubSub();
    const published: Array<[string, Record<string, unknown>]> = [];
    vi.spyOn(target, 'publish').mockImplementation(((topic: string, ...rest: unknown[]) => {
      // plain form: (topic, payload); keyed form: (topic, contractId, payload)
      const payload = rest[rest.length - 1];
      if (rest.length === 2) expect(rest[0]).toMatch(/^C/);
      published.push([topic, payload as Record<string, unknown>]);
    }) as never);

    for (let i = 0; i < BUDGETS.propertyCases; i++) {
      const obj: Record<string, unknown> = {};
      const n = Math.floor(rand() * keys.length);
      for (let k = 0; k < n; k++) obj[pick(keys)] = pick(values);
      const raw = rand() < 0.1 ? pick(values) : obj;
      expect(() => bridgeRealtimeMessage(pick(channels), raw, target)).not.toThrow();
    }

    for (const [topic, payload] of published) {
      const inner = Object.values(payload)[0] as Record<string, unknown>;
      const seq = (inner.ledgerSequence ?? inner.sequence) as number | undefined;
      if (seq !== undefined) {
        expect(Number.isInteger(seq) && seq >= 0).toBe(true);
      }
      for (const dateKey of ['ledgerCloseTime', 'closeTime', 'occurredAt', 'createdAt']) {
        if (dateKey in inner) {
          expect(inner[dateKey]).toBeInstanceOf(Date);
          expect(Number.isNaN((inner[dateKey] as Date).getTime())).toBe(false);
        }
      }
      expect(topic).toMatch(/^[A-Z_]+$/);
    }
  });
});

describe('bridge performance budgets', () => {
  it(`bridges ${BUDGETS.bridgeMessages} messages within ${BUDGETS.bridgeMs}ms`, () => {
    const target = freshPubSub();
    ledgerHeadTracker.reset();
    const start = performance.now();
    for (let i = 0; i < BUDGETS.bridgeMessages; i++) {
      bridgeRealtimeMessage(
        i % 2 === 0 ? 'transactions' : 'events',
        {
          hash: `h${i}`,
          id: `e${i}`,
          transactionHash: `h${i}`,
          ledgerSequence: i,
          timestamp: '2026-01-01T00:00:00Z',
          sourceAccount: 'G' + 'A'.repeat(55),
          contractAddress: CONTRACTS[i % CONTRACTS.length],
          eventType: 'contract',
          status: 'success',
        },
        target,
      );
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(BUDGETS.bridgeMs);
  });

  it(`fans out to ${BUDGETS.fanoutSubscribers} filtered subscribers with zero loss within ${BUDGETS.fanoutMs}ms`, async () => {
    const target = freshPubSub();
    const limiter = new SubscriptionLimiter(() => ({ maxPerClient: 10_000, maxGlobal: 10_000 }));
    const r = createSubscriptionResolvers({ pubSub: target, limiter, isEnabled: () => true });
    const ctx = { req: { ip: '127.0.0.1' } };

    const iterators = Array.from({ length: BUDGETS.fanoutSubscribers }, (_, i) =>
      r.eventEmitted.subscribe(undefined, { contract: CONTRACTS[i % CONTRACTS.length] }, ctx),
    );
    const expectedPerSub = BUDGETS.fanoutMessages / CONTRACTS.length;
    const counts = new Array<number>(iterators.length).fill(0);
    const consumers = iterators.map(async (it, idx) => {
      while (counts[idx] < expectedPerSub) {
        const { done } = await it.next();
        if (done) break;
        counts[idx] += 1;
      }
      await it.return?.(undefined);
    });

    const start = performance.now();
    for (let i = 0; i < BUDGETS.fanoutMessages; i++) {
      bridgeRealtimeMessage(
        'events',
        {
          id: `e${i}`,
          transactionHash: `h${i}`,
          contractAddress: CONTRACTS[i % CONTRACTS.length],
          eventType: 'contract',
          ledgerSequence: i,
          timestamp: '2026-01-01T00:00:00Z',
        },
        target,
      );
    }
    await Promise.all(consumers);
    const elapsed = performance.now() - start;

    expect(counts.every((c) => c === expectedPerSub)).toBe(true);
    expect(limiter.activeTotal()).toBe(0);
    expect(elapsed).toBeLessThan(BUDGETS.fanoutMs);
  });
});
