// OTel SDK must be initialised before any other imports.
import './tracer';

import express from 'express';
import { createServer, Server } from 'http';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import swaggerUi from 'swagger-ui-express';
import { correlationMiddleware } from './middleware/correlation';
import { config } from './config';
import { router } from './api/router';
import { prismaWrite as prisma, prismaRead } from './db';
import { startIndexerService, stopIndexerService } from './indexer/indexer';
import { tieredRateLimit, initRateLimitStore } from './middleware/rateLimit';
import { metricsMiddleware } from './middleware/metricsMiddleware';
import { sanitizeInputs, requestSizeGuard } from './middleware/sanitize';
import { i18nMiddleware } from './i18n';
import { registry, dbConnectionStatus, cacheBackendStatus } from './metrics';
import { replicaGuard } from './middleware/replicaGuard';
import { coldStorageRouter, initializeColdStorage } from './middleware/coldStorageRouter';
import { networkRouter } from './middleware/networkRouter';
import { swaggerSpec } from './indexer/swaggerSpec';
import { attachWebSocketServer, shutdownWebSocketServer } from './ws/eventBroadcaster';
import { attachPrivacyWebSocket as attachPrivacyWebSocketReal } from './ws/privacyBroadcaster';
import yogaHandler from './graphql';
import { warmTokenMetadataCache } from './indexer/token-metadata';
import { cacheConnect, cacheClose, isCacheReady, cacheBackendType } from './cache';
import { markReady, markNotReady } from './readiness';
import { errorHandler } from './middleware/errorHandler';
import { requestContext } from './middleware/requestContext';
import { apiKeyAuth } from './middleware/apiKeyAuth';
import { auditLogMiddleware } from './middleware/auditLog';
import { asyncHandler } from './middleware/asyncHandler';
import { rejectUntrustedForwardedHeaders } from './middleware/proxyTrust';
import { billingRouter } from './services/stripe-billing';
import { logger } from './logger';
import { feedOrchestrator } from './feed/orchestrator';
import { startAuditPipeline } from './indexer/audit-pipeline';
import { startAuditScheduler } from './indexer/audit-scheduler';
import { startContinuousAuditMonitor } from './indexer/audit-monitor';
import { attachAuditWebSocket } from './ws/auditBroadcaster';
import { startAuditExpiryChecker } from './indexer/audit-expiry-checker';
import { startAuditDigestScheduler } from './indexer/audit-digest-scheduler';
import { startPriceUpdater, stopPriceUpdater } from './services/pricing';
import { startBridgeWorker, stopBridgeWorker } from './bridge-tracker';
import { writeFile, mkdir } from 'fs/promises';
import { resolve } from 'path';
import { getIndexerStatus } from './indexer-state';
import { startArbitrageScanner as startArbitrageScannerImpl } from './indexer/arbitrage-scanner';
import { startPoolPriceMonitor as startPoolPriceMonitorImpl } from './indexer/pool-price-monitor';
import { startFeeAggregator as startFeeAggregatorImpl } from './indexer/fee-aggregator';
import { attachArbitrageWebSocket as attachArbitrageWebSocketImpl } from './ws/arbitrageBroadcaster';
import { attachComposabilityWebSocket as attachComposabilityWebSocketImpl } from './ws/composabilityBroadcaster';
import { getHealthStatus, getLivenessStatus, getReadinessStatus } from './health';
import {
  getP2pStatusSnapshot,
  resolveLedgerLocation,
  startP2pNode,
  stopP2pNode,
  wireOnTheFlyIndexer,
} from './p2p';
import { indexSingleLedger } from './indexer/indexer';

let isShuttingDown = false;
const SERVICE_START_TIME = Date.now();
let wssRef: ReturnType<typeof attachWebSocketServer> | null = null;

const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS ?? '30000');
// Default to /tmp/state so the path is writable in read-only container filesystems.
// /tmp is already mounted as a tmpfs in the Compose security profile.
const STATE_DUMP_PATH = process.env.STATE_DUMP_PATH ?? '/tmp/state';

// Feature flags — set env var to 'true' to enable each optional service.
const ENABLE_PRIVACY_WS = process.env.ENABLE_PRIVACY_WS === 'true';
const ENABLE_COMPOSABILITY_WS = process.env.ENABLE_COMPOSABILITY_WS === 'true';
const ENABLE_ARBITRAGE_WS = process.env.ENABLE_ARBITRAGE_WS === 'true';
const ENABLE_POOL_MONITOR = process.env.ENABLE_POOL_MONITOR === 'true';
const ENABLE_ARBITRAGE_SCANNER = process.env.ENABLE_ARBITRAGE_SCANNER === 'true';
const ENABLE_FEE_AGGREGATOR = process.env.ENABLE_FEE_AGGREGATOR === 'true';

// Tracks which optional services are disabled, for /readyz reporting.
const disabledServices: string[] = [];

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
    if (isShuttingDown) {
      return res.status(503).json({ status: 'shutting_down', timestamp: new Date().toISOString() });
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
  if (isShuttingDown) {
    return res.status(503).json({ status: 'dead', reason: 'shutting_down' });
  }

  const liveness = getLivenessStatus(SERVICE_START_TIME);
  res.json(liveness);
});

// Readiness probe - detailed check if service can handle traffic
app.get('/readyz', (_req, res) => {
  if (isShuttingDown) {
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

async function saveShutdownState(): Promise<void> {
  try {
    await mkdir(STATE_DUMP_PATH, { recursive: true });
    const state = {
      shutdownTimestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
    await writeFile(
      resolve(STATE_DUMP_PATH, 'shutdown-state.json'),
      JSON.stringify(state, null, 2),
    );
  } catch (err) {
    logger.warn('Failed to save shutdown state', { error: String(err) });
  }
}

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    logger.warn('[shutdown] Already shutting down, forcing exit');
    process.exit(1);
  }
  isShuttingDown = true;
  logger.info(`[shutdown] Received ${signal}, starting graceful shutdown`);

  const forceExit = setTimeout(() => {
    logger.error(`[shutdown] Forced exit after ${SHUTDOWN_TIMEOUT_MS}ms`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  try {
    stopIndexerService();
    logger.info('[shutdown] Indexer service stopped');

    await stopP2pNode().catch((err) =>
      logger.warn('[shutdown] Error stopping p2p node', { error: String(err) }),
    );
    logger.info('[shutdown] P2P node stopped');

    if (wssRef) {
      shutdownWebSocketServer();
      wssRef.close();
      logger.info('[shutdown] WebSocket server closed');
    }

    stopBridgeWorker();
    logger.info('[shutdown] Bridge worker stopped');

    feedOrchestrator.shutdown();
    logger.info('[shutdown] Feed orchestrator stopped');

    stopPriceUpdater();
    logger.info('[shutdown] Price updater stopped');

    await saveShutdownState();
    logger.info('[shutdown] State saved');

    await cacheClose();
    cacheBackendStatus.set(0);
    logger.info('[shutdown] Cache connection closed');

    await prismaRead.$disconnect();
    await prisma.$disconnect();
    dbConnectionStatus.set(0);
    logger.info('[shutdown] Database connections closed');

    clearTimeout(forceExit);
    logger.info('[shutdown] Graceful shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error('[shutdown] Error during graceful shutdown', { error: String(err) });
    clearTimeout(forceExit);
    process.exit(1);
  }
}

function registerShutdownHandlers(): void {
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    logger.error('[shutdown] Uncaught exception', { error: err.message, stack: err.stack });
    gracefulShutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('[shutdown] Unhandled rejection', { error: String(reason) });
    gracefulShutdown('unhandledRejection');
  });
}

async function validateStateDumpPath(): Promise<void> {
  try {
    await mkdir(STATE_DUMP_PATH, { recursive: true });
    const testFile = resolve(STATE_DUMP_PATH, '.write-test');
    await writeFile(testFile, '');
    const { unlink } = await import('fs/promises');
    await unlink(testFile).catch(() => {});
  } catch (err) {
    logger.warn('State dump path is not writable; shutdown state will not be persisted', {
      path: STATE_DUMP_PATH,
      error: String(err),
    });
  }
}

async function main() {
  registerShutdownHandlers();
  await validateStateDumpPath();

  await initRateLimitStore();

  await cacheConnect();
  if (isCacheReady()) markReady('cache');
  cacheBackendStatus.set(cacheBackendType() === 'redis' ? 1 : 0);

  await prisma.$connect();
  dbConnectionStatus.set(1);
  markReady('db');

  await initializeColdStorage();
  markReady('coldStorage');

  wireOnTheFlyIndexer(indexSingleLedger);
  await startP2pNode().catch((err) => {
    logger.error('[p2p] failed to start', { error: String(err) });
  });

  if (!process.env.DISABLE_INDEXER) {
    markReady('indexer');
    startIndexerService().catch((err) => {
      logger.error('Indexer service failed', { error: String(err) });
      markNotReady('indexer');
    });
    warmTokenMetadataCache().catch((err) =>
      logger.warn('Token-metadata cache warm-up failed', { error: String(err) }),
    );
  } else {
    markReady('indexer');
  }

  const httpServer: Server = createServer(app);
  wssRef = attachWebSocketServer(httpServer);

  if (ENABLE_PRIVACY_WS) {
    attachPrivacyWebSocketReal(httpServer);
    logger.info('Privacy WebSocket attached');
  } else {
    disabledServices.push('privacyWS');
    logger.debug('Privacy WebSocket disabled (ENABLE_PRIVACY_WS not set)');
  }

  if (ENABLE_COMPOSABILITY_WS) {
    try {
      attachComposabilityWebSocketImpl(httpServer);
      logger.info('Composability WebSocket attached');
    } catch (err) {
      logger.warn('Composability WebSocket attachment failed', { error: String(err) });
    }
  } else {
    disabledServices.push('composabilityWS');
    logger.debug('Composability WebSocket disabled (ENABLE_COMPOSABILITY_WS not set)');
  }

  if (ENABLE_ARBITRAGE_WS) {
    try {
      attachArbitrageWebSocketImpl(httpServer);
      logger.info('Arbitrage WebSocket attached');
    } catch (err) {
      logger.warn('Arbitrage WebSocket attachment failed', { error: String(err) });
    }
  } else {
    disabledServices.push('arbitrageWS');
    logger.debug('Arbitrage WebSocket disabled (ENABLE_ARBITRAGE_WS not set)');
  }

  const httpServer = createServer(app);
  attachWebSocketServer(httpServer);
  attachPrivacyWebSocket(httpServer);
  attachComposabilityWebSocket(httpServer);
  attachArbitrageWebSocket(httpServer);
  attachAuditWebSocket(httpServer); // /ws/audit — score alerts, finding alerts, signals

  if (!process.env.DISABLE_INDEXER) {
    if (ENABLE_POOL_MONITOR) {
      try {
        startPoolPriceMonitorImpl();
        logger.info('Pool price monitor started');
      } catch (err) {
        logger.warn('Pool price monitor failed to start', { error: String(err) });
      }
    } else {
      disabledServices.push('poolMonitor');
      logger.debug('Pool price monitor disabled (ENABLE_POOL_MONITOR not set)');
    }

    if (ENABLE_ARBITRAGE_SCANNER) {
      try {
        startArbitrageScannerImpl();
        logger.info('Arbitrage scanner started');
      } catch (err) {
        logger.warn('Arbitrage scanner failed to start', { error: String(err) });
      }
    } else {
      disabledServices.push('arbitrageScanner');
      logger.debug('Arbitrage scanner disabled (ENABLE_ARBITRAGE_SCANNER not set)');
    }

    if (ENABLE_FEE_AGGREGATOR) {
      try {
        startFeeAggregatorImpl();
        logger.info('Fee aggregator started');
      } catch (err) {
        logger.warn('Fee aggregator failed to start', { error: String(err) });
      }
    } else {
      disabledServices.push('feeAggregator');
      logger.debug('Fee aggregator disabled (ENABLE_FEE_AGGREGATOR not set)');
    }

    try {
      startBridgeWorker();
    } catch (err) {
      logger.warn('Bridge worker failed to start', { error: String(err) });
    }

    // Audit Pipeline — initial-audit queue drain (fires within 5 min of first detection)
    try {
      startAuditPipeline();
    } catch (err) {
      logger.warn('Audit pipeline failed to start', { error: String(err) });
    }

    // Audit Scheduler — daily (TVL > $100K, incremental) + weekly (all, full recompute)
    try {
      startAuditScheduler();
    } catch (err) {
      logger.warn('Audit scheduler failed to start', { error: String(err) });
    }

    // Continuous Audit Monitor — real-time 7-signal detector, 1-min poll
    try {
      startContinuousAuditMonitor();
    } catch (err) {
      logger.warn('Continuous audit monitor failed to start', { error: String(err) });
    }

    // Certificate Expiry Checker — 30/14/7-day warnings, auto re-audit at 7d
    try {
      startAuditExpiryChecker();
    } catch (err) {
      logger.warn('Audit expiry checker failed to start', { error: String(err) });
    }

    // Weekly Audit Digest Scheduler — posts to Slack/Discord every Monday 09:00 UTC
    try {
      startAuditDigestScheduler();
    } catch (err) {
      logger.warn('Audit digest scheduler failed to start', { error: String(err) });
    }
  }

  try {
    await startPriceUpdater();
    logger.info('Price updater started');
  } catch (err) {
    logger.warn('Price updater failed to start', { error: String(err) });
  }

  await feedOrchestrator.initialize(httpServer);

  httpServer.listen(config.port, () => {
    logger.info('Soroban Explorer API started', { port: config.port });
  });
}

main().catch((err) => logger.error('Main startup failed', { error: String(err) }));
