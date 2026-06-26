/**
 * Account Abstraction Analytics API
 *
 * Routes:
 *   GET /aa/wallets                  – paginated smart wallet list (filter: type, deployer, authMethod)
 *   GET /aa/wallets/:address         – single wallet detail + recent txs
 *   GET /aa/wallets/:address/auth    – auth decompositions for a wallet
 *   GET /aa/wallets/:address/sessions – session key usage for a wallet
 *   GET /aa/sponsored                – sponsored transaction list
 *   GET /aa/sponsored/:sponsor       – transactions by a specific sponsor
 *   GET /aa/adoption                 – time-series adoption by ledger bucket + wallet type
 *   GET /aa/analytics                – aggregate AA adoption stats
 *   GET /aa/stats                    – real-time summary (total wallets, sponsored, top type)
 */

import { Router, Request, Response } from 'express';
import { prismaRead as prisma } from '../db';
import { z } from 'zod';
import { validateAddressParam } from '../middleware/sanitize';

export const aaRouter = Router();

const pageSchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
});

const walletFilterSchema = pageSchema.extend({
  type: z.string().optional(),
  deployer: z.string().optional(),
  authMethod: z.string().optional(), // filter by a specific authMethod in the JSON array
});

// ── GET /aa/wallets ───────────────────────────────────────────────────────────

aaRouter.get('/wallets', async (req: Request, res: Response) => {
  try {
    const { page, limit, type, deployer, authMethod } = walletFilterSchema.parse(req.query);
    const skip = (page - 1) * limit;

    // authMethod filter uses a PostgreSQL JSON contains check
    const where: Record<string, unknown> = {
      ...(type ? { walletType: type } : {}),
      ...(deployer ? { deployedByAccount: deployer } : {}),
      ...(authMethod ? { authMethods: { array_contains: [authMethod] } } : {}),
    };

    const [wallets, total] = await Promise.all([
      prisma.smartWallet.findMany({
        where,
        orderBy: { lastSeenLedger: 'desc' },
        skip,
        take: limit,
        select: {
          address: true,
          walletType: true,
          signerCount: true,
          threshold: true,
          authMethods: true,
          deployedAtLedger: true,
          deployedByAccount: true,
          firstSeenLedger: true,
          lastSeenLedger: true,
          txCount: true,
          sponsoredTxCount: true,
        },
      }),
      prisma.smartWallet.count({ where }),
    ]);

    res.json({ data: wallets, total, page, limit });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ── GET /aa/wallets/:address ──────────────────────────────────────────────────

aaRouter.get(
  '/wallets/:address',
  validateAddressParam('address'),
  async (req: Request, res: Response) => {
    try {
      const wallet = await prisma.smartWallet.findUnique({
        where: { address: req.params.address },
        include: {
          sponsorships: {
            orderBy: { ledgerSequence: 'desc' },
            take: 10,
            select: {
              transactionHash: true,
              sponsorAccount: true,
              feeCharged: true,
              ledgerSequence: true,
              ledgerCloseTime: true,
            },
          },
        },
      });
      if (!wallet) return res.status(404).json({ error: 'Smart wallet not found' });

      // Attach recent transactions (source = wallet address)
      const recentTxs = await prisma.transaction.findMany({
        where: { sourceAccount: req.params.address },
        orderBy: { ledgerSequence: 'desc' },
        take: 10,
        select: {
          hash: true,
          ledgerSequence: true,
          ledgerCloseTime: true,
          functionName: true,
          status: true,
          humanReadable: true,
        },
      });

      res.json({ data: { ...wallet, recentTransactions: recentTxs } });
    } catch (e) {
      res.status(400).json({ error: String(e) });
    }
  },
);

// ── GET /aa/wallets/:address/auth ─────────────────────────────────────────────

aaRouter.get(
  '/wallets/:address/auth',
  validateAddressParam('address'),
  async (req: Request, res: Response) => {
    try {
      const { page, limit } = pageSchema.parse(req.query);
      const skip = (page - 1) * limit;
      const address = req.params.address;

      const [decomps, total] = await Promise.all([
        prisma.authDecomposition.findMany({
          where: { walletAddress: address },
          orderBy: { ledgerSequence: 'desc' },
          skip,
          take: limit,
        }),
        prisma.authDecomposition.count({ where: { walletAddress: address } }),
      ]);

      res.json({ data: decomps, total, page, limit });
    } catch (e) {
      res.status(400).json({ error: String(e) });
    }
  },
);

// ── GET /aa/sponsored ─────────────────────────────────────────────────────────

aaRouter.get('/sponsored', async (req: Request, res: Response) => {
  try {
    const { page, limit } = pageSchema.parse(req.query);
    const skip = (page - 1) * limit;

    const [txs, total] = await Promise.all([
      prisma.sponsoredTransaction.findMany({
        orderBy: { ledgerSequence: 'desc' },
        skip,
        take: limit,
      }),
      prisma.sponsoredTransaction.count(),
    ]);

    res.json({ data: txs, total, page, limit });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ── GET /aa/sponsored/:sponsor ────────────────────────────────────────────────

aaRouter.get('/sponsored/:sponsor', async (req: Request, res: Response) => {
  try {
    const { page, limit } = pageSchema.parse(req.query);
    const skip = (page - 1) * limit;
    const sponsor = req.params.sponsor;

    const [txs, total] = await Promise.all([
      prisma.sponsoredTransaction.findMany({
        where: { sponsorAccount: sponsor },
        orderBy: { ledgerSequence: 'desc' },
        skip,
        take: limit,
      }),
      prisma.sponsoredTransaction.count({ where: { sponsorAccount: sponsor } }),
    ]);

    res.json({ data: txs, total, page, limit });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ── GET /aa/wallets/:address/signers ──────────────────────────────────────────
// Historical signer-snapshot timeline for threshold trend analysis

aaRouter.get(
  '/wallets/:address/signers',
  validateAddressParam('address'),
  async (req: Request, res: Response) => {
    try {
      const { page, limit } = pageSchema.parse(req.query);
      const skip = (page - 1) * limit;
      const address = req.params.address;

      const [snapshots, total] = await Promise.all([
        prisma.signerSnapshot.findMany({
          where: { contractAddress: address },
          orderBy: { ledgerSequence: 'desc' },
          skip,
          take: limit,
          select: {
            id: true,
            signers: true,
            highThreshold: true,
            ledgerSequence: true,
            createdAt: true,
          },
        }),
        prisma.signerSnapshot.count({ where: { contractAddress: address } }),
      ]);

      res.json({ data: snapshots, total, page, limit });
    } catch (e) {
      res.status(400).json({ error: String(e) });
    }
  },
);

// ── GET /aa/wallets/:address/sessions ─────────────────────────────────────────
// Session key usage patterns for a smart wallet

aaRouter.get(
  '/wallets/:address/sessions',
  validateAddressParam('address'),
  async (req: Request, res: Response) => {
    try {
      const { page, limit } = pageSchema.parse(req.query);
      const skip = (page - 1) * limit;
      const address = req.params.address;

      const [sessions, total] = await Promise.all([
        prisma.sessionAuthorization.findMany({
          where: { contractAddress: address },
          orderBy: { startLedger: 'desc' },
          skip,
          take: limit,
        }),
        prisma.sessionAuthorization.count({ where: { contractAddress: address } }),
      ]);

      // Annotate each session with expiry status relative to now (no ledger clock,
      // so we surface raw fields and let the client determine staleness).
      res.json({ data: sessions, total, page, limit });
    } catch (e) {
      res.status(400).json({ error: String(e) });
    }
  },
);

// ── GET /aa/adoption ──────────────────────────────────────────────────────────
// Time-series: smart wallet first-seen count grouped by ledger bucket (1000-ledger windows)

aaRouter.get('/adoption', async (_req: Request, res: Response) => {
  try {
    const rows = await prisma.$queryRaw<{ bucket: number; count: bigint; wallet_type: string }[]>`
      SELECT
        (("firstSeenLedger" / 1000) * 1000) AS bucket,
        "walletType"                          AS wallet_type,
        COUNT(*)                              AS count
      FROM "SmartWallet"
      GROUP BY bucket, "walletType"
      ORDER BY bucket ASC
    `;

    // Re-shape into { ledger_bucket, byType: {multi_sig: n, ...}, total: n }[]
    const bucketMap = new Map<number, Record<string, number>>();
    for (const row of rows) {
      const b = Number(row.bucket);
      if (!bucketMap.has(b)) bucketMap.set(b, {});
      bucketMap.get(b)![row.wallet_type] = Number(row.count);
    }

    const data = [...bucketMap.entries()]
      .sort(([a], [b]) => a - b)
      .map(([bucket, byType]) => ({
        ledgerBucket: bucket,
        byType,
        total: Object.values(byType).reduce((s, n) => s + n, 0),
      }));

    res.json({ data });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /aa/analytics ────────────────────────────────────────────────────────

aaRouter.get('/analytics', async (_req: Request, res: Response) => {
  try {
    const [
      totalWallets,
      byType,
      totalSponsored,
      topSponsors,
      recentDeployments,
      authMethodBreakdown,
    ] = await Promise.all([
      prisma.smartWallet.count(),

      prisma.smartWallet.groupBy({
        by: ['walletType'],
        _count: { walletType: true },
        orderBy: { _count: { walletType: 'desc' } },
      }),

      prisma.sponsoredTransaction.count(),

      // Top 10 sponsors by transaction volume
      prisma.sponsoredTransaction.groupBy({
        by: ['sponsorAccount'],
        _count: { sponsorAccount: true },
        orderBy: { _count: { sponsorAccount: 'desc' } },
        take: 10,
      }),

      // Most recently deployed smart wallets
      prisma.smartWallet.findMany({
        orderBy: { deployedAtLedger: 'desc' },
        take: 5,
        select: {
          address: true,
          walletType: true,
          deployedAtLedger: true,
          deployedByAccount: true,
        },
      }),

      // Auth decomposition method distribution — raw query because authMethods is Json
      prisma.$queryRaw<{ methods: string; count: bigint }[]>`
        SELECT "authMethods"::text AS methods, COUNT(*) AS count
        FROM "AuthDecomposition"
        GROUP BY "authMethods"
        ORDER BY count DESC
        LIMIT 20
      `,
    ]);

    // Flatten type counts into a plain object
    const walletsByType = Object.fromEntries(
      byType.map((r) => [r.walletType, r._count.walletType]),
    );

    const topSponsorList = topSponsors.map((r) => ({
      sponsor: r.sponsorAccount,
      count: r._count.sponsorAccount,
    }));

    res.json({
      data: {
        totalSmartWallets: totalWallets,
        walletsByType,
        totalSponsoredTransactions: totalSponsored,
        topSponsors: topSponsorList,
        recentDeployments,
        authMethodBreakdown: authMethodBreakdown.map((r) => ({
          methods: r.methods,
          count: Number(r.count),
        })),
      },
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /aa/stats ─────────────────────────────────────────────────────────────
// Lightweight real-time summary for dashboards — one cheap parallel query set.

aaRouter.get('/stats', async (_req: Request, res: Response) => {
  try {
    const [totalWallets, totalSponsored, mostCommonType, recentWallets] = await Promise.all([
      prisma.smartWallet.count(),
      prisma.sponsoredTransaction.count(),
      prisma.smartWallet.groupBy({
        by: ['walletType'],
        _count: { walletType: true },
        orderBy: { _count: { walletType: 'desc' } },
        take: 1,
      }),
      prisma.smartWallet.count({
        where: {
          firstSeenLedger: {
            // wallets first seen in the last ~24 h window (≈17280 ledgers at 5 s each)
            gte:
              (
                await prisma.smartWallet.findFirst({
                  orderBy: { lastSeenLedger: 'desc' },
                  select: { lastSeenLedger: true },
                })
              )?.lastSeenLedger ?? 0 - 17280,
          },
        },
      }),
    ]);

    res.json({
      data: {
        totalSmartWallets: totalWallets,
        totalSponsoredTransactions: totalSponsored,
        mostCommonWalletType: mostCommonType[0]?.walletType ?? null,
        recentWalletsLast24h: recentWallets,
      },
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});
