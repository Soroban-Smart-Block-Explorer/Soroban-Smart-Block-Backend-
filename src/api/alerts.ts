import { Router, Request, Response } from 'express';
import { detectSpikes } from '../indexer/spikeDetector';
import { detectFlashLoans } from '../indexer/flashLoanDetector';
import { DRAIN_EXPLOIT_WARNING } from '../indexer/reentrancy-detector';
import { prismaRead as prisma } from '../db';
import { asyncHandler } from '../middleware/asyncHandler';

/**
 * @swagger
 * tags:
 *   name: Alerts
 *   description: Real-time anomaly detection alerts
 */

export const alertsRouter = Router();

/**
 * @swagger
 * /api/v1/alerts/spikes:
 *   get:
 *     summary: Detect transaction volume spikes per contract
 *     tags: [Alerts]
 *     parameters:
 *       - in: query
 *         name: window
 *         schema:
 *           type: integer
 *           default: 5
 *         description: Observation window in minutes
 *       - in: query
 *         name: history
 *         schema:
 *           type: integer
 *           default: 12
 *         description: Number of prior windows used for baseline
 *       - in: query
 *         name: threshold
 *         schema:
 *           type: number
 *           default: 3.0
 *         description: Z-score threshold to trigger an alert
 *     responses:
 *       200:
 *         description: List of spike alerts
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 alerts:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       contractAddress: { type: string }
 *                       currentCount: { type: integer }
 *                       baseline: { type: number }
 *                       stdDev: { type: number }
 *                       zScore: { type: number }
 *                       windowMinutes: { type: integer }
 *                       detectedAt: { type: string, format: date-time }
 */
alertsRouter.get(
  '/spikes',
  asyncHandler(async (req: Request, res: Response) => {
    const window = Math.max(1, parseInt(String(req.query.window ?? '5'), 10));
    const history = Math.max(1, parseInt(String(req.query.history ?? '12'), 10));
    const threshold = parseFloat(String(req.query.threshold ?? '3.0'));

    const alerts = await detectSpikes(window, history, isNaN(threshold) ? 3.0 : threshold);
    res.json({ alerts });
  }),
);

/**
 * @swagger
 * /api/v1/alerts/flash-loans:
 *   get:
 *     summary: Detect flash loan attack signatures
 *     tags: [Alerts]
 *     parameters:
 *       - in: query
 *         name: ledger
 *         schema:
 *           type: integer
 *         description: Specific ledger to analyze (latest if omitted)
 *     responses:
 *       200:
 *         description: Flash loan alerts
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 alerts:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       ledger: { type: integer }
 *                       poolAddress: { type: string }
 *                       borrowAmount: { type: string }
 *                       returnAmount: { type: string }
 *                       variance: { type: number }
 *                       severity: { type: string, enum: [low, medium, high] }
 *                       transactions: { type: array, items: { type: string } }
 */
alertsRouter.get(
  '/flash-loans',
  asyncHandler(async (req: Request, res: Response) => {
    let ledger = parseInt(String(req.query.ledger ?? '0'), 10);

    if (ledger === 0) {
      const latest = await prisma.ledger.findFirst({
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      });
      ledger = latest?.sequence ?? 0;
    }

    if (ledger === 0) {
      return res.json({ alerts: [] });
    }

    const alerts = await detectFlashLoans(ledger);
    res.json({ alerts });
  }),
);

/**
 * @swagger
 * /api/v1/alerts/reentrancy:
 *   get:
 *     summary: List re-entrancy and drain attack alerts
 *     tags: [Alerts]
 *     parameters:
 *       - in: query
 *         name: contract
 *         schema: { type: string }
 *         description: Filter by contract address
 *       - in: query
 *         name: severity
 *         schema: { type: string, enum: [low, medium, high] }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200:
 *         description: Re-entrancy alerts
 */
alertsRouter.get(
  '/reentrancy',
  asyncHandler(async (req: Request, res: Response) => {
    const contract = req.query.contract ? String(req.query.contract) : undefined;
    const severity = req.query.severity ? String(req.query.severity) : undefined;
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10)));

    const alerts = await prisma.reentrancyAlert.findMany({
      where: {
        ...(contract ? { contractAddress: contract } : {}),
        ...(severity ? { severity } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    // Attach the canonical warning label to every alert for API consumers
    const annotated = alerts.map((a) => ({ ...a, warningLabel: DRAIN_EXPLOIT_WARNING }));

    res.json({ alerts: annotated });
  }),
);

/**
 * @swagger
 * /api/v1/alerts/volume:
 *   get:
 *     summary: List persisted volume spike alerts
 *     tags: [Alerts]
 *     parameters:
 *       - in: query
 *         name: contract
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: acknowledged
 *         schema: { type: boolean }
 *     responses:
 *       200:
 *         description: Volume spike alerts
 */
alertsRouter.get(
  '/volume',
  asyncHandler(async (req: Request, res: Response) => {
    const contract = req.query.contract ? String(req.query.contract) : undefined;
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10)));
    const acknowledged =
      req.query.acknowledged !== undefined ? req.query.acknowledged === 'true' : undefined;

    const alerts = await prisma.volumeAlert.findMany({
      where: {
        ...(contract ? { contractAddress: contract } : {}),
        ...(acknowledged !== undefined ? { acknowledged } : {}),
      },
      orderBy: { detectedAt: 'desc' },
      take: limit,
    });

    res.json({ alerts });
  }),
);

/**
 * PATCH /api/v1/alerts/volume/:id/acknowledge — mark a volume alert as acknowledged
 */
alertsRouter.patch('/volume/:id/acknowledge', async (req: Request, res: Response) => {
  try {
    const alert = await prisma.volumeAlert.update({
      where: { id: req.params.id },
      data: { acknowledged: true },
    });
    res.json(alert);
  } catch {
    res.status(404).json({ error: 'Alert not found' });
  }
});
