/**
 * Express application factory
 *
 * Owns all HTTP-level concerns: middleware wiring, security headers, CORS,
 * routing, health/liveness/readiness probes, the global error handler, and
 * the 404 catch-all. Server creation and background-service startup live in
 * server.ts and services.ts respectively.
 */

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import swaggerUi from 'swagger-ui-express';

import { config } from './config';
import { router } from './api/router';
import { billingRouter } from './services/stripe-billing';
import { correlationMiddleware } from './middleware/correlation';
import { tieredRateLimit } from './middleware/rateLimit';
import { metricsMiddleware } from './middleware/metricsMiddleware';
import { sanitizeInputs, requestSizeGuard } from './middleware/sanitize';
import { i18nMiddleware } from './i18n';
import { registry } from './metrics';
import { replicaGuard } from './middleware/replicaGuard';
import { coldStorageRouter } from './middleware/coldStorageRouter';
import { networkRouter } from './middleware/networkRouter';
import { swaggerSpec } from './indexer/swaggerSpec';
import yogaHandler from './graphql';
import { errorHandler } from './middleware/errorHandler';
import { requestContext } from './middleware/requestContext';
import { apiKeyAuth } from './middleware/apiKeyAuth';
import { metricsAuth, metricsRateLimiter } from './middleware/metricsAuth';
import { auditLogMiddleware } from './middleware/auditLog';
import { asyncHandler } from './middleware/asyncHandler';
import { rejectUntrustedForwardedHeaders } from './middleware/proxyTrust';
import { getHealthStatus, getLivenessStatus, getReadinessStatus } from './health';
import { getP2pStatusSnapshot, resolveLedgerLocation } from './p2p';
import { getIndexerStatus } from './indexer-state';

export interface AppOptions {
  /** Returns true once graceful shutdown has begun (probes respond 503). */
  isShuttingDown: () => boolean;
  /** Timestamp (ms) when the service started, used by the liveness probe. */
  serviceStartTime: number;
  /** Names of optional services that are disabled (reported by /ready). */
  disabledServices: string[];
}

export function createApp(options: AppOptions): express.Express {
  const { isShuttingDown, serviceStartTime, disabledServices } = options;

  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.use(rejectUntrustedForwardedHeaders);

  // ── Security Headers (Issue #274) ─────────────────────────────────────────────
  // Helmet provides HSTS, X-Frame-Options, X-Content-Type-Options, and more.
  app.use(
    helmet({
      // Content-Security-Policy: restrict resource origins, block inline execution
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'https:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          mediaSrc: ["'none'"],
          frameSrc: ["'none'"],
          frameAncestors: ["'none'"],
          formAction: ["'self'"],
          upgradeInsecureRequests: [],
        },
      },
      // HTTP Strict Transport Security: 1 year, include subdomains
      hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true,
      },
      // Prevents MIME-type sniffing
      noSniff: true,
      // Denies framing — defence against clickjacking
      frameguard: { action: 'deny' },
      // Referrer policy: only send origin on same-origin requests
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      // Remove X-Powered-By
      hidePoweredBy: true,
      // XSS filter (legacy browsers)
      xssFilter: true,
      // Prevent IE from opening downloads in-site
      ieNoOpen: true,
    }),
  );

  // Build an origin allowlist from CORS_ALLOWED_ORIGINS (comma-separated URLs).
  // Production requires an explicit list; other envs fall back to '*'.
  const corsOrigin: cors.CorsOptions['origin'] = (() => {
    const raw = process.env.CORS_ALLOWED_ORIGINS?.trim();
    if (raw) return raw.split(',').map((o) => o.trim());
    if (config.nodeEnv === 'production') return false;
    return '*';
  })();

  app.use(
    cors({
      origin: corsOrigin,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Api-Key', 'X-Request-Id'],
      credentials: true,
    }),
  );

  // Correlation IDs first — requestId is needed by morgan token and logger.
  app.use(correlationMiddleware);
  morgan.token('request-id', (req) => (req as express.Request).requestId ?? '-');
  app.use(
    morgan(':method :url :status :res[content-length] - :response-time ms request-id=:request-id'),
  );

  // Request size guard before body parsing (Issue #274)
  app.use(requestSizeGuard(1_048_576)); // 1 MB

  app.use(express.json({ limit: '1mb' }));
  app.use(networkRouter);

  // Request context FIRST (generates requestId + start time for correlation)
  app.use(requestContext);

  // Auth must resolve before rate limiting so tier is known
  app.use(apiKeyAuth);
  app.use(tieredRateLimit);
  app.use(metricsMiddleware);
  app.use(sanitizeInputs);
  app.use(i18nMiddleware);
  app.use(replicaGuard);
  // Audit log captures status + rate limit headers after response
  app.use(auditLogMiddleware);

  app.use(coldStorageRouter);

  // Interactive Swagger UI is disabled in production unless ENABLE_DOCS=true.
  // The raw schema endpoints remain available for tooling/codegen in all envs.
  const docsEnabled = config.nodeEnv !== 'production' || process.env.ENABLE_DOCS === 'true';
  if (docsEnabled) {
    app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
  }
  app.get('/api/docs.json', (_req, res) => res.json(swaggerSpec));
  app.get('/api/v1/openapi.json', (_req, res) => res.json(swaggerSpec));

  app.use('/api/graphql', yogaHandler as unknown as express.RequestHandler);

  app.use('/api/v1', router);
  app.use('/api/billing', billingRouter);

  // #907 — /metrics is rate-limited and gated behind an IP allowlist or
  // bearer token (see src/middleware/metricsAuth.ts). It is also excluded
  // from public Ingress routing (k8s/ingress.yaml) and restricted at the
  // pod-network layer (k8s/network-policy.yaml).
  app.get(
    '/metrics',
    metricsRateLimiter,
    metricsAuth,
    asyncHandler(async (_req, res) => {
      res.set('Content-Type', registry.contentType);
      res.end(await registry.metrics());
    }),
  );

  // Health endpoint with dependency status
  app.get(
    '/health',
    asyncHandler(async (_req, res) => {
      if (isShuttingDown()) {
        return res
          .status(503)
          .json({ status: 'shutting_down', timestamp: new Date().toISOString() });
      }

      const healthStatus = await getHealthStatus();

      // Return 503 if any dependency is unhealthy, 200 otherwise
      const statusCode = healthStatus.status === 'unhealthy' ? 503 : 200;

      res.status(statusCode).json({
        ...healthStatus,
        network: config.stellarNetwork,
      });
    }),
  );

  // P2P indexer network status — peer table, range ownership, recent challenge
  // results (see docs/P2P_INDEXER_DESIGN.md §1.4 dashboard). Reports enabled:false
  // with an empty snapshot on single-node deployments rather than erroring.
  app.get(
    '/p2p/status',
    asyncHandler(async (_req, res) => {
      const snapshot = await getP2pStatusSnapshot();
      res.json(snapshot);
    }),
  );

  // Coordinator-less ledger lookup (design doc §1.3): local DB first, then
  // DHT-forward to a live range owner, then on-the-fly indexing as a last
  // resort. Works identically whether P2P is enabled or not — in single-node
  // mode it's just a local lookup with graceful degradation to on-the-fly
  // indexing, which is a strict improvement over a plain 404.
  app.get(
    '/p2p/ledger/:seq',
    asyncHandler(async (req, res) => {
      const seq = parseInt(req.params.seq, 10);
      if (!Number.isFinite(seq) || seq < 0) {
        return res.status(400).json({ error: 'Invalid ledger sequence' });
      }
      const includeEvents = req.query.events !== 'false';
      const result = await resolveLedgerLocation(config.stellarNetwork, seq, includeEvents);
      res.status(result.found ? 200 : 404).json(result);
    }),
  );

  // Liveness probe - basic check that service is alive
  app.get('/livez', (_req, res) => {
    if (isShuttingDown()) {
      return res.status(503).json({ status: 'dead', reason: 'shutting_down' });
    }

    const liveness = getLivenessStatus(serviceStartTime);
    res.json(liveness);
  });

  // Readiness probe - detailed check if service can handle traffic
  app.get('/readyz', (_req, res) => {
    if (isShuttingDown()) {
      return res.status(503).json({ status: 'not_ready', reason: 'shutting_down' });
    }

    const readinessStatus = getReadinessStatus();
    const statusCode = readinessStatus.status === 'ready' ? 200 : 503;

    res.status(statusCode).json(readinessStatus);
  });

  // Legacy readiness probe — returns 503 when the indexer has suffered a fatal failure (#440)
  app.get('/ready', (_req, res) => {
    const { healthy, failureReason } = getIndexerStatus();
    if (!healthy) {
      res.status(503).json({ status: 'unavailable', reason: failureReason });
      return;
    }
    res.json({
      status: 'ready',
      ...(disabledServices.length > 0 && { disabledServices }),
    });
  });

  // Global error handler — MUST be after all routes but BEFORE 404 catch-all
  app.use(errorHandler);

  // 404 catch-all — only fires when no route matched (not an error)
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

  return app;
}
