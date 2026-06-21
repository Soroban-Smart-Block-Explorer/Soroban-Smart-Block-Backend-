import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prismaRead, prismaWrite } from '../db';
import {
  buildCallGraph,
  detectPatterns,
  verifyCompositionSafety,
  computeRiskLevel,
  performStaticAnalysis,
  generateMitigationPatch,
  runFuzzCampaign,
  checkForExploit,
  computeEcosystemIndex,
  type ContractCall,
} from '../indexer/composability-engine';
import {
  broadcastExploitAlert,
  broadcastCompositionAnalyzed,
} from '../ws/composabilityBroadcaster';
import { asyncHandler } from '../middleware/asyncHandler';

export const composabilityRouter = Router();

const callSchema = z.object({
  from: z.string(),
  to: z.string(),
  method: z.string(),
  args: z.array(z.unknown()).optional(),
});
const analyzeSchema = z.object({
  txHash: z.string(),
  ledgerSeq: z.number().int().optional().default(0),
  timestamp: z.string().datetime({ offset: true }).optional(),
  contractCalls: z.array(callSchema),
});

// ── Core analysis helper ─────────────────────────────────────────────────────
async function analyzeAndPersist(
  txHash: string,
  ledgerSeq: number,
  timestamp: Date,
  contractCalls: ContractCall[],
) {
  const callGraph = buildCallGraph(contractCalls);
  const patterns = detectPatterns(contractCalls);
  const verification = verifyCompositionSafety(contractCalls, callGraph);
  const safetyScore = verification.scores.total;
  const riskLevel = computeRiskLevel(safetyScore);

  const composed = await prismaWrite.composedTransaction.upsert({
    where: { txHash },
    update: {
      contractCalls: contractCalls as object[],
      callGraph: callGraph as object,
      safetyScore,
      riskLevel,
      analysisStatus: 'completed',
    },
    create: {
      txHash,
      ledgerSeq,
      timestamp,
      contractCalls: contractCalls as object[],
      callGraph: callGraph as object,
      safetyScore,
      riskLevel,
      analysisStatus: 'completed',
    },
  });

  for (const p of patterns) {
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
    await prismaWrite.compositionPatternInstance.create({
      data: {
        txId: composed.id,
        patternId: dbPattern.id,
        confidence: p.confidence,
        details: p.details as object,
      },
    });
  }

  const addresses = [...new Set(contractCalls.flatMap((c) => [c.from, c.to]))];
  for (const addr of addresses) {
    const callers = contractCalls.filter((c) => c.to === addr).map((c) => c.from);
    const callees = contractCalls.filter((c) => c.from === addr).map((c) => c.to);
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
    txHash,
    safetyScore,
    riskLevel,
    patternCount: patterns.length,
    timestamp,
  });

  const exploit = checkForExploit(contractCalls);
  if (exploit.exploitDetected) {
    const patch = generateMitigationPatch(contractCalls, patterns);
    await prismaWrite.compositionAlert.create({
      data: {
        txHash,
        severity: 'critical',
        title: `Exploit: ${exploit.exploitType}`,
        description: exploit.description ?? '',
        exploitDetected: true,
        mitigationPatch: patch as object,
      },
    });
    broadcastExploitAlert({
      txHash,
      exploitType: exploit.exploitType!,
      severity: 'critical',
      confidence: exploit.confidence,
      description: exploit.description!,
      patterns: patterns.map((p) => p.patternName),
      timestamp,
    });
  }
  return { composed, patterns, verification, safetyScore, riskLevel, callGraph };
}

// ── POST /analyze ─────────────────────────────────────────────────────────────
composabilityRouter.post('/analyze', async (req: Request, res: Response) => {
  try {
    const body = analyzeSchema.parse(req.body);
    const ts = body.timestamp ? new Date(body.timestamp) : new Date();
    const r = await analyzeAndPersist(
      body.txHash,
      body.ledgerSeq,
      ts,
      body.contractCalls as ContractCall[],
    );
    res.json({
      txHash: body.txHash,
      safetyScore: r.safetyScore,
      riskLevel: r.riskLevel,
      patterns: r.patterns,
      verification: r.verification,
      callGraph: r.callGraph,
    });
  } catch (e: any) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
    res.status(500).json({ error: String(e.message) });
  }
});

// ── POST /analyze/batch ───────────────────────────────────────────────────────
composabilityRouter.post('/analyze/batch', async (req: Request, res: Response) => {
  try {
    const items = z.array(analyzeSchema).parse(req.body);
    const results = await Promise.all(
      items.map(async (b) => {
        const ts = b.timestamp ? new Date(b.timestamp) : new Date();
        const r = await analyzeAndPersist(
          b.txHash,
          b.ledgerSeq,
          ts,
          b.contractCalls as ContractCall[],
        );
        return {
          txHash: b.txHash,
          safetyScore: r.safetyScore,
          riskLevel: r.riskLevel,
          patternCount: r.patterns.length,
        };
      }),
    );
    res.json({ processed: results.length, results });
  } catch (e: any) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
    res.status(500).json({ error: String(e.message) });
  }
});

// ── GET /transactions/:txHash ─────────────────────────────────────────────────
composabilityRouter.get(
  '/transactions/:txHash',
  asyncHandler(async (req: Request, res: Response) => {
    const tx = await prismaRead.composedTransaction.findUnique({
      where: { txHash: req.params.txHash },
      include: { patterns: { include: { pattern: true } } },
    });
    if (!tx) return res.status(404).json({ error: 'Not found' });
    res.json(tx);
  }),
);

// ── GET /contracts/:address ───────────────────────────────────────────────────
composabilityRouter.get(
  '/contracts/:address',
  asyncHandler(async (req: Request, res: Response) => {
    const profile = await prismaRead.contractComposability.findUnique({
      where: { contractAddress: req.params.address },
    });
    if (!profile) return res.status(404).json({ error: 'Not found' });
    res.json(profile);
  }),
);

// ── GET /contracts/:address/patterns ─────────────────────────────────────────
composabilityRouter.get(
  '/contracts/:address/patterns',
  asyncHandler(async (req: Request, res: Response) => {
    const instances = await prismaRead.compositionPatternInstance.findMany({
      where: {
        transaction: { contractCalls: { path: ['$[*].from'], array_contains: req.params.address } },
      },
      include: { pattern: true },
      take: 50,
    });
    res.json(instances);
  }),
);

// ── GET /contracts/:address/callers ───────────────────────────────────────────
composabilityRouter.get(
  '/contracts/:address/callers',
  asyncHandler(async (req: Request, res: Response) => {
    const profile = await prismaRead.contractComposability.findUnique({
      where: { contractAddress: req.params.address },
    });
    res.json({
      contractAddress: req.params.address,
      uniqueCallers: profile?.uniqueCallers ?? 0,
      composedWith: profile?.composedWith ?? [],
    });
  }),
);

// ── GET /contracts/:address/callees ───────────────────────────────────────────
composabilityRouter.get(
  '/contracts/:address/callees',
  asyncHandler(async (req: Request, res: Response) => {
    const profile = await prismaRead.contractComposability.findUnique({
      where: { contractAddress: req.params.address },
    });
    res.json({ contractAddress: req.params.address, uniqueCallees: profile?.uniqueCallees ?? 0 });
  }),
);

// ── GET /patterns ─────────────────────────────────────────────────────────────
composabilityRouter.get(
  '/patterns',
  asyncHandler(async (_req: Request, res: Response) => {
    const patterns = await prismaRead.compositionPattern.findMany({
      orderBy: { riskRating: 'asc' },
    });
    res.json(patterns);
  }),
);

// ── GET /patterns/:id ─────────────────────────────────────────────────────────
composabilityRouter.get(
  '/patterns/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const pattern = await prismaRead.compositionPattern.findUnique({
      where: { id: req.params.id },
      include: { instances: { take: 20, orderBy: { createdAt: 'desc' } } },
    });
    if (!pattern) return res.status(404).json({ error: 'Not found' });
    res.json(pattern);
  }),
);

// ── POST /patterns ────────────────────────────────────────────────────────────
composabilityRouter.post('/patterns', async (req: Request, res: Response) => {
  try {
    const body = z
      .object({
        name: z.string(),
        description: z.string(),
        category: z.string(),
        riskRating: z.enum(['safe', 'low_risk', 'medium_risk', 'high_risk', 'critical']).optional(),
        requiredCalls: z.number().int().optional(),
        detectionRules: z.unknown().optional(),
        safeIf: z.unknown().optional(),
        mitigationGuide: z.string().optional(),
      })
      .parse(req.body);
    const pattern = await prismaWrite.compositionPattern.create({
      data: {
        ...body,
        detectionRules: (body.detectionRules as object) ?? undefined,
        safeIf: (body.safeIf as object) ?? undefined,
      },
    });
    res.status(201).json(pattern);
  } catch (e: any) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
    res.status(500).json({ error: String(e.message) });
  }
});

// ── POST /static-analyze/:address ────────────────────────────────────────────
composabilityRouter.post('/static-analyze/:address', async (req: Request, res: Response) => {
  try {
    const addr = req.params.address;
    const contract = await prismaRead.contract.findUnique({
      where: { address: addr },
      select: { functionSignatures: true, abi: true },
    });
    const fns = contract?.functionSignatures as Array<{ name: string }> | null;
    const abi = contract?.abi as { functions?: Array<{ name: string }> } | null;
    const result = performStaticAnalysis(addr, fns, abi);

    const saved = await prismaWrite.composabilityStaticAnalysis.upsert({
      where: { contractAddress: addr },
      update: {
        externalCalls: result.externalCalls as object[],
        callGraph: result.callGraph as object,
        circularDeps: result.circularDeps as object[],
        hasUnboundedRecursion: result.hasUnboundedRecursion,
        maxCallDepth: result.maxCallDepth,
        analyzedAt: new Date(),
      },
      create: {
        contractAddress: addr,
        externalCalls: result.externalCalls as object[],
        callGraph: result.callGraph as object,
        circularDeps: result.circularDeps as object[],
        hasUnboundedRecursion: result.hasUnboundedRecursion,
        maxCallDepth: result.maxCallDepth,
      },
    });
    res.json(saved);
  } catch (e: any) {
    res.status(500).json({ error: String(e.message) });
  }
});

// ── GET /circular-dependencies ────────────────────────────────────────────────
composabilityRouter.get(
  '/circular-dependencies',
  asyncHandler(async (_req: Request, res: Response) => {
    const analyses = await prismaRead.composabilityStaticAnalysis.findMany({
      where: { hasUnboundedRecursion: true },
      select: { contractAddress: true, circularDeps: true, maxCallDepth: true, analyzedAt: true },
    });
    res.json(analyses);
  }),
);

// ── POST /verify/:txHash ──────────────────────────────────────────────────────
composabilityRouter.post('/verify/:txHash', async (req: Request, res: Response) => {
  try {
    const tx = await prismaRead.composedTransaction.findUnique({
      where: { txHash: req.params.txHash },
    });
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });

    const calls = (tx.contractCalls as unknown as ContractCall[]) ?? [];
    const callGraph = buildCallGraph(calls);
    const verification = verifyCompositionSafety(calls, callGraph);

    const saved = await prismaWrite.composabilityVerification.upsert({
      where: { txHash: req.params.txHash },
      update: {
        atomicity: verification.atomicity,
        authorization: verification.authorization,
        stateConsistency: verification.stateConsistency,
        reentrancyFree: verification.reentrancyFree,
        oracleFreshness: verification.oracleFreshness,
        atomicityScore: verification.scores.atomicity,
        authorizationScore: verification.scores.authorization,
        stateScore: verification.scores.stateConsistency,
        reentrancyScore: verification.scores.reentrancy,
        oracleScore: verification.scores.oracleFreshness,
        totalScore: verification.scores.total,
        proofData: verification.proofData as object,
        verified: verification.verified,
      },
      create: {
        txHash: req.params.txHash,
        atomicity: verification.atomicity,
        authorization: verification.authorization,
        stateConsistency: verification.stateConsistency,
        reentrancyFree: verification.reentrancyFree,
        oracleFreshness: verification.oracleFreshness,
        atomicityScore: verification.scores.atomicity,
        authorizationScore: verification.scores.authorization,
        stateScore: verification.scores.stateConsistency,
        reentrancyScore: verification.scores.reentrancy,
        oracleScore: verification.scores.oracleFreshness,
        totalScore: verification.scores.total,
        proofData: verification.proofData as object,
        verified: verification.verified,
      },
    });
    res.json(saved);
  } catch (e: any) {
    res.status(500).json({ error: String(e.message) });
  }
});

// ── GET /verify/:txHash/proof ─────────────────────────────────────────────────
composabilityRouter.get(
  '/verify/:txHash/proof',
  asyncHandler(async (req: Request, res: Response) => {
    const v = await prismaRead.composabilityVerification.findUnique({
      where: { txHash: req.params.txHash },
    });
    if (!v) return res.status(404).json({ error: 'No verification found for this tx' });
    res.json({
      txHash: req.params.txHash,
      verified: v.verified,
      proofData: v.proofData,
      generatedAt: v.createdAt,
    });
  }),
);

// ── GET /score/:txHash ────────────────────────────────────────────────────────
composabilityRouter.get(
  '/score/:txHash',
  asyncHandler(async (req: Request, res: Response) => {
    const tx = await prismaRead.composedTransaction.findUnique({
      where: { txHash: req.params.txHash },
      select: { safetyScore: true, riskLevel: true, analysisStatus: true },
    });
    if (!tx) return res.status(404).json({ error: 'Not found' });

    const verification = await prismaRead.composabilityVerification.findUnique({
      where: { txHash: req.params.txHash },
    });
    res.json({
      txHash: req.params.txHash,
      safetyScore: tx.safetyScore,
      riskLevel: tx.riskLevel,
      analysisStatus: tx.analysisStatus,
      breakdown: verification
        ? {
            atomicity: verification.atomicityScore,
            authorization: verification.authorizationScore,
            stateConsistency: verification.stateScore,
            reentrancy: verification.reentrancyScore,
            oracleFreshness: verification.oracleScore,
            total: verification.totalScore,
          }
        : null,
    });
  }),
);

// ── GET /report/:txHash ───────────────────────────────────────────────────────
composabilityRouter.get(
  '/report/:txHash',
  asyncHandler(async (req: Request, res: Response) => {
    const tx = await prismaRead.composedTransaction.findUnique({
      where: { txHash: req.params.txHash },
      include: { patterns: { include: { pattern: true } } },
    });
    if (!tx) return res.status(404).json({ error: 'Not found' });

    const verification = await prismaRead.composabilityVerification.findUnique({
      where: { txHash: req.params.txHash },
    });
    const format = (req.query.format as string) ?? 'json';

    const report = {
      txHash: req.params.txHash,
      ledgerSeq: tx.ledgerSeq,
      timestamp: tx.timestamp,
      safetyScore: tx.safetyScore,
      riskLevel: tx.riskLevel,
      callGraph: tx.callGraph,
      contractCalls: tx.contractCalls,
      patterns: tx.patterns.map((pi) => ({
        name: pi.pattern.name,
        category: pi.pattern.category,
        confidence: pi.confidence,
        riskRating: pi.pattern.riskRating,
        mitigationGuide: pi.pattern.mitigationGuide,
      })),
      verification: verification
        ? {
            atomicity: verification.atomicity,
            authorization: verification.authorization,
            stateConsistency: verification.stateConsistency,
            reentrancyFree: verification.reentrancyFree,
            oracleFreshness: verification.oracleFreshness,
            totalScore: verification.totalScore,
            verified: verification.verified,
          }
        : null,
      recommendations: tx.patterns.map((pi) => pi.pattern.mitigationGuide).filter(Boolean),
      generatedAt: new Date().toISOString(),
    };

    if (format === 'html') {
      res.setHeader('Content-Type', 'text/html');
      return res.send(
        `<!DOCTYPE html><html><head><title>Composability Report: ${req.params.txHash}</title><style>body{font-family:monospace;padding:2rem}pre{background:#f4f4f4;padding:1rem}</style></head><body><h1>Composability Report</h1><pre>${JSON.stringify(report, null, 2)}</pre></body></html>`,
      );
    }
    res.json(report);
  }),
);

// ── POST /exploit/check ───────────────────────────────────────────────────────
composabilityRouter.post('/exploit/check', async (req: Request, res: Response) => {
  try {
    const body = z.object({ contractCalls: z.array(callSchema) }).parse(req.body);
    const result = checkForExploit(body.contractCalls as ContractCall[]);
    if (result.exploitDetected) {
      await prismaWrite.compositionAlert.create({
        data: {
          severity: 'critical',
          title: `Pending exploit: ${result.exploitType}`,
          description: result.description ?? '',
          exploitDetected: true,
        },
      });
    }
    res.json(result);
  } catch (e: any) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
    res.status(500).json({ error: String(e.message) });
  }
});

// ── GET /exploit/detected ─────────────────────────────────────────────────────
composabilityRouter.get(
  '/exploit/detected',
  asyncHandler(async (_req: Request, res: Response) => {
    const alerts = await prismaRead.compositionAlert.findMany({
      where: { exploitDetected: true, mitigated: false },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { pattern: true },
    });
    res.json(alerts);
  }),
);

// ── POST /mitigate/:txHash ────────────────────────────────────────────────────
composabilityRouter.post(
  '/mitigate/:txHash',
  asyncHandler(async (req: Request, res: Response) => {
    const tx = await prismaRead.composedTransaction.findUnique({
      where: { txHash: req.params.txHash },
      include: { patterns: { include: { pattern: true } } },
    });
    if (!tx) return res.status(404).json({ error: 'Not found' });
    const calls = (tx.contractCalls as unknown as ContractCall[]) ?? [];
    const patterns = detectPatterns(calls);
    const patch = generateMitigationPatch(calls, patterns);

    await prismaWrite.compositionAlert.create({
      data: {
        txHash: req.params.txHash,
        severity: 'high',
        title: 'Mitigation patch generated',
        description: `Auto-generated patch for ${patterns.length} detected pattern(s)`,
        mitigationPatch: patch as object,
      },
    });
    res.json({ txHash: req.params.txHash, patch });
  }),
);

// ── POST /mitigate/:contractAddress (contract-level) ─────────────────────────
composabilityRouter.post(
  '/mitigate/contract/:contractAddress',
  asyncHandler(async (req: Request, res: Response) => {
    const addr = req.params.contractAddress;
    const recentTxs = await prismaRead.composedTransaction.findMany({
      where: { contractCalls: { path: ['$[*].to'], array_contains: addr } },
      take: 10,
      orderBy: { createdAt: 'desc' },
    });
    const allCalls = recentTxs.flatMap((t) => (t.contractCalls as unknown as ContractCall[]) ?? []);
    const patterns = detectPatterns(allCalls);
    const patch = generateMitigationPatch(allCalls, patterns);
    res.json({ contractAddress: addr, patternsFound: patterns.length, patch });
  }),
);

// ── POST /fuzz/:contractAddress ───────────────────────────────────────────────
composabilityRouter.post('/fuzz/:contractAddress', async (req: Request, res: Response) => {
  try {
    const iterations = Math.min(500, parseInt((req.query.iterations as string) ?? '100', 10));
    const addr = req.params.contractAddress;
    const { findings, coverage } = runFuzzCampaign(addr, iterations);

    const campaign = await prismaWrite.composabilityFuzzCampaign.create({
      data: {
        contractAddress: addr,
        status: 'completed',
        totalCases: iterations,
        unsafeFound: findings.length,
        coveragePct: coverage,
        findings: findings as object[],
        completedAt: new Date(),
      },
    });
    res.json({
      campaignId: campaign.id,
      contractAddress: addr,
      totalCases: iterations,
      unsafeFound: findings.length,
      coverage,
      findings: findings.slice(0, 20),
    });
  } catch (e: any) {
    res.status(500).json({ error: String(e.message) });
  }
});

// ── GET /fuzz/:campaignId ─────────────────────────────────────────────────────
composabilityRouter.get(
  '/fuzz/:campaignId',
  asyncHandler(async (req: Request, res: Response) => {
    const campaign = await prismaRead.composabilityFuzzCampaign.findUnique({
      where: { id: req.params.campaignId },
    });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    res.json(campaign);
  }),
);

// ── GET /fuzz/:campaignId/coverage ────────────────────────────────────────────
composabilityRouter.get(
  '/fuzz/:campaignId/coverage',
  asyncHandler(async (req: Request, res: Response) => {
    const campaign = await prismaRead.composabilityFuzzCampaign.findUnique({
      where: { id: req.params.campaignId },
      select: { id: true, coveragePct: true, totalCases: true, unsafeFound: true },
    });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    res.json(campaign);
  }),
);

// ── GET /exploit-database ─────────────────────────────────────────────────────
composabilityRouter.get(
  '/exploit-database',
  asyncHandler(async (req: Request, res: Response) => {
    const category = req.query.category as string | undefined;
    const exploits = await prismaRead.composabilityExploit.findMany({
      where: category ? { patternCategory: category } : undefined,
      orderBy: { discoveredAt: 'desc' },
      take: 50,
    });
    res.json(exploits);
  }),
);

// ── POST /exploit-database ────────────────────────────────────────────────────
composabilityRouter.post('/exploit-database', async (req: Request, res: Response) => {
  try {
    const body = z
      .object({
        title: z.string(),
        description: z.string(),
        patternCategory: z.string(),
        severity: z.enum(['critical', 'high', 'medium', 'low']),
        cveId: z.string().optional(),
        affectedContracts: z.array(z.string()).optional(),
        exploitTxHashes: z.array(z.string()).optional(),
        advisoryUrl: z.string().optional(),
      })
      .parse(req.body);
    const exploit = await prismaWrite.composabilityExploit.create({
      data: {
        ...body,
        affectedContracts: body.affectedContracts ?? [],
        exploitTxHashes: body.exploitTxHashes ?? [],
      },
    });
    res.status(201).json(exploit);
  } catch (e: any) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
    res.status(500).json({ error: String(e.message) });
  }
});

// ── GET /ecosystem-index ──────────────────────────────────────────────────────
composabilityRouter.get(
  '/ecosystem-index',
  asyncHandler(async (_req: Request, res: Response) => {
    const latest = await prismaRead.ecosystemComposabilityIndex.findFirst({
      orderBy: { computedAt: 'desc' },
    });
    if (latest) return res.json(latest);

    // Compute on the fly if no snapshot exists
    const [totalContracts, totalComposedTx, exploitCount, avgScore] = await Promise.all([
      prismaRead.contractComposability.count(),
      prismaRead.composedTransaction.count(),
      prismaRead.compositionAlert.count({ where: { exploitDetected: true } }),
      prismaRead.composedTransaction.aggregate({ _avg: { safetyScore: true } }),
    ]);
    const patterns = await prismaRead.compositionPattern.findMany({ select: { category: true } });
    const uniqueCategories = new Set(patterns.map((p) => p.category)).size;
    const score = computeEcosystemIndex({
      totalContracts,
      totalComposedTx,
      uniquePatternCategories: uniqueCategories,
      avgSafetyScore: avgScore._avg.safetyScore ?? 0,
      exploitCount,
      totalTx: totalComposedTx,
    });

    const snapshot = await prismaWrite.ecosystemComposabilityIndex.create({
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
    res.json(snapshot);
  }),
);

// ── GET /ecosystem-index/history ─────────────────────────────────────────────
composabilityRouter.get(
  '/ecosystem-index/history',
  asyncHandler(async (req: Request, res: Response) => {
    const limit = Math.min(100, parseInt((req.query.limit as string) ?? '30', 10));
    const history = await prismaRead.ecosystemComposabilityIndex.findMany({
      orderBy: { computedAt: 'desc' },
      take: limit,
    });
    res.json(history);
  }),
);

// ── GET /graph ────────────────────────────────────────────────────────────────
composabilityRouter.get(
  '/graph',
  asyncHandler(async (req: Request, res: Response) => {
    const riskLevel = req.query.riskLevel as string | undefined;
    const limit = Math.min(200, parseInt((req.query.limit as string) ?? '100', 10));
    const txs = await prismaRead.composedTransaction.findMany({
      where: riskLevel ? { riskLevel: riskLevel as any } : undefined,
      select: { txHash: true, callGraph: true, riskLevel: true, safetyScore: true },
      take: limit,
      orderBy: { createdAt: 'desc' },
    });

    const allNodes = new Map<string, { id: string; riskLevel: string | null }>();
    const allEdges: Array<{ from: string; to: string; method: string; txHash: string }> = [];

    for (const tx of txs) {
      const graph = tx.callGraph as {
        nodes?: Array<{ address: string }>;
        edges?: Array<{ from: string; to: string; method: string }>;
      } | null;
      if (!graph) continue;
      for (const n of graph.nodes ?? [])
        allNodes.set(n.address, { id: n.address, riskLevel: tx.riskLevel });
      for (const e of graph.edges ?? []) allEdges.push({ ...e, txHash: tx.txHash });
    }

    res.json({ nodes: Array.from(allNodes.values()), edges: allEdges, totalTx: txs.length });
  }),
);

// ── GET /leaderboard ──────────────────────────────────────────────────────────
composabilityRouter.get(
  '/leaderboard',
  asyncHandler(async (_req: Request, res: Response) => {
    const top = await prismaRead.contractComposability.findMany({
      orderBy: { compositionCount: 'desc' },
      take: 20,
      select: {
        contractAddress: true,
        compositionCount: true,
        uniqueCallers: true,
        uniqueCallees: true,
        safetyScoreAvg: true,
        riskIncidents: true,
      },
    });
    res.json(top);
  }),
);

// ── POST /alerts ──────────────────────────────────────────────────────────────
composabilityRouter.post('/alerts', async (req: Request, res: Response) => {
  try {
    const body = z
      .object({
        contractAddress: z.string().optional(),
        severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
        webhookUrl: z.string().url().optional(),
      })
      .parse(req.body);
    // Store alert subscription in CompositionAlert as a subscription marker
    const alert = await prismaWrite.compositionAlert.create({
      data: {
        contractAddress: body.contractAddress,
        severity: body.severity ?? 'high',
        title: 'Alert subscription created',
        description: `Subscribed to composability alerts${body.contractAddress ? ` for ${body.contractAddress}` : ''}`,
        mitigationPatch: body.webhookUrl ? ({ webhookUrl: body.webhookUrl } as object) : undefined,
      },
    });
    res
      .status(201)
      .json({
        subscriptionId: alert.id,
        contractAddress: body.contractAddress,
        severity: body.severity ?? 'high',
      });
  } catch (e: any) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
    res.status(500).json({ error: String(e.message) });
  }
});

// ── GET /digest ───────────────────────────────────────────────────────────────
composabilityRouter.get(
  '/digest',
  asyncHandler(async (_req: Request, res: Response) => {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [totalTx, criticalAlerts, newPatterns, eci] = await Promise.all([
      prismaRead.composedTransaction.count({ where: { createdAt: { gte: since } } }),
      prismaRead.compositionAlert.count({
        where: { severity: 'critical', createdAt: { gte: since } },
      }),
      prismaRead.compositionPattern.count({ where: { createdAt: { gte: since } } }),
      prismaRead.ecosystemComposabilityIndex.findFirst({ orderBy: { computedAt: 'desc' } }),
    ]);
    res.json({
      period: 'last_7_days',
      totalComposedTransactions: totalTx,
      criticalAlerts,
      newPatternsDetected: newPatterns,
      ecosystemIndex: eci?.score ?? null,
      generatedAt: new Date().toISOString(),
    });
  }),
);
