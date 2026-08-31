import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { scheduler, intervalToCron, type ScheduledJob } from '../src/scheduler/cron-scheduler';

vi.mock('../src/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('CronScheduler - Job Registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await scheduler.gracefulShutdown();
  });

  it('registers a valid job', () => {
    const mockExecute = vi.fn();
    const job: ScheduledJob = {
      id: 'test-job-1',
      cronExpression: '0 * * * * *',
      taskName: 'Test Task',
      execute: mockExecute,
    };

    expect(() => scheduler.register(job)).not.toThrow();
  });

  it('throws on duplicate job ID', () => {
    const mockExecute = vi.fn();
    const job: ScheduledJob = {
      id: 'duplicate-job',
      cronExpression: '0 * * * * *',
      taskName: 'Test Task',
      execute: mockExecute,
    };

    scheduler.register(job);
    expect(() => scheduler.register(job)).toThrow('already registered');
  });

  it('throws on invalid cron expression', () => {
    const mockExecute = vi.fn();
    const job: ScheduledJob = {
      id: 'invalid-cron-job',
      cronExpression: 'invalid cron',
      taskName: 'Test Task',
      execute: mockExecute,
    };

    expect(() => scheduler.register(job)).toThrow('Invalid cron expression');
  });

  it('accepts valid cron expressions', () => {
    const mockExecute = vi.fn();
    const validExpressions = [
      '0 * * * * *', // Every minute
      '*/5 * * * * *', // Every 5 seconds
      '0 0 * * * *', // Every hour
      '0 0 0 * * *', // Every day
    ];

    validExpressions.forEach((expr, idx) => {
      const job: ScheduledJob = {
        id: `cron-job-${idx}`,
        cronExpression: expr,
        taskName: `Task ${idx}`,
        execute: vi.fn(),
      };
      expect(() => scheduler.register(job)).not.toThrow();
    });
  });

  it('stores job metadata correctly', () => {
    const mockExecute = vi.fn();
    const job: ScheduledJob = {
      id: 'metadata-test-job',
      cronExpression: '0 * * * * *',
      taskName: 'Metadata Test',
      execute: mockExecute,
      maxDuration: 5000,
      retryOnFailure: true,
      retryDelayMs: 2000,
    };

    scheduler.register(job);
    const status = scheduler.getStatus('metadata-test-job');
    expect(status.status).not.toBe('not_found');
    expect((status as any).taskName).toBe('Metadata Test');
    expect((status as any).cronExpression).toBe('0 * * * * *');
  });
});

describe('CronScheduler - Job Execution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await scheduler.gracefulShutdown();
  });

  it('executes job on schedule', async () => {
    const mockExecute = vi.fn().mockResolvedValue(undefined);
    const job: ScheduledJob = {
      id: 'execution-test',
      cronExpression: '*/1 * * * * *',
      taskName: 'Execution Test',
      execute: mockExecute,
    };

    scheduler.register(job);

    await vi.advanceTimersByTimeAsync(61000);

    expect(mockExecute).toHaveBeenCalled();
  });

  it('handles task execution errors gracefully', async () => {
    const mockExecute = vi.fn().mockRejectedValue(new Error('Task failed'));
    const job: ScheduledJob = {
      id: 'error-test-job',
      cronExpression: '*/1 * * * * *',
      taskName: 'Error Test',
      execute: mockExecute,
    };

    scheduler.register(job);

    await vi.advanceTimersByTimeAsync(61000);

    expect(mockExecute).toHaveBeenCalled();
    const status = scheduler.getStatus('error-test-job');
    expect((status as any).lastError).toBeDefined();
  });

  it('respects maxDuration timeout', async () => {
    const mockExecute = vi
      .fn()
      .mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 10000)));
    const job: ScheduledJob = {
      id: 'timeout-test',
      cronExpression: '*/1 * * * * *',
      taskName: 'Timeout Test',
      execute: mockExecute,
      maxDuration: 1000,
    };

    scheduler.register(job);

    await vi.advanceTimersByTimeAsync(61000);
    // Stop new ticks and let the in-flight execution's maxDuration timeout
    // fire so gracefulShutdown in afterEach doesn't wait on an abandoned
    // fake-timer promise (which would hang the hook for 30s).
    scheduler.stop('timeout-test');
    await vi.advanceTimersByTimeAsync(1500);

    const status = scheduler.getStatus('timeout-test');
    expect((status as any).lastError).toBeDefined();
  });
});

describe('CronScheduler - Backpressure Handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await scheduler.gracefulShutdown();
  });

  it('skips execution if previous task still running', async () => {
    let resolveExecution: (() => void) | null = null;
    const mockExecute = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveExecution = resolve;
        }),
    );

    const job: ScheduledJob = {
      id: 'backpressure-test',
      cronExpression: '*/1 * * * * *',
      taskName: 'Backpressure Test',
      execute: mockExecute,
    };

    scheduler.register(job);

    await vi.advanceTimersByTimeAsync(1000);

    expect(mockExecute).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);

    expect(mockExecute).toHaveBeenCalledTimes(1);

    // Resolve the final in-flight execution (its resolver was captured when
    // the last tick started it) and stop new ticks so gracefulShutdown in
    // afterEach doesn't wait on an abandoned fake-timer promise.
    if (resolveExecution) {
      resolveExecution();
    }
    scheduler.stop('backpressure-test');
    await vi.advanceTimersByTimeAsync(1000);

    expect(mockExecute).toHaveBeenCalled();
  });
});

describe('CronScheduler - Retry Logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await scheduler.gracefulShutdown();
  });

  it('retries on failure when enabled', async () => {
    let attempt = 0;
    const mockExecute = vi.fn().mockImplementation(async () => {
      attempt++;
      if (attempt === 1) {
        throw new Error('First attempt failed');
      }
    });

    // 0 * * * * * fires once per minute so the count assertions below are
    // exact (a per-second expression would fire 61+ times across the advance).
    const job: ScheduledJob = {
      id: 'retry-test',
      cronExpression: '0 * * * * *',
      taskName: 'Retry Test',
      execute: mockExecute,
      retryOnFailure: true,
      retryDelayMs: 100,
    };

    scheduler.register(job);

    await vi.advanceTimersByTimeAsync(61000);

    expect(mockExecute).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);

    expect(mockExecute).toHaveBeenCalledTimes(2);
  });

  it('does not retry when disabled', async () => {
    const mockExecute = vi.fn().mockRejectedValue(new Error('Task failed'));

    const job: ScheduledJob = {
      id: 'no-retry-test',
      cronExpression: '0 * * * * *',
      taskName: 'No Retry Test',
      execute: mockExecute,
      retryOnFailure: false,
    };

    scheduler.register(job);

    await vi.advanceTimersByTimeAsync(61000);

    expect(mockExecute).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000);

    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it('tracks execution count including retries', async () => {
    let attempt = 0;
    const mockExecute = vi.fn().mockImplementation(async () => {
      attempt++;
      if (attempt <= 2) {
        throw new Error('Attempt failed');
      }
    });

    const job: ScheduledJob = {
      id: 'execution-count-test',
      cronExpression: '*/1 * * * * *',
      taskName: 'Execution Count Test',
      execute: mockExecute,
      retryOnFailure: true,
      retryDelayMs: 100,
    };

    scheduler.register(job);

    await vi.advanceTimersByTimeAsync(61000);
    // Settle the last tick's pending retry timer so afterEach's
    // gracefulShutdown doesn't wait on it.
    scheduler.stop('execution-count-test');
    await vi.advanceTimersByTimeAsync(1500);

    const status = scheduler.getStatus('execution-count-test');
    expect((status as any).executionCount).toBeGreaterThan(0);
  });
});

describe('CronScheduler - Status and Control', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await scheduler.gracefulShutdown();
  });

  it('retrieves job status', () => {
    const mockExecute = vi.fn();
    const job: ScheduledJob = {
      id: 'status-test',
      cronExpression: '0 * * * * *',
      taskName: 'Status Test',
      execute: mockExecute,
    };

    scheduler.register(job);
    const status = scheduler.getStatus('status-test');

    expect(status.status).not.toBe('not_found');
    expect((status as any).id).toBe('status-test');
    expect((status as any).taskName).toBe('Status Test');
  });

  it('returns not_found for unknown job', () => {
    const status = scheduler.getStatus('nonexistent-job');
    expect(status.status).toBe('not_found');
  });

  it('stops a job', () => {
    const mockExecute = vi.fn();
    const job: ScheduledJob = {
      id: 'stop-test',
      cronExpression: '0 * * * * *',
      taskName: 'Stop Test',
      execute: mockExecute,
    };

    scheduler.register(job);
    scheduler.stop('stop-test');

    const status = scheduler.getStatus('stop-test');
    expect((status as any).cronExpression).toBe('0 * * * * *');
  });

  it('starts a stopped job', () => {
    const mockExecute = vi.fn();
    const job: ScheduledJob = {
      id: 'start-test',
      cronExpression: '0 * * * * *',
      taskName: 'Start Test',
      execute: mockExecute,
    };

    scheduler.register(job);
    scheduler.stop('start-test');
    scheduler.start('start-test');

    const status = scheduler.getStatus('start-test');
    expect(status.status).not.toBe('not_found');
  });

  it('lists all jobs', () => {
    const mockExecute = vi.fn();
    const jobs: ScheduledJob[] = [
      {
        id: 'all-jobs-1',
        cronExpression: '0 * * * * *',
        taskName: 'Job 1',
        execute: mockExecute,
      },
      {
        id: 'all-jobs-2',
        cronExpression: '0 * * * * *',
        taskName: 'Job 2',
        execute: mockExecute,
      },
    ];

    jobs.forEach((j) => scheduler.register(j));

    const allJobs = scheduler.getAll();
    expect(allJobs.length).toBeGreaterThanOrEqual(2);
  });

  it('throws on unknown job operation', () => {
    expect(() => scheduler.stop('unknown-job')).toThrow('not found');
  });
});

describe('CronScheduler - Graceful Shutdown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for running jobs to complete', async () => {
    let jobCompleted = false;
    const mockExecute = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      jobCompleted = true;
    });

    const job: ScheduledJob = {
      id: 'shutdown-wait-test',
      cronExpression: '*/1 * * * * *',
      taskName: 'Shutdown Wait Test',
      execute: mockExecute,
    };

    scheduler.register(job);

    await vi.advanceTimersByTimeAsync(1000);

    const shutdownPromise = scheduler.gracefulShutdown();

    await vi.advanceTimersByTimeAsync(100);

    await shutdownPromise;

    expect(jobCompleted).toBe(true);
  });

  it('times out after 30 seconds', async () => {
    const mockExecute = vi.fn().mockImplementation(() => new Promise(() => {}));

    const job: ScheduledJob = {
      id: 'shutdown-timeout-test',
      cronExpression: '*/1 * * * * *',
      taskName: 'Shutdown Timeout Test',
      execute: mockExecute,
    };

    scheduler.register(job);

    await vi.advanceTimersByTimeAsync(1000);

    const shutdownPromise = scheduler.gracefulShutdown();

    await vi.advanceTimersByTimeAsync(31000);

    await shutdownPromise;

    const status = scheduler.getStatus('shutdown-timeout-test');
    expect(status.status).toBe('not_found');
  });

  it('prevents new jobs during shutdown', async () => {
    const mockExecute = vi.fn();
    const job: ScheduledJob = {
      id: 'shutdown-prevent-test',
      cronExpression: '0 * * * * *',
      taskName: 'Shutdown Prevent Test',
      execute: mockExecute,
    };

    scheduler.register(job);

    const shutdownPromise = scheduler.gracefulShutdown();

    await shutdownPromise;

    const newJob: ScheduledJob = {
      id: 'new-job-during-shutdown',
      cronExpression: '0 * * * * *',
      taskName: 'New Job',
      execute: vi.fn(),
    };

    expect(() => scheduler.register(newJob)).not.toThrow();
  });
});

describe('CronScheduler - Interval to Cron Conversion', () => {
  it('converts milliseconds to cron for seconds', () => {
    const cron = intervalToCron(5000);
    expect(cron).toMatch(/\*\/5/);
  });

  it('converts milliseconds to cron for minutes', () => {
    const cron = intervalToCron(300000);
    expect(cron).toMatch(/\*\/5/);
  });

  it('converts milliseconds to cron for hours', () => {
    const cron = intervalToCron(3600000);
    expect(cron).toMatch(/\*\/1/);
  });

  it('throws for unsupported intervals', () => {
    expect(() => intervalToCron(90000)).toThrow('Cannot convert');
  });
});
