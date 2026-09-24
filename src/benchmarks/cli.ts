#!/usr/bin/env ts-node
/**
 * Benchmark CLI for managing performance tests
 * Usage:
 *   ts-node src/benchmarks/cli.ts compare
 *   ts-node src/benchmarks/cli.ts report
 *   ts-node src/benchmarks/cli.ts export <suite-name> <output-path>
 */

import * as fs from 'fs';
import * as path from 'path';
import { BenchmarkStore, exportComparison } from './comparison';

const command = process.argv[2];
const arg1 = process.argv[3];
const arg2 = process.argv[4];

async function main() {
  const store = new BenchmarkStore();

  switch (command) {
    case 'compare': {
      // Load all benchmark suites and compare against baselines
      const suites = ['event-decoding', 'api-responses', 'rpc-calls'];
      const allComparisons: Array<{ suite: string; comparisons: any[] }> = [];

      for (const suiteName of suites) {
        const latest = store.loadLatest(suiteName);
        if (latest) {
          const comparisons = store.compare(suiteName, latest);
          allComparisons.push({ suite: suiteName, comparisons });

          console.log(`\n${'='.repeat(50)}`);
          console.log(`${suiteName.toUpperCase()} BENCHMARKS`);
          console.log(`${'='.repeat(50)}`);
          console.log(store.generateReport(comparisons));

          const hasRegressions = store.hasRegressions(comparisons);
          if (hasRegressions) {
            console.log('\n⚠️ REGRESSIONS DETECTED');
            process.exitCode = 1;
          } else {
            console.log('\n✓ All benchmarks within threshold');
          }
        } else {
          console.log(`No baseline found for ${suiteName} - skipping comparison`);
        }
      }

      // Export overall results
      const allComparisonsList = allComparisons.flatMap((c) => c.comparisons);
      exportComparison(
        allComparisonsList,
        path.join(process.cwd(), '.benchmarks', 'comparison-result.json'),
      );
      break;
    }

    case 'report': {
      // Generate a human-readable report
      const suiteName = arg1 || 'event-decoding';
      const latest = store.loadLatest(suiteName);

      if (!latest) {
        console.error(`No benchmarks found for ${suiteName}`);
        process.exit(1);
      }

      const comparisons = store.compare(suiteName, latest);
      const report = store.generateReport(comparisons);

      console.log(report);

      // Also save to file
      const reportPath = path.join(
        process.cwd(),
        '.benchmarks',
        `report-${suiteName}-${new Date().toISOString().split('T')[0]}.md`,
      );
      fs.writeFileSync(reportPath, report, 'utf-8');
      console.log(`\n✓ Report saved to ${reportPath}`);
      break;
    }

    case 'export': {
      // Export comparison results as JSON
      if (!arg1 || !arg2) {
        console.error('Usage: ts-node cli.ts export <suite-name> <output-path>');
        process.exit(1);
      }

      const latest = store.loadLatest(arg1);
      if (!latest) {
        console.error(`No benchmarks found for ${arg1}`);
        process.exit(1);
      }

      const comparisons = store.compare(arg1, latest);
      exportComparison(comparisons, arg2);
      console.log(`✓ Exported to ${arg2}`);
      break;
    }

    case 'list': {
      // List all benchmark suites
      const benchmarkDir = path.join(process.cwd(), '.benchmarks');
      if (!fs.existsSync(benchmarkDir)) {
        console.log('No benchmarks found');
        break;
      }

      const files = fs.readdirSync(benchmarkDir);
      console.log('Available benchmarks:\n');
      files.forEach((file) => {
        const filepath = path.join(benchmarkDir, file);
        const stat = fs.statSync(filepath);
        const size = (stat.size / 1024).toFixed(2);
        console.log(`  ${file} (${size}KB)`);
      });
      break;
    }

    case 'clean': {
      // Remove old benchmark results (keep last 10)
      const benchmarkDir = path.join(process.cwd(), '.benchmarks');
      if (!fs.existsSync(benchmarkDir)) {
        console.log('No benchmark directory found');
        break;
      }

      const files = fs
        .readdirSync(benchmarkDir)
        .filter((f) => f.endsWith('.json') && f !== 'comparison-result.json')
        .sort()
        .reverse();

      const toDelete = files.slice(10);
      toDelete.forEach((file) => {
        const filepath = path.join(benchmarkDir, file);
        fs.unlinkSync(filepath);
        console.log(`Deleted ${file}`);
      });

      console.log(`✓ Cleaned up ${toDelete.length} old benchmark files`);
      break;
    }

    default:
      console.log(`
Performance Benchmark CLI

Usage:
  ts-node src/benchmarks/cli.ts <command> [options]

Commands:
  compare                        Compare current benchmarks against baseline
  report [suite]                 Generate a human-readable report
  export <suite> <output>        Export results as JSON
  list                           List all benchmark suites
  clean                          Remove old benchmark results (keep last 10)

Examples:
  ts-node src/benchmarks/cli.ts compare
  ts-node src/benchmarks/cli.ts report event-decoding
  ts-node src/benchmarks/cli.ts export api-responses ./result.json
`);
  }
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
