/**
 * DX01 — TypeScript SDK: contract parity against the OpenAPI spec, transport
 * behaviour against a real HTTP server (retries, Retry-After, timeouts, error
 * taxonomy, rate-limit parsing), fault injection, semver policy and backwards
 * compatibility of the 1.0 surface.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import {
  SorobanClient,
  SorobanFeed,
  ReputationClient,
  NotFoundError,
  RateLimitError,
  ServerError,
  AuthenticationError,
  TimeoutError,
  NetworkError,
  RequestValidationError,
  OPERATIONS,
  OPERATION_COUNT,
  type RequestEvent,
} from '../src';
import { buildRequest } from '../src/core/request';
import { parseRetryAfter, normalizeBaseUrl } from '../src/core/http';
import { normalizeOperations, type OpenApiDocument } from '../../../src/lib/openapi/normalize';
import { swaggerSpec } from '../../../src/indexer/swaggerSpec';
import { generateAll } from '../../../scripts/sdk/generate';
import { buildSurface, checkVersionPolicy, diffSurfaces } from '../../../scripts/sdk/surface';
import { TS_ERGONOMIC } from '../../../scripts/sdk/parity';
import fs from 'fs';
import path from 'path';

type Handler = (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void;
let handler: Handler = (_req, _body, res) => res.end('{}');
let server: http.Server;
let baseUrl = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => handler(req, body, res));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

function json(res: http.ServerResponse, status: number, body: unknown, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

const fast = { maxRetryDelayMs: 5 };

describe('contract parity with the OpenAPI spec', () => {
  const ops = normalizeOperations(swaggerSpec as OpenApiDocument);

  it('generated artefacts are up to date (drift gate)', () => {
    const root = path.join(__dirname, '..', '..', '..');
    for (const f of generateAll(swaggerSpec as OpenApiDocument)) {
      expect(fs.readFileSync(path.join(root, f.path), 'utf8'), f.path).toBe(f.content);
    }
  });

  it('covers 100% of operations with identical method and path', () => {
    expect(OPERATION_COUNT).toBe(ops.length);
    const table = OPERATIONS as Record<string, { method: string; path: string }>;
    for (const op of ops) {
      expect(table[op.id], op.id).toBeDefined();
      expect(table[op.id].method).toBe(op.method.toUpperCase());
      expect(table[op.id].path).toBe(op.path);
    }
  });

  it('every curated method maps to a real operation', () => {
    for (const id of Object.keys(TS_ERGONOMIC))
      expect(
        ops.some((o) => o.id === id),
        id,
      ).toBe(true);
  });

  it('every operation builds a request whose path matches its template', () => {
    for (const op of ops) {
      const pathParams = Object.fromEntries(
        op.params.filter((p) => p.in === 'path').map((p) => [p.name, 'x y/z']),
      );
      const query = Object.fromEntries(
        op.params
          .filter((p) => p.in === 'query' && p.required)
          .map((p) => [
            p.name,
            p.enum?.[0] ??
              (p.type === 'integer' || p.type === 'number'
                ? (p.minimum ?? 1)
                : p.type === 'boolean'
                  ? true
                  : p.type === 'array'
                    ? ['a']
                    : 'a'),
          ]),
      );
      const spec = (OPERATIONS as Record<string, never>)[op.id];
      const built = buildRequest(op.id, spec, {
        path: pathParams,
        query,
        body: op.body?.required ? {} : undefined,
      });
      const re = new RegExp(
        '^' +
          op.path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{[^}]+\}/g, 'x%20y%2Fz') +
          '(\\?|$)',
      );
      expect(built.path, op.id).toMatch(re);
    }
  });
});

describe('request validation (runtime mirrors declared types)', () => {
  const spec = OPERATIONS.getTransactions;
  it.each([
    [{ limit: 'ten' }, /integer/],
    [{ limit: 0 }, />= 1/],
    [{ limit: 101 }, /<= 100/],
    [{ nope: 1 }, /unknown query parameter/],
  ])('rejects %o', (query, msg) => {
    expect(() => buildRequest('getTransactions', spec, { query })).toThrow(msg);
  });

  it('rejects missing and dot-segment path params, encodes the rest', () => {
    const s = OPERATIONS.getTransactionsByHash;
    expect(() => buildRequest('getTransactionsByHash', s, {})).toThrow(RequestValidationError);
    expect(() => buildRequest('getTransactionsByHash', s, { path: { hash: '..' } })).toThrow(/dot/);
    expect(buildRequest('getTransactionsByHash', s, { path: { hash: '../admin' } }).path).toBe(
      '/transactions/..%2Fadmin',
    );
  });
});

describe('transport against a real HTTP server', () => {
  it('sends auth + UA headers and returns parsed JSON', async () => {
    let seen: http.IncomingHttpHeaders = {};
    handler = (req, _b, res) => {
      seen = req.headers;
      json(res, 200, { hash: 'h', ledgerSequence: 1 }, { 'x-ratelimit-remaining': '9' });
    };
    const events: RequestEvent[] = [];
    const client = new SorobanClient({
      baseUrl,
      apiKey: 'dev_k',
      onRequest: (e) => events.push(e),
    });
    const tx = await client.transactions.get('h');
    expect(tx.hash).toBe('h');
    expect(seen['x-api-key']).toBe('dev_k');
    expect(seen['user-agent']).toMatch(/^soroban-explorer-client-ts\//);
    expect(events[0]).toMatchObject({
      operationId: 'getTransactionsByHash',
      status: 200,
      outcome: 'success',
      rateLimit: { remaining: 9 },
    });
  });

  it('maps statuses onto the error taxonomy with request id and code', async () => {
    const cases: Array<[number, new (...a: never[]) => Error]> = [
      [401, AuthenticationError],
      [404, NotFoundError],
      [500, ServerError],
    ];
    for (const [status, Cls] of cases) {
      handler = (_r, _b, res) =>
        json(res, status, { error: 'nope', code: 'X' }, { 'x-request-id': 'rid-1' });
      const client = new SorobanClient({ baseUrl, maxRetries: 0 });
      const err = await client.transactions.get('h').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Cls);
      expect(err).toMatchObject({ status, code: 'X', requestId: 'rid-1', message: 'nope' });
    }
  });

  it('fault injection: retries 503 then succeeds; honours Retry-After on 429', async () => {
    let n = 0;
    handler = (_r, _b, res) => {
      n += 1;
      if (n === 1) return json(res, 503, { error: 'down' });
      if (n === 2) return json(res, 429, { error: 'slow down' }, { 'retry-after': '0' });
      json(res, 200, { data: [] });
    };
    const client = new SorobanClient({ baseUrl, maxRetries: 3, ...fast });
    await expect(client.transactions.list()).resolves.toEqual({ data: [] });
    expect(n).toBe(3);
  });

  it('gives up after maxRetries with RateLimitError carrying retryAfterMs', async () => {
    handler = (_r, _b, res) =>
      json(res, 429, { error: 'limited' }, { 'retry-after': '1', 'x-ratelimit-tier': 'public' });
    const client = new SorobanClient({ baseUrl, maxRetries: 1, ...fast });
    const err = (await client.transactions.list().catch((e: unknown) => e)) as RateLimitError;
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfterMs).toBe(1000);
    expect(err.rateLimit.tier).toBe('public');
  });

  it('does not retry non-idempotent requests on 503', async () => {
    let n = 0;
    handler = (_r, _b, res) => {
      n += 1;
      json(res, 503, { error: 'down' });
    };
    const client = new SorobanClient({ baseUrl, maxRetries: 3, ...fast });
    await expect(
      client.call('postWebhooks', { body: { url: 'https://h.example/x' } } as never),
    ).rejects.toBeInstanceOf(ServerError);
    expect(n).toBe(1);
  });

  it('times out slow responses and surfaces network failures', async () => {
    handler = () => undefined; // never responds
    const slow = new SorobanClient({ baseUrl, timeoutMs: 50, maxRetries: 0 });
    await expect(slow.transactions.list()).rejects.toBeInstanceOf(TimeoutError);

    const dead = new SorobanClient({ baseUrl: 'http://127.0.0.1:1/api/v1', maxRetries: 0 });
    await expect(dead.transactions.list()).rejects.toBeInstanceOf(NetworkError);
  });

  it('paginates the cursor envelope until exhausted', async () => {
    handler = (req, _b, res) => {
      const cursor = new URL(req.url ?? '', 'http://x').searchParams.get('cursor');
      if (!cursor) return json(res, 200, { data: [1, 2], hasNext: true, nextCursor: 10 });
      if (cursor === '10') return json(res, 200, { data: [3], hasNext: false, nextCursor: null });
      json(res, 500, {});
    };
    const client = new SorobanClient({ baseUrl });
    const items: unknown[] = [];
    for await (const item of client.paginate('getTransactions', { query: { limit: 2 } })) {
      items.push(item);
    }
    expect(items).toEqual([1, 2, 3]);
  });

  it('streams GraphQL subscription frames and raises coded GraphQL errors', async () => {
    handler = (_r, body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (body.includes('bad')) {
        res.end(
          'event: next\ndata: {"errors":[{"message":"no","extensions":{"code":"INVALID_SUBSCRIPTION_ARGUMENT"}}]}\n\n',
        );
        return;
      }
      res.end(
        ':\n\nevent: next\ndata: {"data":{"ledgerHead":{"sequence":1}}}\n\nevent: next\ndata: {"data":{"ledgerHead":{"sequence":2}}}\n\nevent: complete\ndata:\n\n',
      );
    };
    const client = new SorobanClient({ baseUrl });
    const seen: unknown[] = [];
    for await (const d of client.realtime.graphql('subscription { ledgerHead { sequence } }')) {
      seen.push(d);
    }
    expect(seen).toEqual([{ ledgerHead: { sequence: 1 } }, { ledgerHead: { sequence: 2 } }]);
    await expect(
      (async () => {
        for await (const _ of client.realtime.graphql('bad')) void _;
      })(),
    ).rejects.toThrow(/INVALID_SUBSCRIPTION_ARGUMENT/);
  });
});

describe('configuration safety', () => {
  it('rejects non-http(s) and credentialed base URLs', () => {
    expect(() => normalizeBaseUrl('file:///etc/passwd')).toThrow(/http or https/);
    expect(() => normalizeBaseUrl('https://u:p@h.example')).toThrow(/credentials/);
    expect(() => normalizeBaseUrl('nope')).toThrow(/valid absolute URL/);
    expect(normalizeBaseUrl('https://h.example/api/v1/?x=1#f')).toBe('https://h.example/api/v1');
  });

  it('parses Retry-After seconds and HTTP dates', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter('garbage')).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});

describe('versioning policy (semver breaking-change detection)', () => {
  const ops = normalizeOperations(swaggerSpec as OpenApiDocument);
  const base = buildSurface('1', ops);

  it('an identical surface needs no bump', () => {
    const d = diffSurfaces(base, base);
    expect(d).toEqual({ breaking: [], additive: [] });
    expect(checkVersionPolicy(d, '1.1.0', '1.1.0')).toEqual([]);
  });

  it('removing an operation or adding a required param is breaking ⇒ major', () => {
    const next = JSON.parse(JSON.stringify(base));
    delete next.operations.getTransactions;
    next.operations.getTransactionsByHash.params['query:mustHave'] = {
      type: 'string',
      required: true,
    };
    const d = diffSurfaces(base, next);
    expect(d.breaking.length).toBe(2);
    expect(checkVersionPolicy(d, '1.1.0', '1.2.0').length).toBe(1);
    expect(checkVersionPolicy(d, '1.1.0', '2.0.0')).toEqual([]);
  });

  it('adding operations/optional params is additive ⇒ minor', () => {
    const next = JSON.parse(JSON.stringify(base));
    next.operations.getBrandNew = {
      method: 'GET',
      path: '/new',
      params: {},
      body: 'none',
      deprecated: false,
    };
    const d = diffSurfaces(base, next);
    expect(d.breaking).toEqual([]);
    expect(checkVersionPolicy(d, '1.1.0', '1.1.1').length).toBe(1);
    expect(checkVersionPolicy(d, '1.1.0', '1.2.0')).toEqual([]);
    expect(checkVersionPolicy(d, '1.2.0', '1.1.0').length).toBeGreaterThan(0);
  });
});

describe('backwards compatibility with the 1.0 surface', () => {
  it('keeps SorobanFeed and ReputationClient exports and behaviour', async () => {
    expect(typeof SorobanFeed).toBe('function');
    handler = (req, _b, res) => json(res, 200, { path: req.url });
    const rep = new ReputationClient({ baseUrl: baseUrl.replace(/\/api\/v1$/, '') });
    await expect(rep.score('GABC')).resolves.toEqual({ path: '/api/v1/reputation/score/GABC' });
    const feed = new SorobanFeed({ baseUrl });
    handler = (req, _b, res) => json(res, 200, { url: req.url });
    await expect(feed.getChannels()).resolves.toEqual({ url: '/api/v1/feed/channels' });
  });
});
