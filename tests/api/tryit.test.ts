/**
 * DX04 — try-it console: catalog derivation, router behaviour, feature-flag
 * gating, fault injection/recovery, attribution metrics and budgets.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../src/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
  deriveOperationId,
  exampleFor,
  normalizeOperations,
  normalizePathTemplate,
  resolveRef,
  type OpenApiDocument,
} from '../../src/lib/openapi/normalize';
import { buildCatalog, sameOriginBasePath } from '../../src/api/tryit/catalog';
import {
  TryItErrorCode,
  createTryItRouter,
  tryItApiRequests,
  tryItAttribution,
} from '../../src/api/tryit/router';
import { TRY_IT_CLIENT_SCRIPT } from '../../src/api/tryit/clientScript';
import { TRY_IT_PAGE } from '../../src/api/tryit/page';
import { swaggerSpec } from '../../src/indexer/swaggerSpec';

const fixture: OpenApiDocument = {
  openapi: '3.0.0',
  info: { title: 'Fixture', version: '9.9.9' },
  servers: [{ url: '/api/v1' }],
  components: {
    schemas: {
      Hook: {
        type: 'object',
        required: ['url'],
        properties: {
          url: { type: 'string', format: 'uri' },
          active: { type: 'boolean' },
          retries: { type: 'integer', minimum: 1 },
          tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
        },
      },
    },
  },
  paths: {
    '/transactions/{hash}': {
      get: {
        summary: 'Get tx',
        tags: ['Transactions'],
        parameters: [{ in: 'path', name: 'hash', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'ok' }, '404': { description: 'missing' } },
      },
    },
    '/transactions': {
      parameters: [{ in: 'query', name: 'limit', schema: { type: 'integer', maximum: 100 } }],
      get: {
        summary: 'List',
        parameters: [
          { in: 'query', name: 'status', schema: { type: 'string', enum: ['success', 'failed'] } },
          { in: 'header', name: 'X-Trace', schema: { type: 'string' } },
        ],
        responses: {},
      },
    },
    '/wallets/:address/history': {
      get: { summary: 'Express-style path', deprecated: true, responses: {} },
    },
    '/hooks': {
      post: {
        operationId: 'createHook',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Hook' } } },
        },
        responses: { '201': { description: 'created' } },
      },
    },
  },
};

describe('normalizeOperations', () => {
  it('derives stable ids, honours explicit operationIds and converts :params', () => {
    expect(deriveOperationId('get', '/transactions/{hash}')).toBe('getTransactionsByHash');
    expect(deriveOperationId('delete', '/webhooks/{id}/deliveries')).toBe(
      'deleteWebhooksByIdDeliveries',
    );
    expect(deriveOperationId('get', '/calendar.ics')).toBe('getCalendarIcs');
    expect(normalizePathTemplate('/wallets/:address/history')).toBe('/wallets/{address}/history');
    const ids = normalizeOperations(fixture).map((o) => o.id);
    expect(ids).toEqual([
      'createHook',
      'getTransactions',
      'getTransactionsByHash',
      'getWalletsByAddressHistory',
    ]);
  });

  it('merges path-item params, synthesizes undeclared path params, sorts deterministically', () => {
    const ops = normalizeOperations(fixture);
    const list = ops.find((o) => o.id === 'getTransactions')!;
    expect(list.params.map((p) => `${p.in}:${p.name}`)).toEqual([
      'query:limit',
      'query:status',
      'header:X-Trace',
    ]);
    const hist = ops.find((o) => o.id === 'getWalletsByAddressHistory')!;
    expect(hist.params).toEqual([{ name: 'address', in: 'path', required: true, type: 'string' }]);
    expect(hist.deprecated).toBe(true);
  });

  it('suffixes colliding ids deterministically', () => {
    const doc: OpenApiDocument = {
      paths: {
        '/a/{id}': { get: { responses: {} } },
        '/a/:id': { get: { responses: {} } },
      },
    };
    expect(normalizeOperations(doc).map((o) => o.id)).toEqual(['getAById', 'getAById2']);
  });

  it('builds examples from $ref schemas and resolves missing refs safely', () => {
    const hook = exampleFor(fixture, { $ref: '#/components/schemas/Hook' });
    expect(hook).toEqual({
      url: 'https://example.com/hook',
      active: false,
      retries: 1,
      tags: ['a'],
    });
    expect(resolveRef(fixture, { $ref: '#/components/schemas/Nope' })).toEqual({});
    expect(exampleFor(fixture, { oneOf: [{ type: 'number' }] })).toBe(0);
    expect(exampleFor(fixture, { allOf: [{ example: { a: 1 } }, { example: { b: 2 } }] })).toEqual({
      a: 1,
      b: 2,
    });
    expect(exampleFor(fixture, null)).toBeNull();
  });
});

describe('buildCatalog', () => {
  it('drops header params, fills example bodies and tags untagged ops', () => {
    const c = buildCatalog(fixture);
    expect(c.title).toBe('Fixture');
    expect(c.operationCount).toBe(4);
    const list = c.operations.find((o) => o.id === 'getTransactions')!;
    expect(list.params.some((p) => p.in === 'header')).toBe(false);
    expect(list.tags).toEqual(['Other']);
    const create = c.operations.find((o) => o.id === 'createHook')!;
    expect(JSON.parse(create.body!.example)).toMatchObject({ url: 'https://example.com/hook' });
    expect(c.etag).toMatch(/^[0-9a-f]{16}$/);
    expect(buildCatalog(fixture).etag).toBe(c.etag);
  });

  it('never trusts an absolute or protocol-relative server URL', () => {
    expect(sameOriginBasePath('/api/v1/')).toBe('/api/v1');
    expect(sameOriginBasePath('https://evil.example')).toBe('/api/v1');
    expect(sameOriginBasePath('//evil.example/api')).toBe('/api/v1');
    expect(sameOriginBasePath(undefined)).toBe('/api/v1');
  });

  it('covers 100% of the operations in the real OpenAPI spec, with unique ids, within budget', () => {
    const doc = swaggerSpec as OpenApiDocument;
    let specOps = 0;
    for (const item of Object.values(doc.paths ?? {})) {
      for (const m of ['get', 'post', 'put', 'patch', 'delete']) if (item[m]) specOps++;
    }
    const start = performance.now();
    const c = buildCatalog(doc);
    const elapsed = performance.now() - start;
    expect(c.operationCount).toBe(specOps);
    expect(new Set(c.operations.map((o) => o.id)).size).toBe(specOps);
    // Budgets (design doc §Performance): build < 3 s, payload < 2 MB.
    expect(elapsed).toBeLessThan(3000);
    expect(JSON.stringify(c).length).toBeLessThan(2 * 1024 * 1024);
    for (const op of c.operations) {
      for (const name of op.path.match(/\{([^}]+)\}/g) ?? []) {
        expect(op.params.some((p) => p.in === 'path' && `{${p.name}}` === name)).toBe(true);
      }
    }
  });
});

function appWith(opts: Partial<Parameters<typeof createTryItRouter>[0]> = {}) {
  const app = express();
  app.use(
    '/api/try',
    createTryItRouter({
      getSpec: () => fixture,
      isEnabled: () => true,
      ...opts,
    }),
  );
  return app;
}

describe('try-it router', () => {
  beforeEach(() => tryItApiRequests.reset());

  it('serves the page, the script and the catalog', async () => {
    const app = appWith();
    const page = await request(app).get('/api/try');
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.text).toBe(TRY_IT_PAGE);
    expect(page.text).not.toMatch(/<script>(?!<\/script>)/);

    const js = await request(app).get('/api/try/app.js');
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toContain('javascript');
    expect(js.text).toBe(TRY_IT_CLIENT_SCRIPT);
    const again = await request(app).get('/api/try/app.js').set('If-None-Match', js.headers.etag);
    expect(again.status).toBe(304);

    const cat = await request(app).get('/api/try/catalog.json');
    expect(cat.status).toBe(200);
    expect(cat.body.operationCount).toBe(4);
    const cached = await request(app)
      .get('/api/try/catalog.json')
      .set('If-None-Match', cat.headers.etag);
    expect(cached.status).toBe(304);
  });

  it('kill switch: returns 404 FEATURE_DISABLED for every asset and passes the developer id', async () => {
    const isEnabled = vi.fn().mockReturnValue(false);
    const app = express();
    app.use((req, _res, next) => {
      (req as unknown as { apiKey: { developerId: string } }).apiKey = { developerId: 'dev-1' };
      next();
    });
    app.use('/api/try', createTryItRouter({ getSpec: () => fixture, isEnabled }));
    for (const path of ['/api/try', '/api/try/app.js', '/api/try/catalog.json']) {
      const res = await request(app).get(path);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe(TryItErrorCode.Disabled);
    }
    expect(isEnabled).toHaveBeenCalledWith('dev-1');
  });

  it('fault injection: a failing spec yields 503 + Retry-After, then recovers without restart', async () => {
    let calls = 0;
    const app = appWith({
      getSpec: () => {
        calls += 1;
        if (calls === 1) throw new Error('spec corrupted');
        return fixture;
      },
    });
    const down = await request(app).get('/api/try/catalog.json');
    expect(down.status).toBe(503);
    expect(down.headers['retry-after']).toBe('30');
    expect(down.body).toMatchObject({
      code: TryItErrorCode.CatalogUnavailable,
      fallback: '/api/v1/openapi.json',
    });
    // page and script still work while the catalog is down (partial failure)
    expect((await request(app).get('/api/try/app.js')).status).toBe(200);
    const up = await request(app).get('/api/try/catalog.json');
    expect(up.status).toBe(200);
    expect(calls).toBe(2);
    await request(app).get('/api/try/catalog.json');
    expect(calls).toBe(2);
  });

  it('serves 1000 cached catalog requests within budget', async () => {
    const app = appWith({ getSpec: () => swaggerSpec as OpenApiDocument });
    await request(app).get('/api/try/catalog.json');
    const start = performance.now();
    const agent = request(app);
    for (let i = 0; i < 1000; i += 50) {
      await Promise.all(
        Array.from({ length: 50 }, () =>
          agent.get('/api/try/catalog.json').set('If-None-Match', 'stale'),
        ),
      );
    }
    expect(performance.now() - start).toBeLessThan(15_000);
  });
});

describe('tryItAttribution', () => {
  it('counts console requests by method and status class, and ignores others', async () => {
    tryItApiRequests.reset();
    const app = express();
    app.use(tryItAttribution);
    app.get('/api/v1/x', (_req, res) => res.status(200).json({}));
    app.post('/api/v1/x', (_req, res) => res.status(429).json({}));
    await request(app).get('/api/v1/x').set('X-Client', 'try-it');
    await request(app).post('/api/v1/x').set('X-Client', 'try-it');
    await request(app).get('/api/v1/x');
    const metric = await tryItApiRequests.get();
    const byLabel = Object.fromEntries(
      metric.values.map((v) => [`${v.labels.method}:${v.labels.status_class}`, v.value]),
    );
    expect(byLabel).toEqual({ 'GET:2xx': 1, 'POST:4xx': 1 });
  });
});
