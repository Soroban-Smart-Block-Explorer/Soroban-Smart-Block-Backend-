// OTel SDK must be initialised before any other imports.
import './tracer';

import { writeFile, mkdir } from 'fs/promises';
import { resolve } from 'path';
import type { Server } from 'http';
import type { Socket } from 'net';

import { createApp } from './app';
import { createHttpServer } from './server';
import { initializeServices } from './services';
import { config } from './config';
import { prismaWrite as prisma, prismaRead, prismaBackfill } from './db';
import { stopIndexerService } from './indexer/indexer';
import { stopP2pNode } from './p2p';
import { shutdownWebSocketServer } from './ws/eventBroadcaster';
import { stopBridgeWorker } from './bridge-tracker';
import { feedOrchestrator } from './feed/orchestrator';
import { eventBus } from './events/eventBus';
import { startGraphqlEventBridge } from './graphql/subscriptions';
import { startAuditPipeline } from './indexer/audit-pipeline';
import { startAuditScheduler } from './indexer/audit-scheduler';
import { startContinuousAuditMonitor } from './indexer/audit-monitor';
import { startAuditExpiryChecker } from './indexer/audit-expiry-checker';
import { startAuditDigestScheduler } from './indexer/audit-digest-scheduler';
import { startKeyRotationScheduler } from './auth/keyRotationScheduler';
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
let wssRef: ReturnType<typeof createHttpServer>['wssRef'] | null = null;
let serverRef: Server | null = null;
const activeConnections = new Set<Socket>();

const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS ?? '30000');
// Default to /tmp/state so the path is writable in read-only container filesystems.
// /tmp is already mounted as a tmpfs in the Compose security profile.
const STATE_DUMP_PATH = process.env.STATE_DUMP_PATH ?? '/tmp/state';

// Names of optional services that are disabled, reported by /ready.
const disabledServices: string[] = [];

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
    if (serverRef) {
      logger.info('[shutdown] Closing HTTP server, draining connections...');
      const closePromise = new Promise<void>((resolve) => {
        serverRef!.close(() => {
          logger.info('[shutdown] HTTP server closed');
          resolve();
        });
      });

      const connForceTimeout = setTimeout(() => {
        if (activeConnections.size > 0) {
          logger.warn(
            `[shutdown] Forcing close of ${activeConnections.size} remaining active connections`,
          );
          for (const socket of activeConnections) {
            socket.destroy();
          }
        }
      }, 5000);

      await closePromise;
      clearTimeout(connForceTimeout);
    }

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

    await eventBus.close();
    logger.info('[shutdown] Event bus closed');

    await prismaRead.$disconnect();
    await prisma.$disconnect();
    await prismaBackfill.$disconnect();
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

  await eventBus.connect();
  startGraphqlEventBridge();

  await prisma.$connect();
  dbConnectionStatus.set(1);
  markReady('db');

  await initializeColdStorage();
  markReady('coldStorage');

  wireOnTheFlyIndexer(indexSingleLedger);
  await startP2pNode().catch((err) => {
    logger.error('[p2p] failed to start', { error: String(err) });
  });

  const server = createHttpServer(app, disabledServices);
  wssRef = server.wssRef;
  serverRef = server.httpServer;
  server.httpServer.on('connection', (socket) => {
    activeConnections.add(socket);
    socket.on('close', () => {
      activeConnections.delete(socket);
    });
  });

  await initializeServices(server.httpServer, disabledServices);

  server.httpServer.listen(config.port, () => {
    logger.info('Soroban Explorer API started', { port: config.port });
  });
}

main().catch((err) => logger.error('Main startup failed', { error: String(err) }));
