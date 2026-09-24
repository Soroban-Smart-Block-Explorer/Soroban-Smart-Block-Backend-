import { performance } from 'perf_hooks';
import type { BenchmarkResult, BenchmarkContext } from './types';

/**
 * Benchmark executor with high-resolution timing
 */
export class BenchmarkRunner {
  private iterations: number;
  private warmupIterations: number;
  private timeoutMs: number;

  constructor(context: BenchmarkContext) {
    this.iterations = context.iterations ?? 100;
    this.warmupIterations = context.warmupIterations ?? 10;
    this.timeoutMs = context.timeoutMs ?? 30000;
  }

  /**
   * Run a synchronous benchmark function and collect timing metrics
   */
  async runSync(fn: () => void): Promise<number[]> {
    // Warmup: ensure function is JIT compiled and caches are populated
    for (let i = 0; i < this.warmupIterations; i++) {
      fn();
    }

    // Garbage collection before actual benchmark (if available)
    if (global.gc) {
      global.gc();
    }

    // Measure iterations with high-resolution timer
    const measurements: number[] = [];
    const startTime = performance.now();

    for (let i = 0; i < this.iterations; i++) {
      const iterStart = performance.now();
      fn();
      const iterEnd = performance.now();
      measurements.push(iterEnd - iterStart);

      // Safety timeout
      if (performance.now() - startTime > this.timeoutMs) {
        throw new Error(`Benchmark exceeded timeout of ${this.timeoutMs}ms`);
      }
    }

    return measurements;
  }

  /**
   * Run an asynchronous benchmark function
   */
  async runAsync(fn: () => Promise<void>): Promise<number[]> {
    // Warmup
    for (let i = 0; i < this.warmupIterations; i++) {
      await fn();
    }

    if (global.gc) {
      global.gc();
    }

    const measurements: number[] = [];
    const startTime = performance.now();

    for (let i = 0; i < this.iterations; i++) {
      const iterStart = performance.now();
      await fn();
      const iterEnd = performance.now();
      measurements.push(iterEnd - iterStart);

      if (performance.now() - startTime > this.timeoutMs) {
        throw new Error(`Benchmark exceeded timeout of ${this.timeoutMs}ms`);
      }
    }

    return measurements;
  }

  /**
   * Calculate statistics from measurements
   */
  static calculateStats(measurements: number[]): BenchmarkResult['metrics'] {
    if (measurements.length === 0) {
      throw new Error('No measurements recorded');
    }

    const sorted = [...measurements].sort((a, b) => a - b);
    const sum = sorted.reduce((acc, val) => acc + val, 0);
    const mean = sum / sorted.length;

    // Calculate median
    const median =
      sorted.length % 2 === 0
        ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
        : sorted[Math.floor(sorted.length / 2)];

    // Calculate standard deviation
    const squaredDiffs = sorted.map((val) => Math.pow(val - mean, 2));
    const variance = squaredDiffs.reduce((a, b) => a + b, 0) / sorted.length;
    const stdDev = Math.sqrt(variance);

    // Calculate percentiles
    const p95Index = Math.floor(sorted.length * 0.95);
    const p99Index = Math.floor(sorted.length * 0.99);

    return {
      mean,
      median,
      stdDev,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      p95: sorted[p95Index],
      p99: sorted[p99Index],
      samples: sorted.length,
    };
  }
}

/**
 * Helper to format benchmark results for display
 */
export function formatBenchmarkResult(result: BenchmarkResult): string {
  const { mean, median, stdDev, p95, p99, samples } = result.metrics;
  return `
  ${result.name}
    Mean:    ${mean.toFixed(3)}ms
    Median:  ${median.toFixed(3)}ms
    StdDev:  ${stdDev.toFixed(3)}ms
    Min/Max: ${result.metrics.min.toFixed(3)}ms / ${result.metrics.max.toFixed(3)}ms
    P95/P99: ${p95.toFixed(3)}ms / ${p99.toFixed(3)}ms
    Samples: ${samples}
`;
}
