import express from 'express';
import { createServer } from 'http';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import swaggerUi from 'swagger-ui-express';
import { config } from './config';
import { router } from './api/router';
import { prismaWrite as prisma } from './db';
import { startIndexerService } from './indexer/indexer';
import { tieredRateLimit, initRateLimitStore } from './middleware/rateLimit';
import { metricsMiddleware } from './middleware/metricsMiddleware';
import { sanitizeInputs } from './middleware/sanitize';
import { i18nMiddleware } from './i18n';
import { registry, dbConnectionStatus } from './metrics';
import { replicaGuard } from './middleware/replicaGuard';
import { coldStorageRouter } from './middleware/coldStorageRouter';
import { networkRouter } from './middleware/networkRouter';
import { swaggerSpec } from './indexer/swaggerSpec';
import { attachWebSocketServer } from './ws/eventBroadcaster';
import { warmTokenMetadataCache } from './indexer/token-metadata';
import { cacheConnect } from './cache';
import { startGasAnalyticsScheduler } from './indexer/gasAnalytics';
import { startPortfolioScanner } from './indexer/portfolioScanner';
import { startVolumeAlertScheduler } from './indexer/volumeAlertRunner';
import { startSystemicMonitor } from './indexer/systemicMonitor';
import { startNetworkIndexer } from './indexer/network-indexer';
import { startEmergencyIndexer } from './indexer/emergency-indexer';
import { startHealthScoreScheduler } from './indexer/health-scorer';
import { startPrivacyDetector } from './indexer/privacy-background-detector';
import { startComposabilityIndexer } from './indexer/composability-indexer';
import { attachPrivacyWebSocket } from './ws/privacyBroadcaster';
import { attachComposabilityWebSocket } from './ws/composabilityBroadcaster';
import { attachArbitrageWebSocket } from './ws/arbitrageBroadcaster';
import { startArbitrageScanner } from './indexer/arbitrage-scanner';
import { startPoolPriceMonitor } from './indexer/pool-price-monitor';
import { errorHandler } from './middleware/errorHandler';
import { logger } from './logger';
import { feedOrchestrator } from './feed/orchestrator';
import { refreshPoolRegistry, getAllPools } from './indexer/aggregator/pool-indexer';
import { processDcaStrategies } from './indexer/aggregator/dca';

const app = express();

app.use(helmet({ contentSecurityPolicy: false })); // CSP off so Swagger UI loads
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());
app.use(networkRouter);
app.use(tieredRateLimit);
app.use(metricsMiddleware);
app.use(sanitizeInputs);
app.use(i18nMiddleware);
app.use(replicaGuard);

// #134: Cold storage routing for deep history queries
app.use(coldStorageRouter);

// Interactive API docs
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.get('/api/docs.json', (_req, res) => res.json(swaggerSpec));

app.use('/api/v1', router);

// Prometheus metrics endpoint
app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', registry.contentType);
  res.end(await registry.metrics());
});

app.get('/health', (_req, res) => res.json({ status: 'ok', network: config.stellarNetwork }));

app.use(errorHandler);
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

async function main() {
  await initRateLimitStore();
  await cacheConnect();
  await prisma.$connect();
  dbConnectionStatus.set(1);
  if (!process.env.DISABLE_INDEXER) {
    startIndexerService().catch((err) =>
      logger.error('Indexer service failed', { error: String(err) }),
    );
  }

  if (!process.env.DISABLE_INDEXER) {
    warmTokenMetadataCache().catch((err) =>
      logger.warn('Token-metadata cache warm-up failed', { error: String(err) }),
    );
    startGasAnalyticsScheduler();
    startPortfolioScanner();
    startVolumeAlertScheduler();
    startSystemicMonitor();
    startNetworkIndexer().catch((err) =>
      logger.error('Network indexer failed', { error: String(err) }),
    );
    startEmergencyIndexer().catch((err) =>
      logger.warn('Emergency indexer failed to start', { error: String(err) }),
    );
    startHealthScoreScheduler().catch((err) =>
      logger.warn('Health score scheduler failed to start', { error: String(err) }),
    );
    try {
      startPrivacyDetector();
    } catch (err) {
      logger.warn('Privacy detector failed to start', { error: String(err) });
    }
    try {
      startComposabilityIndexer();
    } catch (err) {
      logger.warn('Composability indexer failed to start', { error: String(err) });
    }
  }

  const httpServer = createServer(app);
  attachWebSocketServer(httpServer);
  attachPrivacyWebSocket(httpServer);
  attachComposabilityWebSocket(httpServer);
  attachArbitrageWebSocket(httpServer);

  if (!process.env.DISABLE_INDEXER) {
    try {
      startPoolPriceMonitor();
    } catch (err) {
      logger.warn('Pool price monitor failed to start', { error: String(err) });
    }
    try {
      startArbitrageScanner();
    } catch (err) {
      logger.warn('Arbitrage scanner failed to start', { error: String(err) });
    }
  }

  // Initialize Feed Orchestrator with WebSocket support
  await feedOrchestrator.initialize(httpServer);

  // Initialize Cross-Protocol Liquidity Aggregation Engine (Issue #334)
  if (!process.env.DISABLE_INDEXER) {
    try {
      await refreshPoolRegistry();
      logger.info('[aggregator] Pool registry initialized', { poolCount: getAllPools().length });
    } catch (err) {
      logger.warn('[aggregator] Pool registry initialization failed', { error: String(err) });
    }

    // Schedule DCA execution every 5 minutes
    setInterval(async () => {
      try {
        const executed = await processDcaStrategies();
        if (executed > 0) {
          logger.info(`[aggregator] Executed ${executed} DCA intervals`);
        }
      } catch (err) {
        logger.warn('[aggregator] DCA execution failed', { error: String(err) });
      }
    }, 300_000); // 5 minutes
  }

  httpServer.listen(config.port, () => {
    logger.info('Soroban Explorer API started', { port: config.port });
  });
}

main().catch((err) => logger.error('Main startup failed', { error: String(err) }));
