import { Router, Request, Response } from 'express';
import { prismaRead, prismaWrite } from '../db';
import { z } from 'zod';

export const contractRouter = Router();

const abiSchema = z.object({
  address: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  abi: z.record(z.unknown()).optional(),
});

const contractStatsQuerySchema = z.object({
  since: z.string().datetime({ offset: true }).optional(),
});

export async function getContractFunctionStats(address: string, since?: Date) {
  const contract = await prismaRead.contract.findUnique({
    where: { address },
    select: { address: true },
  });

  if (!contract) {
    return null;
  }

  const stats = await prismaRead.transaction.groupBy({
    by: ['functionName'],
    where: {
      contractAddress: address,
      functionName: { not: null },
      ...(since ? { ledgerCloseTime: { gte: since } } : {}),
    },
    _count: {
      functionName: true,
    },
    _max: {
      ledgerCloseTime: true,
    },
    orderBy: [
      { _count: { functionName: 'desc' } },
      { functionName: 'asc' },
    ],
  });

  return stats.map((stat) => ({
    functionName: stat.functionName!,
    callCount: stat._count.functionName,
    lastCalledAt: stat._max.ledgerCloseTime,
  }));
}

// GET /contracts
contractRouter.get('/', async (_req: Request, res: Response) => {
  const contracts = await prismaRead.contract.findMany({
    select: { address: true, name: true, description: true, isToken: true, tokenSymbol: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json(contracts);
});

// GET /contracts/:address/stats
contractRouter.get('/:address/stats', async (req: Request, res: Response) => {
  try {
    const { since } = contractStatsQuerySchema.parse(req.query);
    const stats = await getContractFunctionStats(
      req.params.address,
      since ? new Date(since) : undefined,
    );

    if (stats === null) {
      return res.status(404).json({ error: 'Contract not found' });
    }

    return res.json(stats);
  } catch (e) {
    return res.status(400).json({ error: String(e) });
  }
});

// GET /contracts/:address
contractRouter.get('/:address', async (req: Request, res: Response) => {
  const contract = await prismaRead.contract.findUnique({
    where: { address: req.params.address },
    include: {
      transactions: { take: 10, orderBy: { ledger: 'desc' }, select: { hash: true, functionName: true, humanReadable: true, ledger: true } },
      events: { take: 10, orderBy: { ledger: 'desc' }, select: { id: true, eventType: true, decoded: true, ledger: true } },
    },
  });
  if (!contract) return res.status(404).json({ error: 'Contract not found' });
  res.json(contract);
});

// POST /contracts — register ABI metadata
contractRouter.post('/', async (req: Request, res: Response) => {
  try {
    const data = abiSchema.parse(req.body);
    const contract = await prismaWrite.contract.upsert({
      where: { address: data.address },
      update: { name: data.name, description: data.description, abi: data.abi as object },
      create: { address: data.address, name: data.name, description: data.description, abi: data.abi as object },
    });
    res.status(201).json(contract);
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});
