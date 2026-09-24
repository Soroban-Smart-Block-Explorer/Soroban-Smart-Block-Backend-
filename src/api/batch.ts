import { Router, Request, Response } from 'express';
import { prismaRead as prisma } from '../db';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';

/**
 * @swagger
 * tags:
 *   name: Batch Operations
 *   description: Efficient bulk operations for power users - fetch multiple items in one request
 */

export const batchRouter = Router();

/**
 * Batch request schemas
 */
const batchEventsSchema = z.object({
  ids: z.array(z.string()).min(1).max(100),
});

const batchTransactionsSchema = z.object({
  hashes: z.array(z.string()).min(1).max(100),
});

const batchAccountsSchema = z.object({
  addresses: z.array(z.string()).min(1).max(100),
});

/**
 * @swagger
 * /batch/events:
 *   post:
 *     summary: Fetch multiple events by ID (batch operation)
 *     tags: [Batch Operations]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - ids
 *             properties:
 *               ids:
 *                 type: array
 *                 items:
 *                   type: string
 *                 minItems: 1
 *                 maxItems: 100
 *                 description: Array of event IDs to fetch
 *             example:
 *               ids:
 *                 - '3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566-AAAADwAAAAh0cmFuc2Zlcg=='
 *                 - '3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566-AAAADwAAAARzd2Fw'
 *     responses:
 *       200:
 *         description: Array of matching events (null for missing IDs)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   description: Events in same order as input IDs; null for missing items
 *                   items:
 *                     type: object
 *                     nullable: true
 *                     properties:
 *                       id: { type: string }
 *                       transactionHash: { type: string }
 *                       contractAddress: { type: string }
 *                       eventType: { type: string }
 *                       topicSymbol: { type: string, nullable: true }
 *                       decoded: { type: object, nullable: true }
 *                       ledgerSequence: { type: integer }
 *                       ledgerCloseTime: { type: string, format: date-time }
 *                 missing:
 *                   type: array
 *                   description: IDs that were not found
 *                   items:
 *                     type: string
 *               example:
 *                 data:
 *                   - id: '3389e9f0-...-AAAADwAAAAh0cmFuc2Zlcg=='
 *                     transactionHash: '3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566'
 *                     contractAddress: CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5
 *                     eventType: transfer
 *                     topicSymbol: transfer
 *                     decoded: { from: 'GBZX...', amount: '1000000000' }
 *                     ledgerSequence: 3168075
 *                     ledgerCloseTime: '2026-06-19T07:24:26.000Z'
 *                   - null
 *                 missing:
 *                   - '3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566-AAAADwAAAARzd2Fw'
 *       400:
 *         description: Invalid request body or too many IDs
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/Error'
 *               example:
 *                 error: 'ids array must contain at least 1 item(s)'
 */
batchRouter.post(
  '/events',
  asyncHandler(async (req: Request, res: Response) => {
    const { ids } = batchEventsSchema.parse(req.body);

    const events = await prisma.event.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        transactionHash: true,
        contractAddress: true,
        eventType: true,
        topicSymbol: true,
        decoded: true,
        ledgerSequence: true,
        ledgerCloseTime: true,
      },
    });

    // Create a map for quick lookup
    const eventMap = new Map(events.map((e) => [e.id, e]));

    // Maintain order from input and return null for missing
    const data = ids.map((id) => eventMap.get(id) || null);
    const missing = ids.filter((id) => !eventMap.has(id));

    res.json({
      data,
      missing,
    });
  }),
);

/**
 * @swagger
 * /batch/transactions:
 *   post:
 *     summary: Fetch multiple transactions by hash (batch operation)
 *     tags: [Batch Operations]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - hashes
 *             properties:
 *               hashes:
 *                 type: array
 *                 items:
 *                   type: string
 *                 minItems: 1
 *                 maxItems: 100
 *                 description: Array of transaction hashes to fetch
 *             example:
 *               hashes:
 *                 - '3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566'
 *                 - 'a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0'
 *     responses:
 *       200:
 *         description: Array of matching transactions (null for missing hashes)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   description: Transactions in same order as input hashes; null for missing items
 *                   items:
 *                     type: object
 *                     nullable: true
 *                     properties:
 *                       hash: { type: string }
 *                       ledgerSequence: { type: integer }
 *                       ledgerCloseTime: { type: string, format: date-time }
 *                       sourceAccount: { type: string }
 *                       contractAddress: { type: string, nullable: true }
 *                       functionName: { type: string, nullable: true }
 *                       functionArgs: { type: object, nullable: true }
 *                       status: { type: string, description: 'success | failed' }
 *                       humanReadable: { type: string, nullable: true }
 *                       feeCharged: { type: integer }
 *                       sorobanResources: { type: object, nullable: true }
 *                       failureReason: { type: string, nullable: true }
 *                       events:
 *                         type: array
 *                         items:
 *                           type: object
 *                 missing:
 *                   type: array
 *                   description: Hashes that were not found
 *                   items:
 *                     type: string
 *               example:
 *                 data:
 *                   - hash: '3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566'
 *                     ledgerSequence: 3168075
 *                     ledgerCloseTime: '2026-06-19T07:24:26.000Z'
 *                     sourceAccount: GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI
 *                     contractAddress: CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5
 *                     functionName: swap
 *                     status: success
 *                     humanReadable: 'GBZX...swapped 100 USDC for 98.7 XLM'
 *                     feeCharged: 100000
 *                     sorobanResources:
 *                       cpuInstructions: 2000000
 *                       memoryBytes: 1024000
 *                     failureReason: null
 *                     events: []
 *                   - null
 *                 missing:
 *                   - 'a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0'
 *       400:
 *         description: Invalid request body or too many hashes
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/Error'
 *               example:
 *                 error: 'hashes array must contain at least 1 item(s)'
 */
batchRouter.post(
  '/transactions',
  asyncHandler(async (req: Request, res: Response) => {
    const { hashes } = batchTransactionsSchema.parse(req.body);

    const transactions = await prisma.transaction.findMany({
      where: { hash: { in: hashes } },
      select: {
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
        sorobanResources: true,
        failureReason: true,
        events: {
          select: {
            id: true,
            eventType: true,
            topicSymbol: true,
            decoded: true,
          },
        },
      },
    });

    // Create a map for quick lookup
    const txMap = new Map(transactions.map((tx) => [tx.hash, tx]));

    // Maintain order from input and return null for missing
    const data = hashes.map((hash) => txMap.get(hash) || null);
    const missing = hashes.filter((hash) => !txMap.has(hash));

    res.json({
      data,
      missing,
    });
  }),
);

/**
 * @swagger
 * /batch/accounts:
 *   post:
 *     summary: Fetch wallet summaries for multiple accounts (batch operation)
 *     tags: [Batch Operations]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - addresses
 *             properties:
 *               addresses:
 *                 type: array
 *                 items:
 *                   type: string
 *                 minItems: 1
 *                 maxItems: 100
 *                 description: Array of Stellar account addresses to fetch
 *             example:
 *               addresses:
 *                 - 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI'
 *                 - 'GCZST3XVCDTUJ76ZAV2HA72KYXM4Y5LXNLHT3GSXWOOEDNVGY45UXGIT'
 *     responses:
 *       200:
 *         description: Array of account summaries (null for accounts with no activity)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   description: Account summaries in same order as input addresses; null for inactive accounts
 *                   items:
 *                     type: object
 *                     nullable: true
 *                     properties:
 *                       address: { type: string }
 *                       transactionCount: { type: integer, description: 'Total Soroban transactions from this account' }
 *                       eventCount: { type: integer, description: 'Total events involving this account' }
 *                       firstActivityLedger: { type: integer, nullable: true }
 *                       lastActivityLedger: { type: integer, nullable: true }
 *                       firstActivityTime: { type: string, format: date-time, nullable: true }
 *                       lastActivityTime: { type: string, format: date-time, nullable: true }
 *                 inactive:
 *                   type: array
 *                   description: Addresses with no recorded Soroban activity
 *                   items:
 *                     type: string
 *               example:
 *                 data:
 *                   - address: 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI'
 *                     transactionCount: 42
 *                     eventCount: 127
 *                     firstActivityLedger: 3167000
 *                     lastActivityLedger: 3168075
 *                     firstActivityTime: '2026-06-18T12:00:00.000Z'
 *                     lastActivityTime: '2026-06-19T07:24:26.000Z'
 *                   - null
 *                 inactive:
 *                   - 'GCZST3XVCDTUJ76ZAV2HA72KYXM4Y5LXNLHT3GSXWOOEDNVGY45UXGIT'
 *       400:
 *         description: Invalid request body or too many addresses
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/Error'
 *               example:
 *                 error: 'addresses array must contain at least 1 item(s)'
 */
batchRouter.post(
  '/accounts',
  asyncHandler(async (req: Request, res: Response) => {
    const { addresses } = batchAccountsSchema.parse(req.body);

    // Fetch transaction stats for each address
    const txStats = await prisma.transaction.groupBy({
      by: ['sourceAccount'],
      where: { sourceAccount: { in: addresses } },
      _count: {
        hash: true,
      },
      _min: {
        ledgerSequence: true,
        ledgerCloseTime: true,
      },
      _max: {
        ledgerSequence: true,
        ledgerCloseTime: true,
      },
    });

    // Fetch event stats (events can reference addresses in decoded payload)
    // This is more complex, so we'll use a simpler approach: count events where the address appears in the event
    const accountStats: Record<
      string,
      {
        address: string;
        transactionCount: number;
        eventCount: number;
        firstActivityLedger: number | null;
        lastActivityLedger: number | null;
        firstActivityTime: string | null;
        lastActivityTime: string | null;
      }
    > = {};

    for (const stat of txStats) {
      accountStats[stat.sourceAccount] = {
        address: stat.sourceAccount,
        transactionCount: stat._count.hash || 0,
        eventCount: 0, // Will be populated below
        firstActivityLedger: stat._min.ledgerSequence || null,
        lastActivityLedger: stat._max.ledgerSequence || null,
        firstActivityTime: stat._min.ledgerCloseTime
          ? new Date(stat._min.ledgerCloseTime).toISOString()
          : null,
        lastActivityTime: stat._max.ledgerCloseTime
          ? new Date(stat._max.ledgerCloseTime).toISOString()
          : null,
      };
    }

    // For addresses with transaction activity, try to count related events
    const addressesWithActivity = Object.keys(accountStats);
    if (addressesWithActivity.length > 0) {
      // This is approximate: count events from transactions involving these addresses
      const eventCounts = await prisma.event.groupBy({
        by: ['transactionHash'],
        where: {
          transaction: {
            sourceAccount: { in: addressesWithActivity },
          },
        },
        _count: true,
      });

      for (const count of eventCounts) {
        // Aggregate all events from transactions of tracked addresses
        // (This is an approximation; a full implementation might decode payloads)
      }

      // Simple approximation: count all events from transactions by these addresses
      const totalEventCounts = await Promise.all(
        addressesWithActivity.map(async (addr) => {
          const eventCount = await prisma.event.count({
            where: {
              transaction: {
                sourceAccount: addr,
              },
            },
          });
          return { address: addr, eventCount };
        }),
      );

      for (const { address, eventCount } of totalEventCounts) {
        if (accountStats[address]) {
          accountStats[address].eventCount = eventCount;
        }
      }
    }

    // Maintain order from input and return null for inactive addresses
    const data = addresses.map((addr) => accountStats[addr] || null);
    const inactive = addresses.filter((addr) => !accountStats[addr]);

    res.json({
      data,
      inactive,
    });
  }),
);
