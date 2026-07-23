import { Logger } from '../logger';
import { db } from '../db';

/**
 * Adaptive Polling Service
 * Dynamically adjusts polling interval based on:
 * - Number of ledgers behind
 * - Queue depth across processing pipeline
 * - Available worker capacity
 * - Processing throughput
 */

export interface PollingMetrics {
  ledgersBehind: number;
  processingQueueDepth: number;
  availableWorkers: number;
  processingRate: number; // ledgers per second
  currentInterval: number; // milliseconds
}

export interface AdaptivePollingConfig {
  minInterval: number; // 100ms
  maxInterval: number; // 5000ms
  batchSize: number; // 1-50
  processingQueueThreshold: number; // when to slow down
}

const logger = new Logger('AdaptivePolling');

const DEFAULT_CONFIG: AdaptivePollingConfig = {
  minInterval: 100,
  maxInterval: 5000,
  batchSize: 1,
  processingQueueThreshold: 5000
};

export class AdaptivePollingService {
  private currentInterval: number = 5000;
  private currentBatchSize: number = 1;
  private intervalEma: number = 5000;
  private lastUpdateTime: number = Date.now();
  private processingHistory: number[] = []; // track last 10 processing times
  private config: AdaptivePollingConfig;

  constructor(config: Partial<AdaptivePollingConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Calculate next polling interval based on system metrics
   */
  async calculateNextInterval(metrics: PollingMetrics): Promise<number> {
    const { ledgersBehind, processingQueueDepth, availableWorkers, processingRate } = metrics;

    let newInterval = this.currentInterval;

    // Rule 1: Many ledgers behind - speed up ingestion
    if (ledgersBehind > 100) {
      newInterval = this.currentInterval * 0.5; // halve
      logger.debug(`Ledgers behind (${ledgersBehind}) > 100, reducing interval to ${newInterval}ms`);
    }
    // Rule 2: Caught up and idle - slow down
    else if (ledgersBehind === 0 && processingQueueDepth === 0) {
      newInterval = Math.min(this.currentInterval * 1.2, this.config.maxInterval);
      logger.debug(`Caught up (0 behind, 0 queued), increasing interval to ${newInterval}ms`);
    }
    // Rule 3: Some backlog with available capacity - slight speedup
    else if (ledgersBehind > 0 && availableWorkers > 0) {
      newInterval = this.currentInterval * 0.9;
      logger.debug(`Backlog (${ledgersBehind}) with ${availableWorkers} workers, reducing to ${newInterval}ms`);
    }
    // Rule 4: Queue overload - slow down ingestion
    else if (processingQueueDepth > this.config.processingQueueThreshold) {
      newInterval = Math.min(this.currentInterval * 1.5, this.config.maxInterval);
      logger.debug(`Queue overload (${processingQueueDepth}), increasing interval to ${newInterval}ms`);
    }

    // Clamp to valid range
    newInterval = Math.max(this.config.minInterval, Math.min(newInterval, this.config.maxInterval));

    // Apply exponential smoothing to avoid jitter
    // EMA = 0.8 * previous_ema + 0.2 * new_interval
    this.intervalEma = 0.8 * this.intervalEma + 0.2 * newInterval;

    // Persist to database for recovery
    await this.persistPollingState({
      pollingIntervalMs: Math.round(this.intervalEma),
      batchSize: this.currentBatchSize,
      emaIntervalMs: Math.round(this.intervalEma)
    });

    this.currentInterval = Math.round(this.intervalEma);
    this.lastUpdateTime = Date.now();

    return this.currentInterval;
  }

  /**
   * Calculate optimal batch size
   */
  calculateBatchSize(metrics: PollingMetrics): number {
    const { ledgersBehind, availableWorkers } = metrics;

    let batchSize = 1;

    // Real-time mode: process one at a time
    if (ledgersBehind < 10) {
      batchSize = 1;
    }
    // Batch mode: process 5-10 at once
    else if (ledgersBehind >= 10 && ledgersBehind < 100) {
      batchSize = Math.max(5, Math.min(10, availableWorkers * 2));
    }
    // Catch-up mode: process 20-50 at once (and skip empty ledgers)
    else if (ledgersBehind >= 100) {
      batchSize = Math.max(20, Math.min(50, availableWorkers * 5));
    }

    this.currentBatchSize = batchSize;
    return batchSize;
  }

  /**
   * Determine processing mode
   */
  getProcessingMode(metrics: PollingMetrics): 'realtime' | 'batch' | 'catchup' {
    const { ledgersBehind } = metrics;

    if (ledgersBehind < 10) return 'realtime';
    if (ledgersBehind >= 100) return 'catchup';
    return 'batch';
  }

  /**
   * Check if ledger should be skipped (empty ledger optimization)
   * Only in catch-up mode when far behind
   */
  shouldSkipEmptyLedgersCheck(metrics: PollingMetrics): boolean {
    return metrics.ledgersBehind > 100;
  }

  /**
   * Get current configuration
   */
  getConfig(): AdaptivePollingConfig {
    return { ...this.config };
  }

  /**
   * Update configuration at runtime
   */
  updateConfig(updates: Partial<AdaptivePollingConfig>): void {
    this.config = { ...this.config, ...updates };
    logger.info('Adaptive polling config updated', { config: this.config });
  }

  /**
   * Get current state
   */
  getState() {
    return {
      currentInterval: this.currentInterval,
      currentBatchSize: this.currentBatchSize,
      intervalEma: this.intervalEma,
      lastUpdateTime: this.lastUpdateTime,
      config: this.config
    };
  }

  /**
   * Reset to default state (e.g., on indexer restart)
   */
  reset(): void {
    this.currentInterval = 5000;
    this.currentBatchSize = 1;
    this.intervalEma = 5000;
    this.lastUpdateTime = Date.now();
    logger.info('Adaptive polling reset to defaults');
  }

  /**
   * Persist polling state to database for recovery
   */
  private async persistPollingState(state: any): Promise<void> {
    try {
      await db.query(
        `
        INSERT INTO adaptive_polling_state 
          (polling_interval_ms, batch_size, ema_interval_ms, last_updated)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (id) DO UPDATE SET
          polling_interval_ms = $1,
          batch_size = $2,
          ema_interval_ms = $3,
          last_updated = NOW()
        `,
        [state.pollingIntervalMs, state.batchSize, state.emaIntervalMs]
      );
    } catch (error) {
      logger.error('Failed to persist polling state', { error });
      // Continue execution even if persistence fails
    }
  }

  /**
   * Recover polling state from database (e.g., after restart)
   */
  async recoverState(): Promise<void> {
    try {
      const result = await db.query('SELECT * FROM adaptive_polling_state ORDER BY id DESC LIMIT 1');

      if (result.rows.length > 0) {
        const state = result.rows[0];
        this.currentInterval = state.polling_interval_ms;
        this.currentBatchSize = state.batch_size;
        this.intervalEma = state.ema_interval_ms;
        logger.info('Recovered polling state from database', { state });
      }
    } catch (error) {
      logger.warn('Failed to recover polling state (table may not exist yet)', { error });
    }
  }
}

// Singleton instance
let instance: AdaptivePollingService | null = null;

export function getAdaptivePollingService(): AdaptivePollingService {
  if (!instance) {
    instance = new AdaptivePollingService();
  }
  return instance;
}
