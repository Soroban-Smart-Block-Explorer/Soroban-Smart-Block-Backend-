import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prismaRead, prismaWrite } from '../db';
import { z } from 'zod';

export const benchmarkRouter = Router();

const STROOPS_PER_XLM = 10_000_000n;

function stroopsToXlm(stroops: bigint): string {
  const whole = stroops / STROOPS_PER_XLM;
  const frac = stroops % STROOPS_PER_XLM;
  return `${whole}.${frac.toString().padStart(7, '0')} XLM`;
}

function extractCpu(resources: unknown): number {
  if (!resources || typeof resources !== 'object') return 0;
  const r = resources as Record<string, unknown>;
  return typeof r.cpuInstructions === 'number' ? r.cpuInstructions : 0;
}

function extractMem(resources: unknown): number {
  if (!resources || typeof resources !== 'object') return 0;
  const r = resources as Record<string, unknown>;
  return typeof r.memBytes === 'number' ? r.memBytes : 0;
}

function stdDev(values: number[], mean: number): number {
  if (values.length < 2) return 0;
  const squaredDiffs = values.map((v) => (v - mean) ** 2);
  return Math.sqrt(squaredDiffs.reduce((a, b) => a + b, 0) / (values.length - 1));
}

function tTestScore(
  meanA: number,
  meanB: number,
  stdA: number,
  stdB: number,
  nA: number,
  nB: number,
): number {
  const se = Math.sqrt(stdA ** 2 / nA + stdB ** 2 / nB);
  if (se === 0) return 0;
  return Math.abs(meanA - meanB) / se;
}

const OP_NAMES: Record<string, string> = {
  transfer: 'token_transfer',
  balance_of: 'token_balance_of',
  swap: 'swap',
  mint: 'mint',
  burn: 'burn',
  deposit: 'deposit',
  withdraw: 'withdraw',
  approve: 'approve',
};

function mapFunctionName(fn: string | null): string {
  if (!fn) return 'unknown';
  return OP_NAMES[fn.toLowerCase()] ?? fn.toLowerCase();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getContractMetrics(contractAddress: string) {
  const txs = await prismaRead.transaction.findMany({
    where: {
      contractAddress,
      status: 'success',
      sorobanResources: { not: Prisma.JsonNullValueFilter.JsonNull },
    },
    select: {
      functionName: true,
      feeCharged: true,
      sorobanResources: true,
      hash: true,
      ledgerCloseTime: true,
    },
    orderBy: { ledgerCloseTime: 'asc' },
  });

  const byFunction = new Map<
    string,
    {
      fees: bigint[];
      cpus: number[];
      mems: number[];
      samples: number;
      txs: Array<{ hash: string; fee: bigint; cpu: number; mem: number; ledgerCloseTime: Date }>;
    }
  >();

  for (const tx of txs) {
    const fn = tx.functionName ?? 'unknown';
    let entry = byFunction.get(fn);
    if (!entry) {
      entry = { fees: [], cpus: [], mems: [], samples: 0, txs: [] };
      byFunction.set(fn, entry);
    }
    entry.samples++;
    const fee = BigInt(tx.feeCharged ?? '0');
    const cpu = extractCpu(tx.sorobanResources);
    const mem = extractMem(tx.sorobanResources);
    entry.fees.push(fee);
    entry.cpus.push(cpu);
    entry.mems.push(mem);
    entry.txs.push({ hash: tx.hash, fee, cpu, mem, ledgerCloseTime: tx.ledgerCloseTime });
  }

  const result: Array<{
    functionName: string;
    avgCpu: number;
    avgMemory: number;
    avgFeeStroops: bigint;
    minFeeStroops: bigint;
    maxFeeStroops: bigint;
    minCpu: number;
    maxCpu: number;
    samples: number;
    fees: bigint[];
    cpus: number[];
    mems: number[];
    txs: Array<{ hash: string; fee: bigint; cpu: number; mem: number; ledgerCloseTime: Date }>;
  }> = [];

  for (const [fn, entry] of byFunction) {
    const fees = entry.fees;
    const cpus = entry.cpus;
    const mems = entry.mems;
    const avgFee = fees.reduce((a, b) => a + b, 0n) / BigInt(fees.length || 1);
    const avgCpu = Math.round(cpus.reduce((a, b) => a + b, 0) / (cpus.length || 1));
    const avgMem = Math.round(mems.reduce((a, b) => a + b, 0) / (mems.length || 1));

    result.push({
      functionName: fn,
      avgCpu,
      avgMemory: avgMem,
      avgFeeStroops: avgFee,
      minFeeStroops: fees.reduce((a, b) => (b < a ? b : a), fees[0] ?? 0n),
      maxFeeStroops: fees.reduce((a, b) => (b > a ? b : a), 0n),
      minCpu: Math.min(...cpus),
      maxCpu: Math.max(...cpus),
      samples: entry.samples,
      fees,
      cpus,
      mems,
      txs: entry.txs,
    });
  }

  return result;
}

// ── GET /api/v1/benchmarks/operations ──────────────────────────────────────────

benchmarkRouter.get('/operations', async (_req: Request, res: Response) => {
  try {
    const ops = await prismaRead.operationBenchmark.findMany({
      orderBy: { name: 'asc' },
    });

    const operations = ops.map((op) => ({
      name: op.name,
      avgCpu: op.avgCpu,
      avgMemory: op.avgMemory,
      avgFee: stroopsToXlm(op.avgFeeStroops),
      samples: op.samples,
      lastUpdated: op.lastUpdated,
    }));

    res.json({ operations });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /api/v1/benchmarks/compare?contractA=C1&contractB=C2 ──────────────────

const compareSchema = z.object({
  contractA: z.string().min(1),
  contractB: z.string().min(1),
});

benchmarkRouter.get('/compare', async (req: Request, res: Response) => {
  try {
    const { contractA, contractB } = compareSchema.parse(req.query);

    const [metricsA, metricsB] = await Promise.all([
      getContractMetrics(contractA),
      getContractMetrics(contractB),
    ]);

    if (metricsA.length === 0 && metricsB.length === 0) {
      return res.json({ contractA, contractB, comparison: [] });
    }

    const allFunctions = new Set<string>();
    for (const m of metricsA) allFunctions.add(m.functionName);
    for (const m of metricsB) allFunctions.add(m.functionName);

    const comparison: Array<{
      functionName: string;
      contractA: { avgCpu: number; avgMemory: number; avgFee: string; samples: number } | null;
      contractB: { avgCpu: number; avgMemory: number; avgFee: string; samples: number } | null;
      moreEfficient: string | null;
      tStatistic: number;
      significant: boolean;
    }> = [];

    for (const fn of allFunctions) {
      const a = metricsA.find((m) => m.functionName === fn) ?? null;
      const b = metricsB.find((m) => m.functionName === fn) ?? null;

      let moreEfficient: string | null = null;
      let tStatistic = 0;
      let significant = false;

      if (a && b) {
        const aAvg = Number(a.avgFeeStroops);
        const bAvg = Number(b.avgFeeStroops);
        if (aAvg < bAvg) moreEfficient = contractA;
        else if (bAvg < aAvg) moreEfficient = contractB;

        const aFeesNum = a.fees.map((f) => Number(f));
        const bFeesNum = b.fees.map((f) => Number(f));
        const aMean = aFeesNum.reduce((s, v) => s + v, 0) / aFeesNum.length;
        const bMean = bFeesNum.reduce((s, v) => s + v, 0) / bFeesNum.length;
        const aStd = stdDev(aFeesNum, aMean);
        const bStd = stdDev(bFeesNum, bMean);
        tStatistic = tTestScore(aMean, bMean, aStd, bStd, aFeesNum.length, bFeesNum.length);
        significant = tStatistic > 1.96;
      }

      comparison.push({
        functionName: fn,
        contractA: a
          ? {
              avgCpu: a.avgCpu,
              avgMemory: a.avgMemory,
              avgFee: stroopsToXlm(a.avgFeeStroops),
              samples: a.samples,
            }
          : null,
        contractB: b
          ? {
              avgCpu: b.avgCpu,
              avgMemory: b.avgMemory,
              avgFee: stroopsToXlm(b.avgFeeStroops),
              samples: b.samples,
            }
          : null,
        moreEfficient,
        tStatistic: Math.round(tStatistic * 100) / 100,
        significant,
      });
    }

    res.json({ contractA, contractB, comparison });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ── GET /api/v1/benchmarks/contracts/:address/trends?days=30 ──────────────────

const trendsSchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

benchmarkRouter.get('/contracts/:address/trends', async (req: Request, res: Response) => {
  try {
    const { days } = trendsSchema.parse(req.query);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const snapshots = await prismaRead.contractBenchmarkSnapshot.findMany({
      where: {
        contractAddress: req.params.address,
        createdAt: { gte: since },
      },
      orderBy: { createdAt: 'asc' },
    });

    const trends: Array<{
      functionName: string;
      dataPoints: Array<{
        ledgerSequence: number;
        avgCpu: number;
        avgMemory: number;
        avgFee: string;
        samples: number;
        timestamp: string;
      }>;
      regression: boolean;
      regressionPct: number | null;
    }> = [];

    const byFunction = new Map<string, typeof snapshots>();
    for (const s of snapshots) {
      const arr = byFunction.get(s.functionName) ?? [];
      arr.push(s);
      byFunction.set(s.functionName, arr);
    }

    for (const [fn, pts] of byFunction) {
      if (pts.length < 2) {
        trends.push({
          functionName: fn,
          dataPoints: pts.map((p) => ({
            ledgerSequence: p.ledgerSequence,
            avgCpu: p.avgCpu,
            avgMemory: p.avgMemory,
            avgFee: stroopsToXlm(p.avgFeeStroops),
            samples: p.samples,
            timestamp: p.createdAt.toISOString(),
          })),
          regression: false,
          regressionPct: null,
        });
        continue;
      }

      const half = Math.floor(pts.length / 2);
      const recent = pts.slice(half);
      const older = pts.slice(0, half);

      const recentAvg = recent.reduce((s, p) => s + Number(p.avgFeeStroops), 0) / recent.length;
      const olderAvg = older.reduce((s, p) => s + Number(p.avgFeeStroops), 0) / older.length;
      const regressionPct = olderAvg > 0 ? ((recentAvg - olderAvg) / olderAvg) * 100 : 0;
      const regression = regressionPct > 20;

      trends.push({
        functionName: fn,
        dataPoints: pts.map((p) => ({
          ledgerSequence: p.ledgerSequence,
          avgCpu: p.avgCpu,
          avgMemory: p.avgMemory,
          avgFee: stroopsToXlm(p.avgFeeStroops),
          samples: p.samples,
          timestamp: p.createdAt.toISOString(),
        })),
        regression,
        regressionPct: Math.round(regressionPct * 100) / 100,
      });
    }

    const alerts: string[] = [];
    for (const t of trends) {
      if (t.regression && t.regressionPct !== null) {
        alerts.push(
          `Function "${t.functionName}" cost increased by ${t.regressionPct.toFixed(1)}% — possible regression`,
        );
      }
    }

    res.json({
      contractAddress: req.params.address,
      days,
      trends,
      alerts,
    });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ── GET /api/v1/benchmarks/contracts/:address/optimizations ───────────────────

benchmarkRouter.get('/contracts/:address/optimizations', async (req: Request, res: Response) => {
  try {
    const metrics = await getContractMetrics(req.params.address);

    if (metrics.length === 0) {
      return res.json({ contractAddress: req.params.address, optimizations: [] });
    }

    const optimizations: Array<{
      functionName: string;
      avgFee: string;
      cheapestFee: string;
      cheapestTx: string | null;
      savingsPct: number;
      tips: string[];
    }> = [];

    for (const m of metrics) {
      const minFeeNum = Math.min(...m.fees.map((f) => Number(f)));
      const avgFeeNum = Number(m.avgFeeStroops);
      const cheapestTx = m.txs.find((t) => Number(t.fee) === minFeeNum)?.hash ?? null;
      const savingsPct = avgFeeNum > 0 ? ((avgFeeNum - minFeeNum) / avgFeeNum) * 100 : 0;

      const tip = await prismaRead.gasGolfingTip.findUnique({
        where: { functionName: m.functionName },
      });

      optimizations.push({
        functionName: m.functionName,
        avgFee: stroopsToXlm(m.avgFeeStroops),
        cheapestFee: stroopsToXlm(BigInt(minFeeNum)),
        cheapestTx,
        savingsPct: Math.round(savingsPct * 100) / 100,
        tips: (tip?.tips as string[]) ?? [
          'Review storage access patterns',
          'Minimize event data emissions',
        ],
      });
    }

    res.json({ contractAddress: req.params.address, optimizations });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ── GET /api/v1/benchmarks/leaderboard ────────────────────────────────────────

benchmarkRouter.get('/leaderboard', async (_req: Request, res: Response) => {
  try {
    const txs = await prismaRead.transaction.findMany({
      where: {
        status: 'success',
        contractAddress: { not: null },
        sorobanResources: { not: Prisma.JsonNullValueFilter.JsonNull },
      },
      select: {
        contractAddress: true,
        functionName: true,
        feeCharged: true,
        sorobanResources: true,
      },
    });

    const contractAgg = new Map<
      string,
      {
        fees: bigint[];
        cpus: number[];
        mems: number[];
        byFunction: Map<string, { fees: bigint[]; cpus: number[] }>;
      }
    >();

    for (const tx of txs) {
      const addr = tx.contractAddress!;
      let entry = contractAgg.get(addr);
      if (!entry) {
        entry = { fees: [], cpus: [], mems: [], byFunction: new Map() };
        contractAgg.set(addr, entry);
      }
      entry.fees.push(BigInt(tx.feeCharged ?? '0'));
      entry.cpus.push(extractCpu(tx.sorobanResources));
      entry.mems.push(extractMem(tx.sorobanResources));

      const fn = tx.functionName ?? 'unknown';
      let fnEntry = entry.byFunction.get(fn);
      if (!fnEntry) {
        fnEntry = { fees: [], cpus: [] };
        entry.byFunction.set(fn, fnEntry);
      }
      fnEntry.fees.push(BigInt(tx.feeCharged ?? '0'));
      fnEntry.cpus.push(extractCpu(tx.sorobanResources));
    }

    const contracts = await prismaRead.contract.findMany({
      where: { address: { in: Array.from(contractAgg.keys()) } },
      select: { address: true, name: true },
    });
    const nameMap = new Map(contracts.map((c) => [c.address, c.name]));

    const efficiencyScores: Array<{
      contract: string;
      name: string | null;
      avgFee: string;
      efficiencyScore: number;
    }> = [];

    const byFunctionScores: Array<{
      contract: string;
      function: string;
      avgCpu: number;
      rank: number;
    }> = [];

    const allFnGroups = new Map<string, Array<{ addr: string; avgCpu: number }>>();

    for (const [addr, entry] of contractAgg) {
      const avgFeeNum =
        entry.fees.length > 0
          ? Number(entry.fees.reduce((a, b) => a + b, 0n) / BigInt(entry.fees.length))
          : 0;

      // Normalize: lower fee/cpu = higher score (0-100)
      efficiencyScores.push({
        contract: addr,
        name: nameMap.get(addr) ?? null,
        avgFee: stroopsToXlm(BigInt(avgFeeNum)),
        efficiencyScore: Math.max(0, Math.min(100, 100 - Math.round(avgFeeNum / 10000))),
      });

      for (const [fn, fnEntry] of entry.byFunction) {
        let fnGroup = allFnGroups.get(fn);
        if (!fnGroup) {
          fnGroup = [];
          allFnGroups.set(fn, fnGroup);
        }
        const avgFnCpu =
          fnEntry.cpus.length > 0
            ? Math.round(fnEntry.cpus.reduce((a, b) => a + b, 0) / fnEntry.cpus.length)
            : 0;
        fnGroup.push({ addr, avgCpu: avgFnCpu });
      }
    }

    efficiencyScores.sort((a, b) => b.efficiencyScore - a.efficiencyScore);

    for (const [fn, entries] of allFnGroups) {
      entries.sort((a, b) => a.avgCpu - b.avgCpu);
      entries.forEach((e, i) => {
        byFunctionScores.push({
          contract: e.addr,
          function: fn,
          avgCpu: e.avgCpu,
          rank: i + 1,
        });
      });
    }

    res.json({
      byEfficiency: efficiencyScores.slice(0, 50),
      byFunction: byFunctionScores.slice(0, 100),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /api/v1/benchmarks/leaderboard/gas-wasters ───────────────────────────

benchmarkRouter.get('/leaderboard/gas-wasters', async (_req: Request, res: Response) => {
  try {
    const txs = await prismaRead.transaction.findMany({
      where: {
        status: 'success',
        contractAddress: { not: null },
        sorobanResources: { not: Prisma.JsonNullValueFilter.JsonNull },
      },
      select: {
        contractAddress: true,
        feeCharged: true,
        sorobanResources: true,
      },
    });

    const contractAgg = new Map<string, { fees: bigint[]; cpus: number[]; mems: number[] }>();

    for (const tx of txs) {
      const addr = tx.contractAddress!;
      let entry = contractAgg.get(addr);
      if (!entry) {
        entry = { fees: [], cpus: [], mems: [] };
        contractAgg.set(addr, entry);
      }
      entry.fees.push(BigInt(tx.feeCharged ?? '0'));
      entry.cpus.push(extractCpu(tx.sorobanResources));
      entry.mems.push(extractMem(tx.sorobanResources));
    }

    const contracts = await prismaRead.contract.findMany({
      where: { address: { in: Array.from(contractAgg.keys()) } },
      select: { address: true, name: true },
    });
    const nameMap = new Map(contracts.map((c) => [c.address, c.name]));

    const wasters: Array<{
      contract: string;
      name: string | null;
      avgFee: string;
      avgFeeStroops: number;
      avgCpu: number;
      avgMemory: number;
      samples: number;
    }> = [];

    for (const [addr, entry] of contractAgg) {
      const avgFeeNum =
        entry.fees.length > 0
          ? Number(entry.fees.reduce((a, b) => a + b, 0n) / BigInt(entry.fees.length))
          : 0;
      wasters.push({
        contract: addr,
        name: nameMap.get(addr) ?? null,
        avgFee: stroopsToXlm(BigInt(Math.round(avgFeeNum))),
        avgFeeStroops: Math.round(avgFeeNum),
        avgCpu: Math.round(entry.cpus.reduce((a, b) => a + b, 0) / (entry.cpus.length || 1)),
        avgMemory: Math.round(entry.mems.reduce((a, b) => a + b, 0) / (entry.mems.length || 1)),
        samples: entry.fees.length,
      });
    }

    wasters.sort((a, b) => b.avgFeeStroops - a.avgFeeStroops);

    const result = wasters.slice(0, 50).map(({ avgFeeStroops: _, ...rest }) => rest);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /api/v1/benchmarks/compliance/:address ───────────────────────────────

benchmarkRouter.get('/compliance/:address', async (req: Request, res: Response) => {
  try {
    const contract = await prismaRead.contract.findUnique({
      where: { address: req.params.address },
      select: { address: true, isToken: true },
    });

    if (!contract) {
      return res.status(404).json({ error: 'Contract not found' });
    }

    const contractType = contract.isToken ? 'sep-41' : 'dex';

    const thresholds = await prismaRead.standardCompliance.findMany({
      where: { contractType },
    });

    const metrics = await getContractMetrics(req.params.address);

    const checks: Array<{
      functionName: string;
      avgFee: string;
      thresholdFee: string;
      compliant: boolean;
      label: string;
    }> = [];

    for (const m of metrics) {
      const threshold = thresholds.find((t) => t.functionName === m.functionName);

      if (threshold) {
        const avgFeeNum = Number(m.avgFeeStroops);
        const maxFeeNum = Number(threshold.maxFeeStroops);
        const compliant = avgFeeNum <= maxFeeNum;
        const pctOfLimit = maxFeeNum > 0 ? Math.round((avgFeeNum / maxFeeNum) * 100) : 0;

        let label: string;
        if (compliant) {
          if (pctOfLimit < 50) {
            label = `${contractType === 'sep-41' ? 'SEP-41' : 'DEX'} ${m.functionName} should cost < ${stroopsToXlm(threshold.maxFeeStroops)}. This contract: ${stroopsToXlm(m.avgFeeStroops)} — efficient`;
          } else {
            label = `${contractType === 'sep-41' ? 'SEP-41' : 'DEX'} ${m.functionName} should cost < ${stroopsToXlm(threshold.maxFeeStroops)}. This contract: ${stroopsToXlm(m.avgFeeStroops)} — within range`;
          }
        } else {
          label = `${contractType === 'sep-41' ? 'SEP-41' : 'DEX'} ${m.functionName} should cost < ${stroopsToXlm(threshold.maxFeeStroops)}. This contract: ${stroopsToXlm(m.avgFeeStroops)} — potential inefficiency`;
        }

        checks.push({
          functionName: m.functionName,
          avgFee: stroopsToXlm(m.avgFeeStroops),
          thresholdFee: stroopsToXlm(threshold.maxFeeStroops),
          compliant,
          label,
        });
      }
    }

    res.json({
      contractAddress: req.params.address,
      contractType,
      checks,
    });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});
