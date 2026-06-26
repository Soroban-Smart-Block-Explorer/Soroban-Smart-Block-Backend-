import { Router, Request, Response } from 'express';
import { prismaRead as prisma } from '../db';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';

/**
 * @swagger
 * tags:
 *   name: Events
 *   description: Decoded Soroban contract events
 */

export const eventRouter = Router();

const paginationSchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
});

/**
 * @swagger
 * /api/v1/events:
 *   get:
 *     summary: List decoded contract events
 *     tags: [Events]
 *     parameters:
 *       - in: query
 *         name: contract
 *         schema: { type: string }
 *         description: Filter by contract address (exact match)
 *       - in: query
 *         name: type
 *         schema: { type: string }
 *         description: Filter by event type (e.g. transfer, swap, mint, burn, custom)
 *       - in: query
 *         name: topic
 *         schema: { type: string }
 *         description: Filter by decoded first-topic symbol (e.g. "transfer", "mint_pass")
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
 *         description: Paginated list of events (summary fields only)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     description: Event summary (subset of the full Event record)
 *                     properties:
 *                       id: { type: string }
 *                       transactionHash: { type: string }
 *                       contractAddress: { type: string }
 *                       eventType: { type: string, description: 'transfer | swap | mint | burn | custom' }
 *                       topicSymbol: { type: string, nullable: true }
 *                       decoded: { type: object, nullable: true, description: 'Human-readable decoded event payload' }
 *                       ledgerSequence: { type: integer }
 *                       ledgerCloseTime: { type: string, format: date-time }
 *                 total: { type: integer, description: 'Total number of events matching the filter' }
 *                 page: { type: integer }
 *                 limit: { type: integer }
 *               example:
 *                 data:
 *                   - id: '3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566-AAAADwAAAAh0cmFuc2Zlcg=='
 *                     transactionHash: '3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566'
 *                     contractAddress: CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5
 *                     eventType: transfer
 *                     topicSymbol: transfer
 *                     decoded: { from: 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI', amount: '1000000000' }
 *                     ledgerSequence: 3168075
 *                     ledgerCloseTime: '2026-06-19T07:24:26.000Z'
 *                   - id: '3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566-AAAADwAAAARzd2Fw'
 *                     transactionHash: '3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566'
 *                     contractAddress: CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5
 *                     eventType: swap
 *                     topicSymbol: swap
 *                     decoded: { amount_in: '1000000000', amount_out: '987000000' }
 *                     ledgerSequence: 3168074
 *                     ledgerCloseTime: '2026-06-19T07:23:20.000Z'
 *                 total: 1543
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
 *                 error: limit must be less than or equal to 100
 */
// GET /events?contract=&type=&topic=&page=1
eventRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const { page, limit } = paginationSchema.parse(req.query);
    const { contract, type, topic } = req.query as Record<string, string>;
    const skip = (page - 1) * limit;

    const where = {
      ...(contract && { contractAddress: contract }),
      ...(type && { eventType: type }),
      ...(topic && { topicSymbol: topic }),
    };

    const [events, total] = await Promise.all([
      prisma.event.findMany({
        where,
        orderBy: { ledgerSequence: 'desc' },
        skip,
        take: limit,
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
      }),
      prisma.event.count({ where }),
    ]);

    res.json({ data: events, total, page, limit });
  }),
);

/**
 * @swagger
 * /api/v1/events/{id}:
 *   get:
 *     summary: Get a single event by ID
 *     tags: [Events]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Unique event identifier
 *     responses:
 *       200:
 *         description: The full event record
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Event'
 *       404:
 *         description: Event not found
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/Error'
 *               example:
 *                 error: Event not found
 */
// GET /events/:id
eventRouter.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const event = await prisma.event.findUnique({ where: { id: req.params.id } });
    if (!event) return res.status(404).json({ error: 'Event not found' });
    res.json(event);
  }),
);
