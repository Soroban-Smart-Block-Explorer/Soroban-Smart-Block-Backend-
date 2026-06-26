/* eslint-disable @typescript-eslint/no-explicit-any */

import { Router, Request, Response } from 'express';
import { prismaRead, prismaWrite } from '../db';
import { z } from 'zod';
import { detectPrivacyTechniques } from '../indexer/privacy-detector';
import { computePrivacyScore } from '../indexer/privacy-scorer';
import {
  findCommonInputClusters,
  analyzeTiming,
  analyzeAmountCorrelation,
  analyzeTaint,
  buildTransactionGraph,
  analyzeCluster,
  getEffectiveAnonymitySets,
} from '../indexer/privacy-graph';

/**
 * @swagger
 * tags:
 *   name: Privacy
 *   description: Privacy-protocol detection, scoring, compliance, and de-anonymization analytics
 */

export const privacyRouter = Router();

const PRIVACY_PROTOCOLS_INFO: Record<
  string,
  { name: string; description: string; category: string; strength: number }
> = {
  SHIELDED_TRANSFER: {
    name: 'Shielded Transfer',
    description:
      'Commitment-based transfers with hash commitments, encrypted memo fields, and balance concealment via cryptographic accumulators.',
    category: 'transfer',
    strength: 8,
  },
  ZK_SNARK: {
    name: 'zk-SNARK',
    description:
      'Zero-knowledge Succinct Non-Interactive Argument of Knowledge. Groth16 and PLONK proving systems for private transactions.',
    category: 'zkp',
    strength: 15,
  },
  ZK_STARK: {
    name: 'zk-STARK',
    description:
      'Zero-knowledge Scalable Transparent Argument of Knowledge. Post-quantum secure proofs without trusted setup.',
    category: 'zkp',
    strength: 14,
  },
  BULLETPROOF: {
    name: 'Bulletproofs',
    description:
      'Short non-interactive zero-knowledge proofs for range proofs and membership proofs. No trusted setup required.',
    category: 'zkp',
    strength: 12,
  },
  STEALTH_ADDRESS: {
    name: 'Stealth Address',
    description:
      'One-time address generation using ephemeral public keys and stealth meta-address registration with key blinding.',
    category: 'address',
    strength: 10,
  },
  MIXER: {
    name: 'Mixer / Tumbler',
    description:
      'CoinJoin-style multi-party transactions with deposit-wait-withdraw patterns and anonymity pool participation.',
    category: 'mixer',
    strength: 9,
  },
  PRIVATE_VOTING: {
    name: 'Private Voting',
    description:
      'Encrypted vote submissions, commitment-reveal voting schemes, and quadratic voting with privacy guarantees.',
    category: 'voting',
    strength: 13,
  },
  OFF_CHAIN_DATA: {
    name: 'Off-Chain Data',
    description:
      'Off-chain data availability with on-chain proofs, private data feed subscriptions, and oracle integrity proofs.',
    category: 'data',
    strength: 6,
  },
  ENCRYPTED_STATE: {
    name: 'Encrypted State',
    description:
      'Encrypted contract state storage preserving data confidentiality while maintaining on-chain verifiability.',
    category: 'storage',
    strength: 7,
  },
  DIFFERENTIAL_PRIVACY: {
    name: 'Differential Privacy',
    description:
      'Differentially private aggregators using Laplace and Gaussian noise mechanisms for private analytics queries.',
    category: 'analytics',
    strength: 11,
  },
};

const paginationSchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
});

const protocolEnum = z.enum([
  'SHIELDED_TRANSFER',
  'ZK_SNARK',
  'ZK_STARK',
  'BULLETPROOF',
  'STEALTH_ADDRESS',
  'MIXER',
  'PRIVATE_VOTING',
  'OFF_CHAIN_DATA',
  'ENCRYPTED_STATE',
  'DIFFERENTIAL_PRIVACY',
]);

/**
 * @swagger
 * /api/v1/privacy/overview:
 *   get:
 *     summary: Overall privacy landscape
 *     description: Totals, 24h activity, per-protocol counts, and average scores across all privacy transactions.
 *     tags: [Privacy]
 *     responses:
 *       200:
 *         description: Privacy landscape summary
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 totalPrivateTx: { type: integer }
 *                 totalTx: { type: integer }
 *                 privacyShare: { type: number, description: 'totalPrivateTx / totalTx (0-1)' }
 *                 totalVolume: { type: number, nullable: true, description: 'Sum of usdValue across private transactions' }
 *                 recent24h: { type: integer, description: 'Private transactions in the last 24 hours' }
 *                 byProtocol: { type: object, description: 'Per-protocol transaction counts' }
 *                 avgPrivacyScore: { type: number, nullable: true }
 *                 avgRiskScore: { type: number, nullable: true }
 *                 avgAnonymitySet: { type: number, nullable: true }
 *                 latestAnalytics:
 *                   allOf: [{ $ref: '#/components/schemas/PrivacyAnalytics' }]
 *                   nullable: true
 *                   description: Most recent analytics snapshot, or null when none exist
 *               example:
 *                 totalPrivateTx: 320
 *                 totalTx: 15430
 *                 privacyShare: 0.0207
 *                 totalVolume: 4500000
 *                 recent24h: 18
 *                 byProtocol: { ZK_SNARK: 120, MIXER: 45, SHIELDED_TRANSFER: 80 }
 *                 avgPrivacyScore: 71.2
 *                 avgRiskScore: 18.5
 *                 avgAnonymitySet: 96.4
 *                 latestAnalytics: null
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
// GET /api/v1/privacy/overview -- overall privacy landscape
privacyRouter.get('/overview', async (_req: Request, res: Response) => {
  try {
    const totalPrivateTx = await prismaRead.privacyTransaction.count();
    const totalTx = await prismaRead.transaction.count();
    const totalVolume = await prismaRead.privacyTransaction.aggregate({
      _sum: { usdValue: true },
    });

    const latestAnalytics = await prismaRead.privacyAnalytics.findFirst({
      orderBy: { timestamp: 'desc' },
    });

    const protocolCounts = await prismaRead.privacyTransaction.findMany({
      select: { protocols: true },
    });

    const byProtocol: Record<string, number> = {};
    for (const tx of protocolCounts) {
      for (const p of tx.protocols) {
        byProtocol[p] = (byProtocol[p] || 0) + 1;
      }
    }

    const avgScore = await prismaRead.privacyTransaction.aggregate({
      _avg: { privacyScore: true, riskScore: true, anonymitySetSize: true },
    });

    const recentTxs = await prismaRead.privacyTransaction.count({
      where: {
        timestamp: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    });

    res.json({
      totalPrivateTx,
      totalTx,
      privacyShare: totalTx > 0 ? totalPrivateTx / totalTx : 0,
      totalVolume: totalVolume._sum.usdValue,
      recent24h: recentTxs,
      byProtocol,
      avgPrivacyScore: avgScore._avg.privacyScore,
      avgRiskScore: avgScore._avg.riskScore,
      avgAnonymitySet: avgScore._avg.anonymitySetSize,
      latestAnalytics,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * @swagger
 * /api/v1/privacy/protocols:
 *   get:
 *     summary: List all supported privacy protocols
 *     description: Static protocol descriptors enriched with a live transaction count for each.
 *     tags: [Privacy]
 *     responses:
 *       200:
 *         description: Supported protocols with transaction counts
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 protocols:
 *                   type: array
 *                   items:
 *                     allOf:
 *                       - $ref: '#/components/schemas/PrivacyProtocolInfo'
 *                       - type: object
 *                         properties:
 *                           id: { type: string, description: 'Protocol id' }
 *                           txCount: { type: integer, description: 'Transactions using this protocol' }
 *                 total: { type: integer }
 *               example:
 *                 protocols:
 *                   - id: ZK_SNARK
 *                     name: zk-SNARK
 *                     description: 'Zero-knowledge Succinct Non-Interactive Argument of Knowledge. Groth16 and PLONK proving systems for private transactions.'
 *                     category: zkp
 *                     strength: 15
 *                     txCount: 120
 *                 total: 10
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
// GET /api/v1/privacy/protocols -- all supported protocols with descriptions
privacyRouter.get('/protocols', async (_req: Request, res: Response) => {
  try {
    const protocolList = Object.entries(PRIVACY_PROTOCOLS_INFO).map(([key, info]) => ({
      id: key,
      ...info,
    }));

    const txCounts = await prismaRead.privacyTransaction.findMany({
      select: { protocols: true },
    });

    const counts: Record<string, number> = {};
    for (const tx of txCounts) {
      for (const p of tx.protocols) {
        counts[p] = (counts[p] || 0) + 1;
      }
    }

    res.json({
      protocols: protocolList.map((p) => ({
        ...p,
        txCount: counts[p.id] || 0,
      })),
      total: protocolList.length,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * @swagger
 * /api/v1/privacy/protocols/{protocol}:
 *   get:
 *     summary: Analytics for a single privacy protocol
 *     tags: [Privacy]
 *     parameters:
 *       - in: path
 *         name: protocol
 *         required: true
 *         schema:
 *           type: string
 *           enum: [SHIELDED_TRANSFER, ZK_SNARK, ZK_STARK, BULLETPROOF, STEALTH_ADDRESS, MIXER, PRIVATE_VOTING, OFF_CHAIN_DATA, ENCRYPTED_STATE, DIFFERENTIAL_PRIVACY]
 *         description: Protocol id (case-insensitive)
 *     responses:
 *       200:
 *         description: Protocol analytics with recent transactions and history
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 protocol: { $ref: '#/components/schemas/PrivacyProtocolInfo' }
 *                 totalTx: { type: integer }
 *                 uniqueUsers: { type: integer }
 *                 avgPrivacyScore: { type: number, nullable: true }
 *                 avgRiskScore: { type: number, nullable: true }
 *                 avgAnonymitySet: { type: number, nullable: true }
 *                 recentTxs:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       txHash: { type: string }
 *                       privacyScore: { type: number, nullable: true }
 *                       riskScore: { type: number, nullable: true }
 *                       timestamp: { type: string, format: date-time }
 *                 history:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/PrivacyProtocolDetail' }
 *               example:
 *                 protocol: { name: zk-SNARK, description: 'Zero-knowledge proofs for private transactions.', category: zkp, strength: 15 }
 *                 totalTx: 120
 *                 uniqueUsers: 64
 *                 avgPrivacyScore: 84.2
 *                 avgRiskScore: 11.5
 *                 avgAnonymitySet: 112.5
 *                 recentTxs:
 *                   - txHash: '3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566'
 *                     privacyScore: 87.5
 *                     riskScore: 12
 *                     timestamp: '2026-06-19T07:24:26.000Z'
 *                 history: []
 *       400:
 *         description: Unknown protocol
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Unknown protocol: FOO' }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
// GET /api/v1/privacy/protocols/:protocol -- specific protocol analytics
privacyRouter.get('/protocols/:protocol', async (req: Request, res: Response) => {
  try {
    const protocol = req.params.protocol.toUpperCase();
    if (!PRIVACY_PROTOCOLS_INFO[protocol]) {
      return res.status(400).json({ error: `Unknown protocol: ${protocol}` });
    }

    const details = await prismaRead.privacyProtocolDetail.findMany({
      where: { protocol: protocol as any },
      orderBy: { timestamp: 'desc' },
      take: 100,
    });

    const protocolFilter = protocol as any;

    const txs = await prismaRead.privacyTransaction.findMany({
      where: { protocols: { has: protocolFilter } },
      orderBy: { timestamp: 'desc' },
      take: 50,
    });

    const totalTx = await prismaRead.privacyTransaction.count({
      where: { protocols: { has: protocolFilter } },
    });

    const avgScore = await prismaRead.privacyTransaction.aggregate({
      where: { protocols: { has: protocolFilter } },
      _avg: { privacyScore: true, riskScore: true, anonymitySetSize: true },
    });

    const uniqueUsers = new Set(txs.flatMap((t) => t.participants)).size;

    res.json({
      protocol: PRIVACY_PROTOCOLS_INFO[protocol],
      totalTx,
      uniqueUsers,
      avgPrivacyScore: avgScore._avg?.privacyScore ?? null,
      avgRiskScore: avgScore._avg?.riskScore ?? null,
      avgAnonymitySet: avgScore._avg?.anonymitySetSize ?? null,
      recentTxs: txs.slice(0, 20).map((t) => ({
        txHash: t.txHash,
        privacyScore: t.privacyScore,
        riskScore: t.riskScore,
        timestamp: t.timestamp,
      })),
      history: details,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * @swagger
 * /api/v1/privacy/transactions:
 *   get:
 *     summary: List privacy transactions (offset-paginated)
 *     tags: [Privacy]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
 *       - in: query
 *         name: protocol
 *         schema: { type: string }
 *         description: Filter by protocol id (transactions tagged with this protocol)
 *       - in: query
 *         name: minScore
 *         schema: { type: number }
 *         description: Minimum privacy score
 *       - in: query
 *         name: maxRisk
 *         schema: { type: number }
 *         description: Maximum risk score
 *       - in: query
 *         name: address
 *         schema: { type: string }
 *         description: Filter by participant address
 *       - in: query
 *         name: contract
 *         schema: { type: string }
 *         description: Filter by contract address
 *       - in: query
 *         name: fromDate
 *         schema: { type: string, format: date-time }
 *         description: Only transactions at or after this timestamp
 *       - in: query
 *         name: toDate
 *         schema: { type: string, format: date-time }
 *         description: Only transactions at or before this timestamp
 *     responses:
 *       200:
 *         description: Paginated privacy transactions
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/PrivacyTransaction' }
 *                 total: { type: integer, example: 320 }
 *                 page: { type: integer, example: 1 }
 *                 limit: { type: integer, example: 20 }
 *                 pages: { type: integer, example: 16 }
 *       400:
 *         description: Invalid query parameters
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'limit must be less than or equal to 100' }
 */
// GET /api/v1/privacy/transactions -- list privacy transactions with filters
privacyRouter.get('/transactions', async (req: Request, res: Response) => {
  try {
    const q = paginationSchema.parse(req.query);
    const where: any = {};

    if (req.query.protocol) {
      where.protocols = { has: req.query.protocol as any };
    }
    if (req.query.minScore) {
      where.privacyScore = { gte: Number(req.query.minScore) };
    }
    if (req.query.maxRisk) {
      where.riskScore = { lte: Number(req.query.maxRisk) };
    }
    if (req.query.address) {
      where.participants = { has: req.query.address as string };
    }
    if (req.query.contract) {
      where.contractAddresses = { has: req.query.contract as string };
    }
    if (req.query.fromDate) {
      where.timestamp = { ...where.timestamp, gte: new Date(req.query.fromDate as string) };
    }
    if (req.query.toDate) {
      where.timestamp = { ...where.timestamp, lte: new Date(req.query.toDate as string) };
    }

    const [data, total] = await Promise.all([
      prismaRead.privacyTransaction.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
      prismaRead.privacyTransaction.count({ where }),
    ]);

    res.json({
      data,
      total,
      page: q.page,
      limit: q.limit,
      pages: Math.ceil(total / q.limit),
    });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

/**
 * @swagger
 * /api/v1/privacy/transactions/{txHash}:
 *   get:
 *     summary: Detailed privacy analysis for one transaction
 *     description: The privacy record plus the base transaction, de-anonymization findings, a compliance report, and protocol descriptors.
 *     tags: [Privacy]
 *     parameters:
 *       - in: path
 *         name: txHash
 *         required: true
 *         schema: { type: string }
 *         description: Transaction hash
 *     responses:
 *       200:
 *         description: Privacy transaction with related analysis
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/PrivacyTransaction'
 *                 - type: object
 *                   properties:
 *                     baseTransaction:
 *                       allOf: [{ $ref: '#/components/schemas/Transaction' }]
 *                       nullable: true
 *                       description: Indexed base transaction, or null if not indexed
 *                     deAnonymizationFindings:
 *                       type: array
 *                       items: { $ref: '#/components/schemas/DeAnonymizationFinding' }
 *                     complianceReport:
 *                       allOf: [{ $ref: '#/components/schemas/PrivacyComplianceReport' }]
 *                       nullable: true
 *                     protocolDetails:
 *                       type: array
 *                       items: { $ref: '#/components/schemas/PrivacyProtocolInfo' }
 *                     guarantees:
 *                       type: array
 *                       items:
 *                         type: string
 *                         enum: [SENDER_PRIVACY, RECIPIENT_PRIVACY, AMOUNT_PRIVACY, ASSET_TYPE_PRIVACY, VOTE_PRIVACY, FULL_PRIVACY]
 *       404:
 *         description: Privacy transaction not found
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Privacy transaction not found' }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
// GET /api/v1/privacy/transactions/:txHash -- detailed privacy analysis
privacyRouter.get('/transactions/:txHash', async (req: Request, res: Response) => {
  try {
    const tx = await prismaRead.privacyTransaction.findUnique({
      where: { txHash: req.params.txHash },
    });

    if (!tx) {
      return res.status(404).json({ error: 'Privacy transaction not found' });
    }

    const baseTx = await prismaRead.transaction.findUnique({
      where: { hash: req.params.txHash },
    });

    const findings = await prismaRead.deAnonymizationFinding.findMany({
      where: { sourceTx: req.params.txHash },
    });

    const report = await prismaRead.privacyComplianceReport.findFirst({
      where: {
        address: { in: tx.participants },
      },
    });

    res.json({
      ...tx,
      baseTransaction: baseTx,
      deAnonymizationFindings: findings,
      complianceReport: report,
      protocolDetails: tx.protocols.map((p) => PRIVACY_PROTOCOLS_INFO[p] || null).filter(Boolean),
      guarantees: tx.guarantees,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * @swagger
 * /api/v1/privacy/history:
 *   get:
 *     summary: Privacy adoption trend over time
 *     tags: [Privacy]
 *     parameters:
 *       - in: query
 *         name: days
 *         schema: { type: integer, minimum: 1, maximum: 365, default: 30 }
 *         description: Look-back window in days
 *       - in: query
 *         name: granularity
 *         schema: { type: string, default: day }
 *         description: Analytics period to match (e.g. hour, day, week)
 *     responses:
 *       200:
 *         description: Adoption trend series
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 days: { type: integer, example: 30 }
 *                 granularity: { type: string, example: day }
 *                 data:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/PrivacyAnalytics' }
 */
// GET /api/v1/privacy/history -- adoption trend
privacyRouter.get('/history', async (req: Request, res: Response) => {
  try {
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    const granularity = (req.query.granularity as string) || 'day';
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const analytics = await prismaRead.privacyAnalytics.findMany({
      where: {
        timestamp: { gte: since },
        period: granularity,
      },
      orderBy: { timestamp: 'asc' },
    });

    res.json({ days, granularity, data: analytics });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

/**
 * @swagger
 * /api/v1/privacy/history/{protocol}:
 *   get:
 *     summary: Trend for a single privacy protocol
 *     tags: [Privacy]
 *     parameters:
 *       - in: path
 *         name: protocol
 *         required: true
 *         schema: { type: string }
 *         description: Protocol id (case-insensitive)
 *       - in: query
 *         name: days
 *         schema: { type: integer, minimum: 1, maximum: 365, default: 30 }
 *     responses:
 *       200:
 *         description: Protocol trend series
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 protocol:
 *                   allOf: [{ $ref: '#/components/schemas/PrivacyProtocolInfo' }]
 *                   description: Protocol descriptor, or { name } when the id is unknown
 *                 days: { type: integer, example: 30 }
 *                 data:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/PrivacyProtocolDetail' }
 */
// GET /api/v1/privacy/history/:protocol -- protocol-specific trend
privacyRouter.get('/history/:protocol', async (req: Request, res: Response) => {
  try {
    const protocol = req.params.protocol.toUpperCase();
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const details = await prismaRead.privacyProtocolDetail.findMany({
      where: {
        protocol: protocol as any,
        timestamp: { gte: since },
      },
      orderBy: { timestamp: 'asc' },
    });

    res.json({
      protocol: PRIVACY_PROTOCOLS_INFO[protocol] || { name: protocol },
      days,
      data: details,
    });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

/**
 * @swagger
 * /api/v1/privacy/leaderboard:
 *   get:
 *     summary: Top privacy-using contracts
 *     tags: [Privacy]
 *     parameters:
 *       - in: query
 *         name: metric
 *         schema: { type: string, enum: [privacy_share, tx_count, protocol_count], default: privacy_share }
 *         description: Ranking metric
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
 *     responses:
 *       200:
 *         description: Ranked contracts
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 metric: { type: string }
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       address: { type: string }
 *                       txCount: { type: integer }
 *                       protocolCount: { type: integer }
 *                       avgPrivacyScore: { type: number }
 *                       protocols: { type: array, items: { type: string } }
 *               example:
 *                 metric: privacy_share
 *                 data:
 *                   - address: CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5
 *                     txCount: 142
 *                     protocolCount: 3
 *                     avgPrivacyScore: 84.2
 *                     protocols: [ZK_SNARK, SHIELDED_TRANSFER, MIXER]
 */
// GET /api/v1/privacy/leaderboard -- top privacy-using contracts
privacyRouter.get('/leaderboard', async (req: Request, res: Response) => {
  try {
    const metric = (req.query.metric as string) || 'privacy_share';
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

    const allTxs = await prismaRead.privacyTransaction.findMany({
      select: { contractAddresses: true, protocols: true, privacyScore: true },
    });

    const contractStats = new Map<
      string,
      { txCount: number; protocols: Set<string>; totalScore: number }
    >();

    for (const tx of allTxs) {
      for (const addr of tx.contractAddresses) {
        if (!contractStats.has(addr)) {
          contractStats.set(addr, { txCount: 0, protocols: new Set(), totalScore: 0 });
        }
        const stat = contractStats.get(addr)!;
        stat.txCount++;
        tx.protocols.forEach((p) => stat.protocols.add(p));
        stat.totalScore += tx.privacyScore || 0;
      }
    }

    const entries = Array.from(contractStats.entries())
      .map(([address, stats]) => ({
        address,
        txCount: stats.txCount,
        protocolCount: stats.protocols.size,
        avgPrivacyScore: stats.txCount > 0 ? stats.totalScore / stats.txCount : 0,
        protocols: Array.from(stats.protocols),
      }))
      .sort((a, b) => {
        if (metric === 'tx_count') return b.txCount - a.txCount;
        if (metric === 'protocol_count') return b.protocolCount - a.protocolCount;
        return b.avgPrivacyScore - a.avgPrivacyScore;
      })
      .slice(0, limit);

    res.json({ metric, data: entries });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

/**
 * @swagger
 * /api/v1/privacy/leaderboard/users:
 *   get:
 *     summary: Top privacy-using addresses
 *     tags: [Privacy]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
 *     responses:
 *       200:
 *         description: Ranked addresses (by transaction count)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       address: { type: string }
 *                       txCount: { type: integer }
 *                       protocolCount: { type: integer }
 *                       avgPrivacyScore: { type: number }
 *                       totalValue: { type: string, description: 'Summed raw value across the address transactions' }
 *                       protocols: { type: array, items: { type: string } }
 *               example:
 *                 data:
 *                   - address: GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI
 *                     txCount: 37
 *                     protocolCount: 2
 *                     avgPrivacyScore: 78.4
 *                     totalValue: '5400000000'
 *                     protocols: [ZK_SNARK, MIXER]
 */
// GET /api/v1/privacy/leaderboard/users -- top privacy-using addresses
privacyRouter.get('/leaderboard/users', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

    const allTxs = await prismaRead.privacyTransaction.findMany({
      select: { participants: true, protocols: true, privacyScore: true, totalValue: true },
    });

    const userStats = new Map<
      string,
      { txCount: number; protocols: Set<string>; totalScore: number; totalValue: number }
    >();

    for (const tx of allTxs) {
      for (const addr of tx.participants) {
        if (!userStats.has(addr)) {
          userStats.set(addr, { txCount: 0, protocols: new Set(), totalScore: 0, totalValue: 0 });
        }
        const stat = userStats.get(addr)!;
        stat.txCount++;
        tx.protocols.forEach((p) => stat.protocols.add(p));
        stat.totalScore += tx.privacyScore || 0;
        stat.totalValue += Number(tx.totalValue) || 0;
      }
    }

    const entries = Array.from(userStats.entries())
      .map(([address, stats]) => ({
        address,
        txCount: stats.txCount,
        protocolCount: stats.protocols.size,
        avgPrivacyScore: stats.txCount > 0 ? stats.totalScore / stats.txCount : 0,
        totalValue: String(stats.totalValue),
        protocols: Array.from(stats.protocols),
      }))
      .sort((a, b) => b.txCount - a.txCount)
      .slice(0, limit);

    res.json({ data: entries });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

/**
 * @swagger
 * /api/v1/privacy/anonymity-sets:
 *   get:
 *     summary: Current anonymity set sizes by protocol
 *     description: Latest snapshot per protocol, plus current max and average set sizes grouped by protocol combination.
 *     tags: [Privacy]
 *     responses:
 *       200:
 *         description: Anonymity set snapshots and current aggregates
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 snapshots:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/AnonymitySetSnapshot' }
 *                 current:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       protocol: { type: array, items: { type: string }, description: 'Protocol combination for the group' }
 *                       maxSetSize: { type: integer, nullable: true }
 *                       avgSetSize: { type: number, nullable: true }
 *               example:
 *                 snapshots: []
 *                 current:
 *                   - protocol: [ZK_SNARK]
 *                     maxSetSize: 256
 *                     avgSetSize: 112.5
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
// GET /api/v1/privacy/anonymity-sets -- current anonymity set sizes by protocol
privacyRouter.get('/anonymity-sets', async (_req: Request, res: Response) => {
  try {
    const latestSnapshots = await prismaRead.anonymitySetSnapshot.findMany({
      orderBy: { timestamp: 'desc' },
      take: 50,
      distinct: ['protocol'],
    });

    const currentSets = await prismaRead.privacyTransaction.groupBy({
      by: ['protocols'],
      _max: { anonymitySetSize: true },
      _avg: { anonymitySetSize: true },
    });

    res.json({
      snapshots: latestSnapshots,
      current: currentSets.map((c) => ({
        protocol: c.protocols,
        maxSetSize: c._max.anonymitySetSize,
        avgSetSize: c._avg.anonymitySetSize,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * @swagger
 * /api/v1/privacy/anonymity-sets/{protocol}/history:
 *   get:
 *     summary: Anonymity set size history for a protocol
 *     tags: [Privacy]
 *     parameters:
 *       - in: path
 *         name: protocol
 *         required: true
 *         schema: { type: string }
 *         description: Protocol id (case-insensitive)
 *       - in: query
 *         name: days
 *         schema: { type: integer, minimum: 1, maximum: 365, default: 30 }
 *     responses:
 *       200:
 *         description: Snapshot series for the protocol
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 protocol: { type: string, example: MIXER }
 *                 days: { type: integer, example: 30 }
 *                 data:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/AnonymitySetSnapshot' }
 */
// GET /api/v1/privacy/anonymity-sets/:protocol/history
privacyRouter.get('/anonymity-sets/:protocol/history', async (req: Request, res: Response) => {
  try {
    const protocol = req.params.protocol.toUpperCase();
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const snapshots = await prismaRead.anonymitySetSnapshot.findMany({
      where: {
        protocol: protocol as any,
        timestamp: { gte: since },
      },
      orderBy: { timestamp: 'asc' },
    });

    res.json({ protocol, days, data: snapshots });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

/**
 * @swagger
 * /api/v1/privacy/scores/transactions:
 *   get:
 *     summary: Privacy transactions ranked by score
 *     tags: [Privacy]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
 *       - in: query
 *         name: order
 *         schema: { type: string, enum: [privacy, risk], default: privacy }
 *         description: Sort field (privacyScore or riskScore)
 *       - in: query
 *         name: sort
 *         schema: { type: string, enum: [asc, desc], default: desc }
 *     responses:
 *       200:
 *         description: Paginated scored transactions
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/PrivacyTransaction' }
 *                 total: { type: integer, example: 280 }
 *                 page: { type: integer, example: 1 }
 *                 limit: { type: integer, example: 20 }
 *                 pages: { type: integer, example: 14 }
 *       400:
 *         description: Invalid query parameters
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'limit must be less than or equal to 100' }
 */
// GET /api/v1/privacy/scores/transactions -- ranked by privacy score
privacyRouter.get('/scores/transactions', async (req: Request, res: Response) => {
  try {
    const q = paginationSchema.parse(req.query);
    const orderBy = (req.query.order as string) === 'risk' ? 'riskScore' : 'privacyScore';
    const order = (req.query.sort as string) === 'asc' ? 'asc' : 'desc';

    const [data, total] = await Promise.all([
      prismaRead.privacyTransaction.findMany({
        where: { privacyScore: { not: null } },
        orderBy: { [orderBy]: order },
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
      prismaRead.privacyTransaction.count({
        where: { privacyScore: { not: null } },
      }),
    ]);

    res.json({ data, total, page: q.page, limit: q.limit, pages: Math.ceil(total / q.limit) });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

/**
 * @swagger
 * /api/v1/privacy/scores/contracts:
 *   get:
 *     summary: Contracts ranked by average privacy score
 *     tags: [Privacy]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
 *     responses:
 *       200:
 *         description: Ranked contracts
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       address: { type: string }
 *                       txCount: { type: integer }
 *                       avgPrivacyScore: { type: number }
 *                       avgRiskScore: { type: number }
 *                       protocolCount: { type: integer }
 *               example:
 *                 data:
 *                   - address: CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5
 *                     txCount: 142
 *                     avgPrivacyScore: 84.2
 *                     avgRiskScore: 11.5
 *                     protocolCount: 3
 */
// GET /api/v1/privacy/scores/contracts -- contracts ranked by privacy score
privacyRouter.get('/scores/contracts', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

    const allTxs = await prismaRead.privacyTransaction.findMany({
      where: { privacyScore: { not: null } },
      select: { contractAddresses: true, privacyScore: true, riskScore: true, protocols: true },
    });

    const contractMap = new Map<
      string,
      { scores: number[]; risks: number[]; protocols: Set<string>; txCount: number }
    >();

    for (const tx of allTxs) {
      for (const addr of tx.contractAddresses) {
        if (!contractMap.has(addr)) {
          contractMap.set(addr, { scores: [], risks: [], protocols: new Set(), txCount: 0 });
        }
        const entry = contractMap.get(addr)!;
        if (tx.privacyScore !== null) entry.scores.push(tx.privacyScore);
        if (tx.riskScore !== null) entry.risks.push(tx.riskScore);
        tx.protocols.forEach((p) => entry.protocols.add(p));
        entry.txCount++;
      }
    }

    const entries = Array.from(contractMap.entries())
      .map(([address, stats]) => ({
        address,
        txCount: stats.txCount,
        avgPrivacyScore:
          stats.scores.length > 0
            ? stats.scores.reduce((a, b) => a + b, 0) / stats.scores.length
            : 0,
        avgRiskScore:
          stats.risks.length > 0 ? stats.risks.reduce((a, b) => a + b, 0) / stats.risks.length : 0,
        protocolCount: stats.protocols.size,
      }))
      .sort((a, b) => b.avgPrivacyScore - a.avgPrivacyScore)
      .slice(0, limit);

    res.json({ data: entries });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

/**
 * @swagger
 * /api/v1/privacy/compliance/flagged:
 *   get:
 *     summary: List flagged compliance reports
 *     tags: [Privacy]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
 *     responses:
 *       200:
 *         description: Paginated flagged reports (highest risk first)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/PrivacyComplianceReport' }
 *                 total: { type: integer, example: 8 }
 *                 page: { type: integer, example: 1 }
 *                 limit: { type: integer, example: 20 }
 *                 pages: { type: integer, example: 1 }
 *       400:
 *         description: Invalid query parameters
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'limit must be less than or equal to 100' }
 */
// GET /api/v1/privacy/compliance/flagged -- flagged addresses
privacyRouter.get('/compliance/flagged', async (req: Request, res: Response) => {
  try {
    const q = paginationSchema.parse(req.query);

    const [data, total] = await Promise.all([
      prismaRead.privacyComplianceReport.findMany({
        where: { flagged: true },
        orderBy: { riskScore: 'desc' },
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
      prismaRead.privacyComplianceReport.count({ where: { flagged: true } }),
    ]);

    res.json({ data, total, page: q.page, limit: q.limit, pages: Math.ceil(total / q.limit) });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

/**
 * @swagger
 * /api/v1/privacy/compliance/dashboard:
 *   get:
 *     summary: Compliance overview
 *     description: Report totals, flag rate, high-risk count, label breakdown, and recent flags.
 *     tags: [Privacy]
 *     responses:
 *       200:
 *         description: Compliance dashboard summary
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 totalReports: { type: integer }
 *                 flaggedReports: { type: integer }
 *                 flagRate: { type: number, description: 'flaggedReports / totalReports (0-1)' }
 *                 highRiskCount: { type: integer, description: 'Reports with riskScore >= 70' }
 *                 byLabel:
 *                   type: array
 *                   description: Report counts grouped by compliance label
 *                   items:
 *                     type: object
 *                     properties:
 *                       complianceLabel: { type: string, nullable: true }
 *                       _count: { type: integer }
 *                 recentFlags:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/PrivacyComplianceReport' }
 *               example:
 *                 totalReports: 412
 *                 flaggedReports: 8
 *                 flagRate: 0.0194
 *                 highRiskCount: 5
 *                 byLabel:
 *                   - complianceLabel: manual_review
 *                     _count: 3
 *                 recentFlags: []
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
// GET /api/v1/privacy/compliance/dashboard -- compliance overview
privacyRouter.get('/compliance/dashboard', async (_req: Request, res: Response) => {
  try {
    const totalReports = await prismaRead.privacyComplianceReport.count();
    const flaggedReports = await prismaRead.privacyComplianceReport.count({
      where: { flagged: true },
    });

    const byLabel = await prismaRead.privacyComplianceReport.groupBy({
      by: ['complianceLabel'],
      _count: true,
    });

    const highRisk = await prismaRead.privacyComplianceReport.count({
      where: { riskScore: { gte: 70 } },
    });

    const recentFlags = await prismaRead.privacyComplianceReport.findMany({
      where: { flagged: true },
      orderBy: { reportGeneratedAt: 'desc' },
      take: 10,
    });

    res.json({
      totalReports,
      flaggedReports,
      flagRate: totalReports > 0 ? flaggedReports / totalReports : 0,
      highRiskCount: highRisk,
      byLabel,
      recentFlags,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * @swagger
 * /api/v1/privacy/compliance/reports/periodic:
 *   get:
 *     summary: Periodic compliance report summary
 *     tags: [Privacy]
 *     parameters:
 *       - in: query
 *         name: days
 *         schema: { type: integer, minimum: 1, maximum: 90, default: 30 }
 *         description: Look-back window in days
 *     responses:
 *       200:
 *         description: Aggregated report summary for the period
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 period: { type: string, example: '30 days' }
 *                 generatedAt: { type: string, format: date-time }
 *                 totalReports: { type: integer }
 *                 flaggedReports: { type: integer }
 *                 avgRiskScore: { type: number }
 *                 reports:
 *                   type: array
 *                   description: Up to 100 reports for the period (highest risk first)
 *                   items: { $ref: '#/components/schemas/PrivacyComplianceReport' }
 *               example:
 *                 period: '30 days'
 *                 generatedAt: '2026-06-19T07:24:26.000Z'
 *                 totalReports: 64
 *                 flaggedReports: 3
 *                 avgRiskScore: 22.4
 *                 reports: []
 */
// GET /api/v1/privacy/compliance/reports/periodic
privacyRouter.get('/compliance/reports/periodic', async (req: Request, res: Response) => {
  try {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const reports = await prismaRead.privacyComplianceReport.findMany({
      where: { reportGeneratedAt: { gte: since } },
      orderBy: { riskScore: 'desc' },
    });

    const flaggedCount = reports.filter((r) => r.flagged).length;
    const avgRisk =
      reports.length > 0 ? reports.reduce((a, r) => a + (r.riskScore || 0), 0) / reports.length : 0;

    res.json({
      period: `${days} days`,
      generatedAt: new Date(),
      totalReports: reports.length,
      flaggedReports: flaggedCount,
      avgRiskScore: avgRisk,
      reports: reports.slice(0, 100),
    });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

/**
 * @swagger
 * /api/v1/privacy/compliance/report/{address}/export:
 *   get:
 *     summary: Export a compliance report as a file
 *     description: Returns the report as a downloadable JSON or plain-text attachment.
 *     tags: [Privacy]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: format
 *         schema: { type: string, enum: [json, txt], default: json }
 *         description: Export format (anything other than json returns plain text)
 *     responses:
 *       200:
 *         description: The report as a downloadable attachment
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/PrivacyComplianceReport' }
 *           text/plain:
 *             schema: { type: string }
 *             example: |
 *               Compliance Report for GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI
 *               Generated: 2026-06-19T07:24:26.000Z
 *               Risk Score: 35
 *               Flagged: false
 *       404:
 *         description: No report found for this address
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'No report found for this address' }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
// GET /api/v1/privacy/compliance/report/:address/export -- export
privacyRouter.get('/compliance/report/:address/export', async (req: Request, res: Response) => {
  try {
    const address = req.params.address;
    const format = (req.query.format as string) || 'json';

    const report = await prismaRead.privacyComplianceReport.findUnique({ where: { address } });
    if (!report) {
      return res.status(404).json({ error: 'No report found for this address' });
    }

    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="compliance-${address}.json"`);
      return res.json(report);
    }

    const text = [
      `Compliance Report for ${address}`,
      `Generated: ${report.reportGeneratedAt.toISOString()}`,
      `Total Private Transactions: ${report.totalPrivateTx}`,
      `Protocols Used: ${Array.isArray(report.protocolsUsed) ? report.protocolsUsed.join(', ') : report.protocolsUsed}`,
      `Risk Score: ${report.riskScore ?? 'N/A'}`,
      `Flagged: ${report.flagged}`,
      `Flag Reason: ${report.flagReason ?? 'None'}`,
      `Compliance Label: ${report.complianceLabel ?? 'None'}`,
      `Linked Addresses: ${report.linkedAddresses.join(', ')}`,
      `Last Activity: ${report.lastActivity.toISOString()}`,
    ].join('\n');

    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="compliance-${address}.txt"`);
    res.send(text);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * @swagger
 * /api/v1/privacy/compliance/{address}:
 *   get:
 *     summary: Get (or generate) a compliance report for an address
 *     description: >-
 *       Returns the stored report for the address. If none exists, one is generated
 *       from the address privacy transactions and saved before being returned.
 *     tags: [Privacy]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: The compliance report
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/PrivacyComplianceReport' }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
// GET /api/v1/privacy/compliance/:address -- compliance report (must be last)
privacyRouter.get('/compliance/:address', async (req: Request, res: Response) => {
  try {
    const address = req.params.address;
    let report = await prismaRead.privacyComplianceReport.findUnique({
      where: { address },
    });

    if (!report) {
      const privacyTxs = await prismaRead.privacyTransaction.findMany({
        where: { participants: { has: address } },
        orderBy: { timestamp: 'desc' },
      });

      const protocolSet = new Set<string>();
      let totalRisk = 0;
      let flagged = false;
      let flagReason: string | undefined;

      for (const tx of privacyTxs) {
        tx.protocols.forEach((p) => protocolSet.add(p));
        totalRisk += tx.riskScore || 0;
      }

      if (privacyTxs.length > 0) {
        const avgRisk = totalRisk / privacyTxs.length;
        if (avgRisk > 70) {
          flagged = true;
          flagReason = 'High de-anonymization risk score';
        }
        if (protocolSet.has('MIXER')) {
          flagged = true;
          flagReason = 'Mixer/tumbler usage detected';
        }
      }

      const linkedAddresses = new Set<string>();
      for (const tx of privacyTxs) {
        tx.participants.forEach((p) => {
          if (p !== address) linkedAddresses.add(p);
        });
      }

      report = await prismaWrite.privacyComplianceReport.create({
        data: {
          address,
          totalPrivateTx: privacyTxs.length,
          protocolsUsed: Array.from(protocolSet),
          riskScore: privacyTxs.length > 0 ? totalRisk / privacyTxs.length : 0,
          flagged,
          flagReason,
          linkedAddresses: Array.from(linkedAddresses),
          lastActivity: privacyTxs[0]?.timestamp || new Date(),
          reportGeneratedAt: new Date(),
        },
      });
    }

    res.json(report);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * @swagger
 * /api/v1/privacy/de-anonymization/findings:
 *   get:
 *     summary: List de-anonymization findings
 *     tags: [Privacy]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
 *       - in: query
 *         name: technique
 *         schema: { type: string }
 *         description: Filter by heuristic (timing, amount_correlation, taint, common_input)
 *       - in: query
 *         name: minConfidence
 *         schema: { type: number }
 *         description: Minimum confidence (0-1)
 *       - in: query
 *         name: address
 *         schema: { type: string }
 *         description: Filter by target address
 *     responses:
 *       200:
 *         description: Paginated findings
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/DeAnonymizationFinding' }
 *                 total: { type: integer, example: 23 }
 *                 page: { type: integer, example: 1 }
 *                 limit: { type: integer, example: 20 }
 *                 pages: { type: integer, example: 2 }
 *       400:
 *         description: Invalid query parameters
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'limit must be less than or equal to 100' }
 */
// GET /api/v1/privacy/de-anonymization/findings
privacyRouter.get('/de-anonymization/findings', async (req: Request, res: Response) => {
  try {
    const q = paginationSchema.parse(req.query);
    const where: any = {};

    if (req.query.technique) where.technique = req.query.technique;
    if (req.query.minConfidence) where.confidence = { gte: Number(req.query.minConfidence) };
    if (req.query.address) where.targetAddress = req.query.address;

    const [data, total] = await Promise.all([
      prismaRead.deAnonymizationFinding.findMany({
        where,
        orderBy: { detectedAt: 'desc' },
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
      prismaRead.deAnonymizationFinding.count({ where }),
    ]);

    res.json({ data, total, page: q.page, limit: q.limit, pages: Math.ceil(total / q.limit) });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ── Should-Have endpoints ──────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/privacy/de-anonymization/clusters:
 *   get:
 *     summary: Address clusters from common-input heuristics
 *     description: Groups addresses likely controlled by the same entity based on shared transaction inputs.
 *     tags: [Privacy]
 *     responses:
 *       200:
 *         description: Detected address clusters
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 clusters:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       addresses: { type: array, items: { type: string } }
 *                       txCount: { type: integer }
 *                       firstSeen: { type: string, format: date-time }
 *                       lastSeen: { type: string, format: date-time }
 *                 total: { type: integer }
 *               example:
 *                 clusters:
 *                   - addresses: [GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI, GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN]
 *                     txCount: 14
 *                     firstSeen: '2026-06-01T00:00:00.000Z'
 *                     lastSeen: '2026-06-19T07:24:26.000Z'
 *                 total: 1
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
// GET /api/v1/privacy/de-anonymization/clusters
privacyRouter.get('/de-anonymization/clusters', async (_req: Request, res: Response) => {
  try {
    const clusters = await findCommonInputClusters(200);
    res.json({ clusters, total: clusters.length });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * @swagger
 * /api/v1/privacy/de-anonymization/timing/{address}:
 *   get:
 *     summary: Timing-correlation analysis for an address
 *     tags: [Privacy]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Timing correlations and detected patterns
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 address: { type: string }
 *                 correlations:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       type: { type: string }
 *                       relatedTx: { type: string }
 *                       timeDelta: { type: number, description: 'Seconds between correlated events' }
 *                       confidence: { type: number, description: '0-1' }
 *                 patterns:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       type: { type: string }
 *                       description: { type: string }
 *                       frequency: { type: number }
 *               example:
 *                 address: GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI
 *                 correlations:
 *                   - type: deposit_withdraw
 *                     relatedTx: '3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566'
 *                     timeDelta: 42
 *                     confidence: 0.78
 *                 patterns: []
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
// GET /api/v1/privacy/de-anonymization/timing/:address
privacyRouter.get('/de-anonymization/timing/:address', async (req: Request, res: Response) => {
  try {
    const result = await analyzeTiming(req.params.address);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * @swagger
 * /api/v1/privacy/de-anonymization/amount/{address}:
 *   get:
 *     summary: Amount-correlation analysis for an address
 *     description: Matches private transaction amounts against public amounts to suggest linkage.
 *     tags: [Privacy]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Amount-correlation matches
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 address: { type: string }
 *                 matches:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       privateAmount: { type: string }
 *                       publicAmount: { type: string }
 *                       matchType: { type: string }
 *                       confidence: { type: number, description: '0-1' }
 *                       txHash: { type: string }
 *               example:
 *                 address: GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI
 *                 matches:
 *                   - privateAmount: '1000000000'
 *                     publicAmount: '1000000000'
 *                     matchType: exact
 *                     confidence: 0.9
 *                     txHash: '3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
// GET /api/v1/privacy/de-anonymization/amount/:address
privacyRouter.get('/de-anonymization/amount/:address', async (req: Request, res: Response) => {
  try {
    const result = await analyzeAmountCorrelation(req.params.address);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * @swagger
 * /api/v1/privacy/de-anonymization/taint/{address}:
 *   get:
 *     summary: Taint-tracing analysis for an address
 *     description: Traces value flow through privacy protocols up to the requested depth.
 *     tags: [Privacy]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: depth
 *         schema: { type: integer, minimum: 1, maximum: 5, default: 3 }
 *         description: Trace depth (number of hops)
 *     responses:
 *       200:
 *         description: Taint trace path
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 address: { type: string }
 *                 depth: { type: integer }
 *                 path:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       txHash: { type: string }
 *                       fromAddress: { type: string }
 *                       toAddress: { type: string }
 *                       amount: { type: string }
 *                       protocol: { type: string }
 *                       confidence: { type: number, description: '0-1' }
 *               example:
 *                 address: GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI
 *                 depth: 3
 *                 path:
 *                   - txHash: '3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566'
 *                     fromAddress: GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI
 *                     toAddress: GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN
 *                     amount: '1000000000'
 *                     protocol: MIXER
 *                     confidence: 0.65
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
// GET /api/v1/privacy/de-anonymization/taint/:address
privacyRouter.get('/de-anonymization/taint/:address', async (req: Request, res: Response) => {
  try {
    const depth = Math.min(5, Math.max(1, Number(req.query.depth) || 3));
    const result = await analyzeTaint(req.params.address, depth);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * @swagger
 * /api/v1/privacy/anonymity-sets/effective:
 *   get:
 *     summary: Effective vs theoretical anonymity sets
 *     description: Compares the theoretical anonymity set size against the effective size after de-anonymization factors.
 *     tags: [Privacy]
 *     responses:
 *       200:
 *         description: Effective anonymity set comparison per protocol
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       protocol: { type: string }
 *                       theoreticalSet: { type: integer }
 *                       effectiveSet: { type: integer }
 *                       reduction: { type: number, description: 'Fraction reduced (0-1)' }
 *                       factors: { type: array, items: { type: string } }
 *               example:
 *                 data:
 *                   - protocol: MIXER
 *                     theoreticalSet: 128
 *                     effectiveSet: 96
 *                     reduction: 0.25
 *                     factors: [timing_correlation, amount_correlation]
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
// GET /api/v1/privacy/anonymity-sets/effective -- effective vs theoretical
privacyRouter.get('/anonymity-sets/effective', async (_req: Request, res: Response) => {
  try {
    const results = await getEffectiveAnonymitySets();
    res.json({ data: results });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * @swagger
 * /api/v1/privacy/compliance/flag:
 *   post:
 *     summary: Flag an address for compliance review
 *     description: Creates a compliance report for the address if none exists, otherwise updates the existing one.
 *     tags: [Privacy]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [address]
 *             properties:
 *               address: { type: string }
 *               reason: { type: string, description: 'Flag reason (defaults to "Manual flag")' }
 *               label: { type: string, description: 'Compliance label (defaults to "manual_review")' }
 *             example:
 *               address: GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI
 *               reason: Mixer interaction detected
 *               label: manual_review
 *     responses:
 *       200:
 *         description: Address flagged
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *                 address: { type: string }
 *                 flagged: { type: boolean }
 *                 reason: { type: string }
 *               example:
 *                 ok: true
 *                 address: GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI
 *                 flagged: true
 *                 reason: Mixer interaction detected
 *       400:
 *         description: Invalid request body
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'address is required' }
 */
// POST /api/v1/privacy/compliance/flag
privacyRouter.post('/compliance/flag', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      address: z.string(),
      reason: z.string().optional(),
      label: z.string().optional(),
    });
    const { address, reason, label } = schema.parse(req.body);

    const existing = await prismaRead.privacyComplianceReport.findUnique({ where: { address } });

    if (existing) {
      await prismaWrite.privacyComplianceReport.update({
        where: { address },
        data: {
          flagged: true,
          flagReason: reason || existing.flagReason,
          complianceLabel: label || existing.complianceLabel,
        },
      });
    } else {
      await prismaWrite.privacyComplianceReport.create({
        data: {
          address,
          totalPrivateTx: 0,
          protocolsUsed: [],
          flagged: true,
          flagReason: reason || 'Manual flag',
          complianceLabel: label || 'manual_review',
          lastActivity: new Date(),
          reportGeneratedAt: new Date(),
        },
      });
    }

    res.json({ ok: true, address, flagged: true, reason: reason || 'Manual flag' });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

/**
 * @swagger
 * /api/v1/privacy/compliance/unflag/{address}:
 *   post:
 *     summary: Remove the compliance flag from an address
 *     tags: [Privacy]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Address unflagged
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *                 address: { type: string }
 *                 flagged: { type: boolean }
 *               example:
 *                 ok: true
 *                 address: GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI
 *                 flagged: false
 *       500:
 *         description: Server error (e.g. no report exists for this address)
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Record to update not found' }
 */
// POST /api/v1/privacy/compliance/unflag/:address
privacyRouter.post('/compliance/unflag/:address', async (req: Request, res: Response) => {
  try {
    const address = req.params.address;
    await prismaWrite.privacyComplianceReport.update({
      where: { address },
      data: { flagged: false, flagReason: null },
    });
    res.json({ ok: true, address, flagged: false });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── Nice-to-Have: Research Tools ────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/privacy/research/graph:
 *   post:
 *     summary: Build a transaction graph for a set of addresses
 *     description: >-
 *       Returns a node/edge graph. With format=json the graph is returned as JSON;
 *       graphml, gexf, and csv return a downloadable file in the matching format.
 *     tags: [Privacy]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [addresses]
 *             properties:
 *               addresses: { type: array, items: { type: string }, minItems: 1, maxItems: 50 }
 *               depth: { type: integer, minimum: 1, maximum: 5, default: 2 }
 *               format: { type: string, enum: [json, graphml, gexf, csv], default: json }
 *             example:
 *               addresses: [GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI]
 *               depth: 2
 *               format: json
 *     responses:
 *       200:
 *         description: Transaction graph (JSON), or a downloadable file for non-json formats
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 nodes:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       type: { type: string, enum: [address, contract, mixer] }
 *                       privacyScore: { type: number }
 *                       txCount: { type: integer }
 *                 edges:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       source: { type: string }
 *                       target: { type: string }
 *                       txHash: { type: string }
 *                       value: { type: string }
 *                       protocol: { type: string }
 *                       timestamp: { type: string, format: date-time }
 *                 metadata:
 *                   type: object
 *                   properties:
 *                     nodeCount: { type: integer }
 *                     edgeCount: { type: integer }
 *                     privacyTxCount: { type: integer }
 *                     clusters: { type: integer }
 *               example:
 *                 nodes:
 *                   - id: GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI
 *                     type: address
 *                     privacyScore: 80
 *                     txCount: 12
 *                 edges:
 *                   - source: GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI
 *                     target: CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5
 *                     txHash: '3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566'
 *                     value: '1000000000'
 *                     protocol: ZK_SNARK
 *                     timestamp: '2026-06-19T07:24:26.000Z'
 *                 metadata: { nodeCount: 2, edgeCount: 1, privacyTxCount: 1, clusters: 1 }
 *           text/csv:
 *             schema: { type: string }
 *             example: |
 *               source,target,value,timestamp
 *               GBZX...,CALLD...,1000000000,2026-06-19T07:24:26.000Z
 *       400:
 *         description: Invalid request body
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'addresses must contain at least 1 element(s)' }
 */
// POST /api/v1/privacy/research/graph
privacyRouter.post('/research/graph', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      addresses: z.array(z.string()).min(1).max(50),
      depth: z.number().min(1).max(5).default(2),
      format: z.enum(['json', 'graphml', 'gexf', 'csv']).default('json'),
    });
    const body = schema.parse(req.body);

    const graph = await buildTransactionGraph(body.addresses, body.depth);

    if (body.format === 'csv') {
      let csv = 'source,target,value,timestamp\n';
      for (const edge of graph.edges) {
        csv += `${edge.source},${edge.target},${edge.value},${edge.timestamp.toISOString()}\n`;
      }
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="privacy-graph.csv"');
      return res.send(csv);
    }

    if (body.format === 'graphml') {
      let xml =
        '<?xml version="1.0" encoding="UTF-8"?>\n<graphml xmlns="http://graphml.graphdrawing.org/xmlns">\n<graph id="G" edgedefault="directed">\n';
      for (const node of graph.nodes) {
        xml += `<node id="${node.id}"><data key="type">${node.type}</data><data key="txCount">${node.txCount}</data></node>\n`;
      }
      for (const edge of graph.edges) {
        xml += `<edge source="${edge.source}" target="${edge.target}"><data key="value">${edge.value}</data></edge>\n`;
      }
      xml += '</graph>\n</graphml>';
      res.setHeader('Content-Type', 'application/xml');
      res.setHeader('Content-Disposition', 'attachment; filename="privacy-graph.graphml"');
      return res.send(xml);
    }

    if (body.format === 'gexf') {
      const gexf = `<?xml version="1.0" encoding="UTF-8"?>
<gexf xmlns="http://gexf.net/1.3" version="1.3">
  <graph mode="static" defaultedgetype="directed">
    <nodes count="${graph.nodes.length}">
      ${graph.nodes.map((n) => `<node id="${n.id}" label="${n.id.slice(0, 12)}..."/>`).join('\n      ')}
    </nodes>
    <edges count="${graph.edges.length}">
      ${graph.edges.map((e, i) => `<edge id="${i}" source="${e.source}" target="${e.target}" weight="1"/>`).join('\n      ')}
    </edges>
  </graph>
</gexf>`;
      res.setHeader('Content-Type', 'application/xml');
      res.setHeader('Content-Disposition', 'attachment; filename="privacy-graph.gexf"');
      return res.send(gexf);
    }

    res.json(graph);
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

/**
 * @swagger
 * /api/v1/privacy/research/analyze-cluster:
 *   post:
 *     summary: Analyze a cluster of addresses
 *     description: Aggregates transaction counts, privacy rate, shared protocols, and risk across the given addresses.
 *     tags: [Privacy]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [addresses]
 *             properties:
 *               addresses: { type: array, items: { type: string }, minItems: 1, maxItems: 100 }
 *             example:
 *               addresses: [GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI, GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN]
 *     responses:
 *       200:
 *         description: Cluster analysis
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 addresses: { type: array, items: { type: string } }
 *                 totalTx: { type: integer }
 *                 privacyTx: { type: integer }
 *                 privacyRate: { type: number, description: 'privacyTx / totalTx (0-1)' }
 *                 commonProtocols: { type: array, items: { type: string } }
 *                 riskScore: { type: number }
 *                 totalValue: { type: string }
 *               example:
 *                 addresses: [GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI, GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN]
 *                 totalTx: 58
 *                 privacyTx: 21
 *                 privacyRate: 0.362
 *                 commonProtocols: [ZK_SNARK, MIXER]
 *                 riskScore: 28.5
 *                 totalValue: '8400000000'
 *       400:
 *         description: Invalid request body
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'addresses must contain at least 1 element(s)' }
 */
// POST /api/v1/privacy/research/analyze-cluster
privacyRouter.post('/research/analyze-cluster', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      addresses: z.array(z.string()).min(1).max(100),
    });
    const body = schema.parse(req.body);

    const result = await analyzeCluster(body.addresses);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

/**
 * @swagger
 * /api/v1/privacy/research/datasets:
 *   get:
 *     summary: List downloadable privacy research datasets
 *     tags: [Privacy]
 *     responses:
 *       200:
 *         description: Available datasets and per-protocol download links
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 datasets:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       name: { type: string }
 *                       description: { type: string }
 *                       recordCount: { type: integer }
 *                       fields: { type: array, items: { type: string } }
 *                       format: { type: string }
 *                       downloadUrl: { type: string }
 *                 availableProtocols:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       protocol: { type: string }
 *                       count: { type: integer }
 *                       downloadUrl: { type: string }
 *               example:
 *                 datasets:
 *                   - id: privacy-transactions
 *                     name: Privacy Transactions
 *                     description: All detected privacy-preserving transactions with scores
 *                     recordCount: 320
 *                     fields: [txHash, protocols, guarantees, privacyScore, riskScore, anonymitySetSize, totalValue, participants, timestamp]
 *                     format: json
 *                     downloadUrl: /api/v1/privacy/transactions?limit=1000
 *                 availableProtocols:
 *                   - protocol: ZK_SNARK
 *                     count: 120
 *                     downloadUrl: /api/v1/privacy/transactions?protocol=ZK_SNARK&limit=1000
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
// GET /api/v1/privacy/research/datasets
privacyRouter.get('/research/datasets', async (_req: Request, res: Response) => {
  try {
    const totalTx = await prismaRead.privacyTransaction.count();
    const byProtocol = await prismaRead.privacyTransaction.findMany({
      select: { protocols: true },
    });

    const protocolCounts: Record<string, number> = {};
    for (const tx of byProtocol) {
      for (const p of tx.protocols) {
        protocolCounts[p] = (protocolCounts[p] || 0) + 1;
      }
    }

    res.json({
      datasets: [
        {
          id: 'privacy-transactions',
          name: 'Privacy Transactions',
          description: 'All detected privacy-preserving transactions with scores',
          recordCount: totalTx,
          fields: [
            'txHash',
            'protocols',
            'guarantees',
            'privacyScore',
            'riskScore',
            'anonymitySetSize',
            'totalValue',
            'participants',
            'timestamp',
          ],
          format: 'json',
          downloadUrl: '/api/v1/privacy/transactions?limit=1000',
        },
      ],
      availableProtocols: Object.entries(protocolCounts).map(([protocol, count]) => ({
        protocol,
        count,
        downloadUrl: `/api/v1/privacy/transactions?protocol=${protocol}&limit=1000`,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── Nice-to-Have: Privacy Protocol Registry ────────────────────────────────

/**
 * @swagger
 * /api/v1/privacy/registry:
 *   get:
 *     summary: Privacy protocol registry
 *     description: The supported protocols with verification status and known contracts.
 *     tags: [Privacy]
 *     responses:
 *       200:
 *         description: Registry of supported protocols
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 protocols:
 *                   type: array
 *                   items:
 *                     allOf:
 *                       - $ref: '#/components/schemas/PrivacyProtocolInfo'
 *                       - type: object
 *                         properties:
 *                           id: { type: string }
 *                           verificationStatus: { type: string, example: verified }
 *                           firstDetected: { type: string, format: date-time, nullable: true }
 *                           knownContracts: { type: array, items: { type: string } }
 *                 total: { type: integer }
 *               example:
 *                 protocols:
 *                   - id: ZK_SNARK
 *                     name: zk-SNARK
 *                     description: 'Zero-knowledge proofs for private transactions.'
 *                     category: zkp
 *                     strength: 15
 *                     verificationStatus: verified
 *                     firstDetected: null
 *                     knownContracts: []
 *                 total: 10
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
// GET /api/v1/privacy/registry
privacyRouter.get('/registry', async (_req: Request, res: Response) => {
  try {
    const registry = Object.entries(PRIVACY_PROTOCOLS_INFO).map(([key, info]) => ({
      id: key,
      name: info.name,
      description: info.description,
      category: info.category,
      strength: info.strength,
      verificationStatus: 'verified',
      firstDetected: null,
      knownContracts: [],
    }));

    res.json({ protocols: registry, total: registry.length });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── Nice-to-Have: Compliance Screening ─────────────────────────────────────

/**
 * @swagger
 * /api/v1/privacy/compliance/screen:
 *   post:
 *     summary: Screen an address for compliance risk
 *     description: Computes a risk level and flags from the address recent privacy transactions. Does not persist a report.
 *     tags: [Privacy]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [address]
 *             properties:
 *               address: { type: string }
 *               txHash: { type: string }
 *               amount: { type: string }
 *             example:
 *               address: GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI
 *     responses:
 *       200:
 *         description: Screening result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 address: { type: string }
 *                 riskLevel: { type: string, enum: [low, medium, high] }
 *                 riskScore: { type: number }
 *                 transactionCount: { type: integer }
 *                 protocolsUsed: { type: array, items: { type: string } }
 *                 flags: { type: array, items: { type: string } }
 *                 timestamp: { type: string, format: date-time }
 *               example:
 *                 address: GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI
 *                 riskLevel: medium
 *                 riskScore: 52
 *                 transactionCount: 14
 *                 protocolsUsed: [ZK_SNARK, MIXER]
 *                 flags: [Mixer/tumbler interaction detected]
 *                 timestamp: '2026-06-19T07:24:26.000Z'
 *       400:
 *         description: Invalid request body
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'address is required' }
 */
// POST /api/v1/privacy/compliance/screen
privacyRouter.post('/compliance/screen', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      address: z.string(),
      txHash: z.string().optional(),
      amount: z.string().optional(),
    });
    const body = schema.parse(req.body);

    const privacyTxs = await prismaRead.privacyTransaction.findMany({
      where: { participants: { has: body.address } },
      orderBy: { timestamp: 'desc' },
      take: 20,
    });

    const protocolsUsed = new Set<string>();
    let totalRisk = 0;
    for (const tx of privacyTxs) {
      tx.protocols.forEach((p) => protocolsUsed.add(p));
      totalRisk += tx.riskScore || 0;
    }

    const riskScore = privacyTxs.length > 0 ? totalRisk / privacyTxs.length : 0;

    const screeningResult = {
      address: body.address,
      riskLevel: riskScore > 70 ? 'high' : riskScore > 40 ? 'medium' : 'low',
      riskScore,
      transactionCount: privacyTxs.length,
      protocolsUsed: Array.from(protocolsUsed),
      flags: [] as string[],
      timestamp: new Date(),
    };

    if (protocolsUsed.has('MIXER')) {
      screeningResult.flags.push('Mixer/tumbler interaction detected');
    }
    if (riskScore > 70) {
      screeningResult.flags.push('High risk score');
    }
    if (privacyTxs.length > 50) {
      screeningResult.flags.push('High volume of privacy transactions');
    }

    res.json(screeningResult);
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ── ML Endpoints ───────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/privacy/ml/predict-anonymity:
 *   get:
 *     summary: Predict anonymity set trend
 *     description: Simple projection of anonymity set size from recent transactions.
 *     tags: [Privacy]
 *     parameters:
 *       - in: query
 *         name: protocol
 *         schema: { type: string }
 *         description: Protocol id to scope the prediction (case-insensitive)
 *       - in: query
 *         name: days
 *         schema: { type: integer, minimum: 7, maximum: 90, default: 30 }
 *     responses:
 *       200:
 *         description: Anonymity prediction
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 protocol: { type: string, description: 'Protocol id, or "all"' }
 *                 days: { type: integer }
 *                 dataPoints: { type: integer }
 *                 currentAvg: { type: number, nullable: true }
 *                 currentMax: { type: integer, nullable: true }
 *                 predicted: { type: integer, nullable: true }
 *                 trend: { type: string, enum: [increasing, stable, unknown] }
 *                 confidence: { type: number, description: '0-1' }
 *               example:
 *                 protocol: all
 *                 days: 30
 *                 dataPoints: 42
 *                 currentAvg: 96.4
 *                 currentMax: 256
 *                 predicted: 106
 *                 trend: increasing
 *                 confidence: 0.85
 */
// GET /api/v1/privacy/ml/predict-anonymity
privacyRouter.get('/ml/predict-anonymity', async (req: Request, res: Response) => {
  try {
    const protocol = req.query.protocol as string;
    const days = Math.min(90, Math.max(7, Number(req.query.days) || 30));

    const where: any = {
      timestamp: { gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000) },
    };
    if (protocol) where.protocols = { has: protocol.toUpperCase() };

    const recentTxs = await prismaRead.privacyTransaction.findMany({
      where,
      orderBy: { timestamp: 'asc' },
      select: { anonymitySetSize: true, timestamp: true, protocols: true },
    });

    const sets = recentTxs
      .filter((t) => t.anonymitySetSize !== null)
      .map((t) => t.anonymitySetSize!);
    const trend = sets.length > 5 ? 'increasing' : sets.length > 0 ? 'stable' : 'unknown';

    const predicted =
      sets.length > 0 ? Math.round((sets.reduce((a, b) => a + b, 0) / sets.length) * 1.1) : null;

    res.json({
      protocol: protocol || 'all',
      days,
      dataPoints: sets.length,
      currentAvg: sets.length > 0 ? sets.reduce((a, b) => a + b, 0) / sets.length : null,
      currentMax: sets.length > 0 ? Math.max(...sets) : null,
      predicted,
      trend,
      confidence: sets.length > 20 ? 0.85 : sets.length > 10 ? 0.7 : 0.5,
    });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ── Cross-Protocol Analysis ────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/privacy/cross-protocol/{address}:
 *   get:
 *     summary: Cross-protocol privacy profile for an address
 *     description: Per-protocol usage plus aggregate privacy and risk scores for the address.
 *     tags: [Privacy]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Cross-protocol profile
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 address: { type: string }
 *                 totalPrivacyTx: { type: integer }
 *                 uniqueProtocols: { type: integer }
 *                 protocolUsage:
 *                   type: object
 *                   description: Map of protocol id to usage stats
 *                   additionalProperties:
 *                     type: object
 *                     properties:
 *                       count: { type: integer }
 *                       firstUsed: { type: string, format: date-time }
 *                       lastUsed: { type: string, format: date-time }
 *                       totalValue: { type: string }
 *                 avgPrivacyScore: { type: number }
 *                 avgRiskScore: { type: number }
 *                 aggregatePrivacyScore: { type: number, description: 'Capped at 100' }
 *                 assessment: { type: string, description: 'Strong privacy posture | Moderate privacy | Weak privacy' }
 *               example:
 *                 address: GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI
 *                 totalPrivacyTx: 21
 *                 uniqueProtocols: 2
 *                 protocolUsage:
 *                   ZK_SNARK: { count: 14, firstUsed: '2026-06-01T00:00:00.000Z', lastUsed: '2026-06-19T07:24:26.000Z', totalValue: '5400000000' }
 *                 avgPrivacyScore: 78.4
 *                 avgRiskScore: 18
 *                 aggregatePrivacyScore: 100
 *                 assessment: Strong privacy posture
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
// GET /api/v1/privacy/cross-protocol/:address
privacyRouter.get('/cross-protocol/:address', async (req: Request, res: Response) => {
  try {
    const address = req.params.address;

    const privacyTxs = await prismaRead.privacyTransaction.findMany({
      where: { participants: { has: address } },
      orderBy: { timestamp: 'desc' },
    });

    const protocolUsage: Record<
      string,
      { count: number; firstUsed: Date; lastUsed: Date; totalValue: string }
    > = {};

    for (const tx of privacyTxs) {
      for (const p of tx.protocols) {
        if (!protocolUsage[p]) {
          protocolUsage[p] = {
            count: 0,
            firstUsed: tx.timestamp,
            lastUsed: tx.timestamp,
            totalValue: '0',
          };
        }
        protocolUsage[p].count++;
        if (tx.timestamp < protocolUsage[p].firstUsed) protocolUsage[p].firstUsed = tx.timestamp;
        if (tx.timestamp > protocolUsage[p].lastUsed) protocolUsage[p].lastUsed = tx.timestamp;
        protocolUsage[p].totalValue = String(
          Number(protocolUsage[p].totalValue) + (Number(tx.totalValue) || 0),
        );
      }
    }

    const totalScore = privacyTxs.reduce((a, t) => a + (t.privacyScore || 0), 0);
    const totalRisk = privacyTxs.reduce((a, t) => a + (t.riskScore || 0), 0);
    const aggregatePrivacy = Math.min(100, totalScore + privacyTxs.length * 5);

    res.json({
      address,
      totalPrivacyTx: privacyTxs.length,
      uniqueProtocols: Object.keys(protocolUsage).length,
      protocolUsage,
      avgPrivacyScore: privacyTxs.length > 0 ? totalScore / privacyTxs.length : 0,
      avgRiskScore: privacyTxs.length > 0 ? totalRisk / privacyTxs.length : 0,
      aggregatePrivacyScore: aggregatePrivacy,
      assessment:
        aggregatePrivacy > 70
          ? 'Strong privacy posture'
          : aggregatePrivacy > 40
            ? 'Moderate privacy'
            : 'Weak privacy',
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── ZK Dashboard ───────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/privacy/zk/verifiers:
 *   get:
 *     summary: List ZK verifier contracts
 *     description: Contracts seen in zk-SNARK or zk-STARK transactions, with usage stats.
 *     tags: [Privacy]
 *     responses:
 *       200:
 *         description: ZK verifier contracts
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 verifiers:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       address: { type: string }
 *                       txCount: { type: integer }
 *                       proofTypes: { type: array, items: { type: string } }
 *                       lastUsed: { type: string, format: date-time }
 *                 total: { type: integer }
 *               example:
 *                 verifiers:
 *                   - address: CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5
 *                     txCount: 64
 *                     proofTypes: [ZK_SNARK]
 *                     lastUsed: '2026-06-19T07:24:26.000Z'
 *                 total: 1
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
// GET /api/v1/privacy/zk/verifiers
privacyRouter.get('/zk/verifiers', async (req: Request, res: Response) => {
  try {
    const zkTxs = await prismaRead.privacyTransaction.findMany({
      where: {
        protocols: { hasSome: ['ZK_SNARK', 'ZK_STARK'] },
      },
      orderBy: { timestamp: 'desc' },
      take: 100,
    });

    const verifierMap = new Map<
      string,
      { address: string; txCount: number; proofTypes: Set<string>; lastUsed: Date }
    >();

    for (const tx of zkTxs) {
      for (const addr of tx.contractAddresses) {
        if (!verifierMap.has(addr)) {
          verifierMap.set(addr, {
            address: addr,
            txCount: 0,
            proofTypes: new Set(),
            lastUsed: tx.timestamp,
          });
        }
        const v = verifierMap.get(addr)!;
        v.txCount++;
        tx.protocols.forEach((p) => {
          if (p === 'ZK_SNARK' || p === 'ZK_STARK') v.proofTypes.add(p);
        });
        if (tx.timestamp > v.lastUsed) v.lastUsed = tx.timestamp;
      }
    }

    res.json({
      verifiers: Array.from(verifierMap.values()).map((v) => ({
        ...v,
        proofTypes: Array.from(v.proofTypes),
      })),
      total: verifierMap.size,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * @swagger
 * /api/v1/privacy/zk/verifiers/{address}:
 *   get:
 *     summary: ZK verifier detail for a contract
 *     tags: [Privacy]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Verifier usage detail
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 address: { type: string }
 *                 totalTx: { type: integer }
 *                 avgPrivacyScore: { type: number }
 *                 recentTxs:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       txHash: { type: string }
 *                       protocols: { type: array, items: { type: string } }
 *                       privacyScore: { type: number, nullable: true }
 *                       timestamp: { type: string, format: date-time }
 *               example:
 *                 address: CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5
 *                 totalTx: 64
 *                 avgPrivacyScore: 86.1
 *                 recentTxs:
 *                   - txHash: '3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566'
 *                     protocols: [ZK_SNARK]
 *                     privacyScore: 87.5
 *                     timestamp: '2026-06-19T07:24:26.000Z'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
// GET /api/v1/privacy/zk/verifiers/:address
privacyRouter.get('/zk/verifiers/:address', async (req: Request, res: Response) => {
  try {
    const address = req.params.address;

    const txs = await prismaRead.privacyTransaction.findMany({
      where: {
        contractAddresses: { has: address },
        protocols: { hasSome: ['ZK_SNARK', 'ZK_STARK'] },
      },
      orderBy: { timestamp: 'desc' },
    });

    const avgScore =
      txs.length > 0 ? txs.reduce((a, t) => a + (t.privacyScore || 0), 0) / txs.length : 0;

    res.json({
      address,
      totalTx: txs.length,
      avgPrivacyScore: avgScore,
      recentTxs: txs.slice(0, 20).map((t) => ({
        txHash: t.txHash,
        protocols: t.protocols,
        privacyScore: t.privacyScore,
        timestamp: t.timestamp,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * @swagger
 * /api/v1/privacy/zk/proofs:
 *   get:
 *     summary: List zero-knowledge proof transactions
 *     description: Privacy transactions tagged with zk-SNARK, zk-STARK, or Bulletproof protocols.
 *     tags: [Privacy]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
 *     responses:
 *       200:
 *         description: Paginated ZK proof transactions
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/PrivacyTransaction' }
 *                 total: { type: integer, example: 140 }
 *                 page: { type: integer, example: 1 }
 *                 limit: { type: integer, example: 20 }
 *                 pages: { type: integer, example: 7 }
 *       400:
 *         description: Invalid query parameters
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'limit must be less than or equal to 100' }
 */
// GET /api/v1/privacy/zk/proofs
privacyRouter.get('/zk/proofs', async (req: Request, res: Response) => {
  try {
    const q = paginationSchema.parse(req.query);

    const [data, total] = await Promise.all([
      prismaRead.privacyTransaction.findMany({
        where: {
          protocols: { hasSome: ['ZK_SNARK', 'ZK_STARK', 'BULLETPROOF'] },
        },
        orderBy: { timestamp: 'desc' },
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
      prismaRead.privacyTransaction.count({
        where: {
          protocols: { hasSome: ['ZK_SNARK', 'ZK_STARK', 'BULLETPROOF'] },
        },
      }),
    ]);

    res.json({ data, total, page: q.page, limit: q.limit, pages: Math.ceil(total / q.limit) });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

/**
 * @swagger
 * /api/v1/privacy/zk/benchmarks:
 *   get:
 *     summary: ZK proof system benchmarks
 *     description: Sample counts and average privacy scores per ZK proving system.
 *     tags: [Privacy]
 *     responses:
 *       200:
 *         description: Benchmark summary
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 benchmarks:
 *                   type: object
 *                   properties:
 *                     ZK_SNARK:
 *                       type: object
 *                       properties:
 *                         count: { type: integer }
 *                         avgScore: { type: number }
 *                     ZK_STARK:
 *                       type: object
 *                       properties:
 *                         count: { type: integer }
 *                         avgScore: { type: number }
 *                     BULLETPROOF:
 *                       type: object
 *                       properties:
 *                         count: { type: integer }
 *                         avgScore: { type: number }
 *                 totalSamples: { type: integer }
 *               example:
 *                 benchmarks:
 *                   ZK_SNARK: { count: 120, avgScore: 86.1 }
 *                   ZK_STARK: { count: 40, avgScore: 88.4 }
 *                   BULLETPROOF: { count: 22, avgScore: 79.2 }
 *                 totalSamples: 182
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
// GET /api/v1/privacy/zk/benchmarks
privacyRouter.get('/zk/benchmarks', async (_req: Request, res: Response) => {
  try {
    const zkTxs = await prismaRead.privacyTransaction.findMany({
      where: {
        protocols: { hasSome: ['ZK_SNARK', 'ZK_STARK', 'BULLETPROOF'] as any },
      },
      take: 200,
    });

    const benchmarks = {
      ZK_SNARK: { count: 0, avgScore: 0 },
      ZK_STARK: { count: 0, avgScore: 0 },
      BULLETPROOF: { count: 0, avgScore: 0 },
    };

    for (const tx of zkTxs) {
      for (const p of tx.protocols) {
        if (p in benchmarks) {
          (benchmarks as any)[p].count++;
          (benchmarks as any)[p].avgScore += tx.privacyScore || 0;
        }
      }
    }

    for (const key of Object.keys(benchmarks)) {
      const b = (benchmarks as any)[key];
      if (b.count > 0) b.avgScore /= b.count;
    }

    res.json({ benchmarks, totalSamples: zkTxs.length });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── DeFi Privacy Endpoints ─────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/privacy/defi:
 *   get:
 *     summary: DeFi privacy adoption
 *     description: Privacy transaction share across token (DeFi) contracts over the period.
 *     tags: [Privacy]
 *     parameters:
 *       - in: query
 *         name: days
 *         schema: { type: integer, minimum: 1, maximum: 90, default: 30 }
 *     responses:
 *       200:
 *         description: DeFi privacy summary
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 period: { type: string, example: '30 days' }
 *                 totalDefiTx: { type: integer }
 *                 defiPrivacyTx: { type: integer }
 *                 privacyAdoptionRate: { type: number, description: 'defiPrivacyTx / totalDefiTx (0-1)' }
 *                 byProtocol: { type: object, description: 'Per-protocol counts (reserved; currently empty)' }
 *                 recentTxs:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/PrivacyTransaction' }
 *               example:
 *                 period: '30 days'
 *                 totalDefiTx: 5200
 *                 defiPrivacyTx: 88
 *                 privacyAdoptionRate: 0.0169
 *                 byProtocol: {}
 *                 recentTxs: []
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
// GET /api/v1/privacy/defi
privacyRouter.get('/defi', async (req: Request, res: Response) => {
  try {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const defiContracts = await prismaRead.contract.findMany({
      where: {
        isToken: true,
      },
      select: { address: true, name: true },
    });

    const defiAddresses = defiContracts.map((c) => c.address);

    const defiPrivacyTxs = await prismaRead.privacyTransaction.findMany({
      where: {
        contractAddresses: { hasSome: defiAddresses },
        timestamp: { gte: since },
      },
      orderBy: { timestamp: 'desc' },
    });

    const allDefiTxs = await prismaRead.transaction.count({
      where: {
        contractAddress: { in: defiAddresses },
        ledgerCloseTime: { gte: since },
      },
    });

    res.json({
      period: `${days} days`,
      totalDefiTx: allDefiTxs,
      defiPrivacyTx: defiPrivacyTxs.length,
      privacyAdoptionRate: allDefiTxs > 0 ? defiPrivacyTxs.length / allDefiTxs : 0,
      byProtocol: {} as Record<string, number>,
      recentTxs: defiPrivacyTxs.slice(0, 20),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── Cross-Chain Bridge Endpoints ───────────────────────────────────────────

/**
 * @swagger
 * /api/v1/privacy/bridges:
 *   get:
 *     summary: Cross-chain bridge privacy activity
 *     description: Recent privacy transactions treated as bridge activity over the period.
 *     tags: [Privacy]
 *     parameters:
 *       - in: query
 *         name: days
 *         schema: { type: integer, minimum: 1, maximum: 90, default: 30 }
 *     responses:
 *       200:
 *         description: Bridge activity summary
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 period: { type: string, example: '30 days' }
 *                 totalBridgeTxs: { type: integer }
 *                 totalVolume: { type: number, description: 'Summed raw value' }
 *                 uniqueUsers: { type: integer }
 *                 recentTxs:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       txHash: { type: string }
 *                       protocols: { type: array, items: { type: string } }
 *                       value: { type: string, nullable: true }
 *                       participants: { type: array, items: { type: string } }
 *                       timestamp: { type: string, format: date-time }
 *               example:
 *                 period: '30 days'
 *                 totalBridgeTxs: 100
 *                 totalVolume: 12500000000
 *                 uniqueUsers: 47
 *                 recentTxs:
 *                   - txHash: '3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566'
 *                     protocols: [SHIELDED_TRANSFER]
 *                     value: '1000000000'
 *                     participants: [GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI]
 *                     timestamp: '2026-06-19T07:24:26.000Z'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
// GET /api/v1/privacy/bridges
privacyRouter.get('/bridges', async (req: Request, res: Response) => {
  try {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const bridgeTxs = await prismaRead.privacyTransaction.findMany({
      where: {
        timestamp: { gte: since },
      },
      orderBy: { timestamp: 'desc' },
      take: 100,
    });

    res.json({
      period: `${days} days`,
      totalBridgeTxs: bridgeTxs.length,
      totalVolume: bridgeTxs.reduce((a, t) => a + (Number(t.totalValue) || 0), 0),
      uniqueUsers: new Set(bridgeTxs.flatMap((t) => t.participants)).size,
      recentTxs: bridgeTxs.slice(0, 20).map((t) => ({
        txHash: t.txHash,
        protocols: t.protocols,
        value: t.totalValue,
        participants: t.participants,
        timestamp: t.timestamp,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── Scoring Endpoint for Detection ─────────────────────────────────────────

/**
 * @swagger
 * /api/v1/privacy/detect:
 *   post:
 *     summary: Detect privacy techniques and score a parameter set
 *     description: Runs the detector and scorer over the supplied function call shape without persisting anything.
 *     tags: [Privacy]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [functionName]
 *             properties:
 *               functionName: { type: string }
 *               protocols:
 *                 type: array
 *                 items:
 *                   type: string
 *                   enum: [SHIELDED_TRANSFER, ZK_SNARK, ZK_STARK, BULLETPROOF, STEALTH_ADDRESS, MIXER, PRIVATE_VOTING, OFF_CHAIN_DATA, ENCRYPTED_STATE, DIFFERENTIAL_PRIVACY]
 *               anonymitySetSize: { type: integer, nullable: true }
 *               sourceAccount: { type: string }
 *               contractAddresses: { type: array, items: { type: string } }
 *             example:
 *               functionName: shielded_transfer
 *               protocols: [SHIELDED_TRANSFER]
 *               anonymitySetSize: 128
 *               sourceAccount: GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI
 *               contractAddresses: [CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5]
 *     responses:
 *       200:
 *         description: Detection result and privacy score
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 detection:
 *                   type: object
 *                   description: Detected protocols, guarantees, and primitives for the function call
 *                   properties:
 *                     protocols: { type: array, items: { type: string } }
 *                     guarantees: { type: array, items: { type: string } }
 *                     cryptographicPrimitives: { type: object }
 *                     anonymitySetSize: { type: integer, nullable: true }
 *                     participants: { type: array, items: { type: string } }
 *                     totalValue: { type: string, nullable: true }
 *                     assetType: { type: string, nullable: true }
 *                     contractAddresses: { type: array, items: { type: string } }
 *                     confidence: { type: number, description: '0-1' }
 *                 score:
 *                   type: object
 *                   description: Privacy and risk scores with a per-factor breakdown
 *                   properties:
 *                     privacyScore: { type: number }
 *                     riskScore: { type: number }
 *                     breakdown: { type: object }
 *               example:
 *                 detection:
 *                   protocols: [SHIELDED_TRANSFER]
 *                   guarantees: [SENDER_PRIVACY, AMOUNT_PRIVACY]
 *                   cryptographicPrimitives: { commitment: 'pedersen' }
 *                   anonymitySetSize: null
 *                   participants: []
 *                   totalValue: null
 *                   assetType: null
 *                   contractAddresses: []
 *                   confidence: 0.8
 *                 score:
 *                   privacyScore: 72
 *                   riskScore: 18
 *                   breakdown: { protocolDiversity: 10, anonymitySetScore: 20, cryptographicStrength: 25, deAnonymizationVectors: 5, historicalLinkage: 0, baseRisk: 10, graphRisk: 3, contractRisk: 5 }
 *       400:
 *         description: Invalid request body
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'functionName is required' }
 */
// POST /api/v1/privacy/detect -- detect privacy in a set of parameters
privacyRouter.post('/detect', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      functionName: z.string(),
      protocols: z.array(protocolEnum).optional(),
      anonymitySetSize: z.number().nullable().optional(),
      sourceAccount: z.string().optional(),
      contractAddresses: z.array(z.string()).optional(),
    });
    const body = schema.parse(req.body);

    const score = await computePrivacyScore(
      body.protocols || [],
      [],
      body.anonymitySetSize || null,
      body.sourceAccount || null,
      body.contractAddresses || [],
    );

    res.json({
      detection: detectPrivacyTechniques(body.functionName, []),
      score,
    });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});
