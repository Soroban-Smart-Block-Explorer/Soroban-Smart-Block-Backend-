import * as fs from 'fs';
import * as path from 'path';
import type { BenchmarkComparison, BenchmarkSuite } from './types';

const BENCHMARK_DIR = path.join(process.cwd(), '.benchmarks');

/**
 * Storage and comparison engine for benchmark results
 */
export class BenchmarkStore {
  private resultsDir = BENCHMARK_DIR;

  constructor() {
    if (!fs.existsSync(this.resultsDir)) {
      fs.mkdirSync(this.resultsDir, { recursive: true });
    }
  }

  /**
   * Save benchmark results to disk
   */
  saveSuite(suite: BenchmarkSuite): void {
    const filename = `${suite.name}-${new Date().toISOString().split('T')[0]}.json`;
    const filepath = path.join(this.resultsDir, filename);

    fs.writeFileSync(filepath, JSON.stringify(suite, null, 2), 'utf-8');
    console.log(`✓ Benchmark results saved to ${filepath}`);
  }

  /**
   * Load the most recent benchmark for a suite
   */
  loadLatest(suiteName: string): BenchmarkSuite | null {
    if (!fs.existsSync(this.resultsDir)) {
      return null;
    }

    const files = fs.readdirSync(this.resultsDir);
    const benchmarkFiles = files
      .filter((f) => f.startsWith(suiteName))
      .sort()
      .reverse();

    if (benchmarkFiles.length === 0) {
      return null;
    }

    const filepath = path.join(this.resultsDir, benchmarkFiles[0]);
    const data = fs.readFileSync(filepath, 'utf-8');
    return JSON.parse(data) as BenchmarkSuite;
  }

  /**
   * Compare current results against previous baseline
   */
  compare(suiteName: string, current: BenchmarkSuite): BenchmarkComparison[] {
    const previous = this.loadLatest(suiteName);
    if (!previous) {
      console.log('No previous baseline found, creating new baseline...');
      return current.results.map((result) => ({
        name: result.name,
        current: result,
        regression: {
          detected: false,
          changePercent: 0,
          exceeded: false,
          threshold: result.threshold ?? 10,
        },
      }));
    }

    return current.results.map((currentResult) => {
      const previousResult = previous.results.find((r) => r.name === currentResult.name);
      if (!previousResult) {
        return {
          name: currentResult.name,
          current: currentResult,
          regression: {
            detected: false,
            changePercent: 0,
            exceeded: false,
            threshold: currentResult.threshold ?? 10,
          },
        };
      }

      const threshold = currentResult.threshold ?? 10;
      const changePercent =
        ((currentResult.metrics.mean - previousResult.metrics.mean) / previousResult.metrics.mean) *
        100;
      const exceeded = changePercent > threshold;

      return {
        name: currentResult.name,
        previous: previousResult,
        current: currentResult,
        regression: {
          detected: exceeded,
          changePercent,
          exceeded,
          threshold,
        },
      };
    });
  }

  /**
   * Generate a detailed regression report
   */
  generateReport(comparisons: BenchmarkComparison[]): string {
    let report = '# Performance Benchmark Report\n\n';
    report += `Generated: ${new Date().toISOString()}\n\n`;

    const regressions = comparisons.filter((c) => c.regression.detected);
    const improvements = comparisons.filter(
      (c) => !c.regression.detected && c.previous && c.regression.changePercent < 0,
    );

    report += `## Summary\n`;
    report += `- Total benchmarks: ${comparisons.length}\n`;
    report += `- Regressions detected: ${regressions.length}\n`;
    report += `- Improvements: ${improvements.length}\n\n`;

    if (regressions.length > 0) {
      report += `## ⚠️ Regressions\n`;
      regressions.forEach((comp) => {
        const changeSign = comp.regression.changePercent >= 0 ? '+' : '';
        report += `
### ${comp.name}
- Threshold: ${comp.regression.threshold}%
- Change: ${changeSign}${comp.regression.changePercent.toFixed(2)}%
- Previous mean: ${comp.previous?.metrics.mean.toFixed(3)}ms
- Current mean: ${comp.current.metrics.mean.toFixed(3)}ms
- P95: ${comp.current.metrics.p95.toFixed(3)}ms
`;
      });
    }

    if (improvements.length > 0) {
      report += `\n## ✓ Improvements\n`;
      improvements.forEach((comp) => {
        report += `
### ${comp.name}
- Improvement: ${comp.regression.changePercent.toFixed(2)}%
- Previous mean: ${comp.previous?.metrics.mean.toFixed(3)}ms
- Current mean: ${comp.current.metrics.mean.toFixed(3)}ms
`;
      });
    }

    report += `\n## Detailed Results\n`;
    comparisons.forEach((comp) => {
      report += `
### ${comp.name}
| Metric | Value |
|--------|-------|
| Mean | ${comp.current.metrics.mean.toFixed(3)}ms |
| Median | ${comp.current.metrics.median.toFixed(3)}ms |
| StdDev | ${comp.current.metrics.stdDev.toFixed(3)}ms |
| P95 | ${comp.current.metrics.p95.toFixed(3)}ms |
| P99 | ${comp.current.metrics.p99.toFixed(3)}ms |
| Min | ${comp.current.metrics.min.toFixed(3)}ms |
| Max | ${comp.current.metrics.max.toFixed(3)}ms |
| Samples | ${comp.current.metrics.samples} |
`;
    });

    return report;
  }

  /**
   * Check if any benchmarks exceeded regression threshold
   */
  hasRegressions(comparisons: BenchmarkComparison[]): boolean {
    return comparisons.some((c) => c.regression.detected);
  }
}

/**
 * Export comparison results as JSON for CI/CD integration
 */
export function exportComparison(comparisons: BenchmarkComparison[], filepath: string): void {
  const result = {
    timestamp: new Date().toISOString(),
    regressions: comparisons
      .filter((c) => c.regression.detected)
      .map((c) => ({
        benchmark: c.name,
        threshold: c.regression.threshold,
        changePercent: c.regression.changePercent,
        previousMean: c.previous?.metrics.mean,
        currentMean: c.current.metrics.mean,
      })),
    summary: {
      total: comparisons.length,
      regressionCount: comparisons.filter((c) => c.regression.detected).length,
      improveementCount: comparisons.filter(
        (c) => !c.regression.detected && c.previous && c.regression.changePercent < 0,
      ).length,
    },
  };

  fs.writeFileSync(filepath, JSON.stringify(result, null, 2), 'utf-8');
  console.log(`✓ Comparison exported to ${filepath}`);
}
