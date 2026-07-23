/**
 * Sandwich Attack Detection API (#290)
 *
 * Routes:
 *   GET  /mev/sandwich/scan/:ledger     — scan a ledger for sandwich patterns
 *   GET  /mev/sandwich/patterns         — list detected patterns (paginated)
 *   GET  /mev/sandwich/landscape        — MEV landscape statistics
 *   GET  /mev/sandwich/fairness/:proto  — fairness score for a protocol
 *   GET  /mev/sandwich/risk             — pre-tx sandwich probability
 *   GET  /mev/sandwich/alerts           — SSE stream of real-time sandwich alerts
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';
import { prismaRead } from '../db';
import {
  detectAllSandwiches,
  estimateSandwichRisk,
  LedgerTx,
  SandwichPattern,
} from '../indexer/sandwich-detector';
import { paginationSchema, stellarAddress } from '../schemas/common';

export const sandwichRouter = Router();

// ── In-process alert subscribers (SSE) ───────────────────────────────────────
type AlertSubscriber = (pattern: SandwichPattern) => void;
const alertSubscribers = new Set<AlertSubscriber>();

export function broadcastSandwichAlert(pattern: SandwichPattern): void {
  for (const sub of alertSubscribers) {
    try {
      sub(pattern);
    } catch {
      // subscriber disconnected — will be removed on next write
    }
  }
}

// ── Helper: load ledger transactions from DB ──────────────────────────────────
async function loadLedgerTxs(ledgerSeq: number): Promise<LedgerTx[]> {
  const rows = await prismaRead.transaction.findMany({
    where: { ledgerSequence: ledgerSeq },
    orderBy: { id: 'asc' },
    select: {
      hash: true,
      id: true,
      sourceAccount: true,
      contractAddress: true,
      functionName: true,
      humanReadable: true,
      ledgerSequence: true,
      ledgerCloseTime: true,
      feeCharged: true,
      flashLoanAlert: true,
    },
  });

  return rows.map((r, idx) => ({
    hash: r.hash,
    position: idx,
    sourceAccount: r.sourceAccount,
    contractAddress: r.contractAddress,
    functionName: r.functionName,
    humanReadable: r.humanReadable,
    ledgerSequence: r.ledgerSequence,
    ledgerCloseTime: r.ledgerCloseTime,
    feeCharged: r.feeCharged?.toString(),
    flashLoanAlert: r.flashLoanAlert ?? false,
  }));
}

// ── GET /mev/sandwich/scan/:ledger ────────────────────────────────────────────
const scanParamsSchema = z.object({
  ledger: z.coerce.number().int().min(0, 'Ledger sequence must be non-negative'),
});

sandwichRouter.get(
  '/scan/:ledger',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = scanParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Invalid path parameters', details: parsed.error.flatten().fieldErrors });
    }

    const { ledger } = parsed.data;
    const start = Date.now();
    const txs = await loadLedgerTxs(ledger);

    if (txs.length === 0) {
      return res.status(404).json({ error: `No transactions found for ledger ${ledger}` });
    }

    const patterns = detectAllSandwiches(txs);
    const elapsed = Date.now() - start;

    // Broadcast alerts for high-confidence patterns
    for (const p of patterns.filter((p) => p.confidence >= 60)) {
      broadcastSandwichAlert(p);
    }

    return res.json({
      ledgerSeq: ledger,
      txsScanned: txs.length,
      patternsDetected: patterns.length,
      elapsedMs: elapsed,
      patterns,
    });
  }),
);

// ── GET /mev/sandwich/patterns ────────────────────────────────────────────────
const patternsQuerySchema = paginationSchema.extend({
  type: z
    .enum([
      'simple_sandwich',
      'multi_hop_sandwich',
      'cross_pool_sandwich',
      'frontrun_backrun',
      'displacement',
      'jit_liquidity',
    ])
    .optional(),
  attacker: stellarAddress.optional(),
  victim: stellarAddress.optional(),
  minConfidence: z.coerce.number().int().min(0).max(100).default(0),
  ledgerMin: z.coerce.number().int().min(0).optional(),
  ledgerMax: z.coerce.number().int().min(0).optional(),
});

sandwichRouter.get(
  '/patterns',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = patternsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Invalid query parameters', details: parsed.error.flatten().fieldErrors });
    }

    const { page, limit, type, attacker, victim, minConfidence, ledgerMin, ledgerMax } =
      parsed.data;
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {
      confidence: { gte: minConfidence / 100 },
    };
    if (type) where.mevType = type;
    if (attacker) where.attackerAddress = attacker;
    if (victim) where.victimAddress = victim;
    if (ledgerMin !== undefined || ledgerMax !== undefined) {
      where.ledgerSeq = {
        ...(ledgerMin !== undefined ? { gte: ledgerMin } : {}),
        ...(ledgerMax !== undefined ? { lte: ledgerMax } : {}),
      };
    }

    const [events, total] = await Promise.all([
      prismaRead.mevEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip,
        select: {
          id: true,
          txHash: true,
          ledgerSeq: true,
          timestamp: true,
          mevType: true,
          victimAddress: true,
          attackerAddress: true,
          protocolAddress: true,
          profitUsd: true,
          lossUsd: true,
          confidence: true,
          txOrder: true,
          details: true,
        },
      }),
      prismaRead.mevEvent.count({ where }),
    ]);

    return res.json({ data: events, total, page, limit, pages: Math.ceil(total / limit) });
  }),
);

// ── GET /mev/sandwich/landscape ───────────────────────────────────────────────
const landscapeQuerySchema = z.object({
  period: z.enum(['1h', '24h', '7d', '30d']).default('24h'),
});

sandwichRouter.get(
  '/landscape',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = landscapeQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Invalid query parameters', details: parsed.error.flatten().fieldErrors });
    }

    const { period } = parsed.data;
    const hoursMap: Record<string, number> = { '1h': 1, '24h': 24, '7d': 168, '30d': 720 };
    const since = new Date(Date.now() - hoursMap[period] * 3600 * 1000);

    const events = await prismaRead.mevEvent.findMany({
      where: {
        createdAt: { gte: since },
        mevType: {
          in: [
            'sandwich',
            'backrunning',
            'displacement',
            'jit_liquidity',
            'cross_dex_arbitrage',
            'flash_loan_attack',
          ],
        },
      },
      select: {
        mevType: true,
        profitUsd: true,
        lossUsd: true,
        attackerAddress: true,
        protocolAddress: true,
        confidence: true,
      },
    });

    // Build in-memory landscape from DB events
    const byType: Record<string, { count: number; totalUsd: number }> = {};
    const attackerMap = new Map<string, { profit: number; count: number }>();
    const protocolMap = new Map<string, { loss: number; count: number }>();
    let totalExtractedUsd = 0;

    for (const e of events) {
      const t = e.mevType;
      if (!byType[t]) byType[t] = { count: 0, totalUsd: 0 };
      byType[t].count++;
      byType[t].totalUsd += e.profitUsd ?? 0;
      totalExtractedUsd += e.profitUsd ?? 0;

      if (e.attackerAddress) {
        const prev = attackerMap.get(e.attackerAddress) ?? { profit: 0, count: 0 };
        attackerMap.set(e.attackerAddress, {
          profit: prev.profit + (e.profitUsd ?? 0),
          count: prev.count + 1,
        });
      }

      if (e.protocolAddress) {
        const prev = protocolMap.get(e.protocolAddress) ?? { loss: 0, count: 0 };
        protocolMap.set(e.protocolAddress, {
          loss: prev.loss + (e.lossUsd ?? 0),
          count: prev.count + 1,
        });
      }
    }

    const topAttackers = [...attackerMap.entries()]
      .sort(([, a], [, b]) => b.profit - a.profit)
      .slice(0, 10)
      .map(([address, v]) => ({ address, totalProfitUsd: v.profit, attackCount: v.count }));

    const mostVictimizedProtocols = [...protocolMap.entries()]
      .sort(([, a], [, b]) => b.loss - a.loss)
      .slice(0, 10)
      .map(([protocol, v]) => ({ protocol, totalLossUsd: v.loss, attackCount: v.count }));

    let mevConcentration = 0;
    if (totalExtractedUsd > 0) {
      const shares = [...attackerMap.values()].map((v) => v.profit / totalExtractedUsd);
      mevConcentration = shares.reduce((s, share) => s + share * share, 0);
    }

    return res.json({
      period,
      since: since.toISOString(),
      totalExtractedUsd,
      byType,
      topAttackers,
      mostVictimizedProtocols,
      mevConcentration,
      eventCount: events.length,
    });
  }),
);

// ── GET /mev/sandwich/fairness/:protocol ──────────────────────────────────────
const fairnessParamsSchema = z.object({
  protocol: stellarAddress,
});

sandwichRouter.get(
  '/fairness/:protocol',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = fairnessParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Invalid path parameters', details: parsed.error.flatten().fieldErrors });
    }

    const { protocol } = parsed.data;
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000); // last 7 days

    const [txCount, patterns] = await Promise.all([
      prismaRead.transaction.count({
        where: { contractAddress: protocol, ledgerCloseTime: { gte: since } },
      }),
      prismaRead.mevEvent.findMany({
        where: { protocolAddress: protocol, createdAt: { gte: since } },
        select: {
          mevType: true,
          profitUsd: true,
          lossUsd: true,
          confidence: true,
        },
      }),
    ]);

    const sandwichCount = patterns.length;
    const sandwichRate = txCount > 0 ? (sandwichCount / txCount) * 1000 : 0;
    const totalVolumeUsd = 0; // would come from indexed swap volumes
    const totalLossUsd = patterns.reduce((s, p) => s + (p.lossUsd ?? 0), 0);
    const mevExtractedPct = totalVolumeUsd > 0 ? (totalLossUsd / totalVolumeUsd) * 100 : 0;

    const sandwichPenalty = Math.min(60, sandwichRate * 2);
    const mevPenalty = Math.min(30, mevExtractedPct * 3);
    const fairnessScore = Math.max(0, 100 - sandwichPenalty - mevPenalty);

    return res.json({
      protocol,
      fairnessScore,
      sandwichRate,
      unfairOrderingRate: Math.min(1, sandwichRate / 100),
      mevExtractedPct,
      txCount,
      attackCount: sandwichCount,
      totalLossUsd,
      period: '7d',
    });
  }),
);

// ── GET /mev/sandwich/risk ────────────────────────────────────────────────────
const riskQuerySchema = z.object({
  protocol: stellarAddress,
  amount: z.coerce.number().min(0, 'Amount must be non-negative'),
});

sandwichRouter.get(
  '/risk',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = riskQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Invalid query parameters', details: parsed.error.flatten().fieldErrors });
    }

    const { protocol, amount } = parsed.data;
    const since = new Date(Date.now() - 3600 * 1000); // last hour

    const recentPatterns = await prismaRead.mevEvent.findMany({
      where: {
        protocolAddress: protocol,
        mevType: 'sandwich',
        createdAt: { gte: since },
      },
      select: { profitUsd: true, lossUsd: true, confidence: true },
    });

    const mockPatterns = recentPatterns.map((p) => ({
      protocol,
      profitEstimateUsd: p.profitUsd ?? 0,
      victimLossUsd: p.lossUsd ?? 0,
      confidence: Math.round((p.confidence ?? 0) * 100),
    })) as SandwichPattern[];

    const risk = estimateSandwichRisk(amount, protocol, mockPatterns);

    return res.json({
      protocol,
      amountUsd: amount,
      ...risk,
    });
  }),
);

// ── GET /mev/sandwich/alerts (SSE) ────────────────────────────────────────────
sandwichRouter.get('/alerts', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (pattern: SandwichPattern) => {
    try {
      res.write(`data: ${JSON.stringify(pattern)}\n\n`);
    } catch {
      alertSubscribers.delete(send);
    }
  };

  alertSubscribers.add(send);

  // Send a heartbeat every 30s to keep the connection alive
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      clearInterval(heartbeat);
      alertSubscribers.delete(send);
    }
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    alertSubscribers.delete(send);
  });
});
