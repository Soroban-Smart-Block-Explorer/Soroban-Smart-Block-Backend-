import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';
import { prismaRead } from '../db';
import {
  detectFlashLoan,
  computePreFlightScore,
  generateSecurityAdvisory,
  RawTransaction,
  RawEvent,
} from '../indexer/flashLoanDetector';

export const flashLoanRouter = Router();

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const attackFilterSchema = paginationSchema.extend({
  archetype: z.string().optional(),
  minProfit: z.coerce.number().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  isArbitrage: z.enum(['true', 'false']).optional(),
});

/**
 * GET /api/v1/security/flash-loans/attacks
 * Paginated list of detected flash loan attacks.
 */
flashLoanRouter.get(
  '/attacks',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = attackFilterSchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { page, limit, archetype, minProfit, from, to, isArbitrage } = parsed.data;

    const where: Record<string, unknown> = {};
    if (archetype) where.attackArchetype = archetype;
    if (minProfit !== undefined) where.profitUsd = { gte: minProfit };
    if (from || to)
      where.detectedAt = {
        ...(from ? { gte: new Date(from) } : {}),
        ...(to ? { lte: new Date(to) } : {}),
      };
    if (isArbitrage !== undefined) where.isArbitrage = isArbitrage === 'true';

    const [attacks, total] = await Promise.all([
      prismaRead.flashLoanAttack.findMany({
        where,
        orderBy: { detectedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          txHash: true,
          attacker: true,
          detectedAt: true,
          ledgerSequence: true,
          attackArchetype: true,
          attackSubtype: true,
          borrowedTotal: true,
          profitAmount: true,
          profitUsd: true,
          protocolCount: true,
          stepCount: true,
          riskScore: true,
          isArbitrage: true,
          detectionLatencyMs: true,
        },
      }),
      prismaRead.flashLoanAttack.count({ where }),
    ]);

    return res.json({ attacks, total, page, limit, pages: Math.ceil(total / limit) });
  }),
);

/**
 * GET /api/v1/security/flash-loans/attacks/stats
 * Aggregate statistics.
 */
flashLoanRouter.get(
  '/attacks/stats',
  asyncHandler(async (_req: Request, res: Response) => {
    const [total, archetypes, profiles] = await Promise.all([
      prismaRead.flashLoanAttack.count(),
      prismaRead.flashLoanAttack.groupBy({
        by: ['attackArchetype'],
        _count: { id: true },
        _sum: { profitUsd: true },
        orderBy: { _count: { id: 'desc' } },
      }),
      prismaRead.attackerProfile.count(),
    ]);

    const topByProfit = await prismaRead.flashLoanAttack.findMany({
      orderBy: { profitUsd: 'desc' },
      take: 5,
      select: { txHash: true, attackArchetype: true, profitUsd: true, detectedAt: true },
    });

    return res.json({
      totalAttacks: total,
      totalAttackerProfiles: profiles,
      byArchetype: archetypes.map((a) => ({
        archetype: a.attackArchetype,
        count: a._count.id,
        totalProfitUsd: a._sum.profitUsd ?? 0,
      })),
      topByProfit,
    });
  }),
);

/**
 * GET /api/v1/security/flash-loans/attacks/:txHash
 * Full reconstruction with DAG.
 */
flashLoanRouter.get(
  '/attacks/:txHash',
  asyncHandler(async (req: Request, res: Response) => {
    const attack = await prismaRead.flashLoanAttack.findUnique({
      where: { txHash: req.params.txHash },
    });
    if (!attack) return res.status(404).json({ error: 'Attack not found' });

    const advisory = generateSecurityAdvisory({
      txHash: attack.txHash,
      attacker: attack.attacker,
      ledgerSequence: attack.ledgerSequence,
      detectedAt: attack.detectedAt,
      flashLoanTypes: [],
      archetype: attack.attackArchetype as never,
      borrowedTotal: attack.borrowedTotal,
      borrowedTokens: attack.borrowedTokens,
      repaidTotal: attack.repaidTotal,
      profitAmount: attack.profitAmount,
      profitUsd: attack.profitUsd ?? undefined,
      protocolCount: attack.protocolCount,
      stepCount: attack.stepCount,
      fundFlowGraph: attack.fundFlowGraph as { edges: never[]; nodes: string[] },
      reconstruction: [],
      originalTvls: attack.originalTvls as Record<string, string>,
      riskScore: attack.riskScore,
      attackerToxicity: attack.attackerToxicity ?? undefined,
      detectionLatencyMs: attack.detectionLatencyMs,
      brokenInvariants: (attack.brokenInvariants as string[] | null) ?? undefined,
      cweMappings: attack.cweMappings,
      isArbitrage: attack.isArbitrage,
      mevExtracted: attack.mevExtracted ?? undefined,
    });

    return res.json({ ...attack, advisory });
  }),
);

/**
 * GET /api/v1/security/flash-loans/attacks/by-protocol/:address
 */
flashLoanRouter.get(
  '/attacks/by-protocol/:address',
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    const { page, limit } = paginationSchema.parse(req.query);

    const attacks = await prismaRead.flashLoanAttack.findMany({
      where: {
        fundFlowGraph: { path: ['nodes'], array_contains: address },
      },
      orderBy: { detectedAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return res.json({ address, attacks, page, limit });
  }),
);

/**
 * GET /api/v1/security/flash-loans/attacks/by-attacker/:address
 */
flashLoanRouter.get(
  '/attacks/by-attacker/:address',
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    const { page, limit } = paginationSchema.parse(req.query);

    const [attacks, profile] = await Promise.all([
      prismaRead.flashLoanAttack.findMany({
        where: { attacker: address },
        orderBy: { detectedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prismaRead.attackerProfile.findUnique({ where: { address } }),
    ]);

    return res.json({ address, profile, attacks, page, limit });
  }),
);

/**
 * GET /api/v1/security/flash-loans/advisories
 */
flashLoanRouter.get(
  '/advisories',
  asyncHandler(async (_req: Request, res: Response) => {
    const attacks = await prismaRead.flashLoanAttack.findMany({
      where: { riskScore: { gte: 60 } },
      orderBy: { detectedAt: 'desc' },
      take: 50,
    });

    const advisories = attacks.map((a) =>
      generateSecurityAdvisory({
        txHash: a.txHash,
        attacker: a.attacker,
        ledgerSequence: a.ledgerSequence,
        detectedAt: a.detectedAt,
        flashLoanTypes: [],
        archetype: a.attackArchetype as never,
        borrowedTotal: a.borrowedTotal,
        borrowedTokens: a.borrowedTokens,
        repaidTotal: a.repaidTotal,
        profitAmount: a.profitAmount,
        profitUsd: a.profitUsd ?? undefined,
        protocolCount: a.protocolCount,
        stepCount: a.stepCount,
        fundFlowGraph: a.fundFlowGraph as { edges: never[]; nodes: string[] },
        reconstruction: [],
        originalTvls: a.originalTvls as Record<string, string>,
        riskScore: a.riskScore,
        attackerToxicity: a.attackerToxicity ?? undefined,
        detectionLatencyMs: a.detectionLatencyMs,
        brokenInvariants: undefined,
        cweMappings: a.cweMappings,
        isArbitrage: a.isArbitrage,
        mevExtracted: a.mevExtracted ?? undefined,
      }),
    );

    return res.json({ advisories });
  }),
);

/**
 * GET /api/v1/security/flash-loans/protocols/:address/risk
 */
flashLoanRouter.get(
  '/protocols/:address/risk',
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;

    const [vulnerabilities, attackCount] = await Promise.all([
      prismaRead.protocolVulnerability.findMany({ where: { protocolAddress: address } }),
      prismaRead.flashLoanAttack.count({
        where: { fundFlowGraph: { path: ['nodes'], array_contains: address } },
      }),
    ]);

    const riskScore = Math.min(
      vulnerabilities.length * 15 +
        attackCount * 10 +
        vulnerabilities.filter((v) => v.severity === 'CRITICAL').length * 20,
      100,
    );

    return res.json({
      address,
      riskScore,
      vulnerabilities,
      attackCount,
      severity:
        riskScore >= 80
          ? 'CRITICAL'
          : riskScore >= 60
            ? 'HIGH'
            : riskScore >= 40
              ? 'MEDIUM'
              : 'LOW',
    });
  }),
);

/**
 * POST /api/v1/security/flash-loans/simulate
 * Pre-flight attack simulation for a submitted transaction.
 */
const simulateSchema = z.object({
  txXdr: z.string().optional(),
  functionName: z.string().optional(),
  contractAddress: z.string().optional(),
  sourceAccount: z.string().default('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'),
  functionArgs: z.unknown().optional(),
});

flashLoanRouter.post(
  '/simulate',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = simulateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { functionName, contractAddress, sourceAccount, functionArgs } = parsed.data;

    const fakeTx: RawTransaction = {
      hash: 'simulated',
      sourceAccount,
      ledgerSequence: 0,
      ledgerCloseTime: new Date(),
      functionName: functionName ?? undefined,
      contractAddress: contractAddress ?? undefined,
      functionArgs,
      status: 'PENDING',
    };

    const { score, factors } = computePreFlightScore(fakeTx);

    const alertPriority =
      score >= 80 ? 'CRITICAL' : score >= 60 ? 'HIGH' : score >= 40 ? 'MEDIUM' : 'LOW';

    return res.json({
      riskScore: score,
      alertPriority,
      factors,
      recommendation:
        score >= 60
          ? 'High flash loan attack probability. Consider rejecting or monitoring closely.'
          : 'Low risk. Normal monitoring applies.',
    });
  }),
);

/**
 * GET /api/v1/security/flash-loans/attackers
 * Attacker profiles leaderboard.
 */
flashLoanRouter.get(
  '/attackers',
  asyncHandler(async (_req: Request, res: Response) => {
    const profiles = await prismaRead.attackerProfile.findMany({
      orderBy: { attackCount: 'desc' },
      take: 50,
    });
    return res.json({ attackers: profiles, total: profiles.length });
  }),
);

/**
 * GET /api/v1/security/flash-loans/archetypes
 * Known attack archetypes with examples.
 */
flashLoanRouter.get(
  '/archetypes',
  asyncHandler(async (_req: Request, res: Response) => {
    const archetypes = await prismaRead.flashLoanAttack.groupBy({
      by: ['attackArchetype', 'attackSubtype'],
      _count: { id: true },
      _avg: { profitUsd: true, riskScore: true },
      orderBy: { _count: { id: 'desc' } },
    });

    const descriptions: Record<string, string> = {
      oracle_manipulation:
        'Attacker borrows funds, manipulates a spot price oracle, then exploits protocols dependent on that price',
      price_manipulation_liquidation:
        'Flash loan funds used to crash an asset price and trigger liquidations at discount',
      collateral_inflation:
        'Attacker inflates collateral value via token donations or re-entrancy to over-borrow',
      governance_vote:
        'Flash-borrow governance tokens to pass a malicious proposal in a single block',
      cross_protocol_sandwich:
        'Large flash-loan swaps sandwich victim transactions across multiple DEXes',
      fee_rebate_exploit: 'Exploit fee/rebate accounting to extract more value than deposited',
      staking_reward_manipulation:
        'Manipulate reward per token calculation via flash deposit/withdrawal',
      arbitrage:
        'Legitimate arbitrage using flash loans to capture price differences across venues',
      unknown: 'Unclassified flash loan pattern',
    };

    return res.json({
      archetypes: archetypes.map((a) => ({
        archetype: a.attackArchetype,
        subtype: a.attackSubtype,
        count: a._count.id,
        avgProfitUsd: a._avg.profitUsd ?? 0,
        avgRiskScore: a._avg.riskScore ?? 0,
        description: descriptions[a.attackArchetype] ?? '',
      })),
    });
  }),
);

/**
 * GET /api/v1/security/flash-loans/systemic-risk
 * Protocol correlation matrix and cascade simulation.
 */
flashLoanRouter.get(
  '/systemic-risk',
  asyncHandler(async (_req: Request, res: Response) => {
    const vulnerabilities = await prismaRead.protocolVulnerability.findMany({
      select: { protocolAddress: true, severity: true, parentArchetype: true, totalLoss: true },
    });

    const protocolRisk: Record<string, { score: number; archetype: string; totalLoss: string }> =
      {};
    for (const v of vulnerabilities) {
      const existing = protocolRisk[v.protocolAddress];
      const sevScore = { CRITICAL: 30, HIGH: 20, MEDIUM: 10, LOW: 5 }[v.severity] ?? 5;
      if (!existing || sevScore > existing.score) {
        protocolRisk[v.protocolAddress] = {
          score: sevScore,
          archetype: v.parentArchetype,
          totalLoss: v.totalLoss,
        };
      }
    }

    const protocols = Object.entries(protocolRisk).map(([address, data]) => ({ address, ...data }));

    return res.json({
      protocols,
      totalProtocolsAtRisk: protocols.length,
      criticalCount: protocols.filter((p) => p.score >= 30).length,
      message: 'Systemic risk matrix based on historical exploits and shared dependencies',
    });
  }),
);

/**
 * GET /api/v1/security/flash-loans/mempool
 * Stub for real-time mempool risk scores (pre-confirmation).
 */
flashLoanRouter.get(
  '/mempool',
  asyncHandler(async (_req: Request, res: Response) => {
    return res.json({
      pendingHighRisk: [],
      monitoredCount: 0,
      message: 'Real-time mempool surveillance requires direct Soroban node integration',
    });
  }),
);

/**
 * GET /api/v1/security/flash-loans/detect
 * Detect flash loans from recent transactions (last N ledgers).
 */
flashLoanRouter.get(
  '/detect',
  asyncHandler(async (req: Request, res: Response) => {
    const { since } = z.object({ since: z.coerce.number().optional() }).parse(req.query);
    const lookback = since ?? 100;

    const recentTxs = await prismaRead.transaction.findMany({
      where: {
        ledgerSequence: {
          gte:
            (await prismaRead.ledger.findFirst({ orderBy: { sequence: 'desc' } }))?.sequence ??
            0 - lookback,
        },
      },
      include: { events: true },
      take: 200,
      orderBy: { ledgerSequence: 'desc' },
    });

    const detected: ReturnType<typeof detectFlashLoan>[] = [];

    for (const tx of recentTxs) {
      const rawTx: RawTransaction = {
        hash: tx.hash,
        sourceAccount: tx.sourceAccount,
        ledgerSequence: tx.ledgerSequence,
        ledgerCloseTime: tx.ledgerCloseTime,
        functionName: tx.functionName ?? undefined,
        contractAddress: tx.contractAddress ?? undefined,
        functionArgs: tx.functionArgs,
        status: tx.status,
      };

      const rawEvents: RawEvent[] = tx.events.map((e) => ({
        transactionHash: e.transactionHash,
        contractAddress: e.contractAddress,
        eventType: e.eventType,
        topicSymbol: e.topicSymbol ?? undefined,
        topics: Array.isArray(e.topics) ? e.topics : [],
        data: e.data,
        ledgerSequence: e.ledgerSequence,
      }));

      const result = detectFlashLoan(rawTx, rawEvents);
      if (result) detected.push(result);
    }

    return res.json({
      detected: detected.length,
      attacks: detected,
      scannedTransactions: recentTxs.length,
      lookbackLedgers: lookback,
    });
  }),
);
