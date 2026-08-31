/**
 * Unit tests for dynamic worker health (#906).
 *
 * checkWorkerHealth() (src/health.ts) reads its state from the cron
 * scheduler's health registry (src/scheduler/cron-scheduler.ts), which is
 * fed either by scheduler-managed jobs or by external interval-based
 * pipelines calling `scheduler.recordHeartbeat(...)` directly (price
 * updates, key rotation, indexer reconciliation sweeps). These tests inject
 * heartbeats directly into that registry and assert /health's worker status
 * transitions accordingly — no real background jobs are started.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { checkWorkerHealth } from '../health';
import { scheduler } from '../scheduler/cron-scheduler';
import { config } from '../config';

describe('checkWorkerHealth', () => {
  beforeEach(() => {
    scheduler._clearHealthRegistry();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports healthy when no job has reported a heartbeat yet', () => {
    const result = checkWorkerHealth();

    expect(result.status).toBe('healthy');
    expect(result.message).toMatch(/no job heartbeats reported yet/i);
  });

  it('reports healthy when all jobs are recent and succeeding', () => {
    scheduler.recordHeartbeat('job-a', 'success', {
      taskName: 'Job A',
      expectedIntervalMs: 60_000,
    });
    scheduler.recordHeartbeat('job-b', 'success', {
      taskName: 'Job B',
      expectedIntervalMs: 30_000,
    });

    const result = checkWorkerHealth();

    expect(result.status).toBe('healthy');
    expect(result.message).toBe('Workers operational');
  });

  it('reports degraded when a job has missed its scheduled window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    scheduler.recordHeartbeat('stale-job', 'success', {
      taskName: 'Stale Job',
      expectedIntervalMs: 60_000, // every minute
    });

    // Jump forward well past staleIntervalMultiplier * expectedIntervalMs
    // (default multiplier is 3 => stale after 3 minutes).
    const staleAfterMs = 60_000 * config.workerStaleIntervalMultiplier + 60_000;
    vi.setSystemTime(new Date(Date.now() + staleAfterMs));

    const result = checkWorkerHealth();

    expect(result.status).toBe('degraded');
    expect(result.message).toMatch(/missed their scheduled window/i);
    expect(result.message).toContain('Stale Job');
  });

  it('does not flag a job as stale when it is still within its window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    scheduler.recordHeartbeat('fresh-job', 'success', {
      taskName: 'Fresh Job',
      expectedIntervalMs: 60_000,
    });

    // Advance by less than one interval — should stay healthy.
    vi.setSystemTime(new Date(Date.now() + 10_000));

    const result = checkWorkerHealth();

    expect(result.status).toBe('healthy');
  });

  it('reports unhealthy once a job hits the consecutive-failure threshold', () => {
    const maxFailures = config.workerMaxConsecutiveFailures;

    for (let i = 0; i < maxFailures; i++) {
      scheduler.recordHeartbeat('flaky-job', 'failure', {
        taskName: 'Flaky Job',
        expectedIntervalMs: 60_000,
      });
    }

    const result = checkWorkerHealth();

    expect(result.status).toBe('unhealthy');
    expect(result.message).toMatch(/failing repeatedly/i);
    expect(result.message).toContain('Flaky Job');
  });

  it('recovers to healthy after a failing job succeeds again', () => {
    const maxFailures = config.workerMaxConsecutiveFailures;

    for (let i = 0; i < maxFailures; i++) {
      scheduler.recordHeartbeat('recovering-job', 'failure', {
        taskName: 'Recovering Job',
        expectedIntervalMs: 60_000,
      });
    }
    expect(checkWorkerHealth().status).toBe('unhealthy');

    // A single success resets consecutiveFailures to 0.
    scheduler.recordHeartbeat('recovering-job', 'success', {
      taskName: 'Recovering Job',
      expectedIntervalMs: 60_000,
    });

    expect(checkWorkerHealth().status).toBe('healthy');
  });

  it('reports unhealthy even when a different job is merely degraded', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    // One job stale (would be "degraded" on its own) ...
    scheduler.recordHeartbeat('stale-job', 'success', {
      taskName: 'Stale Job',
      expectedIntervalMs: 60_000,
    });
    vi.setSystemTime(new Date(Date.now() + 60_000 * config.workerStaleIntervalMultiplier + 60_000));

    // ...and another job actively failing — unhealthy takes precedence.
    const maxFailures = config.workerMaxConsecutiveFailures;
    for (let i = 0; i < maxFailures; i++) {
      scheduler.recordHeartbeat('failing-job', 'failure', {
        taskName: 'Failing Job',
        expectedIntervalMs: 60_000,
      });
    }

    const result = checkWorkerHealth();

    expect(result.status).toBe('unhealthy');
  });

  it('includes per-job details in the response', () => {
    scheduler.recordHeartbeat('job-a', 'success', {
      taskName: 'Job A',
      expectedIntervalMs: 60_000,
    });

    const result = checkWorkerHealth();
    const jobs = result.details?.jobs as Array<{ id: string; executionStatus: string }>;

    expect(Array.isArray(jobs)).toBe(true);
    expect(jobs.find((j) => j.id === 'job-a')?.executionStatus).toBe('success');
  });
});
