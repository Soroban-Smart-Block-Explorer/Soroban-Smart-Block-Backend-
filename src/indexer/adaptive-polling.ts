import { Logger } from '../logger';
import { db } from '../db';

/**
 * Adaptive Polling Service
 * Dynamically adjusts polling interval based on:
 * - Number of ledgers behind
 * - Queue depth across processing pipeline
 * - Available worker capacity
 * - Processing throughput
 * - Hysteresis bands to prevent interval oscillation near thresholds
 * - Exponential backoff with jitter when RPC errors occur
 */

export interface PollingMetrics {
  ledgersBehind: number;
  processingQueueDepth: number;
  availableWorkers: number;
  processingRate: number; // ledgers per second
  currentInterval: number; // milliseconds
}

export interface AdaptivePollingConfig {
  minInterval: number; // e.g. 100ms
  maxInterval: number; // e.g. 5000ms
  batchSize: number; // 1-50
  processingQueueThreshold: number; // when to slow down
  hysteresisMargin: number; // margin (e.g. 0.15 for 15%) to prevent oscillation
  minIntervalChangeMs: number; // absolute change threshold (e.g. 200ms)
  consecutiveThresholdTicks: number; // ticks required before shifting intervals
}

const logger = new Logger('AdaptivePolling');

const DEFAULT_CONFIG: AdaptivePollingConfig = {
  minInterval: 100,
  maxInterval: 5000,
  batchSize: 1,
  processingQueueThreshold: 5000,
  hysteresisMargin: 0.15,
  minIntervalChangeMs: 200,
  consecutiveThresholdTicks: 2,
};

export class AdaptivePollingService {
  private currentInterval: number = 5000;
  private currentBatchSize: number = 1;
  private intervalEma: number = 5000;
  private lastUpdateTime: number = Date.now();
  private processingHistory: number[] = []; // track last 10 processing times
  private config: AdaptivePollingConfig;

  // Hysteresis state tracking
  private pendingTargetInterval: number = 5000;
  private consecutivePendingTicks: number = 0;

  // RPC Health & Exponential Backoff state
  private rpcConsecutiveErrors: number = 0;
  private lastRpcErrorTime: number = 0;

  constructor(config: Partial<AdaptivePollingConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Record an RPC error to trigger exponential backoff tuning */
  recordRpcError(error?: unknown): void {
    this.rpcConsecutiveErrors += 1;
    this.lastRpcErrorTime = Date.now();
    const message = error instanceof Error ? error.message : String(error ?? 'RPC Error');
    logger.warn(`RPC error recorded (#${this.rpcConsecutiveErrors}): ${message}`);
  }

  /** Record successful RPC execution to clear exponential backoff */
  recordRpcSuccess(): void {
    if (this.rpcConsecutiveErrors > 0) {
      logger.info(
        `RPC health recovered after ${this.rpcConsecutiveErrors} errors. Resetting backoff state.`,
      );
      this.rpcConsecutiveErrors = 0;
    }
  }

  /** Get count of consecutive RPC errors */
  getRpcConsecutiveErrors(): number {
    return this.rpcConsecutiveErrors;
  }

  /**
   * Calculate next polling interval based on system metrics, hysteresis, and RPC health.
   */
  async calculateNextInterval(metrics: PollingMetrics): Promise<number> {
    // 1. Handle RPC degradation via exponential backoff with full jitter
    if (this.rpcConsecutiveErrors > 0) {
      const baseBackoff = Math.min(
        this.config.maxInterval * 4,
        this.config.maxInterval * Math.pow(2, this.rpcConsecutiveErrors - 1),
      );
      const jitter = Math.floor(Math.random() * Math.min(1000, baseBackoff * 0.25));
      const backoffInterval = Math.max(this.currentInterval, baseBackoff + jitter);

      logger.warn(
        `[AdaptivePolling] RPC degraded (${this.rpcConsecutiveErrors} errors). Exponential backoff: ${backoffInterval}ms`,
      );

      this.currentInterval = Math.round(backoffInterval);
      this.intervalEma = 0.8 * this.intervalEma + 0.2 * backoffInterval;
      this.lastUpdateTime = Date.now();

      await this.persistPollingState({
        pollingIntervalMs: this.currentInterval,
        batchSize: this.currentBatchSize,
        emaIntervalMs: Math.round(this.intervalEma),
      });

      return this.currentInterval;
    }

    // 2. Normal adaptive calculation based on metrics
    const { ledgersBehind, processingQueueDepth, availableWorkers } = metrics;
    let targetInterval = this.currentInterval;

    // Rule 1: Many ledgers behind - speed up ingestion
    if (ledgersBehind > 100) {
      targetInterval = this.currentInterval * 0.5;
      logger.debug(
        `Ledgers behind (${ledgersBehind}) > 100, targeting reduced interval ${targetInterval}ms`,
      );
    }
    // Rule 2: Caught up and idle - slow down
    else if (ledgersBehind === 0 && processingQueueDepth === 0) {
      targetInterval = Math.min(this.currentInterval * 1.2, this.config.maxInterval);
      logger.debug(`Caught up (0 behind, 0 queued), targeting increased interval ${targetInterval}ms`);
    }
    // Rule 3: Some backlog with available capacity - slight speedup
    else if (ledgersBehind > 0 && availableWorkers > 0) {
      targetInterval = this.currentInterval * 0.9;
      logger.debug(
        `Backlog (${ledgersBehind}) with ${availableWorkers} workers, targeting ${targetInterval}ms`,
      );
    }
    // Rule 4: Queue overload - slow down ingestion
    else if (processingQueueDepth > this.config.processingQueueThreshold) {
      targetInterval = Math.min(this.currentInterval * 1.5, this.config.maxInterval);
      logger.debug(
        `Queue overload (${processingQueueDepth}), targeting increased interval ${targetInterval}ms`,
      );
    }

    // Clamp target to valid boundaries
    targetInterval = Math.max(
      this.config.minInterval,
      Math.min(targetInterval, this.config.maxInterval),
    );

    // 3. Apply Hysteresis Band Filtering
    const intervalDelta = Math.abs(targetInterval - this.currentInterval);
    const hysteresisBand = Math.max(
      this.config.minIntervalChangeMs,
      this.currentInterval * this.config.hysteresisMargin,
    );

    let chosenInterval = this.currentInterval;

    if (intervalDelta >= hysteresisBand) {
      if (Math.abs(targetInterval - this.pendingTargetInterval) < hysteresisBand * 0.5) {
        this.consecutivePendingTicks += 1;
      } else {
        this.pendingTargetInterval = targetInterval;
        this.consecutivePendingTicks = 1;
      }

      if (this.consecutivePendingTicks >= this.config.consecutiveThresholdTicks) {
        chosenInterval = targetInterval;
        logger.debug(
          `Hysteresis threshold met over ${this.consecutivePendingTicks} ticks. Shifting interval to ${chosenInterval}ms`,
        );
      } else {
        logger.debug(
          `Interval shift candidate (${targetInterval}ms) held by hysteresis band (${this.consecutivePendingTicks}/${this.config.consecutiveThresholdTicks} ticks)`,
        );
      }
    } else {
      // Small fluctuation within deadband — retain current interval
      this.consecutivePendingTicks = 0;
      this.pendingTargetInterval = this.currentInterval;
    }

    // 4. Apply Exponential Moving Average (EMA) smoothing to prevent jitter
    this.intervalEma = 0.8 * this.intervalEma + 0.2 * chosenInterval;
    this.currentInterval = Math.round(this.intervalEma);
    this.lastUpdateTime = Date.now();

    // 5. Persist state to database for crash recovery
    await this.persistPollingState({
      pollingIntervalMs: this.currentInterval,
      batchSize: this.currentBatchSize,
      emaIntervalMs: Math.round(this.intervalEma),
    });

    return this.currentInterval;
  }

  /** Calculate optimal batch size */
  calculateBatchSize(metrics: PollingMetrics): number {
    const { ledgersBehind, availableWorkers } = metrics;
    let batchSize = 1;

    if (ledgersBehind < 10) {
      batchSize = 1;
    } else if (ledgersBehind >= 10 && ledgersBehind < 100) {
      batchSize = Math.max(5, Math.min(10, availableWorkers * 2));
    } else if (ledgersBehind >= 100) {
      batchSize = Math.max(20, Math.min(50, availableWorkers * 5));
    }

    this.currentBatchSize = batchSize;
    return batchSize;
  }

  /** Determine processing mode */
  getProcessingMode(metrics: PollingMetrics): 'realtime' | 'batch' | 'catchup' {
    const { ledgersBehind } = metrics;
    if (ledgersBehind < 10) return 'realtime';
    if (ledgersBehind >= 100) return 'catchup';
    return 'batch';
  }

  /** Check if ledger should be skipped (empty ledger optimization) */
  shouldSkipEmptyLedgersCheck(metrics: PollingMetrics): boolean {
    return metrics.ledgersBehind > 100;
  }

  /** Get current configuration */
  getConfig(): AdaptivePollingConfig {
    return { ...this.config };
  }

  /** Update configuration at runtime */
  updateConfig(updates: Partial<AdaptivePollingConfig>): void {
    this.config = { ...this.config, ...updates };
    logger.info('Adaptive polling config updated', { config: this.config });
  }

  /** Get current state */
  getState() {
    return {
      currentInterval: this.currentInterval,
      currentBatchSize: this.currentBatchSize,
      intervalEma: this.intervalEma,
      lastUpdateTime: this.lastUpdateTime,
      rpcConsecutiveErrors: this.rpcConsecutiveErrors,
      consecutivePendingTicks: this.consecutivePendingTicks,
      config: this.config,
    };
  }

  /** Reset to default state */
  reset(): void {
    this.currentInterval = 5000;
    this.currentBatchSize = 1;
    this.intervalEma = 5000;
    this.lastUpdateTime = Date.now();
    this.rpcConsecutiveErrors = 0;
    this.consecutivePendingTicks = 0;
    logger.info('Adaptive polling reset to defaults');
  }

  /** Persist polling state to database for recovery */
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
        [state.pollingIntervalMs, state.batchSize, state.emaIntervalMs],
      );
    } catch (error) {
      logger.error('Failed to persist polling state', { error });
    }
  }

  /** Recover polling state from database */
  async recoverState(): Promise<void> {
    try {
      const result = await db.query(
        'SELECT * FROM adaptive_polling_state ORDER BY id DESC LIMIT 1',
      );

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
