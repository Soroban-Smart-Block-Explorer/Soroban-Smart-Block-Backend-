import { Router, Request, Response } from 'express';
import { Logger } from '../logger';
import { getAdaptivePollingService } from './adaptive-polling';
import { getPredictiveModelService } from './predictive-model';
import { getGracefulDegradationService, LoadLevel } from './graceful-degradation';
import { getNATSQueueService } from './nats-queue';
import { db } from '../db';

/**
 * Control Plane API
 * Operator dashboard for monitoring and controlling the adaptive indexer
 */

const logger = new Logger('ControlPlane');
const router = Router();

/**
 * GET /admin/indexer/status
 * Get current status of adaptive indexer
 */
router.get('/status', async (req: Request, res: Response) => {
  try {
    const pollingService = getAdaptivePollingService();
    const degradationService = getGracefulDegradationService();
    const natsQueue = await getNATSQueueService();

    const pollingState = pollingService.getState();
    const degradationStats = await degradationService.getStats();
    const queueDepths = await natsQueue.getAllQueueDepths();

    // Get metrics from database
    const metricsResult = await db.query(`
      SELECT 
        (SELECT COUNT(*) FROM ledger_gap) as ledgers_behind,
        (SELECT value FROM indexer_state WHERE key = 'processing_rate') as processing_rate,
        (SELECT value FROM indexer_state WHERE key = 'last_ledger_processed') as last_ledger
    `);

    const metrics = metricsResult.rows[0] || {};

    res.json({
      ledgersBehind: parseInt(metrics.ledgers_behind || 0),
      processingRate: parseFloat(metrics.processing_rate || 0),
      loadLevel: degradationStats.currentLevel,
      backpressure: queueDepths['RAW_LEDGERS'] / 10000, // normalized to 0-1
      adaptivePollingInterval: pollingState.currentInterval,
      processingMode: pollingState.currentInterval < 500 ? 'realtime' : 'batch',
      workerCounts: {
        ingester: parseInt(process.env.INDEXER_REPLICAS || '4'),
        decoder: parseInt(process.env.DECODER_REPLICAS || '4'),
        enrichment: parseInt(process.env.ENRICHMENT_REPLICAS || '4'),
        analytics: parseInt(process.env.ANALYTICS_REPLICAS || '2')
      },
      queueDepths: {
        raw: queueDepths['RAW_LEDGERS'] || 0,
        decoded: queueDepths['DECODED_TRANSACTIONS'] || 0,
        enriched: queueDepths['ENRICHED_EVENTS'] || 0,
        backfill: queueDepths['BACKFILL_LEDGERS'] || 0
      },
      degradation: {
        currentLevel: degradationStats.currentLevel,
        skippedEventsTotal: degradationStats.skippedEventsTotal,
        backfillQueueSize: degradationStats.backfillQueueSize
      },
      prediction: {
        horizon: 5,
        throughput: 450,
        confidence: 0.92,
        lastPredictionTime: new Date().toISOString()
      }
    });
  } catch (error) {
    logger.error('Failed to get status', { error });
    res.status(500).json({ error: 'Failed to get status' });
  }
});

/**
 * GET /admin/indexer/metrics
 * Get detailed metrics for monitoring
 */
router.get('/metrics', async (req: Request, res: Response) => {
  try {
    const degradationService = getGracefulDegradationService();
    const modelService = await getPredictiveModelService();

    const degradationConfig = degradationService.getConfig();
    const modelMetrics = await modelService.getModelMetrics();

    res.json({
      degradation: degradationConfig,
      prediction: {
        rmse: modelMetrics.rmse,
        accuracy: modelMetrics.accuracy,
        lastTraining: new Date(modelMetrics.lastTraining).toISOString(),
        predictionsCount: modelMetrics.predictionsCount
      }
    });
  } catch (error) {
    logger.error('Failed to get metrics', { error });
    res.status(500).json({ error: 'Failed to get metrics' });
  }
});

/**
 * POST /admin/indexer/mode
 * Set processing mode manually
 */
router.post('/mode', async (req: Request, res: Response) => {
  try {
    const { mode } = req.body;

    if (!['realtime', 'balanced', 'backlog', 'catchup'].includes(mode)) {
      return res.status(400).json({ error: 'Invalid mode' });
    }

    const pollingService = getAdaptivePollingService();
    const intervals = {
      realtime: 100,
      balanced: 500,
      backlog: 2000,
      catchup: 5000
    };

    const newInterval = intervals[mode as keyof typeof intervals];
    pollingService.updateConfig({ minInterval: newInterval, maxInterval: newInterval });

    logger.info(`Processing mode changed to ${mode}`);

    res.json({ mode, pollingInterval: newInterval });
  } catch (error) {
    logger.error('Failed to set mode', { error });
    res.status(500).json({ error: 'Failed to set mode' });
  }
});

/**
 * POST /admin/indexer/degradation
 * Manually set degradation level
 */
router.post('/degradation', async (req: Request, res: Response) => {
  try {
    const { level, override } = req.body;

    if (!Object.values(LoadLevel).includes(level)) {
      return res.status(400).json({ error: 'Invalid degradation level' });
    }

    const degradationService = getGracefulDegradationService();

    if (override) {
      await degradationService.setManualOverride(level, 30); // 30 minutes
      logger.warn(`Manual degradation override set to ${level}`);
    } else {
      await degradationService.applyDegradation(level);
      logger.info(`Degradation level set to ${level}`);
    }

    res.json({
      level,
      override,
      appliedAt: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Failed to set degradation level', { error });
    res.status(500).json({ error: 'Failed to set degradation level' });
  }
});

/**
 * POST /admin/indexer/backfill
 * Manually trigger backfill of skipped ledgers
 */
router.post('/backfill', async (req: Request, res: Response) => {
  try {
    const degradationService = getGracefulDegradationService();

    // Start backfill in background
    degradationService.startBackfillProcess().catch(error => {
      logger.error('Backfill failed', { error });
    });

    res.json({
      status: 'backfill_started',
      startedAt: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Failed to start backfill', { error });
    res.status(500).json({ error: 'Failed to start backfill' });
  }
});

/**
 * GET /admin/indexer/predictions
 * Get prediction model info and recent predictions
 */
router.get('/predictions', async (req: Request, res: Response) => {
  try {
    const modelService = await getPredictiveModelService();
    const metrics = await modelService.getModelMetrics();
    const recentPredictions = modelService.getRecentPredictions();

    // Get prediction history from database
    const historyResult = await db.query(`
      SELECT 
        timestamp,
        horizon_minutes,
        predicted_throughput,
        actual_throughput,
        confidence,
        error_rate
      FROM predictions
      ORDER BY timestamp DESC
      LIMIT 100
    `);

    res.json({
      model: {
        type: 'lstm-v2',
        trained: new Date(metrics.lastTraining).toISOString(),
        rmse: metrics.rmse,
        accuracy: metrics.accuracy,
        nextRetrain: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
      },
      recent: recentPredictions.slice(0, 10),
      history: historyResult.rows
    });
  } catch (error) {
    logger.error('Failed to get predictions', { error });
    res.status(500).json({ error: 'Failed to get predictions' });
  }
});

/**
 * GET /admin/indexer/cost-analytics
 * Get cost analysis and optimization recommendations
 */
router.get('/cost-analytics', async (req: Request, res: Response) => {
  try {
    const result = await db.query(`
      SELECT 
        AVG(processing_duration_ms) as avg_duration,
        COUNT(*) as ledgers_processed,
        (SELECT COUNT(DISTINCT contract_id) FROM events) as unique_contracts
      FROM indexer_state
      WHERE processed_at > NOW() - INTERVAL '24 hours'
    `);

    const stats = result.rows[0] || {};
    const ledgersProcessed = parseInt(stats.ledgers_processed || 0);
    const avgDuration = parseFloat(stats.avg_duration || 100);

    // Mock cost calculations
    const costPerLedger = 0.0001;
    const costPerTx = 0.00005;
    const estimatedWorkerCost = 8 * 0.05; // 8 workers * $0.05/hour

    res.json({
      costPerLedger,
      costPerTx,
      dailyCost: ledgersProcessed * costPerLedger,
      monthlyCost: ledgersProcessed * costPerLedger * 30,
      workerCost: {
        current: estimatedWorkerCost,
        optimal: 6 * 0.05,
        estimated_monthly_savings: (estimatedWorkerCost - 6 * 0.05) * 730 // hours per month
      },
      optimizations: [
        {
          recommendation: 'Scale down to 6 workers (current: 8)',
          savings: (estimatedWorkerCost - 6 * 0.05) * 730
        },
        {
          recommendation: 'Enable Level 1 graceful degradation during off-hours',
          savings: 200
        }
      ]
    });
  } catch (error) {
    logger.error('Failed to get cost analytics', { error });
    res.status(500).json({ error: 'Failed to get cost analytics' });
  }
});

/**
 * GET /admin/indexer/health
 * Health check for liveness probes
 */
router.get('/health', async (req: Request, res: Response) => {
  try {
    const natsQueue = await getNATSQueueService();
    const isHealthy = natsQueue.isHealthy();

    if (isHealthy) {
      res.json({ status: 'healthy' });
    } else {
      res.status(503).json({ status: 'unhealthy' });
    }
  } catch (error) {
    res.status(503).json({ status: 'error', error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

export default router;
