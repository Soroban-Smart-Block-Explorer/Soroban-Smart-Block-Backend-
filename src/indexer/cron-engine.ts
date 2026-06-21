/**
 * Cron Execution Engine
 *
 * Polls CronJob records whose nextRunAt has passed, executes the configured
 * contract function via Soroban RPC, records the result, and advances
 * nextRunAt according to the cron expression.
 *
 * No external cron-parser library is available, so we implement minimal
 * 5-field cron parsing and alias expansion in-house.
 */
import { prismaWrite as prisma } from '../db';

// ── Minimal cron parser ───────────────────────────────────────────────────────

const ALIASES: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
};

function expandAlias(expr: string): string {
  return ALIASES[expr.trim()] ?? expr.trim();
}

/**
 * Parse a single cron field (e.g. "5", "step/15", "1-5", "1,3,5") against a
 * range [min, max] and return true if `value` is matched.
 */
function matchField(field: string, value: number, min: number, max: number): boolean {
  if (field === '*') return true;
  for (const part of field.split(',')) {
    if (part.includes('/')) {
      const [rangeStr, stepStr] = part.split('/');
      const step = parseInt(stepStr, 10);
      const start = rangeStr === '*' ? min : parseInt(rangeStr.split('-')[0], 10);
      const end = rangeStr.includes('-') ? parseInt(rangeStr.split('-')[1], 10) : max;
      for (let v = start; v <= end; v += step) {
        if (v === value) return true;
      }
    } else if (part.includes('-')) {
      const [lo, hi] = part.split('-').map(Number);
      if (value >= lo && value <= hi) return true;
    } else {
      if (parseInt(part, 10) === value) return true;
    }
  }
  return false;
}

/**
 * Return the next Date that matches the given 5-field cron expression,
 * starting from `after`.
 */
export function nextCronDate(expression: string, after: Date = new Date()): Date {
  const expr = expandAlias(expression);
  const fields = expr.split(/\s+/);
  // Accept 5-field or 6-field (with seconds) cron
  const [minF, hourF, domF, monF, dowF] = fields.length >= 6 ? fields.slice(1) : fields;

  // Advance by at least one minute
  const start = new Date(after.getTime() + 60_000);
  start.setSeconds(0, 0);

  // Search up to 4 years forward to find the next match
  const limit = new Date(start.getTime() + 4 * 365 * 24 * 3600 * 1000);
  const cursor = new Date(start);

  while (cursor < limit) {
    const mon = cursor.getUTCMonth() + 1; // 1-12
    const dom = cursor.getUTCDate(); // 1-31
    const dow = cursor.getUTCDay(); // 0-6
    const hour = cursor.getUTCHours();
    const min = cursor.getUTCMinutes();

    if (
      matchField(monF, mon, 1, 12) &&
      matchField(domF, dom, 1, 31) &&
      matchField(dowF, dow, 0, 6) &&
      matchField(hourF, hour, 0, 23) &&
      matchField(minF, min, 0, 59)
    ) {
      return new Date(cursor);
    }
    // Advance one minute
    cursor.setTime(cursor.getTime() + 60_000);
  }

  throw new Error(`Unable to compute next run for cron expression: ${expression}`);
}

/**
 * Determine whether a cron expression is syntactically valid.
 */
export function isValidCronExpression(expression: string): boolean {
  try {
    const expr = expandAlias(expression);
    const parts = expr.split(/\s+/);
    if (parts.length < 5 || parts.length > 6) return false;
    nextCronDate(expression, new Date(0));
    return true;
  } catch {
    return false;
  }
}

// ── Execution runner ──────────────────────────────────────────────────────────

const MAX_RETRIES = 3;

/** Simulate executing a Soroban contract function (stub — real impl would use RPC). */
async function executeContractFunction(
  contractAddress: string,
  functionName: string,
  args: unknown,
): Promise<{ success: boolean; txHash?: string; gasUsed?: number; error?: string }> {
  // In production this would call the Soroban RPC simulateTransaction / sendTransaction.
  // Stub returns success to allow the engine to be tested without a live RPC node.
  void contractAddress;
  void functionName;
  void args;
  return { success: true, txHash: undefined, gasUsed: undefined };
}

/**
 * Execute a single cron job with retry logic.
 * Returns true on success, false after exhausting retries.
 */
async function runCronJob(jobId: string): Promise<boolean> {
  const job = await prisma.cronJob.findUnique({ where: { id: jobId } });
  if (!job || !job.enabled) return false;

  const start = Date.now();
  let lastError: string | undefined;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      // Exponential backoff: 2s, 4s
      await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
    }

    const result = await executeContractFunction(
      job.contractAddress,
      job.functionName,
      job.functionArgs,
    );

    if (result.success) {
      const duration = Date.now() - start;
      const next = nextCronDate(job.cronExpression);

      await prisma.$transaction([
        prisma.cronExecution.create({
          data: {
            cronJobId: job.id,
            executedAt: new Date(),
            success: true,
            txHash: result.txHash ?? null,
            gasUsed: result.gasUsed ?? null,
            duration,
          },
        }),
        prisma.cronJob.update({
          where: { id: job.id },
          data: {
            lastRunAt: new Date(),
            nextRunAt: next,
            totalRuns: { increment: 1 },
            successfulRuns: { increment: 1 },
            // Disable if maxRuns reached
            enabled: job.maxRuns !== null ? job.totalRuns + 1 < job.maxRuns : true,
          },
        }),
      ]);
      return true;
    }

    lastError = result.error ?? 'unknown error';
  }

  // All retries exhausted — record failure
  const duration = Date.now() - start;
  const next = nextCronDate(job.cronExpression);

  await prisma.$transaction([
    prisma.cronExecution.create({
      data: {
        cronJobId: job.id,
        executedAt: new Date(),
        success: false,
        errorMessage: lastError,
        duration,
      },
    }),
    prisma.cronJob.update({
      where: { id: job.id },
      data: {
        lastRunAt: new Date(),
        nextRunAt: next,
        totalRuns: { increment: 1 },
        failedRuns: { increment: 1 },
      },
    }),
  ]);
  return false;
}

/**
 * Run all cron jobs that are due. Call this every minute from a setInterval.
 */
export async function runDueCronJobs(): Promise<void> {
  const now = new Date();
  const due = await prisma.cronJob.findMany({
    where: { enabled: true, nextRunAt: { lte: now } },
    select: { id: true },
  });

  await Promise.allSettled(due.map((j) => runCronJob(j.id)));
}

/**
 * Start the cron engine poll loop. Returns a cleanup function.
 */
export function startCronEngine(intervalMs = 60_000): () => void {
  const timer = setInterval(() => {
    runDueCronJobs().catch((err) => {
      console.error('[cron-engine] error:', err);
    });
  }, intervalMs);

  return () => clearInterval(timer);
}
