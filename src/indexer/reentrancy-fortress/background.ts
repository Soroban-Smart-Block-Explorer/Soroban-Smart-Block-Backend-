/**
 * Soroban Reentrancy Fortress — Background Analysis Engine
 *
 * Real-time analysis: process each new transaction as it's indexed.
 * Batch analysis: nightly re-analysis of all transactions in last 24h.
 * Historical backfill: analyze all historical transactions.
 * Incremental risk score updates.
 *
 * Performance target: ≥100 txs/second for call graph construction.
 * Issue #307
 */

import { prismaRead, prismaWrite } from '../../db';
import { buildCallGraph, type TraceCall } from './call-graph';
import { detectReentrancy } from './detector';
import { computeRiskScore } from './scoring';
import {
  type ReentrancySeverity,
  type RiskScore,
  type ReentrancyStatsSnapshot,
  type AnalysisConfig,
  type AnalysisResult,
} from './types';

// ── Default Config ────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: AnalysisConfig = {
  batchSize: 1000,
  batchIntervalMs: 60000, // 1 minute
  realtimeEnabled: true,
};

// ── Core Analysis Pipeline ────────────────────────────────────────────────────

/**
 * Analyze a single transaction: build call graph, detect reentrancy, compute score.
 */
export async function analyzeTransaction(
  txHash: string,
  calls: TraceCall[],
  valueAtRisk?: string,
  usdValueAtRisk?: number,
  timestamp: Date = new Date(),
): Promise<AnalysisResult> {
  // 1. Build call graph
  const graph = buildCallGraph(txHash, calls, timestamp);

  // 2. Detect reentrancy
  const findings = detectReentrancy(txHash, graph, valueAtRisk, usdValueAtRisk);

  // 3. Compute risk score for each involved contract
  const contractAddresses = new Set(graph.vertices.map((v) => v.contractAddress));

  let primaryRiskScore: RiskScore | undefined;
  for (const addr of contractAddresses) {
    const addrFindings = findings.filter((f) => f.contractAddress === addr);
    const maxDepth = graph.vertices
      .filter((v) => v.contractAddress === addr)
      .reduce((max, v) => Math.max(max, v.depth), 0);

    const score = computeRiskScore(addr, addrFindings, undefined, maxDepth);
    if (!primaryRiskScore) primaryRiskScore = score;
  }

  if (!primaryRiskScore) {
    primaryRiskScore = {
      contractAddress: graph.vertices[0]?.contractAddress ?? 'unknown',
      riskScore: 0,
      totalFindings: 0,
      criticalFindings: 0,
      highFindings: 0,
      mediumFindings: 0,
      riskFactors: {
        totalFindings: 0,
        criticalFindings: 0,
        highFindings: 0,
        mediumFindings: 0,
        simpleReentrancyCount: 0,
        crossContractCount: 0,
        multiStepCount: 0,
        readOnlyCount: 0,
        crossFunctionCount: 0,
        destructiveCount: 0,
        avgCycleLength: 0,
        maxCallDepth: 0,
        totalValueAtRiskUsd: 0,
        findingsInLast30Days: 0,
        confirmedAttackCount: 0,
      },
      lastAnalyzed: new Date(),
      severity: 'LOW' as ReentrancySeverity,
    };
  }

  return { graph, findings, riskScore: primaryRiskScore };
}

/**
 * Persist analysis results to the database.
 */
export async function persistAnalysis(
  result: AnalysisResult,
  txHash: string,
  timestamp: Date,
): Promise<void> {
  const { graph, findings, riskScore } = result;

  // Persist vertices
  for (const v of graph.vertices) {
    await prismaWrite.callGraphVertex.create({
      data: {
        txHash,
        contractAddress: v.contractAddress,
        functionName: v.functionName,
        depth: v.depth,
        callIndex: v.callIndex,
        value: v.value,
        preStateReads: v.preStateReads as object,
        postStateWrites: v.postStateWrites as object,
        timestamp,
      },
    });
  }

  // Persist edges
  for (const e of graph.edges) {
    await prismaWrite.callGraphEdge.create({
      data: {
        txHash,
        fromVertexId: e.fromVertexId,
        toVertexId: e.toVertexId,
        functionName: e.functionName,
        value: e.value,
        gasForwarded: e.gasForwarded,
        argsHash: e.argsHash,
        callIndex: e.callIndex,
        timestamp,
      },
    });
  }

  // Persist findings
  for (const f of findings) {
    await prismaWrite.reentrancyFinding.create({
      data: {
        txHash: f.txHash,
        contractAddress: f.contractAddress,
        reentrancyType: f.reentrancyType as any,
        severity: f.severity as any,
        likelihood: f.likelihood,
        loopPath: f.loopPath as object,
        entryPoint: f.entryPoint,
        valueAtRisk: f.valueAtRisk,
        usdValueAtRisk: f.usdValueAtRisk,
        profitPotential: f.profitPotential,
        description: f.description,
        detectedAt: f.detectedAt,
      },
    });
  }

  // Upsert contract risk score
  const previousScore = await prismaWrite.contractRiskScore.findUnique({
    where: { contractAddress: riskScore.contractAddress },
    select: { riskScore: true },
  });

  await prismaWrite.contractRiskScore.upsert({
    where: { contractAddress: riskScore.contractAddress },
    update: {
      riskScore: riskScore.riskScore,
      previousScore: previousScore?.riskScore ?? null,
      totalFindings: riskScore.totalFindings,
      criticalFindings: riskScore.criticalFindings,
      highFindings: riskScore.highFindings,
      mediumFindings: riskScore.mediumFindings,
      riskFactors: riskScore.riskFactors as object,
      lastAnalyzed: riskScore.lastAnalyzed,
    },
    create: {
      contractAddress: riskScore.contractAddress,
      riskScore: riskScore.riskScore,
      previousScore: null,
      totalFindings: riskScore.totalFindings,
      criticalFindings: riskScore.criticalFindings,
      highFindings: riskScore.highFindings,
      mediumFindings: riskScore.mediumFindings,
      riskFactors: riskScore.riskFactors as object,
      lastAnalyzed: riskScore.lastAnalyzed,
    },
  });
}

/**
 * Full analysis pipeline: analyze + persist.
 */
export async function analyzeAndPersist(
  txHash: string,
  calls: TraceCall[],
  valueAtRisk?: string,
  usdValueAtRisk?: number,
  timestamp: Date = new Date(),
): Promise<AnalysisResult> {
  const result = await analyzeTransaction(txHash, calls, valueAtRisk, usdValueAtRisk, timestamp);

  // Persist all findings to database
  try {
    await persistAnalysis(result, txHash, timestamp);
  } catch (err) {
    console.error(`[ReentrancyFortress] Failed to persist analysis for ${txHash}:`, err);
  }

  return result;
}

// ── Batch Analysis ────────────────────────────────────────────────────────────

/**
 * Run batch analysis on the most recent N transactions that haven't been analyzed.
 */
export async function runBatchAnalysis(config: AnalysisConfig = DEFAULT_CONFIG): Promise<{
  processed: number;
  findings: number;
  criticalFindings: number;
}> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Get recent transactions that haven't been analyzed by the fortress
  const recentTxs = await prismaRead.transaction.findMany({
    where: {
      createdAt: { gte: since },
      status: 'success',
    },
    take: config.batchSize,
    orderBy: { ledgerSequence: 'desc' },
    select: {
      hash: true,
      contractAddress: true,
      functionName: true,
      sourceAccount: true,
      ledgerCloseTime: true,
    },
  });

  let processed = 0;
  let totalFindings = 0;
  let criticalFindings = 0;

  // Group by hash for batch processing
  const txMap = new Map<string, (typeof recentTxs)[0][]>();
  for (const tx of recentTxs) {
    const existing = txMap.get(tx.hash) ?? [];
    existing.push(tx);
    txMap.set(tx.hash, existing);
  }

  // Batch check which transactions already have call graph data
  const allTxHashes = [...txMap.keys()];
  const existingVertices = await prismaRead.callGraphVertex.findMany({
    where: { txHash: { in: allTxHashes } },
    select: { txHash: true },
    distinct: ['txHash'],
  });
  const analyzedTxHashes = new Set(existingVertices.map((v) => v.txHash));

  for (const [txHash, txs] of txMap) {
    if (analyzedTxHashes.has(txHash)) continue;

    const calls: TraceCall[] = txs.map((tx, i) => ({
      contractId: tx.contractAddress ?? tx.sourceAccount,
      functionName: tx.functionName ?? 'unknown',
      depth: 0,
      callIndex: i,
    }));

    if (calls.length === 0) continue;

    const result = await analyzeAndPersist(txHash, calls);
    processed++;
    totalFindings += result.findings.length;
    criticalFindings += result.findings.filter((f) => f.severity === 'CRITICAL').length;
  }

  // Update stats after batch run
  await computeAndPersistStats();

  return { processed, findings: totalFindings, criticalFindings };
}

// ── Historical Backfill ───────────────────────────────────────────────────────

/**
 * Backfill analysis for historical transactions.
 */
export async function runHistoricalBackfill(
  startLedger: number,
  endLedger: number,
  batchSize: number = 500,
): Promise<{
  processed: number;
  findings: number;
  criticalFindings: number;
}> {
  let currentLedger = startLedger;
  let processed = 0;
  let totalFindings = 0;
  let criticalFindings = 0;

  while (currentLedger < endLedger) {
    const txs = await prismaRead.transaction.findMany({
      where: {
        ledgerSequence: {
          gte: currentLedger,
          lt: Math.min(currentLedger + 100, endLedger),
        },
        status: 'success',
      },
      take: batchSize,
      select: {
        hash: true,
        contractAddress: true,
        functionName: true,
        sourceAccount: true,
        ledgerCloseTime: true,
      },
    });

    const txMap = new Map<string, (typeof txs)[0][]>();
    for (const tx of txs) {
      const existing = txMap.get(tx.hash) ?? [];
      existing.push(tx);
      txMap.set(tx.hash, existing);
    }

    for (const [txHash, txGroup] of txMap) {
      const existingVertex = await prismaRead.callGraphVertex.findFirst({
        where: { txHash },
      });
      if (existingVertex) continue;

      const calls: TraceCall[] = txGroup.map((tx, i) => ({
        contractId: tx.contractAddress ?? tx.sourceAccount,
        functionName: tx.functionName ?? 'unknown',
        depth: 0,
        callIndex: i,
      }));

      if (calls.length === 0) continue;

      const result = await analyzeAndPersist(txHash, calls);
      processed++;
      totalFindings += result.findings.length;
      criticalFindings += result.findings.filter((f) => f.severity === 'CRITICAL').length;
    }

    currentLedger += 100;
  }

  await computeAndPersistStats();
  return { processed, findings: totalFindings, criticalFindings };
}

// ── Reentrancy Stats ──────────────────────────────────────────────────────────

/**
 * Compute and persist the global reentrancy statistics snapshot.
 */
export async function computeAndPersistStats(): Promise<ReentrancyStatsSnapshot> {
  const [totalGraphs, allFindings, riskScores, allVertices] = await Promise.all([
    prismaRead.callGraphVertex.groupBy({
      by: ['txHash'],
    }),
    prismaRead.reentrancyFinding.findMany({
      select: {
        reentrancyType: true,
        severity: true,
        valueAtRisk: true,
      },
    }),
    prismaRead.contractRiskScore.findMany({
      select: {
        contractAddress: true,
        riskScore: true,
      },
    }),
    prismaRead.callGraphVertex.findMany({
      select: { depth: true },
      take: 10000,
    }),
  ]);

  const totalCallGraphs = totalGraphs.length;
  const contractsAnalyzed = riskScores.length;
  const highRiskContracts = riskScores.filter((s) => s.riskScore >= 50).length;

  const criticalFindings = allFindings.filter((f) => f.severity === 'CRITICAL').length;
  const totalFindings = allFindings.length;

  // Compute pattern frequency
  const patternCounts = new Map<string, number>();
  for (const f of allFindings) {
    patternCounts.set(f.reentrancyType, (patternCounts.get(f.reentrancyType) ?? 0) + 1);
  }

  const mostCommonPatterns = [...patternCounts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // Compute depth stats
  const depths = allVertices.map((v) => v.depth);
  const avgDepth = depths.length > 0 ? depths.reduce((s, d) => s + d, 0) / depths.length : 0;
  const maxDepth = depths.length > 0 ? Math.max(...depths) : 0;

  // Total value at risk
  let totalValueRisk = 0n;
  for (const f of allFindings) {
    if (f.valueAtRisk) {
      try {
        totalValueRisk += BigInt(f.valueAtRisk);
      } catch {
        // ignore invalid values
      }
    }
  }

  const contractsWithLoops = [...patternCounts.entries()].filter(([, count]) => count > 0).length;

  const snapshot: ReentrancyStatsSnapshot = {
    timestamp: new Date(),
    totalCallGraphs,
    contractsAnalyzed,
    contractsWithLoops,
    highRiskContracts,
    criticalFindings,
    totalFindings,
    mostCommonPatterns,
    avgDepth,
    maxDepth: maxDepth > 0 ? maxDepth : undefined,
    valueAtRiskTotal: totalValueRisk > 0n ? totalValueRisk.toString() : undefined,
  };

  await prismaWrite.reentrancyStats.create({
    data: {
      timestamp: snapshot.timestamp,
      totalCallGraphs: snapshot.totalCallGraphs,
      contractsAnalyzed: snapshot.contractsAnalyzed,
      contractsWithLoops: snapshot.contractsWithLoops,
      highRiskContracts: snapshot.highRiskContracts,
      criticalFindings: snapshot.criticalFindings,
      totalFindings: snapshot.totalFindings,
      mostCommonPatterns: snapshot.mostCommonPatterns as object,
      avgDepth: snapshot.avgDepth,
      maxDepth: snapshot.maxDepth,
      valueAtRiskTotal: snapshot.valueAtRiskTotal,
    },
  });

  return snapshot;
}

// ── Alerting ──────────────────────────────────────────────────────────────────

/**
 * Create a reentrancy alert for a contract.
 */
export async function createAlert(
  contractAddress: string,
  alertType: string,
  severity: string,
  message: string,
  findingId?: string,
  metadata?: object,
): Promise<void> {
  // Check if a similar alert already exists recently
  const recentAlert = await prismaRead.reentrancyAlertExtended.findFirst({
    where: {
      contractAddress,
      alertType,
      createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) }, // 1 hour dedup
    },
  });

  if (recentAlert) return; // Deduplicate

  await prismaWrite.reentrancyAlertExtended.create({
    data: {
      contractAddress,
      findingId,
      alertType,
      severity,
      message,
      metadata: metadata as object,
    },
  });
}

// ── Real-Time Transaction Monitor ─────────────────────────────────────────────

/**
 * Process a new transaction in real-time.
 * Called by the indexer when a new transaction is detected.
 */
export async function processRealtimeTransaction(
  txHash: string,
  calls: TraceCall[],
  valueAtRisk?: string,
  usdValueAtRisk?: number,
): Promise<AnalysisResult> {
  const result = await analyzeAndPersist(txHash, calls, valueAtRisk, usdValueAtRisk);

  // Generate alerts for critical findings
  for (const finding of result.findings) {
    if (finding.severity === 'CRITICAL') {
      await createAlert(
        finding.contractAddress,
        'reentrancy_detected',
        finding.severity,
        `[${finding.reentrancyType}] ${finding.description}`,
        finding.id,
        {
          txHash,
          loopLength: finding.loopPath.length,
          usdValueAtRisk: finding.usdValueAtRisk,
        },
      );
    }
  }

  // Alert if risk score increased significantly
  if (result.riskScore.riskScore >= 75) {
    await createAlert(
      result.riskScore.contractAddress,
      'high_risk_score',
      result.riskScore.severity,
      `Contract ${result.riskScore.contractAddress.slice(0, 12)}… has risk score ${result.riskScore.riskScore}/100 with ${result.riskScore.criticalFindings} critical findings`,
      undefined,
      { riskScore: result.riskScore.riskScore },
    );
  }

  return result;
}
