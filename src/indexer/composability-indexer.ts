/**
 * Background composability indexer
 *
 * Polls for new transactions, extracts cross-contract call sequences,
 * runs pattern detection + safety scoring, and persists results.
 * Also runs a daily ECI snapshot job.
 */
import { prismaWrite, prismaRead } from '../db';
import { logger } from '../logger';
import { background } from '../utils/background';

/* eslint-disable @typescript-eslint/no-implied-eval */
const _setInterval: (fn: () => void, ms: number) => unknown = setInterval;
const _setTimeout: (fn: () => void, ms: number) => unknown = setTimeout;
import {
  buildCallGraph,
  detectPatterns,
  verifyCompositionSafety,
  computeRiskLevel,
  checkForExploit,
  generateMitigationPatch,
  computeEcosystemIndex,
  type ContractCall,
} from './composability-engine';
import {
  broadcastExploitAlert,
  broadcastCompositionAnalyzed,
} from '../ws/composabilityBroadcaster';

// Interval between scans (ms)
const SCAN_INTERVAL_MS = 30_000;
const ECI_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily

let lastProcessedTxId: string | null = null;

/**
 * Infer cross-contract calls from a transaction's function call and event data.
 * In production this would be backed by full call-trace parsing; here we use
 * available decoded event data as a signal.
 */
function inferContractCalls(tx: {
  hash: string;
  contractAddress: string | null;
  functionName: string | null;
  events: Array<{ contractAddress: string; eventType: string; decoded: unknown }>;
}): ContractCall[] {
  const calls: ContractCall[] = [];
  if (!tx.contractAddress) return calls;

  // Each event emitted by a different contract = a cross-contract call
  const seen = new Set<string>();
  for (const event of tx.events) {
    if (event.contractAddress === tx.contractAddress) continue;
    if (seen.has(event.contractAddress)) continue;
    seen.add(event.contractAddress);

    calls.push({
      from: tx.contractAddress,
      to: event.contractAddress,
      method: event.eventType ?? 'unknown',
      args: [],
    });
  }

  // Include the root call
  if (calls.length > 0) {
    calls.unshift({
      from: tx.hash.slice(0, 8), // use shortened hash as "caller" placeholder
      to: tx.contractAddress,
      method: tx.functionName ?? 'unknown',
      args: [],
    });
  }

  return calls;
}

async function scanPendingTransactions(): Promise<void> {
  // Find recent transactions with events from multiple contracts (composable)
  const txs = await prismaRead.transaction.findMany({
    where: {
      ...(lastProcessedTxId ? { id: { gt: lastProcessedTxId } } : {}),
      status: 'success',
    },
    include: {
      events: { select: { contractAddress: true, eventType: true, decoded: true } },
    },
    orderBy: { id: 'asc' },
    take: 50,
  });

  for (const tx of txs) {
    lastProcessedTxId = tx.id;

    // Only process transactions touching multiple contracts
    const uniqueContracts = new Set(tx.events.map((e) => e.contractAddress));
    if (uniqueContracts.size < 2) continue;

    // Skip if already analyzed
    const existing = await prismaRead.composedTransaction.findUnique({
      where: { txHash: tx.hash },
    });
    if (existing?.analysisStatus === 'completed') continue;

    const calls = inferContractCalls({
      hash: tx.hash,
      contractAddress: tx.contractAddress,
      functionName: tx.functionName,
      events: tx.events,
    });
    if (calls.length === 0) continue;

    try {
      // Mark as analyzing
      await prismaWrite.composedTransaction.upsert({
        where: { txHash: tx.hash },
        update: { analysisStatus: 'analyzing' },
        create: {
          txHash: tx.hash,
          ledgerSeq: tx.ledgerSequence,
          timestamp: tx.ledgerCloseTime,
          contractCalls: calls as object[],
          analysisStatus: 'analyzing',
        },
      });

      const callGraph = buildCallGraph(calls);
      const patterns = detectPatterns(calls);
      const verification = verifyCompositionSafety(calls, callGraph);
      const safetyScore = verification.scores.total;
      const riskLevel = computeRiskLevel(safetyScore);

      await prismaWrite.composedTransaction.update({
        where: { txHash: tx.hash },
        data: {
          contractCalls: calls as object[],
          callGraph: callGraph as object,
          safetyScore,
          riskLevel,
          analysisStatus: 'completed',
        },
      });

      // Persist pattern instances
      for (const p of patterns) {
        const composed = await prismaRead.composedTransaction.findUnique({
          where: { txHash: tx.hash },
        });
        if (!composed) continue;
        const dbPattern = await prismaWrite.compositionPattern.upsert({
          where: { name: p.patternName },
          update: {},
          create: {
            name: p.patternName,
            description: String(p.details.mitigationGuide ?? ''),
            category: p.category,
            riskRating: (p.details as any).riskRating ?? 'medium_risk',
            mitigationGuide: String(p.details.mitigationGuide ?? ''),
          },
        });
        background('composability.createPatternInstance', () =>
          prismaWrite.compositionPatternInstance
            .create({
              data: {
                txId: composed.id,
                patternId: dbPattern.id,
                confidence: p.confidence,
                details: p.details as object,
              },
            })
            .then(() => {}),
        );
      }

      // Update composability profile for each contract
      const addresses = [...new Set(calls.flatMap((c) => [c.from, c.to]))];
      for (const addr of addresses) {
        const callers = calls.filter((c) => c.to === addr).map((c) => c.from);
        const callees = calls.filter((c) => c.from === addr).map((c) => c.to);
        await prismaWrite.contractComposability.upsert({
          where: { contractAddress: addr },
          update: {
            compositionCount: { increment: 1 },
            uniqueCallers: callers.length,
            uniqueCallees: callees.length,
            safetyScoreAvg: safetyScore,
            lastAnalyzed: new Date(),
          },
          create: {
            contractId: addr,
            contractAddress: addr,
            compositionCount: 1,
            uniqueCallers: callers.length,
            uniqueCallees: callees.length,
            safetyScoreAvg: safetyScore,
            riskIncidents: riskLevel === 'critical' || riskLevel === 'high_risk' ? 1 : 0,
          },
        });
      }

      broadcastCompositionAnalyzed({
        txHash: tx.hash,
        safetyScore,
        riskLevel,
        patternCount: patterns.length,
        timestamp: tx.ledgerCloseTime,
      });

      // Exploit check
      const exploit = checkForExploit(calls);
      if (exploit.exploitDetected) {
        const patch = generateMitigationPatch(calls, patterns);
        await prismaWrite.compositionAlert.create({
          data: {
            txHash: tx.hash,
            severity: 'critical',
            title: `Exploit: ${exploit.exploitType}`,
            description: exploit.description ?? '',
            exploitDetected: true,
            mitigationPatch: patch as object,
          },
        });
        broadcastExploitAlert({
          txHash: tx.hash,
          exploitType: exploit.exploitType!,
          severity: 'critical',
          confidence: exploit.confidence,
          description: exploit.description!,
          patterns: patterns.map((p) => p.patternName),
          timestamp: tx.ledgerCloseTime,
        });
        logger.warn('Composability exploit detected', {
          txHash: tx.hash,
          type: exploit.exploitType,
        });
      }
    } catch (err) {
      background('composability.markTxFailed', () =>
        prismaWrite.composedTransaction
          .update({ where: { txHash: tx.hash }, data: { analysisStatus: 'failed' } })
          .then(() => {}),
      );
      logger.error('Composability analysis failed', { txHash: tx.hash, error: String(err) });
    }
  }
}

async function computeECISnapshot(): Promise<void> {
  try {
    const [totalContracts, totalComposedTx, exploitCount, avgScore, patterns] = await Promise.all([
      prismaRead.contractComposability.count(),
      prismaRead.composedTransaction.count(),
      prismaRead.compositionAlert.count({ where: { exploitDetected: true } }),
      prismaRead.composedTransaction.aggregate({ _avg: { safetyScore: true } }),
      prismaRead.compositionPattern.findMany({ select: { category: true } }),
    ]);

    const uniqueCategories = new Set(patterns.map((p) => p.category)).size;
    const score = computeEcosystemIndex({
      totalContracts,
      totalComposedTx,
      uniquePatternCategories: uniqueCategories,
      avgSafetyScore: avgScore._avg.safetyScore ?? 0,
      exploitCount,
      totalTx: totalComposedTx,
    });

    await prismaWrite.ecosystemComposabilityIndex.create({
      data: {
        score,
        compositionDiversity: uniqueCategories,
        avgSafetyScore: avgScore._avg.safetyScore ?? 0,
        exploitIncidentRate: totalComposedTx > 0 ? exploitCount / totalComposedTx : 0,
        protocolInterconnectivity: totalContracts > 0 ? totalComposedTx / totalContracts : 0,
        totalContracts,
        totalComposedTx,
      },
    });
    logger.info('ECI snapshot computed', { score });
  } catch (err) {
    logger.error('ECI snapshot failed', { error: String(err) });
  }
}

export function startComposabilityIndexer(): void {
  logger.info('Starting composability indexer');

  const scan = () => {
    scanPendingTransactions().catch((err) =>
      logger.error('Composability scan error', { error: String(err) }),
    );
  };
  scan();
  setInterval(scan, SCAN_INTERVAL_MS);
  setInterval(() => {
    background('composability.eciSnapshot', () => computeECISnapshot().then(() => {}));
  }, ECI_INTERVAL_MS);
  setTimeout(() => {
    background('composability.eciSnapshot', () => computeECISnapshot().then(() => {}));
  }, 60_000);
}
