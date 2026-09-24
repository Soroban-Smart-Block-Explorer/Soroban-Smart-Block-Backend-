/**
 * Service initialization orchestration
 *
 * Wires up the runtime dependencies and background services in dependency
 * order: cache, database, cold storage, P2P, the indexer, optional services
 * (gated by feature flags), the price updater, and the feed orchestrator.
 * HTTP/WebSocket wiring lives in server.ts; this module only starts services.
 */

import { logger } from './logger';
import { prismaWrite as prisma } from './db';
import { cacheConnect, isCacheReady, cacheBackendType } from './cache';
import { initRateLimitStore } from './middleware/rateLimit';
import { markReady, markNotReady } from './readiness';
import { cacheBackendStatus, dbConnectionStatus } from './metrics';
import { initializeColdStorage } from './middleware/coldStorageRouter';
import { startIndexerService, indexSingleLedger } from './indexer/indexer';
import { wireOnTheFlyIndexer, startP2pNode } from './p2p';
import { warmTokenMetadataCache } from './indexer/token-metadata';
import { startPoolPriceMonitor as startPoolPriceMonitorImpl } from './indexer/pool-price-monitor';
import { startArbitrageScanner as startArbitrageScannerImpl } from './indexer/arbitrage-scanner';
import { startFeeAggregator as startFeeAggregatorImpl } from './indexer/fee-aggregator';
import { startBridgeWorker } from './bridge-tracker';
import { startAuditPipeline } from './indexer/audit-pipeline';
import { startAuditScheduler } from './indexer/audit-scheduler';
import { startContinuousAuditMonitor } from './indexer/audit-monitor';
import { startAuditExpiryChecker } from './indexer/audit-expiry-checker';
import { startAuditDigestScheduler } from './indexer/audit-digest-scheduler';
import { startExpiryCheckScheduler } from './auth/keyRotationScheduler';
import { startPriceUpdater } from './services/pricing';
import { feedOrchestrator } from './feed/orchestrator';
import { eventBus } from './events/eventBus';
import { startGraphqlEventBridge } from './graphql/subscriptions';
import { featureFlags } from './feature-flags';

export async function initializeServices(disabledServices: string[]): Promise<void> {
  await initRateLimitStore();

  await cacheConnect();
  if (isCacheReady()) markReady('cache');
  cacheBackendStatus.set(cacheBackendType() === 'redis' ? 1 : 0);

  await eventBus.connect();
  startGraphqlEventBridge();

  await prisma.$connect();
  dbConnectionStatus.set(1);
  markReady('db');

  try {
    const { getLatestLedger } = await import('./indexer/rpc');
    await getLatestLedger();
    markReady('rpc');
  } catch (err) {
    logger.error('[rpc] Failed to contact RPC node during services init', { error: String(err) });
  }

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

  if (!process.env.DISABLE_INDEXER) {
    if (featureFlags.shouldStartSync('poolMonitor')) {
      try {
        startPoolPriceMonitorImpl();
        logger.info('Pool price monitor started');
      } catch (err) {
        logger.warn('Pool price monitor failed to start', { error: String(err) });
      }
    } else if (!featureFlags.isEnabledSync('poolMonitor')) {
      disabledServices.push('poolMonitor (flag off)');
      logger.debug('Pool price monitor disabled (feature flag poolMonitor off)');
    } else {
      disabledServices.push('poolMonitor (schema unavailable)');
      logger.debug('Pool price monitor disabled (required tables missing)');
    }

    if (featureFlags.shouldStartSync('arbitrageScanner')) {
      try {
        startArbitrageScannerImpl();
        logger.info('Arbitrage scanner started');
      } catch (err) {
        logger.warn('Arbitrage scanner failed to start', { error: String(err) });
      }
    } else if (!featureFlags.isEnabledSync('arbitrageScanner')) {
      disabledServices.push('arbitrageScanner (flag off)');
      logger.debug('Arbitrage scanner disabled (feature flag arbitrageScanner off)');
    } else {
      disabledServices.push('arbitrageScanner (schema unavailable)');
      logger.debug('Arbitrage scanner disabled (required tables missing)');
    }

    if (featureFlags.shouldStartSync('feeAggregator')) {
      try {
        startFeeAggregatorImpl();
        logger.info('Fee aggregator started');
      } catch (err) {
        logger.warn('Fee aggregator failed to start', { error: String(err) });
      }
    } else if (!featureFlags.isEnabledSync('feeAggregator')) {
      disabledServices.push('feeAggregator (flag off)');
      logger.debug('Fee aggregator disabled (feature flag feeAggregator off)');
    } else {
      disabledServices.push('feeAggregator (schema unavailable)');
      logger.debug('Fee aggregator disabled (required tables missing)');
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

  // DevApiKey expiry enforcement — auto-disables expired keys + emits KeyRotationAudit (#888)
  try {
    startExpiryCheckScheduler();
    logger.info('DevApiKey expiry scheduler started');
  } catch (err) {
    logger.warn('DevApiKey expiry scheduler failed to start', { error: String(err) });
  }

  await feedOrchestrator.initialize();
}
