import { Router } from 'express';
import { prismaRead as prisma } from '../db';
import { asyncHandler } from '../middleware/asyncHandler';

export const grantsBountiesRouter = Router();

// GET /grants-bounties/overview
grantsBountiesRouter.get(
  '/overview',
  asyncHandler(async (_req, res) => {
    const [proposalsCount, payoutsCount, totalPaid] = await Promise.all([
      prisma.governanceProposal.count(),
      prisma.treasuryPayoutStream.count(),
      prisma.treasuryTransaction.aggregate({ _sum: { amount: true } }),
    ]);
    res.json({
      proposals: proposalsCount,
      payoutStreams: payoutsCount,
      totalPaid: totalPaid._sum.amount ?? 0,
    });
  }),
);

// GET /grants-bounties/proposals
grantsBountiesRouter.get(
  '/proposals',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const offset = Number(req.query.offset) || 0;
    const items = await prisma.governanceProposal.findMany({
      skip: offset,
      take: limit,
      orderBy: { createdAt: 'desc' },
    });
    res.json(items);
  }),
);

// GET /grants-bounties/streams
grantsBountiesRouter.get(
  '/streams',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const offset = Number(req.query.offset) || 0;
    const items = await prisma.treasuryPayoutStream.findMany({
      skip: offset,
      take: limit,
      orderBy: { createdAt: 'desc' },
    });
    res.json(items);
  }),
);

// GET /grants-bounties/leaderboard
grantsBountiesRouter.get(
  '/leaderboard',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 10, 50);
    const rows = await prisma.treasuryTransaction.groupBy({
      by: ['recipient'],
      _sum: { amount: true },
      orderBy: { _sum: { amount: 'desc' } },
      take: limit,
    });
    res.json(rows.map((r) => ({ recipient: r.recipient, total: r._sum.amount ?? 0 })));
  }),
);

// GET /grants-bounties/milestones
grantsBountiesRouter.get(
  '/milestones',
  asyncHandler(async (req, res) => {
    const proposalId = String(req.query.proposalId || '');
    if (!proposalId) return res.status(400).json({ error: 'proposalId required' });
    const votes = await prisma.governanceVote.findMany({
      where: { proposalId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json(votes);
  }),
);
