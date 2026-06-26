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
import { sanitizeInputs } from './middleware/sanitize';
import { i18nMiddleware } from './i18n';
import { registry, dbConnectionStatus } from './metrics';
import { replicaGuard } from './middleware/replicaGuard';
import { coldStorageRouter, initializeColdStorage } from './middleware/coldStorageRouter';
import { networkRouter } from './middleware/networkRouter';
import { swaggerSpec } from './indexer/swaggerSpec';
import { attachWebSocketServer, shutdownWebSocketServer } from './ws/eventBroadcaster';
import { attachPrivacyWebSocket as attachPrivacyWebSocketReal } from './ws/privacyBroadcaster';
import yogaHandler from './graphql';
import { warmTokenMetadataCache } from './indexer/token-metadata';
import { cacheConnect, cacheClose } from './cache';
import { errorHandler } from './middleware/errorHandler';
import { logger } from './logger';
import { setIndexerFailed, getIndexerStatus } from './indexer-state';

const app = express();
app.set('trust proxy', config.trustProxy);
app.use(rejectUntrustedForwardedHeaders);

app.use(helmet({ contentSecurityPolicy: false }));

// Build an origin allowlist from CORS_ALLOWED_ORIGINS (comma-separated URLs).
// Production requires an explicit list; other envs fall back to '*'.
const corsOrigin: cors.CorsOptions['origin'] = (() => {
  const raw = process.env.CORS_ALLOWED_ORIGINS?.trim();
  if (raw) return raw.split(',').map((o) => o.trim());
  if (config.nodeEnv === 'production') return false;
  return '*';
})();

// Module-scoped server reference so gracefulShutdown can close it (#439)
let httpServer: ReturnType<typeof createServer> | null = null;

async function gracefulShutdown(signal: string): Promise<void> {
  logger.info('Graceful shutdown initiated', { signal });

  await new Promise<void>((resolve) => {
    if (!httpServer) { resolve(); return; }
    httpServer.close((err) => {
      if (err) logger.error('HTTP server close error', { error: String(err) });
      resolve();
    });
  });

  try { await prisma.$disconnect(); } catch { /* ignore */ }

  logger.info('Graceful shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => { gracefulShutdown('SIGTERM').catch(() => process.exit(1)); });
process.on('SIGINT',  () => { gracefulShutdown('SIGINT').catch(() => process.exit(1)); });

app.use(helmet({ contentSecurityPolicy: false })); // CSP off so Swagger UI loads
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());
app.use(networkRouter);
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

app.get('/health', (_req, res) => {
  if (isShuttingDown) {
    return res.status(503).json({ status: 'shutting_down' });
  }
  res.json({ status: 'ok', network: config.stellarNetwork });
});

app.get('/readyz', (_req, res) => {
  if (isShuttingDown) {
    return res.status(503).json({ status: 'not_ready' });
  }
  res.json({ status: 'ready' });
});

// Readiness probe — returns 503 when the indexer has suffered a fatal failure (#440)
app.get('/ready', (_req, res) => {
  const { healthy, failureReason } = getIndexerStatus();
  if (!healthy) {
    res.status(503).json({ status: 'unavailable', reason: failureReason });
    return;
  }
  res.json({ status: 'ready' });
});

app.use(errorHandler);
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

async function main() {
  registerShutdownHandlers();

  await initRateLimitStore();
  await cacheConnect();
  await prisma.$connect();
  dbConnectionStatus.set(1);
  await initializeColdStorage();

  if (!process.env.DISABLE_INDEXER) {
    startIndexerService().catch((err) =>
      logger.error('Indexer service failed', { error: String(err) }),
    );
    warmTokenMetadataCache().catch((err) =>
      logger.warn('Token-metadata cache warm-up failed', { error: String(err) }),
    );
  }

  const httpServer: Server = createServer(app);
  wssRef = attachWebSocketServer(httpServer);
  attachPrivacyWebSocketReal(httpServer);
  attachComposabilityWebSocket(httpServer);
  attachArbitrageWebSocket(httpServer);

  if (!process.env.DISABLE_INDEXER) {
    startPoolPriceMonitor();
    startArbitrageScanner();
    startFeeAggregator();
    try {
      startBridgeWorker();
    } catch (err) {
      logger.warn('Bridge worker failed to start', { error: String(err) });
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
