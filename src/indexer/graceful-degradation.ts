import { Logger } from '../logger';
import { db } from '../db';

/**
 * Graceful Degradation Service
 * Implements load levels (NORMAL, MODERATE, HIGH, CRITICAL)
 * and gracefully reduces non-essential work under high load
 */

const logger = new Logger('GracefulDegradation');

export enum LoadLevel {
  NORMAL = 'NORMAL',
  MODERATE = 'MODERATE',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL'
}

export interface DegradationConfig {
  level: LoadLevel;
  enableComposability: boolean;
  enableMevClassification: boolean;
  enableAnalytics: boolean;
  sampleRate: number; // 1.0 = all, 0.5 = 50%, 0.1 = 10%
  priorityFilter: 'all' | 'p0_p1' | 'p0_only';
  databaseBatchSize: number;
  alertThreshold?: boolean; // trigger on-call alert
}

export interface LoadMetrics {
  queueDepth: number;
  ledgersBehind: number;
  memoryUsagePercent: number;
  cpuUsagePercent: number;
  activeWorkers: number;
}

const DEGRADATION_CONFIGS: Record<LoadLevel, DegradationConfig> = {
  [LoadLevel.NORMAL]: {
    level: LoadLevel.NORMAL,
    enableComposability: true,
    enableMevClassification: true,
    enableAnalytics: true,
    sampleRate: 1.0,
    priorityFilter: 'all',
    databaseBatchSize: 10,
    alertThreshold: false
  },
  [LoadLevel.MODERATE]: {
    level: LoadLevel.MODERATE,
    enableComposability: false, // skip complex analysis
    enableMevClassification: false,
    enableAnalytics: true,
    sampleRate: 1.0, // process all events
    priorityFilter: 'all',
    databaseBatchSize: 20,
    alertThreshold: false
  },
  [LoadLevel.HIGH]: {
    level: LoadLevel.HIGH,
    enableComposability: false,
    enableMevClassification: false,
    enableAnalytics: false, // disable analytics workers
    sampleRate: 0.8, // process 80% of events
    priorityFilter: 'p0_p1', // only P0 and P1 contracts
    databaseBatchSize: 50,
    alertThreshold: false
  },
  [LoadLevel.CRITICAL]: {
    level: LoadLevel.CRITICAL,
    enableComposability: false,
    enableMevClassification: false,
    enableAnalytics: false,
    sampleRate: 0.2, // process 20% of events (only high value)
    priorityFilter: 'p0_only', // only watchlisted/P0 contracts
    databaseBatchSize: 100,
    alertThreshold: true // alert on-call team
  }
};

export class GracefulDegradationService {
  private currentLevel: LoadLevel = LoadLevel.NORMAL;
  private currentConfig: DegradationConfig = DEGRADATION_CONFIGS[LoadLevel.NORMAL];
  private levelChangeTime: number = Date.now();
  private skippedLedgers: Map<number, { reason: string; priority: string }> = new Map();

  /**
   * Evaluate load and determine appropriate degradation level
   */
  evaluateLoadLevel(metrics: LoadMetrics): LoadLevel {
    const { queueDepth, ledgersBehind, memoryUsagePercent, cpuUsagePercent } = metrics;

    // Critical: Memory critical, queue overflow, or extremely behind
    if (
      memoryUsagePercent > 95 ||
      queueDepth > 30000 ||
      ledgersBehind > 500 ||
      cpuUsagePercent > 95
    ) {
      return LoadLevel.CRITICAL;
    }

    // High: Significant queue buildup or memory pressure
    if (
      queueDepth > 15000 ||
      ledgersBehind > 100 ||
      (memoryUsagePercent > 85 && ledgersBehind > 10) ||
      cpuUsagePercent > 90
    ) {
      return LoadLevel.HIGH;
    }

    // Moderate: Some backlog developing
    if (queueDepth > 5000 || (ledgersBehind > 10 && queueDepth > 1000) || memoryUsagePercent > 75) {
      return LoadLevel.MODERATE;
    }

    return LoadLevel.NORMAL;
  }

  /**
   * Apply degradation config to system
   */
  async applyDegradation(level: LoadLevel): Promise<void> {
    if (level === this.currentLevel) {
      return; // No change
    }

    const previousLevel = this.currentLevel;
    this.currentLevel = level;
    this.currentConfig = DEGRADATION_CONFIGS[level];
    this.levelChangeTime = Date.now();

    logger.warn(`Degradation level changed: ${previousLevel} → ${level}`, {
      config: this.currentConfig
    });

    // Persist degradation event
    await this.recordDegradationEvent(level, previousLevel);

    // Alert if entering critical level
    if (level === LoadLevel.CRITICAL && this.currentConfig.alertThreshold) {
      await this.alertOnCall(`CRITICAL load level triggered. Queue depth spike detected.`);
    }
  }

  /**
   * Determine if event should be processed based on current degradation
   */
  shouldProcessEvent(eventPriority: string): boolean {
    // Always process P0 (watchlisted)
    if (eventPriority === 'P0') {
      return true;
    }

    // Check priority filter
    if (this.currentConfig.priorityFilter === 'p0_only') {
      return false;
    }

    if (this.currentConfig.priorityFilter === 'p0_p1' && eventPriority !== 'P1') {
      return false;
    }

    // Check sample rate
    if (this.currentConfig.sampleRate < 1.0) {
      return Math.random() < this.currentConfig.sampleRate;
    }

    return true;
  }

  /**
   * Track skipped ledger for backfill
   */
  async recordSkippedLedger(ledgerId: number, reason: string, priority: string): Promise<void> {
    this.skippedLedgers.set(ledgerId, { reason, priority });

    try {
      await db.query(
        `
        INSERT INTO skipped_ledgers (ledger_id, reason, priority_level, sampled_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (ledger_id) DO NOTHING
        `,
        [ledgerId, reason, priority]
      );
    } catch (error) {
      logger.warn('Failed to record skipped ledger', { error, ledgerId });
    }
  }

  /**
   * Get skipped ledgers for backfill
   */
  async getSkippedLedgersForBackfill(limit: number = 1000): Promise<Array<{ ledgerId: number; priority: string }>> {
    try {
      const result = await db.query(
        `
        SELECT ledger_id, priority_level
        FROM skipped_ledgers
        WHERE backfilled_at IS NULL
        ORDER BY priority_level DESC, ledger_id ASC
        LIMIT $1
        `,
        [limit]
      );

      return result.rows.map((row: any) => ({
        ledgerId: row.ledger_id,
        priority: row.priority_level
      }));
    } catch (error) {
      logger.error('Failed to fetch skipped ledgers', { error });
      return [];
    }
  }

  /**
   * Mark ledger as backfilled
   */
  async markLedgerBackfilled(ledgerId: number): Promise<void> {
    try {
      await db.query(
        `
        UPDATE skipped_ledgers
        SET backfilled_at = NOW()
        WHERE ledger_id = $1
        `,
        [ledgerId]
      );

      this.skippedLedgers.delete(ledgerId);
    } catch (error) {
      logger.warn('Failed to mark ledger as backfilled', { error, ledgerId });
    }
  }

  /**
   * Start backfill process when load normalizes
   */
  async startBackfillProcess(): Promise<void> {
    // This should run when backpressure < 0.2 for 5+ minutes
    logger.info('Starting backfill process for skipped ledgers');

    const skippedLedgers = await this.getSkippedLedgersForBackfill();

    if (skippedLedgers.length === 0) {
      logger.info('No skipped ledgers to backfill');
      return;
    }

    logger.info(`Backfilling ${skippedLedgers.length} skipped ledgers`, {
      highPriority: skippedLedgers.filter(l => l.priority === 'P0').length,
      mediumPriority: skippedLedgers.filter(l => l.priority === 'P1').length
    });

    // In production: queue these for reprocessing in NATS topic
    // await natsQueue.publishBackfillBatch(skippedLedgers);
  }

  /**
   * Get current configuration
   */
  getConfig(): DegradationConfig {
    return { ...this.currentConfig };
  }

  /**
   * Get current level
   */
  getCurrentLevel(): LoadLevel {
    return this.currentLevel;
  }

  /**
   * Manual override (operator control)
   */
  async setManualOverride(level: LoadLevel, durationMinutes: number): Promise<void> {
    logger.warn(`Manual degradation override: ${level} for ${durationMinutes} minutes`);

    await this.applyDegradation(level);

    // Schedule automatic reset
    setTimeout(() => {
      this.currentLevel = LoadLevel.NORMAL;
      logger.info('Manual degradation override expired, reverting to NORMAL');
    }, durationMinutes * 60 * 1000);
  }

  /**
   * Get degradation stats
   */
  async getStats(): Promise<{
    currentLevel: LoadLevel;
    levelChangedAt: number;
    skippedEventsTotal: number;
    backfillQueueSize: number;
  }> {
    try {
      const result = await db.query(`
        SELECT 
          (SELECT COUNT(*) FROM skipped_ledgers WHERE backfilled_at IS NULL) as backfill_queue,
          (SELECT COUNT(*) FROM skipped_ledgers WHERE reason = 'load_shedding') as skipped_events
      `);

      const stats = result.rows[0] || {};

      return {
        currentLevel: this.currentLevel,
        levelChangedAt: this.levelChangeTime,
        skippedEventsTotal: parseInt(stats.skipped_events || 0),
        backfillQueueSize: parseInt(stats.backfill_queue || 0)
      };
    } catch (error) {
      logger.warn('Failed to get degradation stats', { error });
      return {
        currentLevel: this.currentLevel,
        levelChangedAt: this.levelChangeTime,
        skippedEventsTotal: 0,
        backfillQueueSize: 0
      };
    }
  }

  /**
   * Record degradation event to database
   */
  private async recordDegradationEvent(newLevel: LoadLevel, previousLevel: LoadLevel): Promise<void> {
    try {
      await db.query(
        `
        INSERT INTO degradation_events 
          (load_level, triggered_at, reason, created_at)
        VALUES ($1, NOW(), $2, NOW())
        `,
        [newLevel, `Transitioned from ${previousLevel}`]
      );
    } catch (error) {
      logger.warn('Failed to record degradation event', { error });
    }
  }

  /**
   * Alert on-call team
   */
  private async alertOnCall(message: string): Promise<void> {
    // In production: integrate with PagerDuty, Slack, etc.
    logger.error('CRITICAL ALERT', { message });

    try {
      // Example: Send to Slack
      // await slackClient.postMessage('#incidents', { text: message });
    } catch (error) {
      logger.error('Failed to send alert', { error });
    }
  }
}

// Singleton instance
let instance: GracefulDegradationService | null = null;

export function getGracefulDegradationService(): GracefulDegradationService {
  if (!instance) {
    instance = new GracefulDegradationService();
  }
  return instance;
}
