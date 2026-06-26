import { Histogram, Counter, register } from 'prom-client';
import { logger } from '../logger';

const backgroundOpDuration = new Histogram({
  name: 'background_operation_duration_seconds',
  help: 'Duration of background (fire-and-forget) operations',
  labelNames: ['operation'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10],
  registers: [register],
});

const backgroundOpErrors = new Counter({
  name: 'background_operation_errors_total',
  help: 'Total errors in background operations',
  labelNames: ['operation'],
  registers: [register],
});

const backgroundOpTotal = new Counter({
  name: 'background_operation_total',
  help: 'Total background operations executed',
  labelNames: ['operation'],
  registers: [register],
});

export async function background(
  operation: string,
  fn: () => Promise<void>,
  meta?: Record<string, unknown>,
): Promise<void> {
  const start = Date.now();
  backgroundOpTotal.inc({ operation });

  try {
    await fn();
  } catch (err) {
    backgroundOpErrors.inc({ operation });
    logger.error(`[background] ${operation} failed`, {
      operation,
      error: (err as Error).message,
      stack: (err as Error).stack,
      durationMs: Date.now() - start,
      ...meta,
    });
  } finally {
    backgroundOpDuration.observe({ operation }, (Date.now() - start) / 1000);
  }
}
