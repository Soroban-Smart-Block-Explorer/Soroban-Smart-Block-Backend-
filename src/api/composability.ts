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

/**
 * @swagger
 * /api/v1/composability/analyze:
 *   post:
 *     tags: [Composability]
 *     summary: Analyse a composed transaction's call graph
 *     description: Classifies patterns, scores safety, persists results, and broadcasts WebSocket events. If an exploit is detected a CompositionAlert is also created and broadcast.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [txHash, contractCalls]
 *             properties:
 *               txHash: { type: string }
 *               ledgerSeq: { type: integer, default: 0 }
 *               timestamp: { type: string, format: date-time }
 *               contractCalls:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [from, to, method]
 *                   properties:
 *                     from: { type: string }
 *                     to: { type: string }
 *                     method: { type: string }
 *                     args: { type: array, items: {} }
 *           example:
 *             txHash: "3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566"
 *             ledgerSeq: 3168075
 *             contractCalls:
 *               - { from: "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI", to: "CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5", method: "swap", args: ["1000000000"] }
 *     responses:
 *       200:
 *         description: Analysis result with safety score, detected patterns, and call graph
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 txHash: { type: string }
 *                 safetyScore: { type: number }
 *                 riskLevel: { type: string }
 *                 patterns: { type: array, items: { type: object } }
 *                 verification: { type: object }
 *                 callGraph: { type: object }
 *             example:
 *               txHash: "3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566"
 *               safetyScore: 85.5
 *               riskLevel: "low_risk"
 *               patterns: []
 *               verification: { atomicity: true, reentrancyFree: true, scores: { total: 85.5 } }
 *               callGraph: { nodes: [{ address: "CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5" }], edges: [] }
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ZodValidationError' }
 *             example: { error: [{ code: "invalid_type", path: ["txHash"], message: "Required" }] }
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { error: "Database connection failed" }
 */
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

/**
 * @swagger
 * /api/v1/composability/analyze/batch:
 *   post:
 *     tags: [Composability]
 *     summary: Analyse multiple composed transactions in one request
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: array
 *             items:
 *               type: object
 *               required: [txHash, contractCalls]
 *               properties:
 *                 txHash: { type: string }
 *                 ledgerSeq: { type: integer }
 *                 timestamp: { type: string, format: date-time }
 *                 contractCalls:
 *                   type: array
 *                   items:
 *                     type: object
 *                     required: [from, to, method]
 *                     properties:
 *                       from: { type: string }
 *                       to: { type: string }
 *                       method: { type: string }
 *                       args: { type: array, items: {} }
 *           example:
 *             - txHash: "3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566"
 *               contractCalls: [{ from: "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI", to: "CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5", method: "swap" }]
 *     responses:
 *       200:
 *         description: Summary results for each transaction
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 processed: { type: integer }
 *                 results:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       txHash: { type: string }
 *                       safetyScore: { type: number }
 *                       riskLevel: { type: string }
 *                       patternCount: { type: integer }
 *             example:
 *               processed: 1
 *               results:
 *                 - { txHash: "3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566", safetyScore: 85.5, riskLevel: "low_risk", patternCount: 0 }
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ZodValidationError' }
 *             example: { error: [{ code: "invalid_type", path: [0, "txHash"], message: "Required" }] }
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { error: "Database connection failed" }
 */
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

/**
 * @swagger
 * /api/v1/composability/transactions/{txHash}:
 *   get:
 *     tags: [Composability]
 *     summary: Composed transaction with detected pattern instances
 *     parameters:
 *       - in: path
 *         name: txHash
 *         required: true
 *         schema: { type: string }
 *         example: "3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566"
 *     responses:
 *       200:
 *         description: ComposedTransaction including nested pattern instances and patterns
 *         content:
 *           application/json:
 *             schema: { allOf: [{ $ref: '#/components/schemas/ComposedTransaction' }] }
 *             example: { id: "clz9q1x4t0000s6h2comptx01", txHash: "3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566", ledgerSeq: 3168075, safetyScore: 85.5, riskLevel: "low_risk", analysisStatus: "completed", patterns: [], createdAt: "2026-06-19T07:24:26.000Z" }
 *       404:
 *         description: Transaction not found
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { error: "Not found" }
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { error: "Internal server error" }
 */
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

/**
 * @swagger
 * /api/v1/composability/contracts/{address}:
 *   get:
 *     tags: [Composability]
 *     summary: Composability profile for a contract
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *         example: "CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5"
 *     responses:
 *       200:
 *         description: Caller/callee counts, safety averages, and risk incidents
 *         content:
 *           application/json:
 *             schema: { allOf: [{ $ref: '#/components/schemas/ContractComposabilityProfile' }] }
 *             example: { id: "clz9q1x4t0000s6h2comprf01", contractAddress: "CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5", compositionCount: 42, uniqueCallers: 8, uniqueCallees: 3, safetyScoreAvg: 88.5, riskIncidents: 1, lastAnalyzed: "2026-06-19T07:24:26.000Z" }
 *       404:
 *         description: Profile not found
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { error: "Not found" }
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { error: "Internal server error" }
 */
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

/**
 * @swagger
 * /api/v1/composability/contracts/{address}/patterns:
 *   get:
 *     tags: [Composability]
 *     summary: Pattern instances observed involving a contract
 *     description: Matches transactions where the contract appears as a caller (from address). Returns up to 50 most recent instances.
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *         example: "CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5"
 *     responses:
 *       200:
 *         description: Pattern instance records with embedded pattern metadata
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id: { type: string }
 *                   txId: { type: string }
 *                   patternId: { type: string }
 *                   confidence: { type: number }
 *                   details: { type: object, nullable: true }
 *                   createdAt: { type: string, format: date-time }
 *                   pattern: { $ref: '#/components/schemas/CompositionPattern' }
 *             example:
 *               - { id: "clz9q1x4t0000s6h2cpinst01", txId: "clz9q1x4t0000s6h2comptx01", patternId: "clz9q1x4t0000s6h2comppat1", confidence: 0.92, details: null, createdAt: "2026-06-19T07:24:26.000Z", pattern: { id: "clz9q1x4t0000s6h2comppat1", name: "flash_loan_reentry", category: "reentrancy", riskRating: "critical" } }
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { error: "Internal server error" }
 */
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

/**
 * @swagger
 * /api/v1/composability/contracts/{address}/callers:
 *   get:
 *     tags: [Composability]
 *     summary: Caller count and composition partners for a contract
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *         example: "CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5"
 *     responses:
 *       200:
 *         description: Returns zeros when no profile exists yet
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 contractAddress: { type: string }
 *                 uniqueCallers: { type: integer }
 *                 composedWith: { type: array, items: {} }
 *             example:
 *               contractAddress: "CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5"
 *               uniqueCallers: 8
 *               composedWith: []
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { error: "Internal server error" }
 */
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

/**
 * @swagger
 * /api/v1/composability/contracts/{address}/callees:
 *   get:
 *     tags: [Composability]
 *     summary: Callee count for a contract
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *         example: "CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5"
 *     responses:
 *       200:
 *         description: Returns zero when no profile exists yet
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 contractAddress: { type: string }
 *                 uniqueCallees: { type: integer }
 *             example:
 *               contractAddress: "CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5"
 *               uniqueCallees: 3
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { error: "Internal server error" }
 */
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

/**
 * @swagger
 * /api/v1/composability/patterns:
 *   get:
 *     tags: [Composability]
 *     summary: All catalogued composition patterns ordered by risk rating
 *     responses:
 *       200:
 *         description: Pattern catalogue
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { $ref: '#/components/schemas/CompositionPattern' }
 *             example:
 *               - { id: "clz9q1x4t0000s6h2comppat1", name: "flash_loan_reentry", category: "reentrancy", riskRating: "critical", mitigationGuide: "Add reentrancy guard", createdAt: "2026-06-19T07:24:26.000Z", updatedAt: "2026-06-19T07:24:26.000Z" }
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { error: "Internal server error" }
 *   post:
 *     tags: [Composability]
 *     summary: Add a new pattern to the catalogue
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, description, category]
 *             properties:
 *               name: { type: string }
 *               description: { type: string }
 *               category: { type: string }
 *               riskRating: { type: string, enum: [safe, low_risk, medium_risk, high_risk, critical] }
 *               requiredCalls: { type: integer }
 *               detectionRules: {}
 *               safeIf: {}
 *               mitigationGuide: { type: string }
 *           example:
 *             name: "oracle_price_manipulation"
 *             description: "Caller manipulates oracle price then immediately executes dependent swap"
 *             category: "oracle"
 *             riskRating: "high_risk"
 *             mitigationGuide: "Use TWAP oracle instead of spot price"
 *     responses:
 *       201:
 *         description: Pattern created
 *         content:
 *           application/json:
 *             schema: { allOf: [{ $ref: '#/components/schemas/CompositionPattern' }] }
 *             example: { id: "clz9q1x4t0000s6h2comppat2", name: "oracle_price_manipulation", category: "oracle", riskRating: "high_risk", createdAt: "2026-06-19T07:24:26.000Z", updatedAt: "2026-06-19T07:24:26.000Z" }
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ZodValidationError' }
 *             example: { error: [{ code: "invalid_type", path: ["name"], message: "Required" }] }
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { error: "Unique constraint failed on field: name" }
 */
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

/**
 * @swagger
 * /api/v1/composability/patterns/{id}:
 *   get:
 *     tags: [Composability]
 *     summary: Pattern detail with the 20 most recent instances
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         example: "clz9q1x4t0000s6h2comppat1"
 *     responses:
 *       200:
 *         description: Pattern record with nested instances
 *         content:
 *           application/json:
 *             schema: { allOf: [{ $ref: '#/components/schemas/CompositionPattern' }] }
 *             example: { id: "clz9q1x4t0000s6h2comppat1", name: "flash_loan_reentry", category: "reentrancy", riskRating: "critical", mitigationGuide: "Add reentrancy guard", instances: [], createdAt: "2026-06-19T07:24:26.000Z", updatedAt: "2026-06-19T07:24:26.000Z" }
 *       404:
 *         description: Pattern not found
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { error: "Not found" }
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { error: "Internal server error" }
 */
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

/**
 * @swagger
 * /api/v1/composability/static-analyze/{address}:
 *   post:
 *     tags: [Composability]
 *     summary: Run static analysis on a contract's function signatures
 *     description: Derives call graph and circular dependency info from the contract's ABI in the DB. Upserts the result.
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *         example: "CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5"
 *     responses:
 *       200:
 *         description: Static analysis record
 *         content:
 *           application/json:
 *             schema: { allOf: [{ $ref: '#/components/schemas/ComposabilityStaticAnalysis' }] }
 *             example: { id: "clz9q1x4t0000s6h2compsa01", contractAddress: "CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5", hasUnboundedRecursion: false, maxCallDepth: 3, analysisVersion: "1.0", analyzedAt: "2026-06-19T07:24:26.000Z" }
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { error: "Internal server error" }
 */
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

/**
 * @swagger
 * /api/v1/composability/circular-dependencies:
 *   get:
 *     tags: [Composability]
 *     summary: Contracts with detected unbounded recursion
 *     responses:
 *       200:
 *         description: Static analysis records where hasUnboundedRecursion is true
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   contractAddress: { type: string }
 *                   circularDeps: { type: array, nullable: true, items: {} }
 *                   maxCallDepth: { type: integer }
 *                   analyzedAt: { type: string, format: date-time }
 *             example:
 *               - { contractAddress: "CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5", circularDeps: [["swap", "flash_borrow"]], maxCallDepth: 12, analyzedAt: "2026-06-19T07:24:26.000Z" }
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { error: "Internal server error" }
 */
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

/**
 * @swagger
 * /api/v1/composability/verify/{txHash}:
 *   post:
 *     tags: [Composability]
 *     summary: Verify composition safety for a previously analysed transaction
 *     description: Loads the stored call graph, runs five safety checks, and upserts the verification record.
 *     parameters:
 *       - in: path
 *         name: txHash
 *         required: true
 *         schema: { type: string }
 *         example: "3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566"
 *     responses:
 *       200:
 *         description: Verification record with per-check scores
 *         content:
 *           application/json:
 *             schema: { allOf: [{ $ref: '#/components/schemas/ComposabilityVerification' }] }
 *             example: { id: "clz9q1x4t0000s6h2compvfy1", txHash: "3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566", atomicity: true, reentrancyFree: false, totalScore: 80.0, verified: false, createdAt: "2026-06-19T07:24:26.000Z" }
 *       404:
 *         description: Transaction not found
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { error: "Transaction not found" }
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { error: "Internal server error" }
 */
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

/**
 * @swagger
 * /api/v1/composability/verify/{txHash}/proof:
 *   get:
 *     tags: [Composability]
 *     summary: Verification proof data for a transaction
 *     parameters:
 *       - in: path
 *         name: txHash
 *         required: true
 *         schema: { type: string }
 *         example: "3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566"
 *     responses:
 *       200:
 *         description: Proof data from the verification record
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 txHash: { type: string }
 *                 verified: { type: boolean }
 *                 proofData: { type: object, nullable: true }
 *                 generatedAt: { type: string, format: date-time }
 *             example:
 *               txHash: "3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566"
 *               verified: false
 *               proofData: null
 *               generatedAt: "2026-06-19T07:24:26.000Z"
 *       404:
 *         description: No verification found for this transaction
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { error: "No verification found for this tx" }
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { error: "Internal server error" }
 */
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

/**
 * @swagger
 * /api/v1/composability/score/{txHash}:
 *   get:
 *     tags: [Composability]
 *     summary: Safety score and per-dimension breakdown for a transaction
 *     parameters:
 *       - in: path
 *         name: txHash
 *         required: true
 *         schema: { type: string }
 *         example: "3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566"
 *     responses:
 *       200:
 *         description: Score plus optional breakdown when a verification record exists
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 txHash: { type: string }
 *                 safetyScore: { type: number, nullable: true }
 *                 riskLevel: { type: string, nullable: true }
 *                 analysisStatus: { type: string }
 *                 breakdown:
 *                   type: object
 *                   nullable: true
 *                   properties:
 *                     atomicity: { type: number }
 *                     authorization: { type: number }
 *                     stateConsistency: { type: number }
 *                     reentrancy: { type: number }
 *                     oracleFreshness: { type: number }
 *                     total: { type: number }
 *             example:
 *               txHash: "3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566"
 *               safetyScore: 85.5
 *               riskLevel: "low_risk"
 *               analysisStatus: "completed"
 *               breakdown: { atomicity: 90.0, authorization: 95.0, stateConsistency: 80.0, reentrancy: 60.0, oracleFreshness: 75.0, total: 80.0 }
 *       404:
 *         description: Transaction not found
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { error: "Not found" }
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { error: "Internal server error" }
 */
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

/**
 * @swagger
 * /api/v1/composability/report/{txHash}:
 *   get:
 *     tags: [Composability]
 *     summary: Full composability report for a transaction
 *     parameters:
 *       - in: path
 *         name: txHash
 *         required: true
 *         schema: { type: string }
 *         example: "3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566"
 *       - in: query
 *         name: format
 *         schema: { type: string, enum: [json, html], default: json }
 *     responses:
 *       200:
 *         description: Full composability report (JSON by default; text/html when format=html)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 txHash: { type: string }
 *                 ledgerSeq: { type: integer }
 *                 timestamp: { type: string, format: date-time }
 *                 safetyScore: { type: number, nullable: true }
 *                 riskLevel: { type: string, nullable: true }
 *                 callGraph: { type: object, nullable: true }
 *                 contractCalls: { type: array, nullable: true, items: { type: object } }
 *                 patterns: { type: array, items: { type: object } }
 *                 verification: { type: object, nullable: true }
 *                 recommendations: { type: array, items: { type: string } }
 *                 generatedAt: { type: string, format: date-time }
 *             example:
 *               txHash: "3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566"
 *               ledgerSeq: 3168075
 *               safetyScore: 85.5
 *               riskLevel: "low_risk"
 *               patterns: []
 *               verification: null
 *               recommendations: []
 *               generatedAt: "2026-06-19T07:24:26.000Z"
 *           text/html:
 *             schema: { type: string }
 *       404:
 *         description: Transaction not found
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { error: "Not found" }
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { error: "Internal server error" }
 */
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

/**
 * @swagger
 * /api/v1/composability/exploit/check:
 *   post:
 *     tags: [Composability]
 *     summary: Check a call sequence for exploit patterns
 *     description: If an exploit is detected, a CompositionAlert is persisted with severity critical.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [contractCalls]
 *             properties:
 *               contractCalls:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [from, to, method]
 *                   properties:
 *                     from: { type: string }
 *                     to: { type: string }
 *                     method: { type: string }
 *                     args: { type: array, items: {} }
 *           example:
 *             contractCalls:
 *               - { from: "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI", to: "CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5", method: "flash_borrow" }
 *               - { from: "CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5", to: "CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5", method: "swap" }
 *     responses:
 *       200:
 *         description: Exploit detection result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 exploitDetected: { type: boolean }
 *                 exploitType: { type: string, nullable: true }
 *                 confidence: { type: number }
 *                 description: { type: string, nullable: true }
 *             example:
 *               exploitDetected: false
 *               exploitType: null
 *               confidence: 0.12
 *               description: null
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ZodValidationError' }
 *             example: { error: [{ code: "invalid_type", path: ["contractCalls"], message: "Required" }] }
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { error: "Internal server error" }
 */
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

/**
 * @swagger
 * /api/v1/composability/exploit/detected:
 *   get:
 *     tags: [Composability]
 *     summary: Active (unmitigated) exploit alerts
 *     responses:
 *       200:
 *         description: Up to 50 most recent unmitigated exploit alerts with related pattern
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { $ref: '#/components/schemas/CompositionAlert' }
 *             example:
 *               - { id: "clz9q1x4t0000s6h2compalrt", txHash: "3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566", severity: "critical", title: "Exploit: flash_loan_reentry", exploitDetected: true, mitigated: false, createdAt: "2026-06-19T07:24:26.000Z" }
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { error: "Internal server error" }
 */
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

/**
 * @swagger
 * /api/v1/composability/mitigate/{txHash}:
 *   post:
 *     tags: [Composability]
 *     summary: Generate a mitigation patch for a composed transaction
 *     description: Detects patterns from the stored call graph and generates a patch object. Persists a CompositionAlert with severity high.
 *     parameters:
 *       - in: path
 *         name: txHash
 *         required: true
 *         schema: { type: string }
 *         example: "3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566"
 *     responses:
 *       200:
 *         description: Generated mitigation patch
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 txHash: { type: string }
 *                 patch: { type: object }
 *             example:
 *               txHash: "3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566"
 *               patch: { recommendations: ["Add reentrancy guard"], severity: "high" }
 *       404:
 *         description: Transaction not found
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { error: "Not found" }
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { error: "Internal server error" }
 */
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

/**
 * @swagger
 * /api/v1/composability/mitigate/contract/{contractAddress}:
 *   post:
 *     tags: [Composability]
 *     summary: Generate a mitigation patch across the 10 most recent transactions involving a contract
 *     parameters:
 *       - in: path
 *         name: contractAddress
 *         required: true
 *         schema: { type: string }
 *         example: "CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5"
 *     responses:
 *       200:
 *         description: Aggregated mitigation patch
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 contractAddress: { type: string }
 *                 patternsFound: { type: integer }
 *                 patch: { type: object }
 *             example:
 *               contractAddress: "CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5"
 *               patternsFound: 2
 *               patch: { recommendations: ["Add reentrancy guard", "Use TWAP oracle"] }
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { error: "Internal server error" }
 */
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

/**
 * @swagger
 * /api/v1/composability/fuzz/{contractAddress}:
 *   post:
 *     tags: [Composability]
 *     summary: Run a composability fuzz campaign against a contract
 *     parameters:
 *       - in: path
 *         name: contractAddress
 *         required: true
 *         schema: { type: string }
 *         example: "CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5"
 *       - in: query
 *         name: iterations
 *         schema: { type: integer, default: 100, maximum: 500 }
 *     responses:
 *       200:
 *         description: Campaign summary with up to 20 findings
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 campaignId: { type: string }
 *                 contractAddress: { type: string }
 *                 totalCases: { type: integer }
 *                 unsafeFound: { type: integer }
 *                 coverage: { type: number }
 *                 findings: { type: array, items: { type: object } }
 *             example:
 *               campaignId: "clz9q1x4t0000s6h2compfuz1"
 *               contractAddress: "CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5"
 *               totalCases: 100
 *               unsafeFound: 3
 *               coverage: 0.72
 *               findings: []
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { error: "Internal server error" }
 */
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

/**
 * @swagger
 * /api/v1/composability/fuzz/{campaignId}:
 *   get:
 *     tags: [Composability]
 *     summary: Fuzz campaign record
 *     parameters:
 *       - in: path
 *         name: campaignId
 *         required: true
 *         schema: { type: string }
 *         example: "clz9q1x4t0000s6h2compfuz1"
 *     responses:
 *       200:
 *         description: Full fuzz campaign record including findings
 *         content:
 *           application/json:
 *             schema: { allOf: [{ $ref: '#/components/schemas/ComposabilityFuzzCampaign' }] }
 *             example: { id: "clz9q1x4t0000s6h2compfuz1", contractAddress: "CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5", status: "completed", totalCases: 100, unsafeFound: 3, coveragePct: 0.72, findings: [], completedAt: "2026-06-19T07:24:27.000Z" }
 *       404:
 *         description: Campaign not found
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { error: "Campaign not found" }
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { error: "Internal server error" }
 */
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

/**
 * @swagger
 * /api/v1/composability/fuzz/{campaignId}/coverage:
 *   get:
 *     tags: [Composability]
 *     summary: Coverage summary for a fuzz campaign
 *     parameters:
 *       - in: path
 *         name: campaignId
 *         required: true
 *         schema: { type: string }
 *         example: "clz9q1x4t0000s6h2compfuz1"
 *     responses:
 *       200:
 *         description: Coverage fields only (id, coveragePct, totalCases, unsafeFound)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: string }
 *                 coveragePct: { type: number }
 *                 totalCases: { type: integer }
 *                 unsafeFound: { type: integer }
 *             example: { id: "clz9q1x4t0000s6h2compfuz1", coveragePct: 0.72, totalCases: 100, unsafeFound: 3 }
 *       404:
 *         description: Campaign not found
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { error: "Campaign not found" }
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { error: "Internal server error" }
 */
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

/**
 * @swagger
 * /api/v1/composability/exploit-database:
 *   get:
 *     tags: [Composability]
 *     summary: Browse the composability exploit knowledge base
 *     parameters:
 *       - in: query
 *         name: category
 *         schema: { type: string }
 *         example: "reentrancy"
 *     responses:
 *       200:
 *         description: Up to 50 exploit entries, newest first
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { $ref: '#/components/schemas/ComposabilityExploit' }
 *             example:
 *               - { id: "clz9q1x4t0000s6h2compexp1", title: "StellarSwap Flash Loan Re-entry", patternCategory: "reentrancy", severity: "critical", affectedContracts: ["CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5"], exploitTxHashes: ["3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566"], discoveredAt: "2026-06-19T07:24:26.000Z" }
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { error: "Internal server error" }
 *   post:
 *     tags: [Composability]
 *     summary: Add an exploit entry to the knowledge base
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title, description, patternCategory, severity]
 *             properties:
 *               title: { type: string }
 *               description: { type: string }
 *               patternCategory: { type: string }
 *               severity: { type: string, enum: [critical, high, medium, low] }
 *               cveId: { type: string }
 *               affectedContracts: { type: array, items: { type: string } }
 *               exploitTxHashes: { type: array, items: { type: string } }
 *               advisoryUrl: { type: string }
 *           example:
 *             title: "StellarSwap Flash Loan Re-entry"
 *             description: "Attacker used flash loan to re-enter the swap function"
 *             patternCategory: "reentrancy"
 *             severity: "critical"
 *             affectedContracts: ["CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5"]
 *             exploitTxHashes: ["3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566"]
 *     responses:
 *       201:
 *         description: Exploit entry created
 *         content:
 *           application/json:
 *             schema: { allOf: [{ $ref: '#/components/schemas/ComposabilityExploit' }] }
 *             example: { id: "clz9q1x4t0000s6h2compexp1", title: "StellarSwap Flash Loan Re-entry", patternCategory: "reentrancy", severity: "critical", discoveredAt: "2026-06-19T07:24:26.000Z" }
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ZodValidationError' }
 *             example: { error: [{ code: "invalid_type", path: ["title"], message: "Required" }] }
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { error: "Internal server error" }
 */
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

/**
 * @swagger
 * /api/v1/composability/ecosystem-index:
 *   get:
 *     tags: [Composability]
 *     summary: Latest ecosystem composability health index
 *     description: Returns the most recent DB snapshot or computes and persists one on the fly if none exists.
 *     responses:
 *       200:
 *         description: Ecosystem index snapshot
 *         content:
 *           application/json:
 *             schema: { allOf: [{ $ref: '#/components/schemas/EcosystemComposabilityIndex' }] }
 *             example: { id: "clz9q1x4t0000s6h2ecoidx01", score: 74.5, compositionDiversity: 5, avgSafetyScore: 82.3, exploitIncidentRate: 0.002, protocolInterconnectivity: 4.7, totalContracts: 312, totalComposedTx: 1467, computedAt: "2026-06-19T07:24:26.000Z" }
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { error: "Internal server error" }
 */
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

/**
 * @swagger
 * /api/v1/composability/ecosystem-index/history:
 *   get:
 *     tags: [Composability]
 *     summary: Historical ecosystem index snapshots
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 30, maximum: 100 }
 *     responses:
 *       200:
 *         description: Index snapshots ordered newest-first
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { $ref: '#/components/schemas/EcosystemComposabilityIndex' }
 *             example:
 *               - { id: "clz9q1x4t0000s6h2ecoidx01", score: 74.5, avgSafetyScore: 82.3, totalContracts: 312, computedAt: "2026-06-19T07:24:26.000Z" }
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { error: "Internal server error" }
 */
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

/**
 * @swagger
 * /api/v1/composability/graph:
 *   get:
 *     tags: [Composability]
 *     summary: Aggregate cross-contract call graph across recent transactions
 *     parameters:
 *       - in: query
 *         name: riskLevel
 *         schema: { type: string, enum: [safe, low_risk, medium_risk, high_risk, critical] }
 *         example: "high_risk"
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 100, maximum: 200 }
 *     responses:
 *       200:
 *         description: Graph nodes (unique contract addresses) and directed edges from the merged call graphs
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 nodes:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       riskLevel: { type: string, nullable: true }
 *                 edges:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       from: { type: string }
 *                       to: { type: string }
 *                       method: { type: string }
 *                       txHash: { type: string }
 *                 totalTx: { type: integer }
 *             example:
 *               nodes: [{ id: "CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5", riskLevel: "low_risk" }]
 *               edges: [{ from: "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI", to: "CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5", method: "swap", txHash: "3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566" }]
 *               totalTx: 42
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { error: "Internal server error" }
 */
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

/**
 * @swagger
 * /api/v1/composability/leaderboard:
 *   get:
 *     tags: [Composability]
 *     summary: Top 20 most-composed contracts
 *     responses:
 *       200:
 *         description: Contract composability profiles ordered by composition count descending
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   contractAddress: { type: string }
 *                   compositionCount: { type: integer }
 *                   uniqueCallers: { type: integer }
 *                   uniqueCallees: { type: integer }
 *                   safetyScoreAvg: { type: number, nullable: true }
 *                   riskIncidents: { type: integer }
 *             example:
 *               - { contractAddress: "CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5", compositionCount: 142, uniqueCallers: 8, uniqueCallees: 3, safetyScoreAvg: 88.5, riskIncidents: 1 }
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { error: "Internal server error" }
 */
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

/**
 * @swagger
 * /api/v1/composability/alerts:
 *   post:
 *     tags: [Composability]
 *     summary: Subscribe to composability alerts
 *     description: Creates a subscription marker in CompositionAlert; does not fire immediately.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               contractAddress: { type: string }
 *               severity: { type: string, enum: [critical, high, medium, low] }
 *               webhookUrl: { type: string, format: uri }
 *           example:
 *             contractAddress: "CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5"
 *             severity: "high"
 *             webhookUrl: "https://hooks.example.com/composability"
 *     responses:
 *       201:
 *         description: Subscription created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 subscriptionId: { type: string }
 *                 contractAddress: { type: string, nullable: true }
 *                 severity: { type: string }
 *             example:
 *               subscriptionId: "clz9q1x4t0000s6h2compalrt"
 *               contractAddress: "CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5"
 *               severity: "high"
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ZodValidationError' }
 *             example: { error: [{ code: "invalid_string", path: ["webhookUrl"], message: "Invalid url" }] }
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { error: "Internal server error" }
 */
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

/**
 * @swagger
 * /api/v1/composability/digest:
 *   get:
 *     tags: [Composability]
 *     summary: Weekly composability digest
 *     responses:
 *       200:
 *         description: Composed transaction count, critical alerts, new patterns, and ecosystem index for the last 7 days
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 period: { type: string }
 *                 totalComposedTransactions: { type: integer }
 *                 criticalAlerts: { type: integer }
 *                 newPatternsDetected: { type: integer }
 *                 ecosystemIndex: { type: number, nullable: true }
 *                 generatedAt: { type: string, format: date-time }
 *             example:
 *               period: "last_7_days"
 *               totalComposedTransactions: 312
 *               criticalAlerts: 4
 *               newPatternsDetected: 2
 *               ecosystemIndex: 74.5
 *               generatedAt: "2026-06-19T07:24:26.000Z"
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { error: "Internal server error" }
 */
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
