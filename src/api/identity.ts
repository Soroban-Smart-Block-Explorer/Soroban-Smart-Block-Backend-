import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prismaWrite as prisma, prismaRead } from '../db';

export const identityRouter = Router();

// ─── Schemas ─────────────────────────────────────────────────────────────────

const SUPPORTED_CHAINS = [
  'stellar',
  'soroban',
  'ethereum',
  'solana',
  'cosmos',
  'bitcoin',
  'polygon',
  'arbitrum',
  'optimism',
  'avalanche',
] as const;
type Chain = (typeof SUPPORTED_CHAINS)[number];

const createIdentitySchema = z.object({
  ownerId: z.string().optional(),
  displayName: z.string().max(200).optional(),
  avatarUrl: z.string().url().optional(),
  metadata: z.record(z.unknown()).default({}),
});

const addAddressSchema = z.object({
  chain: z.enum(SUPPORTED_CHAINS),
  address: z.string().min(1),
  label: z.string().max(200).optional(),
  verifyProof: z.string().optional(),
  metadata: z.record(z.unknown()).default({}),
});

const linkIdentitySchema = z.object({
  targetIdentityId: z.string().min(1),
  linkType: z.enum(['same-user', 'bridge', 'contract-deployer', 'associated']).default('same-user'),
  confidence: z.number().min(0).max(1).default(1.0),
  evidence: z.array(z.record(z.unknown())).default([]),
});

const bridgeTransferSchema = z.object({
  fromChain: z.string().min(1),
  toChain: z.string().min(1),
  fromAddress: z.string().min(1),
  toAddress: z.string().min(1),
  asset: z.string().min(1),
  amount: z.string().min(1),
  bridgeProtocol: z.string().optional(),
  txHashSource: z.string().optional(),
  txHashDest: z.string().optional(),
  status: z.enum(['pending', 'completed', 'failed']).default('pending'),
  timestamp: z.string().datetime(),
  metadata: z.record(z.unknown()).default({}),
});

// ─── Identity CRUD ────────────────────────────────────────────────────────────

identityRouter.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = createIdentitySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const identity = await prisma.identityGraph.create({
      data: parsed.data,
      include: { addresses: true },
    });
    res.status(201).json(identity);
  }),
);

identityRouter.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const identity = await prismaRead.identityGraph.findUnique({
      where: { id: req.params.id },
      include: {
        addresses: { orderBy: { createdAt: 'asc' } },
        linksOut: {
          include: {
            targetIdentity: { include: { addresses: { select: { chain: true, address: true } } } },
          },
        },
        linksIn: {
          include: {
            sourceIdentity: { include: { addresses: { select: { chain: true, address: true } } } },
          },
        },
      },
    });
    if (!identity) return res.status(404).json({ error: 'Not found' });
    res.json(identity);
  }),
);

identityRouter.put(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = createIdentitySchema.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const existing = await prismaRead.identityGraph.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const identity = await prisma.identityGraph.update({
      where: { id: req.params.id },
      data: parsed.data,
      include: { addresses: true },
    });
    res.json(identity);
  }),
);

identityRouter.delete(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const existing = await prismaRead.identityGraph.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    await prisma.identityGraph.delete({ where: { id: req.params.id } });
    res.json({ deleted: true });
  }),
);

// ─── Address Management ───────────────────────────────────────────────────────

identityRouter.post(
  '/:id/addresses',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = addAddressSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const existing = await prismaRead.identityGraph.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Identity not found' });

    const conflicting = await prismaRead.chainAddress.findUnique({
      where: { chain_address: { chain: parsed.data.chain, address: parsed.data.address } },
    });
    if (conflicting && conflicting.identityId !== req.params.id) {
      return res
        .status(409)
        .json({
          error: 'Address already linked to another identity',
          conflictingIdentityId: conflicting.identityId,
        });
    }

    const chainAddress = await prisma.chainAddress.upsert({
      where: { chain_address: { chain: parsed.data.chain, address: parsed.data.address } },
      update: {
        label: parsed.data.label,
        metadata: parsed.data.metadata,
        identityId: req.params.id,
      },
      create: { identityId: req.params.id, ...parsed.data },
    });
    res.status(201).json(chainAddress);
  }),
);

identityRouter.delete(
  '/:id/addresses/:addressId',
  asyncHandler(async (req: Request, res: Response) => {
    const addr = await prismaRead.chainAddress.findFirst({
      where: { id: req.params.addressId, identityId: req.params.id },
    });
    if (!addr) return res.status(404).json({ error: 'Not found' });
    await prisma.chainAddress.delete({ where: { id: req.params.addressId } });
    res.json({ removed: true });
  }),
);

// ─── Identity Linking ─────────────────────────────────────────────────────────

identityRouter.post(
  '/:id/links',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = linkIdentitySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    if (parsed.data.targetIdentityId === req.params.id) {
      return res.status(400).json({ error: 'Cannot link an identity to itself' });
    }

    const [source, target] = await Promise.all([
      prismaRead.identityGraph.findUnique({ where: { id: req.params.id } }),
      prismaRead.identityGraph.findUnique({ where: { id: parsed.data.targetIdentityId } }),
    ]);
    if (!source) return res.status(404).json({ error: 'Source identity not found' });
    if (!target) return res.status(404).json({ error: 'Target identity not found' });

    const link = await prisma.identityLink.upsert({
      where: {
        sourceIdentityId_targetIdentityId: {
          sourceIdentityId: req.params.id,
          targetIdentityId: parsed.data.targetIdentityId,
        },
      },
      update: {
        linkType: parsed.data.linkType,
        confidence: parsed.data.confidence,
        evidence: parsed.data.evidence,
      },
      create: { sourceIdentityId: req.params.id, ...parsed.data },
    });
    res.status(201).json(link);
  }),
);

identityRouter.delete(
  '/:id/links/:targetId',
  asyncHandler(async (req: Request, res: Response) => {
    const existing = await prismaRead.identityLink.findUnique({
      where: {
        sourceIdentityId_targetIdentityId: {
          sourceIdentityId: req.params.id,
          targetIdentityId: req.params.targetId,
        },
      },
    });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    await prisma.identityLink.delete({
      where: {
        sourceIdentityId_targetIdentityId: {
          sourceIdentityId: req.params.id,
          targetIdentityId: req.params.targetId,
        },
      },
    });
    res.json({ unlinked: true });
  }),
);

// ─── Address Resolution ───────────────────────────────────────────────────────

identityRouter.get(
  '/resolve/:chain/:address',
  asyncHandler(async (req: Request, res: Response) => {
    const { chain, address } = req.params;

    const chainAddress = await prismaRead.chainAddress.findUnique({
      where: { chain_address: { chain, address } },
      include: {
        identity: {
          include: {
            addresses: { orderBy: { chain: 'asc' } },
            linksOut: {
              include: {
                targetIdentity: {
                  include: { addresses: { select: { chain: true, address: true, label: true } } },
                },
              },
            },
          },
        },
      },
    });

    if (!chainAddress) {
      // Return a minimal record for unknown addresses
      return res.json({
        chain,
        address,
        known: false,
        identity: null,
        sorobanActivity: await getSorobanActivity(chain, address),
      });
    }

    res.json({
      chain,
      address,
      known: true,
      chainAddress,
      identity: chainAddress.identity,
      sorobanActivity:
        chain === 'soroban' || chain === 'stellar'
          ? await getSorobanActivity(chain, address)
          : null,
    });
  }),
);

async function getSorobanActivity(chain: string, address: string) {
  if (chain !== 'soroban' && chain !== 'stellar') return null;

  const [txCount, eventCount, recentTxs] = await Promise.all([
    prismaRead.transaction.count({ where: { sourceAccount: address } }),
    prismaRead.event.count({ where: { contractAddress: address } }),
    prismaRead.transaction.findMany({
      where: { sourceAccount: address },
      orderBy: { ledgerCloseTime: 'desc' },
      take: 5,
      select: { hash: true, status: true, functionName: true, ledgerCloseTime: true },
    }),
  ]);

  return { txCount, eventCount, recentTxs };
}

// ─── Cross-Chain Analytics ────────────────────────────────────────────────────

identityRouter.get(
  '/:id/analytics',
  asyncHandler(async (req: Request, res: Response) => {
    const identity = await prismaRead.identityGraph.findUnique({
      where: { id: req.params.id },
      include: { addresses: true },
    });
    if (!identity) return res.status(404).json({ error: 'Not found' });

    const stellarAddresses = identity.addresses
      .filter((a) => a.chain === 'stellar' || a.chain === 'soroban')
      .map((a) => a.address);

    const [txCount, eventCount, bridgeCount] = await Promise.all([
      stellarAddresses.length > 0
        ? prismaRead.transaction.count({ where: { sourceAccount: { in: stellarAddresses } } })
        : Promise.resolve(0),
      stellarAddresses.length > 0
        ? prismaRead.event.count({ where: { contractAddress: { in: stellarAddresses } } })
        : Promise.resolve(0),
      prismaRead.bridgeTransfer.count({
        where: {
          OR: [
            { fromAddress: { in: identity.addresses.map((a) => a.address) } },
            { toAddress: { in: identity.addresses.map((a) => a.address) } },
          ],
        },
      }),
    ]);

    const chainBreakdown = identity.addresses.reduce<Record<string, number>>((acc, a) => {
      acc[a.chain] = (acc[a.chain] ?? 0) + 1;
      return acc;
    }, {});

    const recentActivity =
      stellarAddresses.length > 0
        ? await prismaRead.transaction.findMany({
            where: { sourceAccount: { in: stellarAddresses } },
            orderBy: { ledgerCloseTime: 'desc' },
            take: 10,
            select: {
              hash: true,
              status: true,
              functionName: true,
              contractAddress: true,
              ledgerCloseTime: true,
            },
          })
        : [];

    res.json({
      identityId: req.params.id,
      totalAddresses: identity.addresses.length,
      chainBreakdown,
      stellarTxCount: txCount,
      stellarEventCount: eventCount,
      bridgeTransferCount: bridgeCount,
      recentActivity,
    });
  }),
);

// ─── Bridge Transfers ─────────────────────────────────────────────────────────

identityRouter.get(
  '/:id/bridges',
  asyncHandler(async (req: Request, res: Response) => {
    const identity = await prismaRead.identityGraph.findUnique({
      where: { id: req.params.id },
      include: { addresses: { select: { address: true } } },
    });
    if (!identity) return res.status(404).json({ error: 'Not found' });

    const addresses = identity.addresses.map((a) => a.address);
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, parseInt(req.query.limit as string) || 20);

    const [bridges, total] = await Promise.all([
      prismaRead.bridgeTransfer.findMany({
        where: { OR: [{ fromAddress: { in: addresses } }, { toAddress: { in: addresses } }] },
        orderBy: { timestamp: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prismaRead.bridgeTransfer.count({
        where: { OR: [{ fromAddress: { in: addresses } }, { toAddress: { in: addresses } }] },
      }),
    ]);

    res.json({ data: bridges, total, page, pages: Math.ceil(total / limit) });
  }),
);

// ─── Bridge Transfer CRUD ─────────────────────────────────────────────────────

identityRouter.post(
  '/bridges',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = bridgeTransferSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const fromAddr = await prismaRead.chainAddress.findUnique({
      where: { chain_address: { chain: parsed.data.fromChain, address: parsed.data.fromAddress } },
    });
    const toAddr = await prismaRead.chainAddress.findUnique({
      where: { chain_address: { chain: parsed.data.toChain, address: parsed.data.toAddress } },
    });

    const bridge = await prisma.bridgeTransfer.create({
      data: {
        ...parsed.data,
        timestamp: new Date(parsed.data.timestamp),
        fromAddressId: fromAddr?.id ?? null,
        toAddressId: toAddr?.id ?? null,
      },
    });
    res.status(201).json(bridge);
  }),
);

identityRouter.get(
  '/bridges',
  asyncHandler(async (req: Request, res: Response) => {
    const fromChain = req.query.fromChain as string | undefined;
    const toChain = req.query.toChain as string | undefined;
    const protocol = req.query.protocol as string | undefined;
    const status = req.query.status as string | undefined;
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, parseInt(req.query.limit as string) || 20);

    const where: Record<string, unknown> = {};
    if (fromChain) where.fromChain = fromChain;
    if (toChain) where.toChain = toChain;
    if (protocol) where.bridgeProtocol = protocol;
    if (status) where.status = status;
    if (from || to) {
      where.timestamp = {
        ...(from ? { gte: new Date(from) } : {}),
        ...(to ? { lte: new Date(to) } : {}),
      };
    }

    const [bridges, total] = await Promise.all([
      prismaRead.bridgeTransfer.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prismaRead.bridgeTransfer.count({ where }),
    ]);

    res.json({ data: bridges, total, page, pages: Math.ceil(total / limit) });
  }),
);

identityRouter.get(
  '/bridges/analytics',
  asyncHandler(async (req: Request, res: Response) => {
    const from = req.query.from
      ? new Date(req.query.from as string)
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const to = req.query.to ? new Date(req.query.to as string) : new Date();

    const [total, completed, byProtocol, byRouteRaw] = await Promise.all([
      prismaRead.bridgeTransfer.count({ where: { timestamp: { gte: from, lte: to } } }),
      prismaRead.bridgeTransfer.count({
        where: { status: 'completed', timestamp: { gte: from, lte: to } },
      }),
      prismaRead.bridgeTransfer.groupBy({
        by: ['bridgeProtocol'],
        _count: true,
        where: { timestamp: { gte: from, lte: to } },
      }),
      prismaRead.bridgeTransfer.groupBy({
        by: ['fromChain', 'toChain'],
        _count: true,
        where: { timestamp: { gte: from, lte: to } },
      }),
    ]);

    const byRoute = byRouteRaw.map((r) => ({
      route: `${r.fromChain} → ${r.toChain}`,
      fromChain: r.fromChain,
      toChain: r.toChain,
      count: r._count,
    }));

    res.json({
      period: { from, to },
      total,
      completed,
      successRate: total > 0 ? `${((completed / total) * 100).toFixed(1)}%` : '0%',
      byProtocol: byProtocol.map((p) => ({
        protocol: p.bridgeProtocol ?? 'unknown',
        count: p._count,
      })),
      byRoute,
    });
  }),
);

identityRouter.put(
  '/bridges/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const existing = await prismaRead.bridgeTransfer.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const parsed = bridgeTransferSchema.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const bridge = await prisma.bridgeTransfer.update({
      where: { id: req.params.id },
      data: {
        ...parsed.data,
        ...(parsed.data.timestamp ? { timestamp: new Date(parsed.data.timestamp) } : {}),
      },
    });
    res.json(bridge);
  }),
);

// ─── Supported Chains ─────────────────────────────────────────────────────────

identityRouter.get('/chains', (_req: Request, res: Response) => {
  res.json({
    supported: SUPPORTED_CHAINS,
    addressFormats: {
      stellar: 'G... (56 chars, base32)',
      soroban: 'C... (56 chars, base32)',
      ethereum: '0x... (42 hex chars)',
      solana: 'base58 (32-44 chars)',
      cosmos: 'cosmos1... (bech32)',
      bitcoin: '1... or bc1... (base58/bech32)',
      polygon: '0x... (same as Ethereum)',
      arbitrum: '0x... (same as Ethereum)',
      optimism: '0x... (same as Ethereum)',
      avalanche: '0x... (same as Ethereum)',
    },
  });
});
