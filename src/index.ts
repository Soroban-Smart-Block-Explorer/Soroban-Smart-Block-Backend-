// OTel SDK must be initialised before any other imports.
import './tracer';

import { writeFile, mkdir } from 'fs/promises';
import { resolve } from 'path';

import { createApp } from './app';
import { createHttpServer } from './server';
import { initializeServices } from './services';
import { config } from './config';
import { prismaWrite as prisma, prismaRead } from './db';
import { stopIndexerService } from './indexer/indexer';
import { stopP2pNode } from './p2p';
import { shutdownWebSocketServer } from './ws/eventBroadcaster';
import { stopBridgeWorker } from './bridge-tracker';
import { feedOrchestrator } from './feed/orchestrator';
import { stopPriceUpdater } from './services/pricing';
import { cacheClose } from './cache';
import { dbConnectionStatus, cacheBackendStatus } from './metrics';
import { logger } from './logger';

let isShuttingDown = false;
const SERVICE_START_TIME = Date.now();
let wssRef: ReturnType<typeof createHttpServer>['wssRef'] | null = null;

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

  const app = createApp({
    isShuttingDown: () => isShuttingDown,
    serviceStartTime: SERVICE_START_TIME,
    disabledServices,
  });

  const server = createHttpServer(app, disabledServices);
  wssRef = server.wssRef;

  await initializeServices(server.httpServer, disabledServices);

  server.httpServer.listen(config.port, () => {
    logger.info('Soroban Explorer API started', { port: config.port });
  });
}

main().catch((err) => logger.error('Main startup failed', { error: String(err) }));
