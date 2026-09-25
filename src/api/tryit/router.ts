/**
 * Try-it console router (DX04), mounted at /api/try.
 *
 *   GET /api/try               — console page
 *   GET /api/try/app.js        — console script (TryItCore + DOM app)
 *   GET /api/try/catalog.json  — operation catalog derived from the OpenAPI spec
 *
 * The console never proxies: the browser calls /api/v1 directly, so every
 * request it sends passes the normal auth, tier rate limit, audit log and
 * metrics middleware and there is no server-side fetch (no SSRF surface).
 * Requests sent from the console carry `X-Client: try-it` and are counted by
 * `tryItAttribution`.
 */

import { createHash } from 'crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { Counter, Histogram } from 'prom-client';
import { registry } from '../../metrics';
import { logger } from '../../logger';
import type { OpenApiDocument } from '../../lib/openapi/normalize';
import { buildCatalog, type TryItCatalog } from './catalog';
import { TRY_IT_CLIENT_SCRIPT } from './clientScript';
import { TRY_IT_PAGE } from './page';

function getOrCreate<T>(name: string, create: () => T): T {
  return (registry.getSingleMetric(name) as unknown as T) ?? create();
}

export const tryItAssetRequests = getOrCreate(
  'tryit_asset_requests_total',
  () =>
    new Counter({
      name: 'tryit_asset_requests_total',
      help: 'Try-it console asset responses by asset and status',
      labelNames: ['asset', 'status'],
      registers: [registry],
    }),
);

export const tryItCatalogBuilds = getOrCreate(
  'tryit_catalog_builds_total',
  () =>
    new Counter({
      name: 'tryit_catalog_builds_total',
      help: 'Try-it catalog build attempts by outcome',
      labelNames: ['outcome'],
      registers: [registry],
    }),
);

export const tryItCatalogBuildDuration = getOrCreate(
  'tryit_catalog_build_duration_seconds',
  () =>
    new Histogram({
      name: 'tryit_catalog_build_duration_seconds',
      help: 'Time to derive the try-it catalog from the OpenAPI spec',
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
      registers: [registry],
    }),
);

export const tryItApiRequests = getOrCreate(
  'tryit_api_requests_total',
  () =>
    new Counter({
      name: 'tryit_api_requests_total',
      help: 'API requests sent from the try-it console by method and status class',
      labelNames: ['method', 'status_class'],
      registers: [registry],
    }),
);

export const TryItErrorCode = {
  Disabled: 'FEATURE_DISABLED',
  CatalogUnavailable: 'TRYIT_CATALOG_UNAVAILABLE',
} as const;

export interface TryItRouterOptions {
  /** Returns the OpenAPI document (the one served at /api/v1/openapi.json). */
  getSpec: () => OpenApiDocument;
  /** Feature-flag check (`tryItConsole`), evaluated per request. */
  isEnabled: (developerId?: string) => boolean;
}

function etagOf(text: string): string {
  return `"${createHash('sha256').update(text).digest('hex').slice(0, 16)}"`;
}

const SCRIPT_ETAG = etagOf(TRY_IT_CLIENT_SCRIPT);

function developerIdOf(req: Request): string | undefined {
  return (req as Request & { apiKey?: { developerId?: string } }).apiKey?.developerId;
}

export function createTryItRouter(options: TryItRouterOptions): Router {
  const router = Router();
  let cached: { catalog: TryItCatalog; body: string; etag: string } | null = null;

  router.use((req: Request, res: Response, next: NextFunction) => {
    if (!options.isEnabled(developerIdOf(req))) {
      tryItAssetRequests.inc({ asset: 'any', status: '404' });
      res.status(404).json({
        error: 'The API console is disabled',
        code: TryItErrorCode.Disabled,
        fallback: '/api/v1/openapi.json',
      });
      return;
    }
    next();
  });

  router.get('/', (_req: Request, res: Response) => {
    res.set('Cache-Control', 'no-cache');
    res.type('html').send(TRY_IT_PAGE);
    tryItAssetRequests.inc({ asset: 'page', status: '200' });
  });

  router.get('/app.js', (req: Request, res: Response) => {
    res.set('ETag', SCRIPT_ETAG);
    res.set('Cache-Control', 'public, max-age=300');
    if (req.get('if-none-match') === SCRIPT_ETAG) {
      res.status(304).end();
      tryItAssetRequests.inc({ asset: 'script', status: '304' });
      return;
    }
    res.type('application/javascript').send(TRY_IT_CLIENT_SCRIPT);
    tryItAssetRequests.inc({ asset: 'script', status: '200' });
  });

  router.get('/catalog.json', (req: Request, res: Response) => {
    if (!cached) {
      const stop = tryItCatalogBuildDuration.startTimer();
      try {
        const catalog = buildCatalog(options.getSpec());
        const body = JSON.stringify(catalog);
        cached = { catalog, body, etag: `"${catalog.etag}"` };
        tryItCatalogBuilds.inc({ outcome: 'success' });
        logger.info('[try-it] catalog built', {
          operations: catalog.operationCount,
          bytes: body.length,
        });
      } catch (err) {
        // Not cached: the next request retries, so recovery is automatic
        // once the underlying fault (e.g. a malformed spec) is fixed.
        tryItCatalogBuilds.inc({ outcome: 'failure' });
        tryItAssetRequests.inc({ asset: 'catalog', status: '503' });
        logger.error('[try-it] catalog build failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        res.set('Retry-After', '30');
        res.status(503).json({
          error: 'API catalog temporarily unavailable',
          code: TryItErrorCode.CatalogUnavailable,
          fallback: '/api/v1/openapi.json',
        });
        return;
      } finally {
        stop();
      }
    }
    res.set('ETag', cached.etag);
    res.set('Cache-Control', 'public, max-age=60');
    if (req.get('if-none-match') === cached.etag) {
      res.status(304).end();
      tryItAssetRequests.inc({ asset: 'catalog', status: '304' });
      return;
    }
    res.type('application/json').send(cached.body);
    tryItAssetRequests.inc({ asset: 'catalog', status: '200' });
  });

  return router;
}

/**
 * Counts and logs API requests sent from the console (`X-Client: try-it`).
 * Attribution only — it never changes the response.
 */
export function tryItAttribution(req: Request, res: Response, next: NextFunction): void {
  if (req.get('x-client') === 'try-it') {
    res.on('finish', () => {
      const statusClass = `${Math.floor(res.statusCode / 100)}xx`;
      tryItApiRequests.inc({ method: req.method, status_class: statusClass });
      logger.info('[try-it] request', {
        method: req.method,
        path: req.baseUrl + (req.route?.path ?? ''),
        status: res.statusCode,
        requestId: (req as Request & { requestId?: string }).requestId,
      });
    });
  }
  next();
}
