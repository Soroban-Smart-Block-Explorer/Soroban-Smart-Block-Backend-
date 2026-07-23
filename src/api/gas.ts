/**
 * GET  /api/v1/gas/contract/:address              — full gas profile for a contract
 * GET  /api/v1/gas/contract/:address/function/:fn — per-function deep dive
 * GET  /api/v1/gas/contract/:address/history      — time-series breakdown
 * GET  /api/v1/gas/contract/:address/efficiency   — efficiency score 0-100
 * GET  /api/v1/gas/leaderboard                    — ranked contracts/functions
 * GET  /api/v1/gas/network                        — network-wide gas stats
 * POST /api/v1/gas/benchmark                      — record a gas benchmark
 * GET  /api/v1/gas/benchmark/:contract/:fn        — benchmark history
 * GET  /api/v1/gas/alerts                         — list gas alerts
 * POST /api/v1/gas/alerts                         — create alert rule
 * GET  /api/v1/gas/visualizations/contract/:addr  — chart data
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prismaRead, prismaWrite } from '../db';
import { asyncHandler } from '../middleware/asyncHandler';

export const gasRouter = Router();

// ── Helpers ──────────────────────────────────────────────────────────────────

function feeToXlm(fee: string): string {
  const stroops = Number(fee);
  return isNaN(stroops) ? fee : `${(stroops / 1e7).toFixed(7)} XLM`;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function efficiencyScore(avgFee: number, benchmarkFee: number, failureRate: number): number {
  const costScore = benchmarkFee > 0 ? Math.min(100, (benchmarkFee / avgFee) * 60) : 60;
  const reliabilityScore = Math.max(0, 40 - failureRate * 4);
  return Math.round(costScore + reliabilityScore);
}

function buildOptimizationSuggestions(
  contractAddress: string,
  functionName: string,
  avg: {
    cpu: number;
    memory: number;
    reads: number;
    writes: number;
    events: number;
    returns: number;
    calls: number;
  },
) {
  const suggestions = [];

  if (avg.cpu > 10_000_000) {
    suggestions.push({
      suggestionType: 'cache_computation',
      title: 'Cache expensive computations',
      description:
        'CPU usage is very high. Cache repeated computations or pre-compute values off-chain and pass as arguments.',
      effort: 'medium',
      severity: 'warning',
    });
  }
  if (avg.events > 200_000) {
    suggestions.push({
      suggestionType: 'reduce_events',
      title: 'Reduce event data size',
      description:
        'Contract events are large. Use indexed topics instead of large data blobs and trim payload fields.',
      effort: 'low',
      severity: 'warning',
    });
  }
  if (avg.reads > 500_000) {
    suggestions.push({
      suggestionType: 'batch_reads',
      title: 'Batch ledger reads',
      description:
        'High ledger read bytes detected. Use try_read patterns and batch multiple keys into a single data structure.',
      effort: 'medium',
      severity: 'warning',
    });
  }
  if (avg.writes > 200_000) {
    suggestions.push({
      suggestionType: 'reduce_writes',
      title: 'Reduce ledger writes',
      description:
        'Ledger write bytes are high. Prefer append-only patterns and batch writes where possible.',
      effort: 'high',
      severity: 'critical',
    });
  }
  if (avg.returns > 50_000) {
    suggestions.push({
      suggestionType: 'paginate_returns',
      title: 'Paginate large return values',
      description:
        'Return value size is large. Split into paginated responses to reduce per-call cost.',
      effort: 'medium',
      severity: 'info',
    });
  }
  if (avg.calls > 5) {
    suggestions.push({
      suggestionType: 'optimize_loops',
      title: 'Reduce cross-contract calls',
      description:
        'Many contract calls detected. Inline reusable logic or cache results from frequently called contracts.',
      effort: 'high',
      severity: 'warning',
    });
  }
  if (avg.memory > 500_000) {
    suggestions.push({
      suggestionType: 'reduce_writes',
      title: 'Reduce memory allocation',
      description:
        'Memory usage is high. Stack-allocate temporary values and reuse buffers instead of allocating per call.',
      effort: 'medium',
      severity: 'info',
    });
  }

  return suggestions.map((s) => ({
    ...s,
    contractAddress,
    functionName,
    currentCost: '(see contract profile)',
    estimatedSavings: '10-30%',
    savingsPct: 20,
  }));
}

// ── GET /gas/contract/:address ────────────────────────────────────────────────

gasRouter.get(
  '/contract/:address',
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    const schema = z.object({
      from: z.string().optional(),
      to: z.string().optional(),
    });
    const { from, to } = schema.parse(req.query);

    const where = {
      contractAddress: address,
      ...(from || to
        ? {
            ledgerCloseTime: {
              ...(from ? { gte: new Date(from) } : {}),
              ...(to ? { lte: new Date(to) } : {}),
            },
          }
        : {}),
    };

    const rows = await prismaRead.gasAnalytics.findMany({
      where,
      orderBy: { ledgerCloseTime: 'asc' },
    });

    if (rows.length === 0) {
      return res.json({ contract: address, totalTxs: 0, summary: null, byFunction: [] });
    }

    const fees = rows.map((r) => Number(r.totalFee)).sort((a, b) => a - b);
    const avgFee = fees.reduce((a, b) => a + b, 0) / fees.length;

    const summary = {
      avgFee: feeToXlm(String(avgFee)),
      medianFee: feeToXlm(String(median(fees))),
      p95Fee: feeToXlm(String(percentile(fees, 95))),
      p99Fee: feeToXlm(String(percentile(fees, 99))),
      avgCpu: Math.round(rows.reduce((s, r) => s + r.cpuInstructions, 0) / rows.length),
      avgMemory: Math.round(rows.reduce((s, r) => s + r.memoryBytes, 0) / rows.length),
      avgLedgerReads: Math.round(rows.reduce((s, r) => s + r.ledgerReadBytes, 0) / rows.length),
      avgLedgerWrites: Math.round(rows.reduce((s, r) => s + r.ledgerWriteBytes, 0) / rows.length),
    };

    const byFnMap = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = byFnMap.get(r.functionName) ?? [];
      list.push(r);
      byFnMap.set(r.functionName, list);
    }

    const byFunction = Array.from(byFnMap.entries()).map(([fn, fnRows]) => {
      const fnFees = fnRows.map((r) => Number(r.totalFee)).sort((a, b) => a - b);
      const failures = fnRows.filter((r) => r.failureFlag).length;
      const avgCpu = fnRows.reduce((s, r) => s + r.cpuInstructions, 0) / fnRows.length;
      const avgMem = fnRows.reduce((s, r) => s + r.memoryBytes, 0) / fnRows.length;
      const avgReads = fnRows.reduce((s, r) => s + r.ledgerReadBytes, 0) / fnRows.length;
      const avgWrites = fnRows.reduce((s, r) => s + r.ledgerWriteBytes, 0) / fnRows.length;
      const avgEvents = fnRows.reduce((s, r) => s + r.contractEventsBytes, 0) / fnRows.length;
      const avgReturns = fnRows.reduce((s, r) => s + r.returnValueBytes, 0) / fnRows.length;
      const avgCalls = fnRows.reduce((s, r) => s + r.contractCalls, 0) / fnRows.length;
      return {
        function: fn,
        callCount: fnRows.length,
        avgFee: feeToXlm(String(fnFees.reduce((a, b) => a + b, 0) / fnFees.length)),
        medianFee: feeToXlm(String(median(fnFees))),
        p95Fee: feeToXlm(String(percentile(fnFees, 95))),
        avgCpu: Math.round(avgCpu),
        avgMemory: Math.round(avgMem),
        failureRate: Number(((failures / fnRows.length) * 100).toFixed(2)),
        recommendations: buildOptimizationSuggestions(address, fn, {
          cpu: avgCpu,
          memory: avgMem,
          reads: avgReads,
          writes: avgWrites,
          events: avgEvents,
          returns: avgReturns,
          calls: avgCalls,
        }),
      };
    });

    const totalCpu = rows.reduce((s, r) => s + r.cpuInstructions, 0);
    const totalMem = rows.reduce((s, r) => s + r.memoryBytes, 0);
    const totalIO = rows.reduce((s, r) => s + r.ledgerReadBytes + r.ledgerWriteBytes, 0);
    const totalResourceCost = totalCpu + totalMem + totalIO;
    const frac = (n: number) => (totalResourceCost > 0 ? n / totalResourceCost : 0);

    const costBreakdown = {
      cpuCost: feeToXlm(String(avgFee * frac(totalCpu))),
      memoryCost: feeToXlm(String(avgFee * frac(totalMem))),
      ledgerIOCost: feeToXlm(String(avgFee * frac(totalIO))),
    };

    const now = Date.now();
    const rows7d = rows.filter((r) => r.ledgerCloseTime.getTime() >= now - 7 * 86400e3);
    const rows30d = rows.filter((r) => r.ledgerCloseTime.getTime() >= now - 30 * 86400e3);
    const rowsPrev7d = rows.filter(
      (r) =>
        r.ledgerCloseTime.getTime() >= now - 14 * 86400e3 &&
        r.ledgerCloseTime.getTime() < now - 7 * 86400e3,
    );
    const rowsPrev30d = rows.filter(
      (r) =>
        r.ledgerCloseTime.getTime() >= now - 60 * 86400e3 &&
        r.ledgerCloseTime.getTime() < now - 30 * 86400e3,
    );

    const avg7d =
      rows7d.length > 0 ? rows7d.reduce((s, r) => s + Number(r.totalFee), 0) / rows7d.length : 0;
    const avgPrev7d =
      rowsPrev7d.length > 0
        ? rowsPrev7d.reduce((s, r) => s + Number(r.totalFee), 0) / rowsPrev7d.length
        : 0;
    const avg30d =
      rows30d.length > 0 ? rows30d.reduce((s, r) => s + Number(r.totalFee), 0) / rows30d.length : 0;
    const avgPrev30d =
      rowsPrev30d.length > 0
        ? rowsPrev30d.reduce((s, r) => s + Number(r.totalFee), 0) / rowsPrev30d.length
        : 0;

    const trend = {
      '7dChange':
        avgPrev7d > 0 ? `${(((avg7d - avgPrev7d) / avgPrev7d) * 100).toFixed(1)}%` : 'N/A',
      '30dChange':
        avgPrev30d > 0 ? `${(((avg30d - avgPrev30d) / avgPrev30d) * 100).toFixed(1)}%` : 'N/A',
    };

    const failures = rows.filter((r) => r.failureFlag).length;
    const failureRate = (failures / rows.length) * 100;

    const benchmark = await prismaRead.gasBenchmark.findFirst({
      where: { contractAddress: address, source: 'historical_best' },
      orderBy: { recordedAt: 'desc' },
    });
    const benchmarkFee = benchmark ? Number(benchmark.totalFee) : avgFee * 0.7;

    const period: Record<string, string | undefined> = {};
    if (rows.length > 0) {
      period['from'] = rows[0].ledgerCloseTime.toISOString();
      period['to'] = rows[rows.length - 1].ledgerCloseTime.toISOString();
    }

    res.json({
      contract: address,
      totalTxs: rows.length,
      period,
      summary,
      byFunction,
      costBreakdown,
      trend,
      efficiencyScore: efficiencyScore(avgFee, benchmarkFee, failureRate),
    });
  }),
);

// ── GET /gas/contract/:address/function/:functionName ─────────────────────────

gasRouter.get(
  '/contract/:address/function/:functionName',
  asyncHandler(async (req: Request, res: Response) => {
    const { address, functionName } = req.params;

    const rows = await prismaRead.gasAnalytics.findMany({
      where: { contractAddress: address, functionName },
      orderBy: { ledgerCloseTime: 'desc' },
      take: 1000,
    });

    if (rows.length === 0) {
      return res.status(404).json({ error: 'No analytics data for this function' });
    }

    const fees = rows.map((r) => Number(r.totalFee)).sort((a, b) => a - b);
    const avgCpu = rows.reduce((s, r) => s + r.cpuInstructions, 0) / rows.length;
    const avgMem = rows.reduce((s, r) => s + r.memoryBytes, 0) / rows.length;
    const avgReads = rows.reduce((s, r) => s + r.ledgerReadBytes, 0) / rows.length;
    const avgWrites = rows.reduce((s, r) => s + r.ledgerWriteBytes, 0) / rows.length;
    const avgEvents = rows.reduce((s, r) => s + r.contractEventsBytes, 0) / rows.length;
    const avgReturns = rows.reduce((s, r) => s + r.returnValueBytes, 0) / rows.length;
    const avgCalls = rows.reduce((s, r) => s + r.contractCalls, 0) / rows.length;
    const failures = rows.filter((r) => r.failureFlag).length;

    const suggestions = buildOptimizationSuggestions(address, functionName, {
      cpu: avgCpu,
      memory: avgMem,
      reads: avgReads,
      writes: avgWrites,
      events: avgEvents,
      returns: avgReturns,
      calls: avgCalls,
    });

    res.json({
      contract: address,
      function: functionName,
      callCount: rows.length,
      fees: {
        avg: feeToXlm(String(fees.reduce((a, b) => a + b, 0) / fees.length)),
        median: feeToXlm(String(median(fees))),
        p95: feeToXlm(String(percentile(fees, 95))),
        p99: feeToXlm(String(percentile(fees, 99))),
        min: feeToXlm(String(fees[0])),
        max: feeToXlm(String(fees[fees.length - 1])),
      },
      resources: {
        avgCpuInstructions: Math.round(avgCpu),
        avgMemoryBytes: Math.round(avgMem),
        avgLedgerReadBytes: Math.round(avgReads),
        avgLedgerWriteBytes: Math.round(avgWrites),
        avgContractEventsBytes: Math.round(avgEvents),
        avgReturnValueBytes: Math.round(avgReturns),
        avgContractCalls: Math.round(avgCalls),
      },
      failureRate: Number(((failures / rows.length) * 100).toFixed(2)),
      recommendations: suggestions,
      recentTxs: rows.slice(0, 10).map((r) => ({
        txHash: r.txHash,
        fee: feeToXlm(r.totalFee),
        cpuInstructions: r.cpuInstructions,
        ledgerCloseTime: r.ledgerCloseTime,
        failed: r.failureFlag,
      })),
    });
  }),
);

// ── GET /gas/contract/:address/history ────────────────────────────────────────

gasRouter.get(
  '/contract/:address/history',
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    const schema = z.object({
      days: z.coerce.number().min(1).max(365).default(90),
      granularity: z.enum(['hour', 'day', 'week']).default('day'),
    });
    const { days, granularity } = schema.parse(req.query);
    const since = new Date(Date.now() - days * 86400e3);

    const rows = await prismaRead.gasAnalytics.findMany({
      where: { contractAddress: address, ledgerCloseTime: { gte: since } },
      orderBy: { ledgerCloseTime: 'asc' },
    });

    const granMs = granularity === 'hour' ? 3600e3 : granularity === 'day' ? 86400e3 : 604800e3;
    const buckets = new Map<number, typeof rows>();
    for (const r of rows) {
      const key = Math.floor(r.ledgerCloseTime.getTime() / granMs) * granMs;
      const b = buckets.get(key) ?? [];
      b.push(r);
      buckets.set(key, b);
    }

    const series = Array.from(buckets.entries())
      .sort(([a], [b]) => a - b)
      .map(([ts, bRows]) => {
        const bFees = bRows.map((r) => Number(r.totalFee)).sort((a, b) => a - b);
        return {
          timestamp: new Date(ts).toISOString(),
          avgFee: Number((bFees.reduce((a, b) => a + b, 0) / bFees.length).toFixed(0)),
          medianFee: Number(median(bFees).toFixed(0)),
          p95Fee: Number(percentile(bFees, 95).toFixed(0)),
          txCount: bRows.length,
          avgCpu: Math.round(bRows.reduce((s, r) => s + r.cpuInstructions, 0) / bRows.length),
        };
      });

    res.json({ contract: address, granularity, days, series });
  }),
);

// ── GET /gas/contract/:address/efficiency ─────────────────────────────────────

gasRouter.get(
  '/contract/:address/efficiency',
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;

    const rows = await prismaRead.gasAnalytics.findMany({
      where: { contractAddress: address },
      orderBy: { ledgerCloseTime: 'desc' },
      take: 500,
    });

    if (rows.length === 0) {
      return res.status(404).json({ error: 'No analytics data found' });
    }

    const avgFee = rows.reduce((s, r) => s + Number(r.totalFee), 0) / rows.length;
    const failures = rows.filter((r) => r.failureFlag).length;
    const failureRate = (failures / rows.length) * 100;

    const benchmark = await prismaRead.gasBenchmark.findFirst({
      where: { contractAddress: address, source: 'historical_best' },
      orderBy: { recordedAt: 'desc' },
    });
    const benchmarkFee = benchmark ? Number(benchmark.totalFee) : avgFee * 0.7;

    const score = efficiencyScore(avgFee, benchmarkFee, failureRate);

    const byFnMap = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = byFnMap.get(r.functionName) ?? [];
      list.push(r);
      byFnMap.set(r.functionName, list);
    }

    const byFunction = Array.from(byFnMap.entries()).map(([fn, fnRows]) => {
      const fnAvg = fnRows.reduce((s, r) => s + Number(r.totalFee), 0) / fnRows.length;
      const fnFails = fnRows.filter((r) => r.failureFlag).length;
      return {
        function: fn,
        efficiencyScore: efficiencyScore(fnAvg, benchmarkFee, (fnFails / fnRows.length) * 100),
        callCount: fnRows.length,
        avgFee: feeToXlm(String(fnAvg)),
      };
    });

    res.json({
      contract: address,
      efficiencyScore: score,
      breakdown: {
        costScore: Math.min(100, benchmarkFee > 0 ? (benchmarkFee / avgFee) * 60 : 60),
        reliabilityScore: Math.max(0, 40 - failureRate * 4),
        failureRate: Number(failureRate.toFixed(2)),
        avgFee: feeToXlm(String(avgFee)),
        benchmarkFee: feeToXlm(String(benchmarkFee)),
      },
      byFunction,
    });
  }),
);

// ── GET /gas/leaderboard ──────────────────────────────────────────────────────

gasRouter.get(
  '/leaderboard',
  asyncHandler(async (_req: Request, res: Response) => {
    const allRows = await prismaRead.gasAnalytics.findMany({
      select: { contractAddress: true, totalFee: true, failureFlag: true },
    });

    const contractMap = new Map<string, { fees: number[]; failures: number; count: number }>();
    for (const r of allRows) {
      const entry = contractMap.get(r.contractAddress) ?? { fees: [], failures: 0, count: 0 };
      entry.fees.push(Number(r.totalFee));
      if (r.failureFlag) entry.failures++;
      entry.count++;
      contractMap.set(r.contractAddress, entry);
    }

    const contracts = Array.from(contractMap.entries()).map(([addr, data]) => {
      const sorted = [...data.fees].sort((a, b) => a - b);
      const total = sorted.reduce((a, b) => a + b, 0);
      const avg = total / sorted.length;
      return { addr, total, avg, count: data.count, failures: data.failures, sorted };
    });

    const byTotalFee = [...contracts].sort((a, b) => b.total - a.total).slice(0, 20);
    const byAvgFee = [...contracts].sort((a, b) => b.avg - a.avg).slice(0, 20);

    res.json({
      mostExpensiveByTotalFee: byTotalFee.map((c) => ({
        contract: c.addr,
        totalFee: feeToXlm(String(c.total)),
        txCount: c.count,
        avgFee: feeToXlm(String(c.avg)),
      })),
      mostExpensiveByAvgFee: byAvgFee.map((c) => ({
        contract: c.addr,
        avgFee: feeToXlm(String(c.avg)),
        txCount: c.count,
      })),
    });
  }),
);

// ── GET /gas/network ──────────────────────────────────────────────────────────

gasRouter.get(
  '/network',
  asyncHandler(async (_req: Request, res: Response) => {
    const rows = await prismaRead.gasAnalytics.findMany({
      select: {
        contractAddress: true,
        totalFee: true,
        cpuInstructions: true,
        memoryBytes: true,
        ledgerReadBytes: true,
        ledgerWriteBytes: true,
      },
      orderBy: { ledgerCloseTime: 'desc' },
      take: 50000,
    });

    if (rows.length === 0) {
      return res.json({ totalTxs: 0 });
    }

    const fees = rows.map((r) => Number(r.totalFee)).sort((a, b) => a - b);
    const totalFees = fees.reduce((a, b) => a + b, 0);
    const avgFee = totalFees / fees.length;

    const ranges = [
      { label: '0-0.001 XLM', min: 0, max: 10000 },
      { label: '0.001-0.01 XLM', min: 10000, max: 100000 },
      { label: '0.01-0.1 XLM', min: 100000, max: 1000000 },
      { label: '>0.1 XLM', min: 1000000, max: Infinity },
    ];
    const feeDistribution = ranges.map((range) => {
      const count = fees.filter((f) => f >= range.min && f < range.max).length;
      return {
        range: range.label,
        txCount: count,
        pct: Number(((count / fees.length) * 100).toFixed(1)),
      };
    });

    const contractFees = new Map<string, number>();
    for (const r of rows) {
      contractFees.set(
        r.contractAddress,
        (contractFees.get(r.contractAddress) ?? 0) + Number(r.totalFee),
      );
    }
    const topConsumers = Array.from(contractFees.entries())
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([addr, total]) => ({
        contract: addr,
        totalFee: feeToXlm(String(total)),
        txCount: rows.filter((r) => r.contractAddress === addr).length,
      }));

    const maxCpu = Math.max(...rows.map((r) => r.cpuInstructions));
    const maxMem = Math.max(...rows.map((r) => r.memoryBytes));
    const maxIO = Math.max(...rows.map((r) => r.ledgerReadBytes + r.ledgerWriteBytes));

    res.json({
      networkAvgFee: feeToXlm(String(avgFee)),
      networkMedianFee: feeToXlm(String(median(fees))),
      totalFeesPaid: feeToXlm(String(totalFees)),
      totalTxs: rows.length,
      busiestContract: topConsumers[0]?.contract ?? null,
      feeDistribution,
      resourceUtilization: {
        avgCpuUtilization:
          maxCpu > 0
            ? Number(
                (rows.reduce((s, r) => s + r.cpuInstructions, 0) / rows.length / maxCpu).toFixed(3),
              )
            : 0,
        avgMemoryUtilization:
          maxMem > 0
            ? Number(
                (rows.reduce((s, r) => s + r.memoryBytes, 0) / rows.length / maxMem).toFixed(3),
              )
            : 0,
        avgLedgerIOLoad:
          maxIO > 0
            ? Number(
                (
                  rows.reduce((s, r) => s + r.ledgerReadBytes + r.ledgerWriteBytes, 0) /
                  rows.length /
                  maxIO
                ).toFixed(3),
              )
            : 0,
      },
      topConsumers,
    });
  }),
);

// ── POST /gas/benchmark ───────────────────────────────────────────────────────

const benchmarkSchema = z.object({
  contractAddress: z.string(),
  functionName: z.string(),
  arguments: z.record(z.unknown()).optional(),
  cpuInstructions: z.number().int().min(0).default(0),
  memoryBytes: z.number().int().min(0).default(0),
  ledgerReadBytes: z.number().int().min(0).default(0),
  ledgerWriteBytes: z.number().int().min(0).default(0),
  ledgerEntryCount: z.number().int().min(0).default(0),
  totalFee: z.string(),
  source: z.enum(['simulation', 'historical_best', 'historical_median']).default('simulation'),
});

gasRouter.post(
  '/benchmark',
  asyncHandler(async (req: Request, res: Response) => {
    const body = benchmarkSchema.parse(req.body);

    const record = await prismaWrite.gasBenchmark.create({
      data: {
        contractAddress: body.contractAddress,
        functionName: body.functionName,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        arguments: (body.arguments ?? {}) as any,
        cpuInstructions: body.cpuInstructions,
        memoryBytes: body.memoryBytes,
        ledgerReadBytes: body.ledgerReadBytes,
        ledgerWriteBytes: body.ledgerWriteBytes,
        ledgerEntryCount: body.ledgerEntryCount,
        totalFee: body.totalFee,
        recordedAt: new Date(),
        source: body.source,
      },
    });

    res.status(201).json(record);
  }),
);

// ── GET /gas/benchmark/:contract/:function ────────────────────────────────────

gasRouter.get(
  '/benchmark/:contract/:function',
  asyncHandler(async (req: Request, res: Response) => {
    const { contract, function: fn } = req.params;

    const benchmarks = await prismaRead.gasBenchmark.findMany({
      where: { contractAddress: contract, functionName: fn },
      orderBy: { recordedAt: 'desc' },
      take: 100,
    });

    const best = benchmarks.find((b) => b.source === 'historical_best');
    const historical = await prismaRead.gasAnalytics.findMany({
      where: { contractAddress: contract, functionName: fn },
      select: { totalFee: true },
      orderBy: { totalFee: 'asc' },
      take: 1,
    });

    res.json({
      contract,
      function: fn,
      benchmarks,
      cheapestHistorical: historical[0] ? { totalFee: feeToXlm(historical[0].totalFee) } : null,
      bestBenchmark: best
        ? {
            totalFee: feeToXlm(best.totalFee),
            cpuInstructions: best.cpuInstructions,
            memoryBytes: best.memoryBytes,
          }
        : null,
    });
  }),
);

// ── GET /gas/alerts ───────────────────────────────────────────────────────────

gasRouter.get(
  '/alerts',
  asyncHandler(async (req: Request, res: Response) => {
    const schema = z.object({
      contract: z.string().optional(),
      alertType: z.string().optional(),
      severity: z.string().optional(),
      limit: z.coerce.number().min(1).max(200).default(50),
    });
    const { contract, alertType, severity, limit } = schema.parse(req.query);

    const alerts = await prismaRead.gasAlert.findMany({
      where: {
        ...(contract ? { contractAddress: contract } : {}),
        ...(alertType ? { alertType } : {}),
        ...(severity ? { severity } : {}),
      },
      orderBy: { detectedAt: 'desc' },
      take: limit,
    });

    res.json({ alerts, count: alerts.length });
  }),
);

// ── POST /gas/alerts ──────────────────────────────────────────────────────────

const createAlertSchema = z.object({
  contractAddress: z.string(),
  alertType: z.enum(['cost_spike', 'anomaly', 'inefficiency', 'regression']),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  metric: z.string(),
  currentValue: z.number(),
  baselineValue: z.number(),
  deviationPct: z.number(),
  txHash: z.string().optional(),
  message: z.string(),
});

gasRouter.post(
  '/alerts',
  asyncHandler(async (req: Request, res: Response) => {
    const body = createAlertSchema.parse(req.body);

    const alert = await prismaWrite.gasAlert.create({
      data: { ...body, detectedAt: new Date() },
    });

    res.status(201).json(alert);
  }),
);

// ── GET /gas/visualizations/contract/:address ─────────────────────────────────

gasRouter.get(
  '/visualizations/contract/:address',
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;

    const rows = await prismaRead.gasAnalytics.findMany({
      where: { contractAddress: address },
      orderBy: { ledgerCloseTime: 'asc' },
      take: 1000,
    });

    if (rows.length === 0) {
      return res.status(404).json({ error: 'No data for this contract' });
    }

    const totalCpu = rows.reduce((s, r) => s + r.cpuInstructions, 0);
    const totalMem = rows.reduce((s, r) => s + r.memoryBytes, 0);
    const totalIO = rows.reduce((s, r) => s + r.ledgerReadBytes + r.ledgerWriteBytes, 0);
    const total = totalCpu + totalMem + totalIO;

    const costBreakdownPie = [
      { label: 'CPU', value: total > 0 ? Number(((totalCpu / total) * 100).toFixed(1)) : 0 },
      { label: 'Memory', value: total > 0 ? Number(((totalMem / total) * 100).toFixed(1)) : 0 },
      { label: 'Ledger I/O', value: total > 0 ? Number(((totalIO / total) * 100).toFixed(1)) : 0 },
    ];

    const dayBuckets = new Map<string, number[]>();
    for (const r of rows) {
      const key = r.ledgerCloseTime.toISOString().slice(0, 10);
      const b = dayBuckets.get(key) ?? [];
      b.push(Number(r.totalFee));
      dayBuckets.set(key, b);
    }
    const costOverTime = Array.from(dayBuckets.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, fees]) => ({
        date,
        avgFee: Math.round(fees.reduce((a, b) => a + b, 0) / fees.length),
        txCount: fees.length,
      }));

    const fnMap = new Map<string, number[]>();
    for (const r of rows) {
      const b = fnMap.get(r.functionName) ?? [];
      b.push(Number(r.totalFee));
      fnMap.set(r.functionName, b);
    }
    const functionComparison = Array.from(fnMap.entries()).map(([fn, fees]) => ({
      function: fn,
      avgFee: Math.round(fees.reduce((a, b) => a + b, 0) / fees.length),
      callCount: fees.length,
    }));

    const fees = rows.map((r) => Number(r.totalFee)).sort((a, b) => a - b);
    const histogramBuckets = 10;
    const min = fees[0];
    const max = fees[fees.length - 1];
    const step = (max - min) / histogramBuckets || 1;
    const histogram = Array.from({ length: histogramBuckets }, (_, i) => {
      const lo = min + i * step;
      const hi = lo + step;
      return {
        range: `${feeToXlm(String(lo))}-${feeToXlm(String(hi))}`,
        count: fees.filter((f) => f >= lo && f < hi).length,
      };
    });

    const avgFee = fees.reduce((a, b) => a + b, 0) / fees.length;
    const failures = rows.filter((r) => r.failureFlag).length;
    const failureRate = (failures / rows.length) * 100;
    const benchmark = await prismaRead.gasBenchmark.findFirst({
      where: { contractAddress: address, source: 'historical_best' },
    });
    const benchmarkFee = benchmark ? Number(benchmark.totalFee) : avgFee * 0.7;

    res.json({
      costBreakdownPie,
      costOverTime,
      functionComparison,
      feeDistributionHistogram: histogram,
      efficiencyGauge: efficiencyScore(avgFee, benchmarkFee, failureRate),
    });
  }),
);
