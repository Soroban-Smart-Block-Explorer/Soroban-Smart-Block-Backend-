import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { prismaMock, cacheMock } = vi.hoisted(() => {
  // config.ts resolves a network profile at import time; the testnet profile
  // needs a database URL or it throws before any test runs.
  process.env.STELLAR_NETWORK = 'testnet';
  process.env.TESTNET_DATABASE_URL = 'postgresql://localhost:5432/test';

  return {
    prismaMock: {
      contract: { findMany: vi.fn() },
      transaction: { findMany: vi.fn() },
      event: { findMany: vi.fn() },
    },
    cacheMock: {
      cacheGet: vi.fn(),
      cacheSet: vi.fn(),
      buildCacheKey: vi.fn((namespace: string, ...parts: Array<string | number>) =>
        [namespace, ...parts].join(':').toLowerCase(),
      ),
    },
  };
});

vi.mock('../src/db', () => ({
  prismaRead: prismaMock,
  prismaWrite: prismaMock,
}));

vi.mock('../src/cache', () => cacheMock);

import {
  getSearchSuggestions,
  rankCandidates,
  scoreMatch,
  withBudget,
  searchRouter,
  type SuggestCandidate,
} from '../src/api/search';

// ── Helpers ───────────────────────────────────────────────────────────────────

type FindManyArgs = {
  where?: { isToken?: boolean };
  take?: number;
  distinct?: string[];
};

/** Route-by-shape Prisma mock: contract vs token share one delegate. */
function installDefaultMocks() {
  prismaMock.contract.findMany.mockResolvedValue([]);
  prismaMock.transaction.findMany.mockResolvedValue([]);
  prismaMock.event.findMany.mockResolvedValue([]);
}

function useInMemoryCache() {
  const store = new Map<string, unknown>();
  cacheMock.cacheGet.mockImplementation(async (key: string) => store.get(key) ?? null);
  cacheMock.cacheSet.mockImplementation(async (key: string, value: unknown) => {
    store.set(key, value);
  });
  return store;
}

beforeEach(() => {
  vi.clearAllMocks();
  useInMemoryCache();
  installDefaultMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── scoreMatch ────────────────────────────────────────────────────────────────

describe('scoreMatch', () => {
  it('scores an exact match highest', () => {
    expect(scoreMatch('USDC', ['USDC'])).toBe(100);
  });

  it('scores a prefix match above a substring match', () => {
    const prefix = scoreMatch('usd', ['USDC']);
    const substring = scoreMatch('sdc', ['USDC']);
    expect(prefix).not.toBeNull();
    expect(substring).not.toBeNull();
    expect(prefix as number).toBeGreaterThan(substring as number);
  });

  it('weights earlier fields more heavily', () => {
    const primary = scoreMatch('swap', ['swap', 'other']);
    const secondary = scoreMatch('swap', ['other', 'swap']);
    expect(primary as number).toBeGreaterThan(secondary as number);
  });

  it('is case insensitive and ignores surrounding whitespace', () => {
    expect(scoreMatch('  usd ', ['USDC'])).toBe(88);
  });

  it('returns null when nothing matches', () => {
    expect(scoreMatch('zzz', ['USDC', 'USD Coin'])).toBeNull();
  });

  it('skips null and undefined fields', () => {
    expect(scoreMatch('usd', [null, undefined, 'USDC'])).toBe(88 - 4);
  });
});

// ── rankCandidates ────────────────────────────────────────────────────────────

describe('rankCandidates', () => {
  const candidate = (over: Partial<SuggestCandidate>): SuggestCandidate => ({
    type: 'contract',
    id: over.id ?? 'id',
    label: over.label ?? 'label',
    score: over.score ?? 50,
    ...over,
  });

  it('orders by score descending and applies the limit', () => {
    const ranked = rankCandidates(
      [
        candidate({ id: 'a', score: 40 }),
        candidate({ id: 'b', score: 90 }),
        candidate({ id: 'c', score: 60 }),
      ],
      2,
    );
    expect(ranked.map((c) => c.id)).toEqual(['b', 'c']);
  });

  it('breaks score ties by type priority (token before transaction)', () => {
    const ranked = rankCandidates(
      [
        candidate({ id: 'tx', type: 'transaction', score: 88 }),
        candidate({ id: 'tok', type: 'token', score: 88 }),
      ],
      2,
    );
    expect(ranked.map((c) => c.id)).toEqual(['tok', 'tx']);
  });
});

// ── withBudget ────────────────────────────────────────────────────────────────

describe('withBudget', () => {
  it('returns the loader result when it finishes in time', async () => {
    await expect(withBudget(async () => [1, 2], 50)).resolves.toEqual([1, 2]);
  });

  it('resolves to an empty list when the loader exceeds the budget', async () => {
    vi.useFakeTimers();
    const never = new Promise<number[]>(() => {});
    const result = withBudget(() => never, 100);
    await vi.advanceTimersByTimeAsync(100);
    await expect(result).resolves.toEqual([]);
  });

  it('swallows loader errors so one source cannot fail the request', async () => {
    await expect(
      withBudget(async () => {
        throw new Error('boom');
      }, 50),
    ).resolves.toEqual([]);
  });
});

// ── getSearchSuggestions ──────────────────────────────────────────────────────

describe('getSearchSuggestions', () => {
  it('merges candidates from multiple types in one call', async () => {
    prismaMock.contract.findMany.mockImplementation((args: FindManyArgs) =>
      Promise.resolve(
        args?.where?.isToken === true
          ? [{ address: 'CTOKEN', tokenSymbol: 'USDX', tokenName: 'USD X' }]
          : [{ address: 'CCONTRACT', name: 'USD Swap', description: null }],
      ),
    );
    prismaMock.transaction.findMany.mockResolvedValue([{ sourceAccount: 'GUSDWALLET' }]);
    prismaMock.event.findMany.mockResolvedValue([]);

    const result = await getSearchSuggestions({ q: 'usd' });

    expect(result.query).toBe('usd');
    expect(result.count).toBe(result.data.length);
    expect(result.data.map((c) => c.type).sort()).toEqual(['contract', 'token', 'wallet']);
    expect(result.data.find((c) => c.type === 'token')?.label).toBe('USDX');
    expect(result.data.find((c) => c.type === 'wallet')?.id).toBe('GUSDWALLET');
  });

  it('only queries the requested types', async () => {
    await getSearchSuggestions({ q: 'ab', types: ['token'] });

    expect(prismaMock.contract.findMany).toHaveBeenCalledTimes(1);
    expect((prismaMock.contract.findMany.mock.calls[0][0] as FindManyArgs).where?.isToken).toBe(
      true,
    );
    expect(prismaMock.transaction.findMany).not.toHaveBeenCalled();
    expect(prismaMock.event.findMany).not.toHaveBeenCalled();
  });

  it('caps each source and the merged result at the limit', async () => {
    prismaMock.contract.findMany.mockImplementation((args: FindManyArgs) =>
      Promise.resolve(
        args?.where?.isToken === true
          ? Array.from({ length: 5 }, (_, i) => ({
              address: `CTOK${i}`,
              tokenSymbol: `TK${i}`,
              tokenName: null,
            }))
          : [],
      ),
    );

    const result = await getSearchSuggestions({ q: 'tk', types: ['token'], limit: 3 });

    expect((prismaMock.contract.findMany.mock.calls[0][0] as FindManyArgs).take).toBe(5);
    expect(result.data).toHaveLength(3);
  });

  it('returns an empty result when nothing matches', async () => {
    const result = await getSearchSuggestions({ q: 'zzzz' });
    expect(result.data).toEqual([]);
    expect(result.count).toBe(0);
  });

  it('serves repeated queries from the cache', async () => {
    await getSearchSuggestions({ q: 'usd' });
    const callsAfterFirst = prismaMock.contract.findMany.mock.calls.length;

    await getSearchSuggestions({ q: 'USD' });

    expect(prismaMock.contract.findMany).toHaveBeenCalledTimes(callsAfterFirst);
    expect(cacheMock.cacheSet).toHaveBeenCalledTimes(1);
  });

  it('keeps results when one source throws', async () => {
    prismaMock.contract.findMany.mockImplementation((args: FindManyArgs) => {
      if (args?.where?.isToken === true) return Promise.reject(new Error('token lookup failed'));
      return Promise.resolve([]);
    });
    prismaMock.transaction.findMany.mockResolvedValue([{ sourceAccount: 'GABC' }]);

    const result = await getSearchSuggestions({ q: 'abc', types: ['contract', 'token', 'wallet'] });

    expect(result.data.map((c) => c.type)).toContain('wallet');
  });
});

// ── route wiring ──────────────────────────────────────────────────────────────

describe('GET /search/suggest', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use('/search', searchRouter);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it('returns ranked suggestions for a valid query', async () => {
    prismaMock.contract.findMany.mockImplementation((args: FindManyArgs) =>
      Promise.resolve(
        args?.where?.isToken === true
          ? [{ address: 'CTOKEN', tokenSymbol: 'USDC', tokenName: 'USD Coin' }]
          : [],
      ),
    );

    const res = await fetch(`${baseUrl}/search/suggest?q=usd&types=token`);
    const body = (await res.json()) as { query: string; data: SuggestCandidate[]; count: number };

    expect(res.status).toBe(200);
    expect(body.query).toBe('usd');
    expect(body.count).toBe(1);
    expect(body.data[0]).toMatchObject({ type: 'token', id: 'CTOKEN', label: 'USDC' });
  });

  it('rejects a missing query with 400', async () => {
    const res = await fetch(`${baseUrl}/search/suggest`);
    expect(res.status).toBe(400);
  });
});
