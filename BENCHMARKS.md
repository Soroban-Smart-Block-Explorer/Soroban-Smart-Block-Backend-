# Performance Benchmarking System

This document describes the performance benchmarking infrastructure for the Soroban Smart Block Explorer backend. The system automatically detects performance regressions in critical code paths and fails CI when performance degrades beyond acceptable thresholds.

## Overview

The benchmarking system measures performance of three critical paths:

1. **Event Decoding** (`src/indexer/decoder.ts`)
   - SEP-41 transfer event decoding
   - Complex generic event handling
   - XDR parsing overhead

2. **API Responses** (`src/api/`)
   - Transaction list endpoint performance
   - Event list endpoint performance
   - Contract detail endpoint performance
   - Pagination overhead

3. **RPC Calls** (`src/indexer/rpc.ts`)
   - getEvents RPC call overhead
   - getTransaction RPC call performance
   - getLedger RPC call performance
   - Batch event processing
   - Retry logic overhead

## Architecture

### Core Components

```
src/benchmarks/
├── types.ts           # TypeScript interfaces for benchmark data
├── runner.ts          # BenchmarkRunner - high-resolution timing execution
├── comparison.ts      # BenchmarkStore - result storage and regression detection
├── cli.ts             # CLI for managing benchmarks
├── event-decoding.bench.ts  # Event decoding benchmarks (3 benchmarks)
├── api-responses.bench.ts   # API endpoint benchmarks (4 benchmarks)
└── rpc-calls.bench.ts       # RPC call benchmarks (5 benchmarks)
```

### Key Metrics

Each benchmark collects the following metrics:

- **Mean**: Average execution time
- **Median**: 50th percentile
- **StdDev**: Standard deviation (consistency)
- **Min/Max**: Extreme values
- **P95/P99**: 95th and 99th percentiles (tail latency)
- **Samples**: Total measurements collected

### Regression Detection

Regressions are detected when:

```
(current_mean - previous_mean) / previous_mean * 100 > threshold
```

Default thresholds:

- Event decoding: **10%**
- API responses: **15-20%**
- RPC calls: **10-15%**

## Running Benchmarks

### All Benchmarks

```bash
npm run bench
```

Runs all three benchmark suites with default iterations.

### Individual Suites

```bash
npm run bench:event-decoding
npm run bench:api-responses
npm run bench:rpc-calls
```

### Watch Mode

```bash
npm run bench:watch
```

Reruns benchmarks on file changes.

### Compare Against Baseline

```bash
npm run bench:compare
```

Compares current results against the most recent baseline and generates a report:

```
==================================================
EVENT-DECODING BENCHMARKS
==================================================

# Performance Benchmark Report

Generated: 2026-07-28T10:54:17.018Z

## Summary
- Total benchmarks: 3
- Regressions detected: 0
- Improvements: 0

## Detailed Results
...
```

### Generate Report

```bash
npm run bench:report
```

Generates a detailed markdown report for a specific benchmark suite.

### Export Results as JSON

```bash
ts-node src/benchmarks/cli.ts export event-decoding ./result.json
```

Exports comparison results in JSON format for programmatic analysis.

### List Benchmarks

```bash
ts-node src/benchmarks/cli.ts list
```

Shows all stored benchmark results:

```
Available benchmarks:

  event-decoding-2026-07-28.json (4.23KB)
  api-responses-2026-07-28.json (5.87KB)
  rpc-calls-2026-07-28.json (6.12KB)
  comparison-result.json (2.45KB)
```

### Clean Up Old Results

```bash
ts-node src/benchmarks/cli.ts clean
```

Removes old benchmark files (keeps last 10).

## Data Storage

Benchmark results are stored in `.benchmarks/` directory (git-ignored):

```
.benchmarks/
├── event-decoding-2026-07-28.json
├── event-decoding-2026-07-27.json
├── api-responses-2026-07-28.json
├── rpc-calls-2026-07-28.json
└── comparison-result.json
```

Each file contains:

```json
{
  "name": "event-decoding",
  "description": "Event decoding performance benchmarks",
  "timestamp": "2026-07-28T10:54:17.018Z",
  "duration": 450.23,
  "results": [
    {
      "name": "sep41-transfer-decode",
      "path": "src/indexer/decoder.ts:decodeEvent",
      "timestamp": "2026-07-28T10:54:17.018Z",
      "metrics": {
        "mean": 0.234,
        "median": 0.212,
        "stdDev": 0.045,
        "min": 0.189,
        "max": 0.412,
        "p95": 0.356,
        "p99": 0.401,
        "samples": 1000
      },
      "threshold": 10
    }
  ]
}
```

## CI Integration

### GitHub Actions Workflow

The `.github/workflows/benchmarks.yml` workflow:

1. **Runs on every push and PR** to `main` and `develop`
2. **Executes benchmarks** on Node.js 18.x and 20.x
3. **Compares against baseline** and detects regressions
4. **Uploads artifacts** with results for 30 days
5. **Comments on PR** with summary and any regressions
6. **Fails job** if regressions exceed thresholds
7. **Generates reports** for main branch merges

### Example CI Output

When regressions are detected, the workflow:

1. Fails the benchmark job (exit code 1)
2. Posts a PR comment with details:

```markdown
## 📊 Performance Benchmark Results

| Metric | Value |
|--------|-------|
| Total Benchmarks | 12 |
| Regressions | 1 |
| Improvements | 2 |

### ⚠️ Regressions Detected

- **sep41-transfer-decode**: +12.45% (threshold: 10%)
  - Previous: 0.234ms → Current: 0.263ms
```

3. Uploads artifacts including detailed comparison logs

## Adding New Benchmarks

### 1. Create Benchmark Suite

```typescript
// src/benchmarks/new-feature.bench.ts
import { describe, it } from 'vitest';
import { BenchmarkRunner } from './runner';
import { BenchmarkStore } from './comparison';

describe('New Feature Benchmarks', () => {
  const store = new BenchmarkStore();
  const results: BenchmarkResult[] = [];

  it('should benchmark critical function', async () => {
    const runner = new BenchmarkRunner({
      name: 'critical-function',
      iterations: 100,
      warmupIterations: 10,
    });

    const measurements = await runner.runSync(() => {
      myFunction();
    });

    const metrics = BenchmarkRunner.calculateStats(measurements);
    results.push({
      name: 'critical-function',
      path: 'src/my-module.ts:myFunction',
      timestamp: new Date().toISOString(),
      metrics,
      threshold: 10,
    });

    expect(metrics.mean).toBeLessThan(5);
  });

  it.after(() => {
    // Save and compare results...
  });
});
```

### 2. Add Script to package.json

```json
{
  "scripts": {
    "bench:new-feature": "vitest run src/benchmarks/new-feature.bench.ts"
  }
}
```

### 3. Update CI Workflow

Add to `.github/workflows/benchmarks.yml`:

```yaml
- name: Run new feature benchmarks
  run: npm run bench:new-feature
```

## Best Practices

### Writing Benchmarks

1. **Warmup iterations** - Run the function 10-50 times before measuring to allow JIT compilation
2. **High iteration counts** - Aim for at least 100-1000 samples for statistical significance
3. **Isolation** - Benchmark one function at a time
4. **Realistic data** - Use production-like data structures
5. **Timeout protection** - Set reasonable timeout limits

### Threshold Selection

- **Tight thresholds (5-8%)**: For latency-critical paths (event decoding)
- **Moderate thresholds (10-15%)**: For general functions
- **Loose thresholds (20%+)**: For I/O-dependent operations

### Interpreting Results

```
Change Percent = ((New - Old) / Old) * 100

Negative = Improvement  ✓
Positive = Regression   ⚠️
Zero = No change        →
```

Example:
- Old mean: 1.00ms
- New mean: 1.12ms
- Change: +12%
- Status: Regression (if threshold is 10%)

## Troubleshooting

### "No previous baseline found"

On first run, benchmarks create a baseline. Run again to compare against it:

```bash
npm run bench:event-decoding  # Creates baseline
npm run bench:event-decoding  # Compares against baseline
```

### High standard deviation

- Increase warmup iterations
- Reduce background processes
- Check for GC pauses during test
- Consider higher iteration count

### Timeout exceeded

- Reduce iterations
- Increase `timeoutMs`
- Check for infinite loops or blocking I/O

### CI failures

Check the PR comment or artifact logs:

```bash
# Download artifact: benchmark-results-20.x
unzip benchmark-results-20.x
cat comparison.log
```

## Performance Targets

Recommended performance targets:

| Component | Operation | Target |
|-----------|-----------|--------|
| Event Decoding | SEP-41 transfer | < 0.5ms |
| Event Decoding | Complex event | < 1.0ms |
| Event Decoding | XDR parse | < 0.2ms |
| API Response | List (50 items) | < 100ms |
| API Response | Detail + relations | < 150ms |
| API Response | Pagination | < 200ms |
| RPC Calls | getEvents | < 5ms |
| RPC Calls | getTransaction | < 3ms |
| RPC Calls | Batch processing | < 20ms |

## Next Steps

To integrate benchmarks into your workflow:

1. Run full benchmark suite: `npm run bench`
2. Review results: `npm run bench:compare`
3. Commit baseline to repository if desired
4. Push to main branch - CI will automatically compare future PRs
5. Monitor PR comments for regressions

## References

- [Vitest Performance Guide](https://vitest.dev/guide/features.html)
- [Node.js perf_hooks API](https://nodejs.org/api/perf_hooks.html)
- [Statistical Analysis for Benchmarks](https://en.wikipedia.org/wiki/Benchmark_(computing))
