import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { getLatestLedger } from '../indexer/rpc';

export const authorizationRouter = Router();

const paginationSchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
});

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
