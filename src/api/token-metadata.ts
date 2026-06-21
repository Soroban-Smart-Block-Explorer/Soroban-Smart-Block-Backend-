/**
 * Token Metadata API
 *
 * Exposes the token-metadata micro-service over HTTP.
 *
 * Routes:
 *   GET  /token-metadata/:address
 *       Returns { symbol, name, decimals, source } for a Soroban token.
 *
 *   GET  /token-metadata/:address/format?amount=<integer>
 *       Formats a raw on-chain integer using the token's decimal config.
 *       e.g. ?amount=10000000 → "1.0000000 USDC"
 *
 *   POST /token-metadata/batch
 *       Body: { addresses: string[] }
 *       Returns a map of address → metadata (null if unresolvable).
 *
 *   DELETE /token-metadata/:address/cache
 *       Evicts a single address from the in-process cache.
 */

import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { z } from 'zod';
import {
  getTokenMetadata,
  formatTokenAmount,
  invalidateTokenMetadata,
  getTokenMetadataCacheSize,
} from '../indexer/token-metadata';

export const tokenMetadataRouter = Router();

// ─── GET /token-metadata/:address ────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/token-metadata/{address}:
 *   get:
 *     summary: Resolve token metadata for a Soroban contract address
 *     tags: [TokenMetadata]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *         description: Soroban contract address (C-address)
 *     responses:
 *       200:
 *         description: Token metadata
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 address:  { type: string }
 *                 symbol:   { type: string, nullable: true }
 *                 name:     { type: string, nullable: true }
 *                 decimals: { type: integer }
 *                 source:   { type: string, enum: [db, sac, rpc, classic] }
 *       404:
 *         description: Token metadata could not be resolved
 */
tokenMetadataRouter.get(
  '/:address',
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    const meta = await getTokenMetadata(address);
    if (!meta) {
      return res.status(404).json({
        error: 'Token metadata not found. The contract may not be a SEP-41 token.',
      });
    }
    res.json(meta);
  }),
);

// ─── GET /token-metadata/:address/format ─────────────────────────────────────

const formatQuerySchema = z.object({
  amount: z.string().regex(/^-?\d+$/, 'amount must be an integer string'),
});

/**
 * @swagger
 * /api/v1/token-metadata/{address}/format:
 *   get:
 *     summary: Format a raw on-chain integer amount using the token's decimal config
 *     tags: [TokenMetadata]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: amount
 *         required: true
 *         schema: { type: string }
 *         description: Raw integer amount as a string (e.g. "10000000")
 *     responses:
 *       200:
 *         description: Formatted amount
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 raw:       { type: string }
 *                 formatted: { type: string }
 *                 decimals:  { type: integer }
 *                 symbol:    { type: string, nullable: true }
 *       400:
 *         description: Invalid amount parameter
 */
tokenMetadataRouter.get(
  '/:address/format',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = formatQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten().fieldErrors });
    }

    const { address } = req.params;
    const raw = BigInt(parsed.data.amount);

    const meta = await getTokenMetadata(address);
    const decimals = meta?.decimals ?? 7;
    const symbol = meta?.symbol ?? null;

    const formatted = await formatTokenAmount(raw, address);

    res.json({
      raw: parsed.data.amount,
      formatted,
      decimals,
      symbol,
    });
  }),
);

// ─── POST /token-metadata/batch ──────────────────────────────────────────────

const batchBodySchema = z.object({
  addresses: z.array(z.string().min(1)).min(1).max(100),
});

/**
 * @swagger
 * /api/v1/token-metadata/batch:
 *   post:
 *     summary: Bulk-resolve token metadata for up to 100 addresses
 *     tags: [TokenMetadata]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               addresses:
 *                 type: array
 *                 items: { type: string }
 *                 maxItems: 100
 *     responses:
 *       200:
 *         description: Map of address → metadata (null if unresolvable)
 *       400:
 *         description: Validation error
 */
tokenMetadataRouter.post(
  '/batch',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = batchBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const results = await Promise.all(
      parsed.data.addresses.map(async (address) => {
        const meta = await getTokenMetadata(address);
        return [address, meta] as const;
      }),
    );

    res.json({ tokens: Object.fromEntries(results) });
  }),
);

// ─── DELETE /token-metadata/:address/cache ────────────────────────────────────

/**
 * @swagger
 * /api/v1/token-metadata/{address}/cache:
 *   delete:
 *     summary: Evict a token's metadata from the in-process cache
 *     tags: [TokenMetadata]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       204:
 *         description: Cache entry evicted
 */
tokenMetadataRouter.delete('/:address/cache', (req: Request, res: Response) => {
  invalidateTokenMetadata(req.params.address);
  res.status(204).send();
});

// ─── GET /token-metadata/_cache/stats ────────────────────────────────────────

tokenMetadataRouter.get('/_cache/stats', (_req: Request, res: Response) => {
  res.json({ size: getTokenMetadataCacheSize() });
});
