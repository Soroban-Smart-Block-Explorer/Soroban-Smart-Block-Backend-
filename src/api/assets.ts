import { Router, Request, Response } from 'express';
import { computeAssetMetrics } from '../indexer/assetTracker';
import { asyncHandler } from '../middleware/asyncHandler';

/**
 * @swagger
 * tags:
 *   name: Assets
 *   description: Token asset tracking and valuation metrics
 */

export const assetsRouter = Router();

/**
 * @swagger
 * /api/v1/assets/metrics:
 *   get:
 *     summary: Compute live token storage metrics for all SAC-mapped assets
 *     description: >
 *       Loops through contract balance keys to compute total live token storage metrics.
 *       Cross-references token volumes against public exchange pricing APIs to convert
 *       token quantities into standardised fiat or XLM valuations.
 *     tags: [Assets]
 *     responses:
 *       200:
 *         description: Asset metrics with fiat/XLM valuations
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 assets:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       contractAddress: { type: string }
 *                       assetCode: { type: string, nullable: true }
 *                       assetIssuer: { type: string, nullable: true }
 *                       totalEvents: { type: integer }
 *                       totalTransactions: { type: integer }
 *                       estimatedVolume: { type: number }
 *                       volumeXlm: { type: number, nullable: true }
 *                       volumeUsd: { type: number, nullable: true }
 *                       priceXlm: { type: number, nullable: true }
 *                       priceUsd: { type: number, nullable: true }
 *                       lastActivityAt: { type: string, format: date-time, nullable: true }
 */
assetsRouter.get(
  '/metrics',
  asyncHandler(async (_req: Request, res: Response) => {
    const assets = await computeAssetMetrics();
    res.json({ assets });
  }),
);
