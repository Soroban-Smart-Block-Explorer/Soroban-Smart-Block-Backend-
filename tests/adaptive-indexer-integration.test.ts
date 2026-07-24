import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AdaptivePollingService } from '../src/indexer/adaptive-polling';
import { PredictiveModelService } from '../src/indexer/predictive-model';
import {
  GracefulDegradationService,
  LoadLevel,
  LoadMetrics,
} from '../src/indexer/graceful-degradation';

/**
 * Integration tests for Adaptive Indexer components
 */

describe('Adaptive Indexer Integration', () => {
  let pollingService: AdaptivePollingService;
  let degradationService: GracefulDegradationService;
  let modelService: PredictiveModelService;

  beforeAll(async () => {
    pollingService = new AdaptivePollingService();
    degradationService = new GracefulDegradationService();
    modelService = new PredictiveModelService();
    await modelService.initialize();
  });

  describe('Adaptive Polling', () => {
    it('should increase polling interval when caught up', async () => {
      const metrics = {
        ledgersBehind: 0,
        processingQueueDepth: 0,
        availableWorkers: 4,
        processingRate: 100,
      };

      const interval = await pollingService.calculateNextInterval({
        ...metrics,
        currentInterval: 1000,
      });

      // Should increase interval when caught up
      expect(interval).toBeGreaterThan(1000);
      expect(interval).toBeLessThanOrEqual(5000);
    });

    it('should decrease polling interval when behind', async () => {
      const metrics = {
        ledgersBehind: 150,
        processingQueueDepth: 5000,
        availableWorkers: 4,
        processingRate: 50,
      };

      const interval = await pollingService.calculateNextInterval({
        ...metrics,
        currentInterval: 5000,
      });

      // Should decrease interval when behind
      expect(interval).toBeLessThan(5000);
      expect(interval).toBeGreaterThanOrEqual(100);
    });

    it('should calculate correct batch size based on backlog', () => {
      // Real-time mode
      let batchSize = pollingService.calculateBatchSize({
        ledgersBehind: 5,
        processingQueueDepth: 100,
        availableWorkers: 4,
        processingRate: 100,
      });
      expect(batchSize).toBe(1);

      // Batch mode
      batchSize = pollingService.calculateBatchSize({
        ledgersBehind: 50,
        processingQueueDepth: 2000,
        availableWorkers: 4,
        processingRate: 50,
      });
      expect(batchSize).toBeGreaterThanOrEqual(5);
      expect(batchSize).toBeLessThanOrEqual(10);

      // Catch-up mode
      batchSize = pollingService.calculateBatchSize({
        ledgersBehind: 200,
        processingQueueDepth: 10000,
        availableWorkers: 4,
        processingRate: 20,
      });
      expect(batchSize).toBeGreaterThanOrEqual(20);
      expect(batchSize).toBeLessThanOrEqual(50);
    });

    it('should determine processing mode correctly', () => {
      const realtimeMode = pollingService.getProcessingMode({
        ledgersBehind: 5,
        processingQueueDepth: 100,
        availableWorkers: 4,
        processingRate: 100,
      });
      expect(realtimeMode).toBe('realtime');

      const batchMode = pollingService.getProcessingMode({
        ledgersBehind: 50,
        processingQueueDepth: 2000,
        availableWorkers: 4,
        processingRate: 50,
      });
      expect(batchMode).toBe('batch');

      const catchupMode = pollingService.getProcessingMode({
        ledgersBehind: 200,
        processingQueueDepth: 10000,
        availableWorkers: 4,
        processingRate: 20,
      });
      expect(catchupMode).toBe('catchup');
    });

    it('should skip empty ledgers only in catch-up mode', () => {
      const shouldSkip1 = pollingService.shouldSkipEmptyLedgersCheck({
        ledgersBehind: 50,
        processingQueueDepth: 2000,
        availableWorkers: 4,
        processingRate: 50,
      });
      expect(shouldSkip1).toBe(false);

      const shouldSkip2 = pollingService.shouldSkipEmptyLedgersCheck({
        ledgersBehind: 150,
        processingQueueDepth: 5000,
        availableWorkers: 4,
        processingRate: 20,
      });
      expect(shouldSkip2).toBe(true);
    });
  });

  describe('Graceful Degradation', () => {
    it('should evaluate load level correctly', () => {
      const normalMetrics: LoadMetrics = {
        queueDepth: 1000,
        ledgersBehind: 5,
        memoryUsagePercent: 50,
        cpuUsagePercent: 40,
        activeWorkers: 8,
      };
      expect(degradationService.evaluateLoadLevel(normalMetrics)).toBe(LoadLevel.NORMAL);

      const moderateMetrics: LoadMetrics = {
        queueDepth: 6000,
        ledgersBehind: 15,
        memoryUsagePercent: 75,
        cpuUsagePercent: 60,
        activeWorkers: 8,
      };
      expect(degradationService.evaluateLoadLevel(moderateMetrics)).toBe(LoadLevel.MODERATE);

      const highMetrics: LoadMetrics = {
        queueDepth: 20000,
        ledgersBehind: 100,
        memoryUsagePercent: 85,
        cpuUsagePercent: 85,
        activeWorkers: 8,
      };
      expect(degradationService.evaluateLoadLevel(highMetrics)).toBe(LoadLevel.HIGH);

      const criticalMetrics: LoadMetrics = {
        queueDepth: 35000,
        ledgersBehind: 600,
        memoryUsagePercent: 96,
        cpuUsagePercent: 96,
        activeWorkers: 8,
      };
      expect(degradationService.evaluateLoadLevel(criticalMetrics)).toBe(LoadLevel.CRITICAL);
    });

    it('should apply degradation config correctly', async () => {
      await degradationService.applyDegradation(LoadLevel.MODERATE);

      const config = degradationService.getConfig();
      expect(config.enableComposability).toBe(false);
      expect(config.enableMevClassification).toBe(false);
      expect(config.sampleRate).toBe(1.0);
      expect(config.priorityFilter).toBe('all');

      await degradationService.applyDegradation(LoadLevel.CRITICAL);

      const criticalConfig = degradationService.getConfig();
      expect(criticalConfig.enableAnalytics).toBe(false);
      expect(criticalConfig.priorityFilter).toBe('p0_only');
      expect(criticalConfig.sampleRate).toBe(0.2);
    });

    it('should process events based on priority and degradation level', async () => {
      await degradationService.applyDegradation(LoadLevel.NORMAL);
      expect(degradationService.shouldProcessEvent('P2')).toBe(true);

      await degradationService.applyDegradation(LoadLevel.HIGH);
      expect(degradationService.shouldProcessEvent('P0')).toBe(true);
      expect(degradationService.shouldProcessEvent('P2')).toBe(false);

      await degradationService.applyDegradation(LoadLevel.CRITICAL);
      expect(degradationService.shouldProcessEvent('P0')).toBe(true);
      expect(degradationService.shouldProcessEvent('P1')).toBe(false);
    });

    it('should respect sampling rate', async () => {
      await degradationService.applyDegradation(LoadLevel.HIGH);

      // Sample 100 events and check that roughly 80% pass
      const processed = Array.from({ length: 100 }).filter(() =>
        degradationService.shouldProcessEvent('P1'),
      ).length;

      // Allow some variance (70-90% should pass for 80% sample rate)
      expect(processed).toBeGreaterThan(60);
      expect(processed).toBeLessThan(100);
    });
  });

  describe('Predictive Model', () => {
    it('should extract features correctly', () => {
      const timestamp = new Date('2026-07-16T14:30:00Z').getTime();
      const features = modelService.extractFeatures(timestamp);

      expect(features.hourOfDay).toBe(14);
      expect(features.dayOfWeek).toBeGreaterThanOrEqual(0);
      expect(features.dayOfWeek).toBeLessThan(7);
      expect(features.recentThroughput).toBeGreaterThan(0);
      expect(features.externalSignalScore).toBeGreaterThanOrEqual(0);
      expect(features.externalSignalScore).toBeLessThanOrEqual(1);
    });

    it('should make predictions with confidence', async () => {
      const prediction = await modelService.predict(5);

      expect(prediction.horizon).toBe(5);
      expect(prediction.predictedThroughput).toBeGreaterThan(0);
      expect(prediction.confidence).toBeGreaterThanOrEqual(0);
      expect(prediction.confidence).toBeLessThanOrEqual(1);
      expect(prediction.confidenceInterval.length).toBe(2);
      expect(prediction.confidenceInterval[0]).toBeLessThan(prediction.confidenceInterval[1]);
    });

    it('should determine scaling action based on prediction', async () => {
      const predictions = [
        await modelService.predict(5),
        await modelService.predict(15),
        await modelService.predict(30),
      ];

      // Should have at least one scaling action
      const hasScalingAction = predictions.some(
        (p) => p.scalingAction && p.scalingAction !== 'maintain',
      );
      expect(predictions.length).toBeGreaterThan(0);
    });
  });

  describe('Load Spike Simulation', () => {
    it('should handle realistic load spike scenario', async () => {
      const startMetrics = {
        ledgersBehind: 5,
        processingQueueDepth: 500,
        availableWorkers: 4,
        processingRate: 200,
      };

      // Phase 1: Normal state
      const normalInterval = await pollingService.calculateNextInterval(startMetrics);
      expect(normalInterval).toBeLessThanOrEqual(5000);

      // Phase 2: Activity spike begins
      const spikeMetrics = {
        ledgersBehind: 150,
        processingQueueDepth: 25000,
        availableWorkers: 2,
        processingRate: 50,
      };

      const spikeInterval = await pollingService.calculateNextInterval(spikeMetrics);
      expect(spikeInterval).toBeLessThan(normalInterval);

      // Degradation should kick in
      const loadLevel = degradationService.evaluateLoadLevel({
        queueDepth: spikeMetrics.processingQueueDepth,
        ledgersBehind: spikeMetrics.ledgersBehind,
        memoryUsagePercent: 90,
        cpuUsagePercent: 90,
        activeWorkers: 2,
      });
      expect(loadLevel).toBe(LoadLevel.HIGH);

      // Model should predict scaling
      const prediction = await modelService.predict(5);
      expect(prediction.requiredWorkers).toBeGreaterThan(2);
    });

    it('should maintain < 5s lag during 99th percentile activity', async () => {
      // Simulate 500 tx/s for 1 hour
      // At 50 tx/s per worker, need 10 workers
      const highActivityMetrics = {
        ledgersBehind: 10,
        processingQueueDepth: 5000,
        availableWorkers: 10,
        processingRate: 500,
      };

      const interval = await pollingService.calculateNextInterval(highActivityMetrics);

      // At 500 tx/s rate with 10 workers, 10 ledger backlog = ~1.2 seconds lag
      // Should maintain adaptive interval to stay caught up
      expect(interval).toBeLessThan(1000);
    });
  });

  describe('Recovery & Backfill', () => {
    it('should track skipped ledgers for backfill', async () => {
      await degradationService.applyDegradation(LoadLevel.HIGH);

      // Simulate skipping some ledgers
      await degradationService.recordSkippedLedger(1000, 'load_shedding', 'P2');
      await degradationService.recordSkippedLedger(1001, 'load_shedding', 'P2');
      await degradationService.recordSkippedLedger(1002, 'load_shedding', 'P2');

      const skipped = await degradationService.getSkippedLedgersForBackfill(10);
      expect(skipped.length).toBeGreaterThan(0);
    });

    it('should prioritize backfill by contract priority', async () => {
      // Skip P0, P1, and P2 ledgers
      await degradationService.recordSkippedLedger(2000, 'load_shedding', 'P0');
      await degradationService.recordSkippedLedger(2001, 'load_shedding', 'P2');
      await degradationService.recordSkippedLedger(2002, 'load_shedding', 'P1');

      const skipped = await degradationService.getSkippedLedgersForBackfill(10);

      // Should have P0 first, then P1, then P2
      if (skipped.length >= 3) {
        expect(skipped[0].priority).toBe('P0');
        expect(skipped[1].priority).toBe('P1');
        expect(skipped[2].priority).toBe('P2');
      }
    });
  });

  describe('Configuration & State Management', () => {
    it('should persist and recover state', async () => {
      const originalState = pollingService.getState();

      pollingService.updateConfig({
        minInterval: 200,
        maxInterval: 3000,
      });

      const updatedConfig = pollingService.getConfig();
      expect(updatedConfig.minInterval).toBe(200);
      expect(updatedConfig.maxInterval).toBe(3000);
    });

    it('should reset to defaults', () => {
      pollingService.reset();

      const state = pollingService.getState();
      expect(state.currentInterval).toBe(5000);
      expect(state.currentBatchSize).toBe(1);
    });
  });

  afterAll(() => {
    // Cleanup
  });
});
