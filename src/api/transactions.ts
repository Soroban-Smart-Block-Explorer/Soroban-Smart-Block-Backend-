import { Router, Request, Response } from 'express';
import { prismaRead as prisma } from '../db';
import { getBn254ExemptionByTx } from '../indexer/bn254-tracker';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';

/**
 * @swagger
 * tags:
 *   name: Transactions
 *   description: Indexed Soroban transactions with human-readable decoding
 */

export const transactionRouter = Router();

const TX_SELECT = {
  hash: true,
  ledgerSequence: true,
  ledgerCloseTime: true,
  sourceAccount: true,
  contractAddress: true,
  functionName: true,
  functionArgs: true,
  status: true,
  humanReadable: true,
  feeCharged: true,
  sorobanResources: true, // #48
  failureReason: true, // #49
  freezeViolation: true, // CAP-0077
};

const listSchema = z.object({
  // cursor-based (preferred for large datasets) — cursor = ledger number
  cursor: z.coerce.number().int().min(0).optional(),
  // offset-based fallback
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  // filters
  contract: z.string().optional(),
  account: z.string().optional(),
  status: z.string().optional(),
  ledgerMin: z.coerce.number().int().min(0).optional(),
  ledgerMax: z.coerce.number().int().min(0).optional(),
});

/**
 * @swagger
 * /api/v1/transactions:
 *   get:
 *     summary: List indexed transactions (cursor- or offset-paginated)
 *     tags: [Transactions]
 *     parameters:
 *       - in: query
 *         name: cursor
 *         schema: { type: integer, minimum: 0 }
 *         description: >-
 *           Ledger sequence cursor (preferred for large datasets). When set,
 *           returns rows with ledgerSequence < cursor in descending order and the
 *           response uses the cursor envelope.
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *         description: 1-based page number (offset pagination; ignored when cursor is set)
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
 *         description: Page size
 *       - in: query
 *         name: contract
 *         schema: { type: string }
 *         description: Filter by contract address (exact match)
 *       - in: query
 *         name: account
 *         schema: { type: string }
 *         description: Filter by source account
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *         description: Filter by status (success | failed)
 *       - in: query
 *         name: ledgerMin
 *         schema: { type: integer, minimum: 0 }
 *         description: Inclusive lower bound on ledger sequence
 *       - in: query
 *         name: ledgerMax
 *         schema: { type: integer, minimum: 0 }
 *         description: Inclusive upper bound on ledger sequence
 *     responses:
 *       200:
 *         description: >-
 *           Paginated transactions. Returns the cursor envelope when `cursor` is
 *           supplied, otherwise the offset envelope.
 *         content:
 *           application/json:
 *             schema:
 *               oneOf:
 *                 - title: CursorPage
 *                   type: object
 *                   properties:
 *                     data:
 *                       type: array
 *                       items: { $ref: '#/components/schemas/Transaction' }
 *                     nextCursor:
 *                       type: integer
 *                       nullable: true
 *                       description: ledgerSequence to pass as the next `cursor`, or null when there are no more rows
 *                       example: 3168074
 *                     hasNext: { type: boolean, example: true }
 *                 - title: OffsetPage
 *                   type: object
 *                   properties:
 *                     data:
 *                       type: array
 *                       items: { $ref: '#/components/schemas/Transaction' }
 *                     total: { type: integer, description: 'Total transactions matching the filter', example: 1543 }
 *                     page: { type: integer, example: 1 }
 *                     limit: { type: integer, example: 20 }
 *                     pages: { type: integer, description: 'Total number of pages (ceil(total / limit))', example: 78 }
 *       400:
 *         description: Invalid query parameters
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/Error'
 *               example:
 *                 error: limit must be less than or equal to 100
 */
// GET /transactions
// Cursor mode:  ?cursor=<ledger>&limit=20&contract=...
// Offset mode:  ?page=2&limit=20&contract=...
transactionRouter.get('/', async (req: Request, res: Response) => {
  try {
    const q = listSchema.parse(req.query);

    const where: any = {
      ...(q.contract && { contractAddress: q.contract }),
      ...(q.account && { sourceAccount: q.account }),
      ...(q.status && { status: q.status }),
      ...((q.ledgerMin !== undefined || q.ledgerMax !== undefined) && {
        ledgerSequence: {
          ...(q.ledgerMin !== undefined && { gte: q.ledgerMin }),
          ...(q.ledgerMax !== undefined && { lte: q.ledgerMax }),
        },
      }),
    };

    if (q.cursor !== undefined) {
      // Cursor-based: return rows with ledger < cursor (descending)
      where.ledgerSequence = { ...where.ledgerSequence, lt: q.cursor };

      const rows = await prisma.transaction.findMany({
        where,
        orderBy: [{ ledgerSequence: 'desc' }, { id: 'desc' }],
        take: q.limit + 1,
        select: TX_SELECT,
      });

      const hasNext = rows.length > q.limit;
      const data = hasNext ? rows.slice(0, q.limit) : rows;
      const nextCursor = hasNext ? (data[data.length - 1] as any).ledgerSequence : null;

      return res.json({ data, nextCursor, hasNext });
    }

    // Offset-based fallback
    const skip = (q.page - 1) * q.limit;
    const [data, total] = await Promise.all([
      prisma.transaction.findMany({
        where,
        orderBy: [{ ledgerSequence: 'desc' }, { id: 'desc' }],
        skip,
        take: q.limit,
        select: TX_SELECT,
      }),
      prisma.transaction.count({ where }),
    ]);

    res.json({ data, total, page: q.page, limit: q.limit, pages: Math.ceil(total / q.limit) });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

/**
 * @swagger
 * /api/v1/transactions/{hash}:
 *   get:
 *     summary: Get a single transaction by hash
 *     tags: [Transactions]
 *     parameters:
 *       - in: path
 *         name: hash
 *         required: true
 *         schema: { type: string }
 *         description: Transaction hash
 *     responses:
 *       200:
 *         description: The transaction, its decoded events, and an optional ZK gas-exemption summary
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/Transaction'
 *                 - type: object
 *                   properties:
 *                     events:
 *                       type: array
 *                       items: { $ref: '#/components/schemas/Event' }
 *                       description: Full decoded events emitted by this transaction
 *                     bn254GasExemption:
 *                       type: object
 *                       nullable: true
 *                       description: >-
 *                         CAP-0080 BN254 host-function gas-exemption summary, or null when
 *                         the transaction used no host-accelerated ZK operations.
 *                       properties:
 *                         bn254Ops:
 *                           type: array
 *                           items: { type: string }
 *                           description: 'Detected BN254 op types, e.g. ["bn254_add", "bn254_pairing_check"]'
 *                           example: ['bn254_pairing_check', 'bn254_multiscalar_mul']
 *                         opCount: { type: integer, example: 2 }
 *                         feeCharged: { type: string, nullable: true, description: 'Actual fee charged (stroops)', example: '100' }
 *                         estimatedWasmFee: { type: string, nullable: true, description: 'Estimated equivalent Wasm fee (stroops)', example: '385' }
 *                         stroopSavings: { type: string, nullable: true, description: 'Net stroops saved', example: '285' }
 *                         savingsPct: { type: number, nullable: true, description: 'Savings percentage (e.g. 74.0)', example: 74.0 }
 *                         cpuInstructions: { type: integer, example: 24500000 }
 *                         msmComplexity: { type: integer, description: 'Multi-scalar multiplication complexity factor', example: 8 }
 *                         humanReadable: { type: string, example: 'Saved 74% in processing fees via host ZK acceleration (bn254_pairing_check, bn254_multiscalar_mul)' }
 *       404:
 *         description: Transaction not found
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/Error'
 *               example:
 *                 error: Transaction not found
 */
// GET /transactions/:hash
transactionRouter.get(
  '/:hash',
  asyncHandler(async (req: Request, res: Response) => {
    const tx = await prisma.transaction.findUnique({
      where: { hash: req.params.hash },
      select: {
        ...TX_SELECT,
        events: true,
      },
    });
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });

    // Include BN254 ZK host function gas exemption data if available (CAP-0080)
    const bn254Savings = await getBn254ExemptionByTx(req.params.hash);

    res.json({ ...tx, bn254GasExemption: bn254Savings });
  }),
);
