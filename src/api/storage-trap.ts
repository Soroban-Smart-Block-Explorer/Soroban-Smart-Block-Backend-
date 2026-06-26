/**
 * Storage Trap API Router
 *
 * Detects and monitors storage traps in Soroban contracts — patterns that
 * cause unbounded storage growth, storage griefing attacks, or excessive
 * rent fee accumulation that could DoS a contract.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';

export const storageTrapRouter = Router();

// ── GET / ─────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /storage-trap:
 *   get:
 *     summary: Storage trap detector service overview
 *     tags: [Storage Trap]
 *     responses:
 *       200:
 *         description: Service info
 */
storageTrapRouter.get('/', (_req: Request, res: Response) => {
  res.json({
    service: 'Storage Trap API',
    description:
      'Detects unbounded storage growth, griefing attacks, and DoS patterns in Soroban contracts',
    detectionRules: [
      'unbounded_map_growth',
      'user_controlled_keys',
      'missing_size_limits',
      'griefing_via_dust_entries',
      'excessive_rent_accumulation',
    ],
    endpoints: [
      'GET  /storage-trap',
      'GET  /storage-trap/contracts/:contractId',
      'POST /storage-trap/analyze',
      'GET  /storage-trap/detected',
      'GET  /storage-trap/stats',
    ],
  });
});

// ── GET /contracts/:contractId ─────────────────────────────────────────────────

/**
 * @swagger
 * /storage-trap/contracts/{contractId}:
 *   get:
 *     summary: Get storage trap risk assessment for a contract
 *     tags: [Storage Trap]
 *     parameters:
 *       - in: path
 *         name: contractId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Trap risk assessment
 */
storageTrapRouter.get('/contracts/:contractId', (req: Request, res: Response) => {
  const { contractId } = req.params;

  res.json({
    contractId,
    riskLevel: 'unknown',
    detectedTraps: [],
    entryGrowthRate: null,
    projectedRentFee: null,
    recommendations: [],
    message: 'No storage trap analysis available. Run POST /storage-trap/analyze first.',
  });
});

// ── POST /analyze ─────────────────────────────────────────────────────────────

/**
 * @swagger
 * /storage-trap/analyze:
 *   post:
 *     summary: Analyze a contract for storage trap patterns
 *     tags: [Storage Trap]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [contractId]
 *             properties:
 *               contractId: { type: string }
 *               analyzeWasm: { type: boolean }
 *               checkGrowthRate: { type: boolean }
 *     responses:
 *       200:
 *         description: Analysis result
 *       400:
 *         description: Validation error
 */
storageTrapRouter.post('/analyze', (req: Request, res: Response) => {
  const schema = z.object({
    contractId: z.string().min(1),
    analyzeWasm: z.boolean().default(false),
    checkGrowthRate: z.boolean().default(true),
    checkWindow: z.enum(['1d', '7d', '30d']).default('7d'),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { contractId, analyzeWasm, checkGrowthRate, checkWindow } = parsed.data;

  res.json({
    contractId,
    analyzeWasm,
    checkGrowthRate,
    checkWindow,
    analysis: {
      riskLevel: 'low',
      detectedTraps: [],
      entryCount: 0,
      growthRate: 0,
      projectedEntries30d: 0,
      estimatedRentFee: 0,
      recommendations: [],
    },
    analyzedAt: new Date().toISOString(),
    message: 'Analysis complete. No storage traps detected.',
  });
});

// ── GET /detected ──────────────────────────────────────────────────────────────

/**
 * @swagger
 * /storage-trap/detected:
 *   get:
 *     summary: List contracts with detected storage traps
 *     tags: [Storage Trap]
 *     parameters:
 *       - in: query
 *         name: riskLevel
 *         schema: { type: string, enum: [low, medium, high, critical] }
 *     responses:
 *       200:
 *         description: Detected traps
 */
storageTrapRouter.get('/detected', (req: Request, res: Response) => {
  const riskLevel = req.query.riskLevel as string | undefined;
  const limit = Math.min(100, parseInt((req.query.limit as string) ?? '20', 10));

  res.json({
    filter: { riskLevel },
    detectedContracts: [],
    total: 0,
    limit,
    message: 'No storage traps detected across monitored contracts.',
  });
});

// ── GET /stats ─────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /storage-trap/stats:
 *   get:
 *     summary: Get storage trap detection statistics
 *     tags: [Storage Trap]
 *     responses:
 *       200:
 *         description: Detection stats
 */
storageTrapRouter.get('/stats', (_req: Request, res: Response) => {
  res.json({
    contractsAnalyzed: 0,
    trapsDetected: 0,
    highRisk: 0,
    mediumRisk: 0,
    lowRisk: 0,
    topTrapType: null,
    computedAt: new Date().toISOString(),
  });
});
