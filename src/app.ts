/**
 * Express application factory
 *
 * Owns all HTTP-level concerns: middleware wiring, security headers, CORS,
 * cookie/session handling, routing, health/liveness/readiness probes, the
 * global error handler, and the 404 catch-all. Server creation and
 * background-service startup live in server.ts and services.ts respectively.
 */

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import hpp from 'hpp';
import morgan from 'morgan';
import swaggerUi from 'swagger-ui-express';

import { correlationMiddleware } from './middleware/correlation';
import { responseEnvelopeMiddleware } from './middleware/responseEnvelope';
import { compressionMiddleware } from './middleware/compression';
import { config } from './config';
import { router } from './api/router';
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
import { versioningMiddleware } from './middleware/versioning';
import { apiKeyAuth } from './middleware/apiKeyAuth';
import { auditLogMiddleware } from './middleware/auditLog';
import { asyncHandler } from './middleware/asyncHandler';
import { rejectUntrustedForwardedHeaders } from './middleware/proxyTrust';
import { requestTimeout } from './middleware/requestTimeout';
import { sessionCookieAuth, COOKIE_CONFIG } from './middleware/cookieAuth';
import { billingRouter } from './services/stripe-billing';
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
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Api-Key',
        'X-Request-Id',
        'X-CSRF-Token',
      ],
      credentials: true,
    }),
  );

  // Correlation IDs first — requestId is needed by morgan token and logger.
  app.use(correlationMiddleware);
  app.use(responseEnvelopeMiddleware);

  // Response compression (gzip/brotli) for large JSON payloads
  app.use(
    compressionMiddleware({
      threshold: 1024, // Compress responses >= 1KB
      gzipLevel: 6, // Balanced speed/compression
      brotliLevel: 6, // Balanced speed/compression
      enableBrotli: true, // Try brotli first, fall back to gzip
      logStats: config.nodeEnv === 'development', // Log in dev mode
    }),
  );

  morgan.token('request-id', (req) => (req as express.Request).requestId ?? '-');

  // Query strings can carry sensitive values (API keys, tokens, session ids).
  // Redact any parameter whose name looks sensitive instead of logging it raw.
  const SENSITIVE_QUERY_PARAM_PATTERN =
    /token|key|secret|password|auth|credential|session|signature/i;
  morgan.token('safe-url', (req) => {
    const raw = (req as express.Request).originalUrl ?? req.url ?? '';
    const [pathname, query] = raw.split('?');
    if (!query) return pathname;
    const params = new URLSearchParams(query);
    for (const name of params.keys()) {
      if (SENSITIVE_QUERY_PARAM_PATTERN.test(name)) {
        params.set(name, '[REDACTED]');
      }
    }
    return `${pathname}?${params.toString()}`;
  });
  app.use(
    morgan(
      ':method :safe-url :status :res[content-length] - :response-time ms request-id=:request-id',
    ),
  );

  // CSRF Protection (Issue #658) ───────────────────────────────────────────────────
  // Add CSRF token middleware for cookie-based endpoints
  // Bearer token endpoints are CSRF-protected by design
  const csrfProtection = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    // Skip CSRF check for API key and Bearer token auth (stateless)
    const authHeader = req.headers['authorization'];
    const apiKey = req.headers['x-api-key'];
    if (authHeader?.startsWith('Bearer ') || apiKey) {
      return next();
    }

    // For cookie-based sessions, validate CSRF token from header
    const csrfToken = req.headers['x-csrf-token'];
    const sessionToken = req.cookies?.['__session'];

    if (sessionToken && !csrfToken) {
      return res.status(403).json({ error: 'CSRF token required' });
    }
    next();
  };
  app.use(csrfProtection);

  // Set SameSite cookie policy (Issue #658)
  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    const originalSend = res.send;
    res.send = function (data: any) {
      res.setHeader(
        'Set-Cookie',
        (res.getHeader('Set-Cookie') || []).map((cookie: string) => {
          if (!cookie.includes('SameSite')) {
            return `${cookie}; SameSite=Strict; Secure; HttpOnly`;
          }
          return cookie;
        }),
      );
      return originalSend.call(this, data);
    };
    next();
  });

  // Request size guard before body parsing (Issue #274)
  app.use(requestSizeGuard(1_048_576)); // 1 MB

  // Explicit request body size limits (Issue #659)
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ limit: '1mb', extended: true }));
  app.use(express.raw({ limit: '1mb', type: 'application/octet-stream' }));

  // HTTP Parameter Pollution protection — last duplicate query parameter wins
  app.use(hpp());
  app.use(networkRouter);

  // Cookie parsing — enables session cookie authentication (cookieAuth middleware)
  // Uses COOKIE_SECRET env var for HMAC signing if provided
  app.use(cookieParser(COOKIE_CONFIG.secret || undefined));

  // Request context FIRST (generates requestId + start time for correlation)
  app.use(requestContext);

  // Session cookie authentication — complements X-Api-Key header auth
  // Validates signed cookies and attaches SessionContext to req.session
  app.use(sessionCookieAuth());

  // Request timeout — prevents long-running queries from hanging indefinitely
  // Applied early so timeout is enforced for all subsequent middleware/routes
  app.use(requestTimeout());

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

  app.use('/api', versioningMiddleware, (req, res, next) => {
    if (!req.url.startsWith('/v1/') && req.url !== '/v1') {
      req.url = '/v1' + (req.url.startsWith('/') ? req.url : '/' + req.url);
    }
    next();
  });
  app.use('/api/v1', router);
  app.use('/api/billing', billingRouter);

  app.get(
    '/metrics',
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

  // /healthz — Kubernetes liveness probe (Issue #704)
  // Returns 200 while the process is alive; 503 during graceful shutdown.
  // K8s probe config: initialDelaySeconds: 15, periodSeconds: 20, failureThreshold: 3
  app.get('/healthz', (_req, res) => {
    if (isShuttingDown()) {
      return res.status(503).json({ status: 'dead', reason: 'shutting_down' });
    }

    const liveness = getLivenessStatus(serviceStartTime);
    res.json(liveness);
  });

  // Readiness probe - detailed check if service can handle traffic
  // /readyz — Kubernetes readiness probe (Issue #704)
  // K8s probe config: initialDelaySeconds: 10, periodSeconds: 10, failureThreshold: 3
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
