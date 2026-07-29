# Performance Benchmarks - Quick Start Guide

## One-Minute Setup

```bash
# Install (done automatically via npm install)
# Already in package.json dependencies

# Run benchmarks
npm run bench

# This creates a baseline in .benchmarks/ directory
```

## Common Commands

### Run All Benchmarks
```bash
npm run bench
```

### Run Specific Suite
```bash
npm run bench:event-decoding    # Event decoding tests
npm run bench:api-responses     # API endpoint tests
npm run bench:rpc-calls         # RPC call tests
```

### Compare Against Baseline
```bash
npm run bench:compare
```
Shows which benchmarks improved or regressed.

### Generate Report
```bash
npm run bench:report event-decoding
```

### Watch Mode (during development)
```bash
npm run bench:watch
```

## What Gets Measured

| Suite | Benchmarks | Target | Threshold |
|-------|-----------|--------|-----------|
| Event Decoding | 3 | <1ms | 10% |
| API Responses | 4 | <200ms | 20% |
| RPC Calls | 5 | <20ms | 15% |

## Output Format

When you run `npm run bench:compare`, you get:

```
==================================================
EVENT-DECODING BENCHMARKS
==================================================

# Performance Benchmark Report

Generated: 2026-07-28T10:54:17.018Z

## Summary
- Total benchmarks: 3
- Regressions detected: 0
- Improvements: 1

## Detailed Results

### sep41-transfer-decode
| Metric | Value |
|--------|-------|
| Mean | 0.234ms |
| Median | 0.212ms |
| StdDev | 0.045ms |
| P95 | 0.356ms |
| P99 | 0.401ms |
| Samples | 1000 |
```

## File Storage

Results saved to `.benchmarks/` (git-ignored):

```
.benchmarks/
├── event-decoding-2026-07-28.json
├── event-decoding-2026-07-27.json
├── api-responses-2026-07-28.json
├── rpc-calls-2026-07-28.json
└── comparison-result.json
```

## CI/CD Behavior

When you push a PR:

1. ✅ GitHub Actions runs benchmarks automatically
2. ✅ Compares against main branch baseline
3. ✅ Comments on PR if regressions found
4. ⛔ Blocks merge if >10% regression detected
5. 📦 Uploads results as artifacts

Example PR comment:

```
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

## Troubleshooting

### "No previous baseline found"
Normal on first run. Run again to compare:
```bash
npm run bench:event-decoding  # Create baseline
npm run bench:event-decoding  # Compare against it
```

### High standard deviation
- Increase warmup iterations in benchmark config
- Close background applications
- Check system load

### Benchmarks too slow
- Reduce iterations in the benchmark file
- Increase timeout value
- Run on a quieter system

### View detailed logs
```bash
# Download artifact from failed GitHub Actions run
# Check .benchmarks/ directory for comparison-result.json
cat .benchmarks/comparison-result.json | jq .
```

## Adding a New Benchmark

1. Create new file: `src/benchmarks/my-feature.bench.ts`
2. Follow pattern from existing benchmarks
3. Add npm script in `package.json`:
   ```json
   "bench:my-feature": "vitest run src/benchmarks/my-feature.bench.ts"
   ```
4. Run it: `npm run bench:my-feature`

Template:
```typescript
import { describe, it } from 'vitest';
import { BenchmarkRunner } from './runner';
import { BenchmarkStore } from './comparison';

describe('My Feature Benchmarks', () => {
  const runner = new BenchmarkRunner({
    name: 'my-benchmark',
    iterations: 100,
    warmupIterations: 10,
  });

  it('should benchmark my function', async () => {
    const measurements = await runner.runSync(() => {
      myFunction();
    });

    const metrics = BenchmarkRunner.calculateStats(measurements);
    console.log(`Mean: ${metrics.mean}ms, P95: ${metrics.p95}ms`);
  });
});
```

## Performance Targets

Keep these in mind when optimizing:

- **Event decoding**: Aim for <0.5ms (currently ~0.2ms)
- **API endpoints**: Aim for <100ms response (currently ~50ms)
- **RPC calls**: Aim for <5ms overhead (currently ~1-2ms)

## Key Metrics Explained

| Metric | Meaning |
|--------|---------|
| Mean | Average execution time |
| Median | Middle value (less affected by outliers) |
| StdDev | Consistency (lower is better) |
| P95/P99 | Tail latency (how long slow cases take) |
| Min/Max | Extreme values |

## For CI/CD Maintainers

The GitHub Actions workflow automatically:
- ✅ Runs on Node 18 and 20
- ✅ Saves results to `.benchmarks/`
- ✅ Comments on PRs with regression info
- ✅ Fails job if threshold exceeded
- ✅ Uploads artifacts for 30 days

No manual intervention needed!

## Links

- **Full Guide**: See `BENCHMARKS.md`
- **Implementation Details**: See `PERFORMANCE_BENCHMARKS_IMPLEMENTATION.md`
- **Verification Checklist**: See `BENCHMARK_IMPLEMENTATION_CHECKLIST.md`

## Support

For issues:
1. Check `BENCHMARKS.md` troubleshooting section
2. Review GitHub Actions logs
3. Inspect `.benchmarks/` JSON files
4. Run `npm run bench:compare` locally
