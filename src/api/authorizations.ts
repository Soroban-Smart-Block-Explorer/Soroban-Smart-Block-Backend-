import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prismaRead as prisma } from '../db';
import { getLatestLedger } from '../indexer/rpc';

/**
 * @swagger
 * tags:
 *   name: Authorizations
 *   description: Soroban session authorization tracking and expiry countdowns
 */

export const authorizationRouter = Router();

const paginationSchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
});

/**
 * @swagger
 * /api/v1/authorizations:
 *   get:
 *     summary: List session authorizations
 *     description: Returns paginated session authorizations with expiry countdown and active/expired status.
 *     tags: [Authorizations]
 *     parameters:
 *       - in: query
 *         name: contract
 *         schema: { type: string }
 *         description: Filter by contract address
 *       - in: query
 *         name: active
 *         schema: { type: string, enum: ['true', 'false', '1', '0'] }
 *         description: Filter active (not yet expired) or expired authorizations
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
 *     responses:
 *       200:
 *         description: Paginated authorizations
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data: { type: array, items: { type: object } }
 *                 total: { type: integer }
 *                 page: { type: integer }
 *                 limit: { type: integer }
 *                 latestLedger: { type: integer }
 *       400:
 *         description: Invalid query parameters
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
authorizationRouter.get('/', async (req: Request, res: Response) => {
  try {
    const { page, limit } = paginationSchema.parse(req.query);
    const { contract, active } = req.query as Record<string, string>;
    const latestLedger = await getLatestLedger();
    const skip = (page - 1) * limit;

    const expiryFilter: Record<string, unknown> =
      active === 'true' || active === '1'
        ? { expiryLedger: { gt: latestLedger } }
        : active === 'false' || active === '0'
          ? { expiryLedger: { lte: latestLedger } }
          : {};

    const where = {
      ...(contract ? { contractAddress: contract } : {}),
      ...expiryFilter,
    };

    const [items, total] = await Promise.all([
      prisma.sessionAuthorization.findMany({
        where,
        orderBy: { expiryLedger: 'asc' },
        skip,
        take: limit,
      }),
      prisma.sessionAuthorization.count({ where }),
    ]);

    const data = items.map((item) => {
      const remainingBlocks = Math.max(0, item.expiryLedger - latestLedger);
      return {
        ...item,
        remainingBlocks,
        status: remainingBlocks > 0 ? 'active' : 'expired',
        countdown: `${remainingBlocks} blocks`,
      };
    });

    res.json({ data, total, page, limit, latestLedger });
  } catch (error) {
    res.status(400).json({ error: String(error) });
  }
});

/**
 * @swagger
 * /api/v1/authorizations/dashboard:
 *   get:
 *     summary: Authorization expiry dashboard
 *     description: Returns the top 50 active authorizations with block countdown to expiry.
 *     tags: [Authorizations]
 *     responses:
 *       200:
 *         description: Active authorization countdowns
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 latestLedger: { type: integer }
 *                 activeCount: { type: integer }
 *                 countdowns: { type: array, items: { type: object } }
 */
authorizationRouter.get('/dashboard', async (_req: Request, res: Response) => {
  try {
    const latestLedger = await getLatestLedger();
    const activeAuthorizations = await prisma.sessionAuthorization.findMany({
      where: { expiryLedger: { gt: latestLedger } },
      orderBy: { expiryLedger: 'asc' },
      take: 50,
    });

    const countdowns = activeAuthorizations.map((item) => {
      const remainingBlocks = Math.max(0, item.expiryLedger - latestLedger);
      return {
        id: item.id,
        contractAddress: item.contractAddress,
        hotSigner: item.hotSigner,
        authorizationType: item.authorizationType,
        expiryLedger: item.expiryLedger,
        startLedger: item.startLedger,
        remainingBlocks,
        countdown: `${remainingBlocks} blocks until expiry`,
      };
    });

    res.json({ latestLedger, activeCount: countdowns.length, countdowns });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

/**
 * @swagger
 * /api/v1/authorizations/{id}:
 *   get:
 *     summary: Get a single authorization by ID
 *     tags: [Authorizations]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Authorization record with countdown
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: string }
 *                 remainingBlocks: { type: integer }
 *                 status: { type: string, enum: [active, expired] }
 *                 countdown: { type: string }
 *                 latestLedger: { type: integer }
 *       404:
 *         description: Authorization not found
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
authorizationRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const auth = await prisma.sessionAuthorization.findUnique({ where: { id: req.params.id } });
    if (!auth) {
      return res.status(404).json({ error: 'Authorization not found' });
    }

    const latestLedger = await getLatestLedger();
    const remainingBlocks = Math.max(0, auth.expiryLedger - latestLedger);

    res.json({
      ...auth,
      remainingBlocks,
      status: remainingBlocks > 0 ? 'active' : 'expired',
      countdown: `${remainingBlocks} blocks until expiry`,
      latestLedger,
    });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});
