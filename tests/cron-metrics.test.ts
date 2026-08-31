/**
 * #911 — Cron-scheduled jobs must expose success/failure metrics and
 * last-run tracking (cron_job_runs_total, cron_job_duration_seconds,
 * cron_job_last_success_timestamp). These tests drive the real scheduler
 * with fake timers and assert the metrics land on the shared Prometheus
 * registry, for both scheduler-managed jobs and externally-managed
 * recurring tasks that report through scheduler.recordHeartbeat().
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { scheduler, type ScheduledJob } from '../src/scheduler/cron-scheduler';
import { registry } from '../src/metrics';

vi.mock('../src/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

async function metricText(name: string): Promise<string> {
  return registry.getSingleMetricAsString(name);
}

describe('cron scheduler metrics (#911)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registry.resetMetrics();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await scheduler.gracefulShutdown();
  });

  it('emits runs_total, duration, and last_success on a successful run', async () => {
    // 0 * * * * * fires once per minute — exactly one run per 61s advance.
    const job: ScheduledJob = {
      id: 'metrics-success-job',
      cronExpression: '0 * * * * *',
      taskName: 'Metrics Success Job',
      execute: vi.fn().mockResolvedValue(undefined),
    };
    scheduler.register(job);
    await vi.advanceTimersByTimeAsync(61_000);

    const runs = await metricText('cron_job_runs_total');
    expect(runs).toContain('cron_job_runs_total{job="metrics-success-job",status="success"} 1');
    expect(runs).not.toContain('status="failure"');

    const durations = await metricText('cron_job_duration_seconds');
    expect(durations).toContain('cron_job_duration_seconds_count{job="metrics-success-job"} 1');

    const lastSuccess = await metricText('cron_job_last_success_timestamp');
    expect(lastSuccess).toContain('cron_job_last_success_timestamp{job="metrics-success-job"}');
  });

  it('emits failure outcome and no last-success update on failure', async () => {
    const job: ScheduledJob = {
      id: 'metrics-fail-job',
      cronExpression: '0 * * * * *',
      taskName: 'Metrics Fail Job',
      execute: vi.fn().mockRejectedValue(new Error('boom')),
    };
    scheduler.register(job);
    await vi.advanceTimersByTimeAsync(61_000);

    const runs = await metricText('cron_job_runs_total');
    expect(runs).toContain('cron_job_runs_total{job="metrics-fail-job",status="failure"} 1');
    expect(runs).not.toContain('cron_job_runs_total{job="metrics-fail-job",status="success"}');

    const lastSuccess = await metricText('cron_job_last_success_timestamp');
    expect(lastSuccess).not.toContain('metrics-fail-job');
  });

  it('records metrics for externally-managed jobs via recordHeartbeat', async () => {
    scheduler.recordHeartbeat('price-updater:active', 'success');
    scheduler.recordHeartbeat('price-updater:active', 'success');
    scheduler.recordHeartbeat('price-updater:active', 'failure');

    const runs = await metricText('cron_job_runs_total');
    expect(runs).toContain('cron_job_runs_total{job="price-updater:active",status="success"} 2');
    expect(runs).toContain('cron_job_runs_total{job="price-updater:active",status="failure"} 1');

    const lastSuccess = await metricText('cron_job_last_success_timestamp');
    expect(lastSuccess).toContain('cron_job_last_success_timestamp{job="price-updater:active"}');
  });

  it('keeps runs_total and last_success in sync with health registry heartbeats', async () => {
    // Every scheduler-managed run funnels through recordHeartbeat(), so a
    // failing job must NOT be double-counted as a success.
    const job: ScheduledJob = {
      id: 'metrics-sync-job',
      cronExpression: '0 * * * * *',
      taskName: 'Metrics Sync Job',
      execute: vi.fn().mockRejectedValue(new Error('always fails')),
    };
    scheduler.register(job);
    await vi.advanceTimersByTimeAsync(61_000);

    const runs = await metricText('cron_job_runs_total');
    expect(runs).toContain('cron_job_runs_total{job="metrics-sync-job",status="failure"} 1');
    // Exactly one run total — no duplicate count from executeJob + recordHeartbeat.
    const failureCount = runs.match(
      /cron_job_runs_total\{job="metrics-sync-job",status="failure"\} (\d+)/,
    );
    expect(failureCount).not.toBeNull();
    expect(Number(failureCount![1])).toBe(1);
  });
});
