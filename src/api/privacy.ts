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

// GET /api/v1/privacy/de-anonymization/clusters
privacyRouter.get('/de-anonymization/clusters', async (_req: Request, res: Response) => {
  try {
    const clusters = await findCommonInputClusters(200);
    res.json({ clusters, total: clusters.length });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/v1/privacy/de-anonymization/timing/:address
privacyRouter.get('/de-anonymization/timing/:address', async (req: Request, res: Response) => {
  try {
    const result = await analyzeTiming(req.params.address);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/v1/privacy/de-anonymization/amount/:address
privacyRouter.get('/de-anonymization/amount/:address', async (req: Request, res: Response) => {
  try {
    const result = await analyzeAmountCorrelation(req.params.address);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

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

// GET /api/v1/privacy/anonymity-sets/effective -- effective vs theoretical
privacyRouter.get('/anonymity-sets/effective', async (_req: Request, res: Response) => {
  try {
    const results = await getEffectiveAnonymitySets();
    res.json({ data: results });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

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
