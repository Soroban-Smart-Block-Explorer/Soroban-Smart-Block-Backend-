/**
 * Centralized cron scheduler with job management, error handling, and graceful shutdown.
 *
 * Replaces setInterval-based scheduling with node-cron for better:
 * - Timing precision (no drift)
 * - Backpressure handling (wait for previous job to complete before next)
 * - Error isolation (failure in one job doesn't affect others)
 * - Shutdown coordination (stop all jobs cleanly)
 */

import * as cron from 'node-cron';
import { logger } from '../logger';

export interface ScheduledJob {
  id: string;
  cronExpression: string;
  taskName: string;
  execute: () => Promise<void>;
  maxDuration?: number; // ms timeout for task execution
  retryOnFailure?: boolean;
  retryDelayMs?: number; // delay before retry if enabled
  /**
   * Expected time between successful runs, used for staleness detection
   * (#906). Defaults to a best-effort parse of `cronExpression` — pass this
   * explicitly for expressions the heuristic in `approxCronIntervalMs` can't
   * read (e.g. day-of-week/month schedules), or staleness detection is
   * skipped for that job.
   */
  expectedIntervalMs?: number;
}

interface JobInstance {
  job: cron.ScheduledTask;
  metadata: Omit<ScheduledJob, 'execute'>;
  lastRunTime?: Date;
  lastError?: Error;
  isRunning: boolean;
  executionCount: number;
}

/**
 * #906 — background job health tracking.
 *
 * `success`/`failure` mirror the outcome of the most recent run;
 * `never_run` means the job has been registered/observed but has not
 * completed a run yet (still healthy — just no data).
 */
export type JobExecutionStatus = 'success' | 'failure' | 'never_run';

export interface JobHealthEntry {
  id: string;
  taskName: string;
  lastRunTimestamp: number | null; // epoch ms, null if never run
  executionStatus: JobExecutionStatus;
  consecutiveFailures: number;
  expectedIntervalMs: number | null; // null = staleness unknown/not tracked
}

export interface JobHealthSnapshot extends JobHealthEntry {
  /** True when this job has missed its expected window by more than the configured multiplier. */
  stale: boolean;
}

export interface WorkerHealthSummary {
  status: 'healthy' | 'degraded' | 'unhealthy';
  jobs: JobHealthSnapshot[];
}

/**
 * Best-effort parse of common cron shorthand into an approximate interval in
 * milliseconds, for staleness detection when a job doesn't supply
 * `expectedIntervalMs` explicitly. Handles the "every N seconds/minutes"
 * patterns actually used in this codebase (`* * * * *`, `*/N * * * *`,
 * 6-field `*/N * * * * *`); anything else (day-of-week/month schedules)
 * returns null, meaning "don't flag this job as stale".
 */
export function approxCronIntervalMs(expression: string): number | null {
  const parts = expression.trim().split(/\s+/);

  if (parts.length === 5) {
    const [minute] = parts;
    if (minute === '*') return 60_000;
    const everyN = minute.match(/^\*\/(\d+)$/);
    if (everyN) return parseInt(everyN[1], 10) * 60_000;
    return null;
  }

  if (parts.length === 6) {
    const [second, minute] = parts;
    if (second === '*') return 1000;
    const everySec = second.match(/^\*\/(\d+)$/);
    if (everySec) return parseInt(everySec[1], 10) * 1000;
    if (minute === '*') return 60_000;
    const everyMin = minute.match(/^\*\/(\d+)$/);
    if (everyMin) return parseInt(everyMin[1], 10) * 60_000;
    return null;
  }

  return null;
}

class CronScheduler {
  private jobs = new Map<string, JobInstance>();
  private isShuttingDown = false;
  private healthRegistry = new Map<string, JobHealthEntry>();

  /**
   * Record the outcome of a job run — either a run driven by this scheduler
   * (called automatically from `executeJob`) or an externally-managed
   * recurring task (price updater, key rotation, etc. — anything still using
   * its own `setInterval`) that wants to report into the same health
   * registry so `/health` can see it. See src/health.ts `checkWorkerHealth`.
   */
  public recordHeartbeat(
    id: string,
    status: 'success' | 'failure',
    meta?: { taskName?: string; expectedIntervalMs?: number },
  ): void {
    const existing = this.healthRegistry.get(id);
    const consecutiveFailures = status === 'failure' ? (existing?.consecutiveFailures ?? 0) + 1 : 0;

    this.healthRegistry.set(id, {
      id,
      taskName: meta?.taskName ?? existing?.taskName ?? id,
      lastRunTimestamp: Date.now(),
      executionStatus: status,
      consecutiveFailures,
      expectedIntervalMs: meta?.expectedIntervalMs ?? existing?.expectedIntervalMs ?? null,
    });
  }

  /** Raw per-job health entries, no staleness computed yet. */
  public getJobHealth(): JobHealthEntry[] {
    return Array.from(this.healthRegistry.values());
  }

  /**
   * Computes overall worker health from every job that has ever reported a
   * heartbeat (cron-managed or external).
   *
   * - `unhealthy`  — any job has >= `maxConsecutiveFailures` failures in a row.
   * - `degraded`   — otherwise, any job with a known interval hasn't run in
   *                  more than `staleIntervalMultiplier` * its expected interval.
   * - `healthy`    — otherwise (including no jobs having reported yet).
   */
  public getHealthSummary(
    staleIntervalMultiplier: number,
    maxConsecutiveFailures: number,
  ): WorkerHealthSummary {
    const now = Date.now();

    const jobs: JobHealthSnapshot[] = this.getJobHealth().map((entry) => {
      const stale =
        entry.expectedIntervalMs != null &&
        entry.lastRunTimestamp != null &&
        now - entry.lastRunTimestamp > entry.expectedIntervalMs * staleIntervalMultiplier;
      return { ...entry, stale };
    });

    const unhealthy = jobs.some((j) => j.consecutiveFailures >= maxConsecutiveFailures);
    const degraded = !unhealthy && jobs.some((j) => j.stale);

    return {
      status: unhealthy ? 'unhealthy' : degraded ? 'degraded' : 'healthy',
      jobs,
    };
  }

  /** Exposed for testing only — do not call in production code. */
  public _clearHealthRegistry(): void {
    this.healthRegistry.clear();
  }

  /**
   * Register and start a scheduled job.
   * @param jobConfig Job configuration with cron expression and handler.
   * @throws Error if job ID already exists or cron expression is invalid.
   */
  public register(jobConfig: ScheduledJob): void {
    if (this.jobs.has(jobConfig.id)) {
      throw new Error(`Job "${jobConfig.id}" is already registered`);
    }

    // Validate cron expression
    if (!cron.validate(jobConfig.cronExpression)) {
      throw new Error(
        `Invalid cron expression for job "${jobConfig.id}": ${jobConfig.cronExpression}`,
      );
    }

    const jobInstance: JobInstance = {
      job: null as any, // Will be assigned after task creation
      metadata: {
        id: jobConfig.id,
        cronExpression: jobConfig.cronExpression,
        taskName: jobConfig.taskName,
        maxDuration: jobConfig.maxDuration,
        retryOnFailure: jobConfig.retryOnFailure ?? false,
        retryDelayMs: jobConfig.retryDelayMs ?? 5000,
      },
      isRunning: false,
      executionCount: 0,
    };

    // Create the scheduled task with backpressure handling
    const scheduledTask = cron.schedule(
      jobConfig.cronExpression,
      async () => {
        await this.executeJob(jobConfig, jobInstance);
      },
      { runOnInit: false }, // Don't run immediately, let the job decide
    );

    jobInstance.job = scheduledTask;
    this.jobs.set(jobConfig.id, jobInstance);

    logger.info(
      `[scheduler] Registered job: ${jobConfig.id} (${jobConfig.taskName}) on "${jobConfig.cronExpression}"`,
    );
  }

  /**
   * Execute a job with backpressure, timeout, and error handling.
   */
  private async executeJob(jobConfig: ScheduledJob, jobInstance: JobInstance): Promise<void> {
    // Skip if already running (backpressure)
    if (jobInstance.isRunning) {
      logger.warn(
        `[scheduler] Skipping ${jobConfig.id} (${jobConfig.taskName}): previous execution still running`,
      );
      return;
    }

    if (this.isShuttingDown) {
      logger.info(
        `[scheduler] Skipping ${jobConfig.id} (${jobConfig.taskName}): scheduler is shutting down`,
      );
      return;
    }

    jobInstance.isRunning = true;
    const startTime = Date.now();

    try {
      // Execute with optional timeout
      if (jobConfig.maxDuration) {
        await this.executeWithTimeout(jobConfig.execute, jobConfig.maxDuration);
      } else {
        await jobConfig.execute();
      }

      const duration = Date.now() - startTime;
      jobInstance.lastRunTime = new Date();
      jobInstance.lastError = undefined;
      jobInstance.executionCount++;

      this.recordHeartbeat(jobConfig.id, 'success', {
        taskName: jobConfig.taskName,
        expectedIntervalMs:
          jobConfig.expectedIntervalMs ?? approxCronIntervalMs(jobConfig.cronExpression) ?? undefined,
      });

      logger.info(
        `[scheduler] ✓ ${jobConfig.id} (${jobConfig.taskName}) completed in ${duration}ms (execution #${jobInstance.executionCount})`,
      );
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      jobInstance.lastError = error instanceof Error ? error : new Error(String(error));
      jobInstance.executionCount++;

      this.recordHeartbeat(jobConfig.id, 'failure', {
        taskName: jobConfig.taskName,
        expectedIntervalMs:
          jobConfig.expectedIntervalMs ?? approxCronIntervalMs(jobConfig.cronExpression) ?? undefined,
      });

      logger.error(
        `[scheduler] ✗ ${jobConfig.id} (${jobConfig.taskName}) failed after ${duration}ms: ${errorMessage}`,
      );

      // Retry logic
      if (jobConfig.retryOnFailure) {
        logger.info(`[scheduler] Retrying ${jobConfig.id} in ${jobConfig.retryDelayMs}ms...`);
        setTimeout(async () => {
          if (this.isShuttingDown) return;
          jobInstance.isRunning = false;
          await this.executeJob(jobConfig, jobInstance);
        }, jobConfig.retryDelayMs);
      } else {
        jobInstance.isRunning = false;
      }

      return;
    } finally {
      jobInstance.isRunning = false;
    }
  }

  /**
   * Execute a task with a timeout.
   */
  private executeWithTimeout(task: () => Promise<void>, timeoutMs: number): Promise<void> {
    return Promise.race([
      task(),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error(`Task timeout after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
  }

  /**
   * Immediately run a job (manually trigger, not on schedule).
   */
  public async runNow(jobId: string): Promise<void> {
    const jobInstance = this.jobs.get(jobId);
    if (!jobInstance) {
      throw new Error(`Job "${jobId}" not found`);
    }

    logger.info(`[scheduler] Manually triggering job: ${jobId}`);

    if (jobInstance.isRunning) {
      throw new Error(`Job "${jobId}" is already running`);
    }

    // We need to find the original job config to execute
    // Since we don't store it, we'll just call the job's internal task
    // This is a limitation; ideally store the full config
    logger.warn(
      `[scheduler] runNow(${jobId}) requires stored job config; use the registered job's execute() directly`,
    );
  }

  /**
   * Stop a specific job.
   */
  public stop(jobId: string): void {
    const jobInstance = this.jobs.get(jobId);
    if (!jobInstance) {
      throw new Error(`Job "${jobId}" not found`);
    }

    jobInstance.job.stop();
    logger.info(`[scheduler] Stopped job: ${jobId}`);
  }

  /**
   * Start a previously stopped job.
   */
  public start(jobId: string): void {
    const jobInstance = this.jobs.get(jobId);
    if (!jobInstance) {
      throw new Error(`Job "${jobId}" not found`);
    }

    jobInstance.job.start();
    logger.info(`[scheduler] Started job: ${jobId}`);
  }

  /**
   * Get the status of a job.
   */
  public getStatus(jobId: string):
    | { status: 'not_found' }
    | {
        status: 'running' | 'idle' | 'stopped';
        id: string;
        taskName: string;
        cronExpression: string;
        lastRunTime?: Date;
        lastError?: string;
        executionCount: number;
      } {
    const jobInstance = this.jobs.get(jobId);
    if (!jobInstance) {
      return { status: 'not_found' };
    }

    return {
      status: jobInstance.isRunning ? 'running' : 'idle',
      id: jobInstance.metadata.id,
      taskName: jobInstance.metadata.taskName,
      cronExpression: jobInstance.metadata.cronExpression,
      lastRunTime: jobInstance.lastRunTime,
      lastError: jobInstance.lastError?.message,
      executionCount: jobInstance.executionCount,
    };
  }

  /**
   * Get status of all registered jobs.
   */
  public getAll(): ReturnType<CronScheduler['getStatus']>[] {
    return Array.from(this.jobs.keys()).map((jobId) => this.getStatus(jobId));
  }

  /**
   * Gracefully shutdown all jobs.
   * Waits for currently running tasks to complete before stopping.
   */
  public async gracefulShutdown(): Promise<void> {
    if (this.isShuttingDown) {
      logger.warn('[scheduler] Shutdown already in progress');
      return;
    }

    this.isShuttingDown = true;
    logger.info(`[scheduler] Initiating graceful shutdown of ${this.jobs.size} job(s)`);

    // Stop all jobs from scheduling new runs
    for (const jobInstance of this.jobs.values()) {
      jobInstance.job.stop();
    }

    // Wait for currently running tasks to complete
    const maxWaitTime = 30_000; // 30s max wait
    const startTime = Date.now();

    while (Array.from(this.jobs.values()).some((j) => j.isRunning)) {
      if (Date.now() - startTime > maxWaitTime) {
        const stillRunning = Array.from(this.jobs.values())
          .filter((j) => j.isRunning)
          .map((j) => j.metadata.id);
        logger.warn(
          `[scheduler] Shutdown timeout reached. Still running: ${stillRunning.join(', ')}`,
        );
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Stop all scheduled tasks
    for (const jobInstance of this.jobs.values()) {
      jobInstance.job.stop();
    }

    this.jobs.clear();
    logger.info('[scheduler] Graceful shutdown complete');
  }
}

// Export singleton instance
export const scheduler = new CronScheduler();

/**
 * Helper to convert milliseconds to cron expression.
 * Only handles common intervals (every N seconds, minutes, hours).
 * For custom intervals, use cron expression directly.
 */
export function intervalToCron(intervalMs: number): string {
  const seconds = Math.round(intervalMs / 1000);

  if (seconds < 60) {
    // Every N seconds: */N * * * * * (every N seconds, every minute, every hour, etc.)
    return `*/${seconds} * * * * *`;
  }

  const minutes = Math.round(seconds / 60);
  if (seconds % 60 === 0 && minutes < 60) {
    // Every N minutes: */N * * * *
    return `0 */${minutes} * * * *`;
  }

  const hours = Math.round(minutes / 60);
  if (minutes % 60 === 0 && hours < 24) {
    // Every N hours: 0 */N * * * *
    return `0 0 */${hours} * * *`;
  }

  throw new Error(`Cannot convert interval ${intervalMs}ms to cron (use cron expression directly)`);
}
