import { Router, Request, Response } from 'express';
import { prismaRead as prisma } from '../db';
import { z } from 'zod';
import { validateAddressParam } from '../middleware/sanitize';
import axios from 'axios';
import { config } from '../config';
import { asyncHandler } from '../middleware/asyncHandler';

/**
 * @swagger
 * tags:
 *   name: Wallets
 *   description: Per-account activity - Soroban transactions, events, and unified history
 */

export const walletRouter = Router();

const paginationSchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
});

/**
 * @swagger
 * /api/v1/wallets/{address}/transactions:
 *   get:
 *     summary: List a wallet's Soroban transactions (offset-paginated)
 *     description: Transactions where this address is the source account, newest first.
 *     tags: [Wallets]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *         description: Stellar account address (G...) whose transactions to list
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *         description: 1-based page number (offset pagination)
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
 *         description: Page size
 *     responses:
 *       200:
 *         description: Paginated transactions for the wallet (summary fields only)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     description: Transaction summary (subset of the full Transaction record)
 *                     properties:
 *                       hash: { type: string }
 *                       ledgerSequence: { type: integer }
 *                       ledgerCloseTime: { type: string, format: date-time }
 *                       contractAddress: { type: string, nullable: true }
 *                       functionName: { type: string, nullable: true }
 *                       status: { type: string, description: 'success | failed' }
 *                       humanReadable: { type: string, nullable: true }
 *                 total: { type: integer, description: 'Total transactions sourced by this wallet' }
 *                 page: { type: integer }
 *                 limit: { type: integer }
 *               example:
 *                 data:
 *                   - hash: '3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566'
 *                     ledgerSequence: 3168075
 *                     ledgerCloseTime: '2026-06-19T07:24:26.000Z'
 *                     contractAddress: CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5
 *                     functionName: swap
 *                     status: success
 *                     humanReadable: 'GBZX...swapped 100 USDC for 98.7 XLM on StellarSwap'
 *                 total: 42
 *                 page: 1
 *                 limit: 20
 *       400:
 *         description: Invalid Stellar address or query parameters
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/Error'
 *               example:
 *                 error: 'Invalid Stellar address: GBADDRESS'
 */
// GET /wallets/:address/transactions
walletRouter.get(
  '/:address/transactions',
  validateAddressParam('address'),
  asyncHandler(async (req: Request, res: Response) => {
    const { page, limit } = paginationSchema.parse(req.query);
    const skip = (page - 1) * limit;

    const [transactions, total] = await Promise.all([
      prisma.transaction.findMany({
        where: { sourceAccount: req.params.address },
        orderBy: { ledgerSequence: 'desc' },
        skip,
        take: limit,
        select: {
          hash: true,
          ledgerSequence: true,
          ledgerCloseTime: true,
          contractAddress: true,
          functionName: true,
          status: true,
          humanReadable: true,
        },
      }),
      prisma.transaction.count({ where: { sourceAccount: req.params.address } }),
    ]);

    res.json({ data: transactions, total, page, limit });
  }),
);

/**
 * @swagger
 * /api/v1/wallets/{address}/events:
 *   get:
 *     summary: List events involving a wallet (offset-paginated)
 *     description: >-
 *       Full event records whose decoded payload references this address as either
 *       `from` or `to`, newest first.
 *     tags: [Wallets]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *         description: Stellar account address (G...) referenced in the event payload
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *         description: 1-based page number (offset pagination)
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
 *         description: Page size
 *     responses:
 *       200:
 *         description: Paginated full event records involving the wallet
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/Event' }
 *                 total: { type: integer, description: 'Total events involving this wallet', example: 17 }
 *                 page: { type: integer, example: 1 }
 *                 limit: { type: integer, example: 20 }
 *       400:
 *         description: Invalid Stellar address or query parameters
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/Error'
 *               example:
 *                 error: 'Invalid Stellar address: GBADDRESS'
 */
// GET /wallets/:address/events — events involving this address
walletRouter.get(
  '/:address/events',
  validateAddressParam('address'),
  asyncHandler(async (req: Request, res: Response) => {
    const { page, limit } = paginationSchema.parse(req.query);
    const skip = (page - 1) * limit;
    const address = req.params.address;

    // Fetch events where decoded JSON contains this address as from/to
    const [events, total] = await Promise.all([
      prisma.event.findMany({
        where: {
          OR: [
            { decoded: { path: ['from'], equals: address } },
            { decoded: { path: ['to'], equals: address } },
          ],
        },
        orderBy: { ledgerSequence: 'desc' },
        skip,
        take: limit,
      }),
      prisma.event.count({
        where: {
          OR: [
            { decoded: { path: ['from'], equals: address } },
            { decoded: { path: ['to'], equals: address } },
          ],
        },
      }),
    ]);

    res.json({ data: events, total, page, limit });
  }),
);

/**
 * @swagger
 * /api/v1/wallets/{address}/history:
 *   get:
 *     summary: Unified Soroban + classic Stellar history for a wallet
 *     description: >-
 *       Merges indexed Soroban transactions with classic Horizon operations for the
 *       account into a single timeline, sorted newest first, then paginated. Each item
 *       is tagged `type: soroban | classic`; fields not applicable to a given type are
 *       null. If Horizon is unavailable the classic half is silently omitted.
 *     tags: [Wallets]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *         description: Stellar account address (G...) whose history to assemble
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *         description: 1-based page number applied to the merged timeline
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
 *         description: Page size
 *     responses:
 *       200:
 *         description: Paginated unified history items
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     description: Unified history item (Soroban transaction or classic Horizon operation)
 *                     properties:
 *                       type: { type: string, enum: [soroban, classic] }
 *                       timestamp: { type: string, format: date-time }
 *                       hash: { type: string }
 *                       ledgerSequence: { type: integer, nullable: true, description: 'Null for classic operations' }
 *                       status: { type: string, description: 'success | failed' }
 *                       contractAddress: { type: string, nullable: true, description: 'Soroban only' }
 *                       functionName: { type: string, nullable: true, description: 'Soroban only' }
 *                       humanReadable: { type: string, nullable: true, description: 'Soroban only' }
 *                       operationType: { type: string, nullable: true, description: 'Classic only, e.g. payment, create_account' }
 *                       amount: { type: string, nullable: true, description: 'Classic only' }
 *                       asset: { type: string, nullable: true, description: 'Classic only; "XLM" for native' }
 *                       from: { type: string, nullable: true, description: 'Classic only' }
 *                       to: { type: string, nullable: true, description: 'Classic only' }
 *                 total: { type: integer, description: 'Size of the merged timeline before pagination' }
 *                 page: { type: integer }
 *                 limit: { type: integer }
 *               example:
 *                 data:
 *                   - type: soroban
 *                     timestamp: '2026-06-19T07:24:26.000Z'
 *                     hash: '3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566'
 *                     ledgerSequence: 3168075
 *                     status: success
 *                     contractAddress: CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5
 *                     functionName: swap
 *                     humanReadable: 'GBZX...swapped 100 USDC for 98.7 XLM on StellarSwap'
 *                     operationType: null
 *                     amount: null
 *                     asset: null
 *                     from: null
 *                     to: null
 *                   - type: classic
 *                     timestamp: '2026-06-19T07:20:00.000Z'
 *                     hash: '9f0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f'
 *                     ledgerSequence: null
 *                     status: success
 *                     contractAddress: null
 *                     functionName: null
 *                     humanReadable: null
 *                     operationType: payment
 *                     amount: '100.0000000'
 *                     asset: XLM
 *                     from: GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI
 *                     to: GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN
 *                 total: 134
 *                 page: 1
 *                 limit: 20
 *       400:
 *         description: Invalid query parameters
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/Error'
 *               example:
 *                 error: 'limit must be less than or equal to 100'
 */
// GET /wallets/:address/history — unified Soroban + classic Stellar history
walletRouter.get(
  '/:address/history',
  asyncHandler(async (req: Request, res: Response) => {
    const { page, limit } = paginationSchema.parse(req.query);
    const address = req.params.address;

    // Fetch Soroban transactions and classic Horizon operations in parallel
    const [sorobanTxs, horizonOps] = await Promise.all([
      prisma.transaction.findMany({
        where: { sourceAccount: address },
        orderBy: { ledgerCloseTime: 'desc' },
        take: limit * 2, // over-fetch to allow merged sort
        select: {
          hash: true,
          ledgerSequence: true,
          ledgerCloseTime: true,
          contractAddress: true,
          functionName: true,
          status: true,
          humanReadable: true,
        },
      }),
      fetchHorizonOperations(address, limit * 2),
    ]);

    // Normalise into a unified shape
    const sorobanItems = sorobanTxs.map((tx) => ({
      type: 'soroban' as const,
      timestamp: tx.ledgerCloseTime,
      hash: tx.hash,
      ledgerSequence: tx.ledgerSequence,
      status: tx.status,
      contractAddress: tx.contractAddress ?? null,
      functionName: tx.functionName ?? null,
      humanReadable: tx.humanReadable ?? null,
      // classic fields not applicable
      operationType: null,
      amount: null,
      asset: null,
      from: null,
      to: null,
    }));

    const classicItems = horizonOps.map((op: any) => ({
      type: 'classic' as const,
      timestamp: new Date(op.created_at),
      hash: op.transaction_hash,
      ledgerSequence: null,
      status: op.transaction_successful ? 'success' : 'failed',
      contractAddress: null,
      functionName: null,
      humanReadable: null,
      operationType: op.type,
      amount: op.amount ?? op.starting_balance ?? null,
      asset: op.asset_type === 'native' ? 'XLM' : (op.asset_code ?? null),
      from: op.from ?? op.funder ?? null,
      to: op.to ?? op.account ?? null,
    }));

    // Merge and sort descending by timestamp
    const merged = [...sorobanItems, ...classicItems].sort(
      (a, b) => b.timestamp.getTime() - a.timestamp.getTime(),
    );

    // Apply pagination on merged result
    const skip = (page - 1) * limit;
    const paginated = merged.slice(skip, skip + limit);

    res.json({ data: paginated, total: merged.length, page, limit });
  }),
);

async function fetchHorizonOperations(address: string, limit: number): Promise<any[]> {
  try {
    const url = `${config.horizonUrl}/accounts/${encodeURIComponent(address)}/operations`;
    const resp = await axios.get(url, {
      params: { limit, order: 'desc' },
      timeout: 10_000,
    });
    return resp.data?._embedded?.records ?? [];
  } catch {
    // Horizon unavailable or account not found — return empty rather than failing the whole request
    return [];
  }
}
