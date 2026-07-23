/**
 * Gas Analytics Engine — indexes multi-dimensional resource data from
 * Soroban transactions and runs anomaly detection / alert generation.
 */

import { prismaRead, prismaWrite } from '../db';

interface SorobanResources {
  instructions?: number;
  readBytes?: number;
  writeBytes?: number;
  readLedgerEntries?: number;
  writeLedgerEntries?: number;
}

export async function indexTransactionGasData(
  txHash: string,
  contractAddress: string,
  functionName: string,
  feeCharged: string,
  sorobanResources: SorobanResources | null,
  ledgerSequence: number,
  ledgerCloseTime: Date,
  failureFlag: boolean,
  errorCode?: string,
): Promise<void> {
  const cpu = sorobanResources?.instructions ?? 0;
  const memBytes = Math.round(cpu * 0.05);
  const readBytes = sorobanResources?.readBytes ?? 0;
  const writeBytes = sorobanResources?.writeBytes ?? 0;
  const readEntries = sorobanResources?.readLedgerEntries ?? 0;
  const writeEntries = sorobanResources?.writeLedgerEntries ?? 0;
  const totalEntries = readEntries + writeEntries;
  const txSizeBytes = feeCharged ? feeCharged.length * 2 : 0;

  const totalFeeNum = Number(feeCharged);
  const effectiveFeePerInstr = cpu > 0 ? String((totalFeeNum / cpu).toFixed(10)) : '0';

  await prismaWrite.gasAnalytics.upsert({
    where: { txHash },
    create: {
      txHash,
      contractAddress,
      functionName,
      cpuInstructions: cpu,
      memoryBytes: memBytes,
      ledgerReadBytes: readBytes,
      ledgerWriteBytes: writeBytes,
      ledgerEntryCount: totalEntries,
      contractEventsBytes: 0,
      returnValueBytes: 0,
      hostFunctionCalls: 1,
      contractCalls: 0,
      storageAccesses: totalEntries,
      txSizeBytes,
      totalFee: feeCharged,
      effectiveFeePerInstr,
      ledgerSequence,
      ledgerCloseTime,
      failureFlag,
      errorCode,
    },
    update: {
      failureFlag,
      errorCode,
    },
  });
}

export async function runGasAnomalyDetection(contractAddress: string): Promise<void> {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86400e3);

  const recent = await prismaRead.gasAnalytics.findMany({
    where: { contractAddress, ledgerCloseTime: { gte: sevenDaysAgo } },
    select: { totalFee: true, cpuInstructions: true, ledgerCloseTime: true, txHash: true },
    orderBy: { ledgerCloseTime: 'desc' },
  });

  if (recent.length < 10) return;

  const fees = recent.map((r) => Number(r.totalFee));
  const avg = fees.reduce((a, b) => a + b, 0) / fees.length;
  const variance = fees.reduce((s, f) => s + Math.pow(f - avg, 2), 0) / fees.length;
  const stdDev = Math.sqrt(variance);

  const latestFee = fees[0];
  const deviationPct = avg > 0 ? ((latestFee - avg) / avg) * 100 : 0;

  if (deviationPct > 50) {
    await prismaWrite.gasAlert.create({
      data: {
        contractAddress,
        alertType: 'cost_spike',
        severity: deviationPct > 100 ? 'critical' : 'high',
        metric: 'totalFee',
        currentValue: latestFee,
        baselineValue: avg,
        deviationPct,
        txHash: recent[0]?.txHash,
        message: `Fee spiked ${deviationPct.toFixed(1)}% above 7-day average (${avg.toFixed(0)} stroops avg, ${latestFee} latest)`,
        detectedAt: now,
      },
    });
  }

  if (stdDev > 0) {
    const zScore = Math.abs(latestFee - avg) / stdDev;
    if (zScore > 3) {
      await prismaWrite.gasAlert.create({
        data: {
          contractAddress,
          alertType: 'anomaly',
          severity: 'medium',
          metric: 'totalFee',
          currentValue: latestFee,
          baselineValue: avg,
          deviationPct,
          txHash: recent[0]?.txHash,
          message: `Fee anomaly detected (z-score ${zScore.toFixed(2)}): ${latestFee} vs avg ${avg.toFixed(0)}`,
          detectedAt: now,
        },
      });
    }
  }
}

export async function generateOptimizationSuggestions(contractAddress: string): Promise<void> {
  const rows = await prismaRead.gasAnalytics.findMany({
    where: { contractAddress },
    orderBy: { ledgerCloseTime: 'desc' },
    take: 500,
  });

  if (rows.length === 0) return;

  const byFn = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byFn.get(r.functionName) ?? [];
    list.push(r);
    byFn.set(r.functionName, list);
  }

  for (const [functionName, fnRows] of byFn.entries()) {
    const avgCpu = fnRows.reduce((s, r) => s + r.cpuInstructions, 0) / fnRows.length;
    const avgEvents = fnRows.reduce((s, r) => s + r.contractEventsBytes, 0) / fnRows.length;
    const avgReads = fnRows.reduce((s, r) => s + r.ledgerReadBytes, 0) / fnRows.length;
    const avgWrites = fnRows.reduce((s, r) => s + r.ledgerWriteBytes, 0) / fnRows.length;
    const avgFee = fnRows.reduce((s, r) => s + Number(r.totalFee), 0) / fnRows.length;

    const suggestions: Array<{
      suggestionType: string;
      title: string;
      description: string;
      effort: string;
      severity: string;
      savingsPct: number;
    }> = [];

    if (avgCpu > 10_000_000) {
      suggestions.push({
        suggestionType: 'cache_computation',
        title: 'Cache expensive computations',
        description:
          'CPU usage exceeds 10M instructions. Move repeated computations off-chain or cache results in contract storage.',
        effort: 'medium',
        severity: 'warning',
        savingsPct: 25,
      });
    }
    if (avgEvents > 200_000) {
      suggestions.push({
        suggestionType: 'reduce_events',
        title: 'Reduce event payload size',
        description:
          'Event bytes are high. Trim fields from event data and use indexed topics for searchable attributes.',
        effort: 'low',
        severity: 'warning',
        savingsPct: 15,
      });
    }
    if (avgReads > 500_000) {
      suggestions.push({
        suggestionType: 'batch_reads',
        title: 'Batch ledger reads',
        description:
          'Ledger read bytes are high. Group multiple key reads and use try_read to avoid unnecessary fetches.',
        effort: 'medium',
        severity: 'warning',
        savingsPct: 20,
      });
    }
    if (avgWrites > 200_000) {
      suggestions.push({
        suggestionType: 'reduce_writes',
        title: 'Reduce ledger write size',
        description:
          'Write bytes are high. Use compact data structures and batch writes into single ledger entries.',
        effort: 'high',
        severity: 'critical',
        savingsPct: 30,
      });
    }

    for (const s of suggestions) {
      const estimatedSavings = ((avgFee * s.savingsPct) / 100).toFixed(0);
      const existing = await prismaRead.gasOptimizationSuggestion.findFirst({
        where: { contractAddress, functionName, suggestionType: s.suggestionType },
        select: { id: true },
      });
      if (existing) {
        await prismaWrite.gasOptimizationSuggestion.update({
          where: { id: existing.id },
          data: { currentCost: avgFee.toFixed(0), estimatedSavings },
        });
      } else {
        await prismaWrite.gasOptimizationSuggestion.create({
          data: {
            contractAddress,
            functionName,
            suggestionType: s.suggestionType,
            title: s.title,
            description: s.description,
            currentCost: avgFee.toFixed(0),
            estimatedSavings,
            savingsPct: s.savingsPct,
            effort: s.effort,
            severity: s.severity,
          },
        });
      }
    }
  }
}
