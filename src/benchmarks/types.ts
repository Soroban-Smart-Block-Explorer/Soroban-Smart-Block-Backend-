/**
 * Performance benchmark types and interfaces
 */

export interface BenchmarkResult {
  name: string;
  path: string;
  timestamp: string;
  metrics: {
    mean: number; // milliseconds
    median: number;
    stdDev: number;
    min: number;
    max: number;
    p95: number;
    p99: number;
    samples: number;
  };
  threshold?: number; // regression threshold in percent
}

export interface BenchmarkComparison {
  name: string;
  previous?: BenchmarkResult;
  current: BenchmarkResult;
  regression: {
    detected: boolean;
    changePercent: number;
    exceeded: boolean;
    threshold: number;
  };
}

export interface BenchmarkSuite {
  name: string;
  description: string;
  results: BenchmarkResult[];
  timestamp: string;
  duration: number; // milliseconds
}

export interface BenchmarkContext {
  name: string;
  iterations?: number;
  warmupIterations?: number;
  timeoutMs?: number;
}
