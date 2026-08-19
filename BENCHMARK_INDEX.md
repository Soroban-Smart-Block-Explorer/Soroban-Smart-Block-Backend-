# Performance Benchmark System - Complete Index

## 📋 Quick Navigation

### For First-Time Users
→ Start here: **[BENCHMARK_QUICK_START.md](BENCHMARK_QUICK_START.md)**
- One-minute setup guide
- Common commands
- Quick troubleshooting

### For Developers
→ Implementation guide: **[PERFORMANCE_BENCHMARKS_IMPLEMENTATION.md](PERFORMANCE_BENCHMARKS_IMPLEMENTATION.md)**
- What was built
- File-by-file breakdown
- Integration points
- Benefits overview

### For Complete Reference
→ Full documentation: **[BENCHMARKS.md](BENCHMARKS.md)**
- Architecture details
- All CLI commands
- Best practices
- Performance targets
- Detailed troubleshooting

### For Verification
→ Completion checklist: **[BENCHMARK_IMPLEMENTATION_CHECKLIST.md](BENCHMARK_IMPLEMENTATION_CHECKLIST.md)**
- What was implemented
- Verification results
- Success criteria

## 📂 File Structure

```
src/benchmarks/
├── types.ts                    # TypeScript interfaces
├── runner.ts                   # Benchmark executor
├── comparison.ts               # Storage & regression detection
├── cli.ts                      # Command-line tools
├── event-decoding.bench.ts    # Event decoding benchmarks
├── api-responses.bench.ts     # API endpoint benchmarks
└── rpc-calls.bench.ts         # RPC call benchmarks

.github/workflows/
└── benchmarks.yml             # GitHub Actions CI/CD

Documentation/
├── BENCHMARK_QUICK_START.md           # This file location equivalent
├── BENCHMARKS.md                      # Complete reference
├── PERFORMANCE_BENCHMARKS_IMPLEMENTATION.md
├── BENCHMARK_IMPLEMENTATION_CHECKLIST.md
└── BENCHMARK_INDEX.md                 # This file
```

## 🎯 What Gets Monitored

### 1. Event Decoding (3 benchmarks)
- **File**: `src/benchmarks/event-decoding.bench.ts`
- **Measures**: `src/indexer/decoder.ts:decodeEvent()`
- **Benchmarks**:
  - SEP-41 transfer decoding (~0.2ms)
  - Complex event decoding (~0.5ms)
  - XDR parsing overhead (~0.1ms)
- **Threshold**: 10% regression

### 2. API Responses (4 benchmarks)
- **File**: `src/benchmarks/api-responses.bench.ts`
- **Measures**: `src/api/{transactions,events,contracts}.ts`
- **Benchmarks**:
  - Transactions list endpoint (~50ms)
  - Events list endpoint (~50ms)
  - Contract detail endpoint (~75ms)
  - Pagination overhead (~100ms)
- **Threshold**: 15-20% regression

### 3. RPC Calls (5 benchmarks)
- **File**: `src/benchmarks/rpc-calls.bench.ts`
- **Measures**: `src/indexer/rpc.ts`
- **Benchmarks**:
  - getEvents overhead (~1ms)
  - getTransaction call (~0.5ms)
  - getLedger call (~0.5ms)
  - Batch processing (~10ms)
  - Retry logic (~0.5ms)
- **Threshold**: 10-15% regression

## 🚀 Quick Commands

| Command | Purpose |
|---------|---------|
| `npm run bench` | Run all benchmarks |
| `npm run bench:watch` | Watch mode (auto-rerun) |
| `npm run bench:compare` | Compare vs baseline |
| `npm run bench:report` | Generate markdown report |
| `npm run bench:event-decoding` | Event decoding suite only |
| `npm run bench:api-responses` | API responses suite only |
| `npm run bench:rpc-calls` | RPC calls suite only |

### Advanced CLI
```bash
ts-node src/benchmarks/cli.ts compare    # Full comparison
ts-node src/benchmarks/cli.ts report     # Generate report
ts-node src/benchmarks/cli.ts export <suite> <output>  # Export JSON
ts-node src/benchmarks/cli.ts list       # List benchmarks
ts-node src/benchmarks/cli.ts clean      # Cleanup old results
```

## 📊 Understanding the Output

When you run `npm run bench:compare`, you get:

```
## Summary
- Total benchmarks: 12
- Regressions detected: 1
- Improvements: 2

## ⚠️ Regressions Detected

### sep41-transfer-decode
- Threshold: 10%
- Change: +12.45%
- Previous mean: 0.234ms
- Current mean: 0.263ms
- P95: 0.356ms
```

**Green**: Within threshold ✓  
**Red**: Above threshold ✗ (blocks PR merge)

## 🔄 CI/CD Flow

1. **Push/PR created** → GitHub Actions triggered
2. **Benchmarks run** → 12 tests execute on Node 18.x and 20.x
3. **Results compared** → Against main branch baseline
4. **PR comment posted** → With regression details
5. **Artifacts saved** → For 30-day investigation window
6. **Decision made** → Merge (if pass) or fix (if fail)

## 💾 Result Storage

Stored in `.benchmarks/` (git-ignored):

```json
{
  "name": "event-decoding",
  "timestamp": "2026-07-28T10:54:17.018Z",
  "results": [
    {
      "name": "sep41-transfer-decode",
      "metrics": {
        "mean": 0.234,
        "median": 0.212,
        "stdDev": 0.045,
        "p95": 0.356,
        "p99": 0.401,
        "samples": 1000
      },
      "threshold": 10
    }
  ]
}
```

## 🛠️ Setup Steps

1. **First run**
   ```bash
   npm run bench
   ```
   Creates baseline in `.benchmarks/`

2. **Verify results**
   ```bash
   npm run bench:compare
   ```

3. **Monitor on CI**
   - Push to repository
   - GitHub Actions runs automatically
   - Check PR comments for results

## 🎓 Common Scenarios

### Scenario 1: First-Time Setup
```bash
npm run bench           # Create baseline
npm run bench:compare   # View results
```

### Scenario 2: Development Changes
```bash
npm run bench:watch    # Auto-run on changes
# Make code changes
# Benchmarks automatically run and show impact
```

### Scenario 3: PR Review
1. Create PR
2. GitHub Actions runs automatically
3. Check PR comments for regression alerts
4. If regressions detected, job fails

### Scenario 4: Production Deploy
1. All CI checks pass (including benchmarks)
2. No regressions detected
3. Safe to merge and deploy

## 📈 Performance Goals

| Component | Target | Threshold |
|-----------|--------|-----------|
| Event Decoding | <0.5ms | 10% |
| API Responses | <100ms | 15-20% |
| RPC Calls | <5ms | 10-15% |

Exceeding threshold = Merge blocked

## 🔍 Troubleshooting

**Q: No baseline found?**  
A: Normal on first run. Run benchmarks again to compare.

**Q: High variance in results?**  
A: Close background apps, increase warmup iterations, check system load.

**Q: Benchmarks too slow?**  
A: Reduce iterations in benchmark file or increase timeout.

**Q: View detailed analysis?**  
A: Check `.benchmarks/comparison-result.json`

See **BENCHMARKS.md** for complete troubleshooting guide.

## 📚 Reading Recommendations

By Use Case:

- **Just getting started**: BENCHMARK_QUICK_START.md
- **Need full reference**: BENCHMARKS.md
- **Understanding implementation**: PERFORMANCE_BENCHMARKS_IMPLEMENTATION.md
- **Verifying what was done**: BENCHMARK_IMPLEMENTATION_CHECKLIST.md
- **Needing specific answer**: Check this index

## 🎯 Success Criteria

- [x] 12 benchmarks covering critical paths
- [x] Automatic regression detection (>10%)
- [x] CI/CD integration with PR comments
- [x] Job fails on regression
- [x] Historical tracking for trends
- [x] Clear reporting and insights
- [x] Production ready

## 🔗 Related Documentation

In this repository:
- `.env.example` - Environment setup
- `docker-compose.yml` - Local environment
- `.github/workflows/ci.yml` - Main CI/CD workflow
- `README.md` - Project overview

## ⚡ Next Steps

1. Run: `npm run bench`
2. Review: `npm run bench:compare`
3. Push to repo
4. Monitor PR comments
5. Optimize if needed

## 📞 Support

For questions about:
- **Setup**: See BENCHMARK_QUICK_START.md
- **Usage**: See BENCHMARKS.md
- **Implementation**: See PERFORMANCE_BENCHMARKS_IMPLEMENTATION.md
- **Verification**: See BENCHMARK_IMPLEMENTATION_CHECKLIST.md

---

**System Status**: ✅ PRODUCTION READY  
**Last Updated**: 2026-07-28  
**Version**: 1.0  
