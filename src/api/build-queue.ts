/**
 * Build Queue for Compiler Endpoints
 *
 * Implements a job queue with concurrency limits per API tier to prevent
 * resource exhaustion attacks. Each build job tracks memory, CPU time, and
 * completion status.
 */

import { Counter, Histogram, Gauge } from 'prom-client';
import { registry } from '../metrics';

export interface BuildJob {
  id: string;
  apiKeyId?: string;
  tier: string;
  startTime: number;
  memoryLimitMb: number;
  timeoutMs: number;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'timeout';
  resolve: (value?: void | PromiseLike<void>) => void;
  reject: (error: Error) => void;
}

// Concurrency limits per tier
const CONCURRENCY_LIMITS: Record<string, number> = {
  unauthenticated: 0,
  free: 0,
  developer: 2,
  pro: 5,
  enterprise: 10,
};

// Resource quotas per tier (in MB, seconds)
const RESOURCE_QUOTAS: Record<string, { memoryMb: number; timeoutSec: number }> = {
  unauthenticated: { memoryMb: 0, timeoutSec: 0 },
  free: { memoryMb: 0, timeoutSec: 0 },
  developer: { memoryMb: 1024, timeoutSec: 120 },
  pro: { memoryMb: 2048, timeoutSec: 180 },
  enterprise: { memoryMb: 4096, timeoutSec: 240 },
};

// Active jobs by tier
const jobsByTier: Map<string, BuildJob[]> = new Map();
const activeByTier: Map<string, number> = new Map();

// Metrics
export const buildJobsTotal = new Counter({
  name: 'compiler_build_jobs_total',
  help: 'Total number of compiler build jobs by status and tier',
  labelNames: ['tier', 'status'],
  registers: [registry],
});

export const buildDurationSeconds = new Histogram({
  name: 'compiler_build_duration_seconds',
  help: 'Build job duration in seconds',
  labelNames: ['tier', 'status'],
  buckets: [1, 5, 10, 30, 60, 120, 180, 240],
  registers: [registry],
});

export const buildActiveGauge = new Gauge({
  name: 'compiler_builds_active',
  help: 'Currently active builds per tier',
  labelNames: ['tier'],
  registers: [registry],
});

export function getConcurrencyLimit(tier: string): number {
  return CONCURRENCY_LIMITS[tier] ?? 0;
}

export function getResourceQuota(tier: string) {
  return RESOURCE_QUOTAS[tier] ?? { memoryMb: 0, timeoutSec: 0 };
}

export function getActiveBuildCount(tier: string): number {
  return activeByTier.get(tier) ?? 0;
}

export function getTotalQueued(): number {
  let total = 0;
  for (const jobs of jobsByTier.values()) {
    total += jobs.filter((j) => j.status === 'queued').length;
  }
  return total;
}

export function pushBuildJob(tier: string, apiKeyId?: string): Promise<void> {
  const limit = getConcurrencyLimit(tier);
  if (limit === 0) {
    return Promise.reject(new Error('Build jobs not allowed for this tier'));
  }

  const active = getActiveBuildCount(tier);
  if (active >= limit) {
    buildJobsTotal.inc({ tier, status: 'rejected' });
    return Promise.reject(new Error('Concurrent build limit exceeded for tier'));
  }

  const queue = jobsByTier.get(tier) ?? [];
  const job: BuildJob = {
    id: `build-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    apiKeyId,
    tier,
    startTime: Date.now(),
    memoryLimitMb: RESOURCE_QUOTAS[tier].memoryMb,
    timeoutMs: RESOURCE_QUOTAS[tier].timeoutSec * 1000,
    status: 'queued',
    resolve: () => {},
    reject: () => {},
  };

  queue.push(job);
  jobsByTier.set(tier, queue);

  return new Promise((resolve, reject) => {
    job.resolve = resolve;
    job.reject = reject;
  });
}

export async function startBuildJob(tier: string): Promise<BuildJob | null> {
  const queue = jobsByTier.get(tier);
  if (!queue || queue.length === 0) {
    return null;
  }

  const jobIndex = queue.findIndex((j) => j.status === 'queued');
  if (jobIndex === -1) return null;

  const job = queue[jobIndex];
  job.status = 'running';
  const active = (activeByTier.get(tier) ?? 0) + 1;
  activeByTier.set(tier, active);
  buildActiveGauge.set({ tier }, active);
  buildJobsTotal.inc({ tier, status: 'running' });

  // Set up timeout handling
  if (job.timeoutMs > 0) {
    setTimeout(() => {
      if (job.status === 'running') {
        job.status = 'timeout';
        job.reject(new Error(`Build timed out after ${job.timeoutMs / 1000}s`));
        completeBuildJob(tier, job, false);
      }
    }, job.timeoutMs).unref();
  }

  return job;
}

export function completeBuildJob(tier: string, job: BuildJob, success = true): void {
  const finalStatus = success ? 'completed' : 'failed';
  job.status = finalStatus;
  const active = (activeByTier.get(tier) ?? 1) - 1;
  activeByTier.set(tier, Math.max(0, active));
  buildActiveGauge.set({ tier }, Math.max(0, active));
  buildJobsTotal.inc({ tier, status: finalStatus });

  const duration = (Date.now() - job.startTime) / 1000;
  buildDurationSeconds.observe({ tier, status: finalStatus }, duration);

  job.resolve(undefined);
}

// Expose queue state for /compiler/metrics endpoint
export function getQueueMetrics() {
  const metrics: Record<string, { active: number; queued: number }> = {};
  for (const tier of Object.keys(CONCURRENCY_LIMITS)) {
    const queue = jobsByTier.get(tier) ?? [];
    metrics[tier] = {
      active: activeByTier.get(tier) ?? 0,
      queued: queue.filter((j) => j.status === 'queued').length,
    };
  }
  return metrics;
}
