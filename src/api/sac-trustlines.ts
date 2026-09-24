/**
 * SAC Trustlines API Router
 *
 * Stellar Asset Contract (SAC) trustline management. Tracks trustline
 * creation, balance updates, authorization flags, and clawback operations
 * for SAC-wrapped Stellar assets.
 *
 * All GET endpoints read real data from the sacTrustlineMapping table via
 * the mapper query helpers in src/indexer/sac-trustline-mapper.ts.
 *
 * POST /authorize and POST /revoke validate input and return the parameters
 * needed to build and submit a Stellar transaction; they do not themselves
 * sign or submit anything.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';
import {
  getTrustlinesByAccount,
  getTrustlinesBySac,
  getSacTrustlineStats,
} from '../indexer/sac-trustline-mapper';
import { prismaRead as prisma } from '../db';

export const sacTrustlinesRouter = Router();

// ── GET / ─────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /sac-trustlines:
 *   get:
 *     summary: SAC trustlines service overview
 *     tags: [SAC Trustlines]
 *     responses:
 *       200:
 *         description: Service info
 */
sacTrustlinesRouter.get('/', (_req: Request, res: Response) => {
  res.json({
    service: 'SAC Trustlines API',
    description: 'Stellar Asset Contract trustline management and authorization tracking',
    endpoints: [
      'GET  /sac-trustlines',
      'GET  /sac-trustlines/assets/:assetCode',
      'GET  /sac-trustlines/accounts/:address',
      'GET  /sac-trustlines/accounts/:address/authorized',
      'POST /sac-trustlines/authorize',
      'POST /sac-trustlines/revoke',
      'GET  /sac-trustlines/stats',
    ],
  });
});

// ── GET /assets/:assetCode ─────────────────────────────────────────────────────

/**
 * @swagger
 * /sac-trustlines/assets/{assetCode}:
 *   get:
 *     summary: Get trustline holders for a SAC asset
 *     tags: [SAC Trustlines]
 *     parameters:
 *       - in: path
 *         name: assetCode
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: authorized
 *         schema: { type: boolean }
 *       - in: query
 *         name: limit
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Trustline holders list read from the indexer database
 */
sacTrustlinesRouter.get(
  '/assets/:assetCode',
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const { assetCode } = req.params;
      const authorized =
        req.query.authorized !== undefined ? req.query.authorized === 'true' : undefined;
      const limit = Math.min(200, parseInt((req.query.limit as string) ?? '50', 10));

      // Resolve the SAC address for this asset from the sacMapping table
      const sacMapping = await prisma.sacMapping.findFirst({
        where: { assetCode: assetCode.toUpperCase() },
      });

      let trustlines;
      if (sacMapping) {
        // Use the indexed SAC address to query trustlines
        trustlines = await getTrustlinesBySac(sacMapping.sacAddress, limit);
      } else {
        // Fall back to a direct query by assetCode in case the SAC mapping is
        // not yet indexed but individual trustline records exist
        const records = await prisma.sacTrustlineMapping.findMany({
          where: {
            assetCode: assetCode.toUpperCase(),
            ...(authorized !== undefined ? { status: authorized ? 'active' : 'deactivated' } : {}),
          },
          orderBy: { ledgerSequence: 'desc' },
          take: limit,
        });
        trustlines = records;
      }

      // Apply the `authorized` filter after fetch when using the mapper helper
      const filtered =
        authorized !== undefined
          ? trustlines.filter((t: any) =>
              authorized ? t.status === 'active' : t.status !== 'active',
            )
          : trustlines;

      res.json({
        assetCode: assetCode.toUpperCase(),
        sacAddress: sacMapping?.sacAddress ?? null,
        trustlines: filtered,
        total: filtered.length,
        limit,
        filter: { authorized },
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch trustlines for asset' });
    }
  }),
);

// ── GET /accounts/:address ──────────────────────────────────────────────────────

/**
 * @swagger
 * /sac-trustlines/accounts/{address}:
 *   get:
 *     summary: Get all SAC trustlines for an account
 *     tags: [SAC Trustlines]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Account trustlines read from the indexer database
 */
sacTrustlinesRouter.get(
  '/accounts/:address',
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const { address } = req.params;
      const limit = Math.min(200, parseInt((req.query.limit as string) ?? '50', 10));

      const trustlines = await getTrustlinesByAccount(address, limit);

      res.json({
        address,
        trustlines,
        total: trustlines.length,
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch trustlines for account' });
    }
  }),
);

// ── GET /accounts/:address/authorized ───────────────────────────────────────────

/**
 * @swagger
 * /sac-trustlines/accounts/{address}/authorized:
 *   get:
 *     summary: Get authorized trustlines for an account
 *     tags: [SAC Trustlines]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Active (authorized) trustlines for the account
 */
sacTrustlinesRouter.get(
  '/accounts/:address/authorized',
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const { address } = req.params;
      const limit = Math.min(200, parseInt((req.query.limit as string) ?? '50', 10));

      const all = await getTrustlinesByAccount(address, limit);
      const authorized = all.filter((t) => t.status === 'active');

      res.json({
        address,
        authorizedTrustlines: authorized,
        total: authorized.length,
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch authorized trustlines for account' });
    }
  }),
);

// ── POST /authorize ────────────────────────────────────────────────────────────

/**
 * @swagger
 * /sac-trustlines/authorize:
 *   post:
 *     summary: Build authorization parameters for a SAC trustline
 *     tags: [SAC Trustlines]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [assetCode, accountAddress, adminKey]
 *             properties:
 *               assetCode: { type: string }
 *               accountAddress: { type: string }
 *               adminKey: { type: string }
 *               authorizeFlags: { type: integer, minimum: 0, maximum: 3 }
 *     responses:
 *       200:
 *         description: Authorization parameters ready for Stellar network submission
 *       400:
 *         description: Validation error
 */
sacTrustlinesRouter.post(
  '/authorize',
  asyncHandler(async (req: Request, res: Response) => {
    const schema = z.object({
      assetCode: z.string().min(1).max(12),
      accountAddress: z.string().min(1),
      adminKey: z.string().min(1),
      authorizeFlags: z.number().int().min(0).max(3).default(1),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    // Look up the SAC mapping to enrich the response with the contract address
    const sacMapping = await prisma.sacMapping.findFirst({
      where: { assetCode: parsed.data.assetCode.toUpperCase() },
    });

    // Look up the current trustline state from the indexer
    const existingTrustlines = sacMapping
      ? await getTrustlinesBySac(sacMapping.sacAddress, 1000)
      : [];
    const existing = existingTrustlines.find((t) => t.gAccount === parsed.data.accountAddress);

    return res.json({
      ...parsed.data,
      sacAddress: sacMapping?.sacAddress ?? null,
      assetIssuer: sacMapping?.assetIssuer ?? null,
      operation: 'authorize_trustline',
      // The operation must be signed and submitted to the Stellar network by the caller.
      // This endpoint constructs the required parameters; it does not sign or submit.
      status: 'pending_submission',
      currentState: existing
        ? { status: existing.status, isUnlimited: existing.isUnlimited }
        : null,
      note: 'Build a SetTrustLineFlags operation with these parameters and submit to the Stellar network.',
      preparedAt: new Date().toISOString(),
    });
  }),
);

// ── POST /revoke ───────────────────────────────────────────────────────────────

/**
 * @swagger
 * /sac-trustlines/revoke:
 *   post:
 *     summary: Build revocation parameters for a SAC trustline
 *     tags: [SAC Trustlines]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [assetCode, accountAddress, adminKey]
 *             properties:
 *               assetCode: { type: string }
 *               accountAddress: { type: string }
 *               adminKey: { type: string }
 *               reason: { type: string }
 *     responses:
 *       200:
 *         description: Revocation parameters ready for Stellar network submission
 *       400:
 *         description: Validation error
 */
sacTrustlinesRouter.post(
  '/revoke',
  asyncHandler(async (req: Request, res: Response) => {
    const schema = z.object({
      assetCode: z.string().min(1).max(12),
      accountAddress: z.string().min(1),
      adminKey: z.string().min(1),
      reason: z.string().optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    // Look up the SAC mapping to enrich the response with the contract address
    const sacMapping = await prisma.sacMapping.findFirst({
      where: { assetCode: parsed.data.assetCode.toUpperCase() },
    });

    // Look up the current trustline state from the indexer
    const existingTrustlines = sacMapping
      ? await getTrustlinesBySac(sacMapping.sacAddress, 1000)
      : [];
    const existing = existingTrustlines.find((t) => t.gAccount === parsed.data.accountAddress);

    return res.json({
      ...parsed.data,
      sacAddress: sacMapping?.sacAddress ?? null,
      assetIssuer: sacMapping?.assetIssuer ?? null,
      operation: 'revoke_trustline',
      // The operation must be signed and submitted to the Stellar network by the caller.
      status: 'pending_submission',
      currentState: existing
        ? { status: existing.status, isUnlimited: existing.isUnlimited }
        : null,
      note: 'Build a SetTrustLineFlags operation with these parameters and submit to the Stellar network.',
      preparedAt: new Date().toISOString(),
    });
  }),
);

// ── GET /stats ─────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /sac-trustlines/stats:
 *   get:
 *     summary: Get SAC trustline statistics from the indexer
 *     tags: [SAC Trustlines]
 *     responses:
 *       200:
 *         description: Aggregate trustline stats read from the indexer database
 */
sacTrustlinesRouter.get(
  '/stats',
  asyncHandler(async (_req: Request, res: Response) => {
    try {
      const stats = await getSacTrustlineStats();
      res.json({
        ...stats,
        computedAt: new Date().toISOString(),
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch SAC trustline statistics' });
    }
  }),
);
