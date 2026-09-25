/**
 * DX04 — the shipped browser script, evaluated verbatim in a Node `vm`
 * context (no DOM), so the code under test is the code users run.
 */
import { describe, it, expect } from 'vitest';
import vm from 'vm';
import { TRY_IT_CLIENT_SCRIPT } from '../../src/api/tryit/clientScript';
import { buildCatalog, type TryItCatalog, type TryItOperation } from '../../src/api/tryit/catalog';
import type { OpenApiDocument } from '../../src/lib/openapi/normalize';

interface BuildOk {
  ok: true;
  url: string;
  init: { method: string; headers: Record<string, string>; body?: string };
  curl: string;
}
interface BuildErr {
  ok: false;
  errors: string[];
}
interface Core {
  encodeShare(s: {
    op: string;
    path?: Record<string, string>;
    query?: Record<string, string>;
    body?: string;
  }): string;
  decodeShare(
    token: unknown,
    catalog: TryItCatalog,
  ):
    | {
        ok: true;
        state: {
          op: string;
          path: Record<string, string>;
          query: Record<string, string>;
          body?: string;
        };
        dropped: string[];
      }
    | { ok: false; error: string };
  buildRequest(
    catalog: TryItCatalog,
    op: TryItOperation,
    input: { path?: Record<string, string>; query?: Record<string, string>; body?: string },
    apiKey: string,
    origin: string,
  ): BuildOk | BuildErr;
  filterOperations(catalog: TryItCatalog, term: string): TryItOperation[];
  findOperation(catalog: TryItCatalog, id: string): TryItOperation | null;
  RATE_LIMIT_HEADERS: string[];
}

function loadCore(): Core {
  const sandbox: Record<string, unknown> = {
    TextEncoder,
    TextDecoder,
    btoa,
    atob,
    URL,
    encodeURIComponent,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(TRY_IT_CLIENT_SCRIPT, sandbox, { filename: 'app.js' });
  return sandbox.TryItCore as Core;
}

const core = loadCore();
const ORIGIN = 'https://explorer.example';

const doc: OpenApiDocument = {
  info: { title: 'T', version: '1' },
  servers: [{ url: '/api/v1' }],
  paths: {
    '/transactions/{hash}': {
      get: {
        parameters: [{ in: 'path', name: 'hash', required: true, schema: { type: 'string' } }],
        responses: {},
      },
    },
    '/transactions': {
      get: {
        summary: 'List transactions',
        parameters: [
          { in: 'query', name: 'limit', schema: { type: 'integer', minimum: 1, maximum: 100 } },
          { in: 'query', name: 'ratio', schema: { type: 'number' } },
          { in: 'query', name: 'desc', schema: { type: 'boolean' } },
          { in: 'query', name: 'status', schema: { type: 'string', enum: ['success', 'failed'] } },
        ],
        responses: {},
      },
    },
    '/webhooks': {
      post: {
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        responses: {},
      },
    },
    '/raw': {
      put: {
        requestBody: { content: { 'text/plain': { schema: { type: 'string' } } } },
        responses: {},
      },
    },
  },
};
const catalog = buildCatalog(doc);
const op = (id: string) => core.findOperation(catalog, id)!;

describe('share links', () => {
  it('round-trips operation, params and body, including unicode', () => {
    const token = core.encodeShare({
      op: 'getTransactions',
      query: { limit: '5', status: 'success' },
      body: '',
    });
    expect(token.startsWith('v1.')).toBe(true);
    expect(token).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    const d = core.decodeShare(token, catalog);
    expect(d).toMatchObject({ ok: true, state: { op: 'getTransactions', query: { limit: '5' } } });

    const t2 = core.encodeShare({
      op: 'postWebhooks',
      body: '{"note":"héllo ✓"}',
    });
    const d2 = core.decodeShare(t2, catalog);
    expect(d2.ok && d2.state.body).toBe('{"note":"héllo ✓"}');
  });

  it('drops parameters the operation does not declare', () => {
    const t = core.encodeShare({
      op: 'getTransactionsByHash',
      path: { hash: 'abc', evil: 'x' },
      query: { injected: '1' },
    });
    const d = core.decodeShare(t, catalog);
    expect(d.ok && d.state.path).toEqual({ hash: 'abc' });
    expect(d.ok && d.dropped.sort()).toEqual(['evil', 'injected']);
  });

  it.each([
    [null],
    ['v2.abc'],
    ['v1.!!!'],
    ['v1.' + Buffer.from('not json').toString('base64url')],
    ['v1.' + Buffer.from('{"o":1}').toString('base64url')],
    ['v1.' + Buffer.from('{"o":"getTransactions","q":{"limit":5}}').toString('base64url')],
    ['v1.' + Buffer.from('{"o":"getTransactions","b":{}}').toString('base64url')],
    ['v1.' + Buffer.from('{"o":"gone"}').toString('base64url')],
    ['v1.' + 'A'.repeat(9000)],
  ])('rejects corrupted, tampered, stale or oversized links (%#)', (token) => {
    const d = core.decodeShare(token, catalog);
    expect(d.ok).toBe(false);
  });

  it('refuses to encode requests larger than a URL can carry', () => {
    expect(() => core.encodeShare({ op: 'postWebhooks', body: 'x'.repeat(10_000) })).toThrow(
      /too large/,
    );
  });

  it('property: random states round-trip and never contain an API key', () => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const chars = 'abcXYZ019 -_./%?#&=é✓"\'\\<>';
    const str = (n: number) =>
      Array.from(
        { length: Math.floor(rand() * n) },
        () => chars[Math.floor(rand() * chars.length)],
      ).join('');
    for (let i = 0; i < 500; i++) {
      const state = {
        op: 'getTransactions',
        query: { limit: str(8), status: str(8) },
        body: str(40),
      };
      const token = core.encodeShare(state);
      expect(token).not.toContain('SECRET');
      const d = core.decodeShare(token, catalog);
      expect(d.ok).toBe(true);
      if (d.ok) {
        for (const [k, v] of Object.entries(state.query)) {
          if (v.length) expect(d.state.query[k]).toBe(v);
        }
      }
    }
  });
});

describe('buildRequest', () => {
  it('builds a same-origin GET with encoded params, key only in a header', () => {
    const r = core.buildRequest(
      catalog,
      op('getTransactions'),
      { query: { limit: '10', status: 'failed', desc: 'true', ratio: '0.5' } },
      'dev_SECRETKEY',
      ORIGIN,
    ) as BuildOk;
    expect(r.ok).toBe(true);
    expect(r.url).toBe(
      'https://explorer.example/api/v1/transactions?desc=true&limit=10&ratio=0.5&status=failed',
    );
    expect(r.url).not.toContain('SECRET');
    expect(r.init.headers['X-Api-Key']).toBe('dev_SECRETKEY');
    expect(r.init.headers['X-Client']).toBe('try-it');
    expect(r.curl).toContain('$SOROBAN_API_KEY');
    expect(r.curl).not.toContain('SECRET');
  });

  it('omits the key header when no key is given', () => {
    const r = core.buildRequest(catalog, op('getTransactions'), {}, '', ORIGIN) as BuildOk;
    expect(r.init.headers['X-Api-Key']).toBeUndefined();
    expect(r.url).toBe('https://explorer.example/api/v1/transactions');
  });

  it.each([
    [{ limit: 'abc' }, /integer/],
    [{ limit: '0' }, />= 1/],
    [{ limit: '101' }, /<= 100/],
    [{ ratio: 'x' }, /number/],
    [{ desc: 'yes' }, /true or false/],
    [{ status: 'pending' }, /one of/],
  ])('validates query param types %o', (query, message) => {
    const r = core.buildRequest(catalog, op('getTransactions'), { query }, '', ORIGIN) as BuildErr;
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(message);
  });

  it('path params cannot escape their segment (traversal / injection)', () => {
    for (const hash of [
      '../../admin',
      'a/b',
      'x?y=1',
      'x#frag',
      '%2e%2e',
      'https://evil.example',
    ]) {
      const r = core.buildRequest(
        catalog,
        op('getTransactionsByHash'),
        { path: { hash } },
        '',
        ORIGIN,
      ) as BuildOk;
      expect(r.ok).toBe(true);
      const u = new URL(r.url);
      expect(u.origin).toBe(ORIGIN);
      expect(u.pathname.startsWith('/api/v1/transactions/')).toBe(true);
      expect(u.pathname.split('/').length).toBe(5);
      expect(u.search).toBe('');
    }
    for (const hash of ['.', '..']) {
      const r = core.buildRequest(
        catalog,
        op('getTransactionsByHash'),
        { path: { hash } },
        '',
        ORIGIN,
      );
      expect(r.ok).toBe(false);
    }
    const missing = core.buildRequest(
      catalog,
      op('getTransactionsByHash'),
      {},
      '',
      ORIGIN,
    ) as BuildErr;
    expect(missing.errors).toContain('hash is required');
  });

  it('refuses a tampered catalog basePath (SSRF / open redirect defence)', () => {
    for (const basePath of ['https://evil.example/api', '//evil.example', 'api/v1']) {
      const bad = { ...catalog, basePath };
      const r = core.buildRequest(bad, op('getTransactions'), {}, '', ORIGIN) as BuildErr;
      expect(r.ok).toBe(false);
    }
  });

  it('validates and normalises JSON bodies; enforces required bodies', () => {
    const ok = core.buildRequest(
      catalog,
      op('postWebhooks'),
      { body: '{ "url": "https://h.example" }' },
      '',
      ORIGIN,
    ) as BuildOk;
    expect(ok.init.body).toBe('{"url":"https://h.example"}');
    expect(ok.init.headers['Content-Type']).toBe('application/json');
    expect(ok.curl).toContain('--data \'{"url":"https://h.example"}\'');

    const bad = core.buildRequest(
      catalog,
      op('postWebhooks'),
      { body: '{nope' },
      '',
      ORIGIN,
    ) as BuildErr;
    expect(bad.errors).toContain('Body is not valid JSON');
    const none = core.buildRequest(
      catalog,
      op('postWebhooks'),
      { body: ' ' },
      '',
      ORIGIN,
    ) as BuildErr;
    expect(none.errors).toContain('Request body is required');
    const huge = core.buildRequest(
      catalog,
      op('postWebhooks'),
      { body: 'x'.repeat(70_000) },
      '',
      ORIGIN,
    ) as BuildErr;
    expect(huge.errors).toContain('Body is too large');

    const raw = core.buildRequest(
      catalog,
      op('putRaw'),
      { body: "it's raw" },
      '',
      ORIGIN,
    ) as BuildOk;
    expect(raw.init.body).toBe("it's raw");
    expect(raw.curl).toContain(`--data 'it'\\''s raw'`);
  });
});

describe('catalog helpers', () => {
  it('filters by path, summary, id and method', () => {
    expect(core.filterOperations(catalog, '').length).toBe(catalog.operationCount);
    expect(core.filterOperations(catalog, 'list trans').map((o) => o.id)).toEqual([
      'getTransactions',
    ]);
    expect(core.filterOperations(catalog, 'put').map((o) => o.id)).toEqual(['putRaw']);
    expect(core.filterOperations(catalog, 'BYHASH').map((o) => o.id)).toEqual([
      'getTransactionsByHash',
    ]);
  });

  it('surfaces the rate-limit and versioning headers users need to see', () => {
    expect(core.RATE_LIMIT_HEADERS).toEqual(
      expect.arrayContaining(['x-ratelimit-remaining', 'retry-after', 'x-request-id', 'sunset']),
    );
  });

  it('ships no template literals or inline HTML sinks', () => {
    expect(TRY_IT_CLIENT_SCRIPT).not.toContain('innerHTML');
    expect(TRY_IT_CLIENT_SCRIPT).not.toContain('eval(');
    expect(TRY_IT_CLIENT_SCRIPT).not.toContain('document.write');
  });
});
