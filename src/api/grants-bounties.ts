import { Router } from 'express';
import { prisma } from '../lib/prisma';

export const grantsBountiesRouter = Router();

// GET /grants-bounties/overview
grantsBountiesRouter.get('/overview', async (_req, res) => {
  try {
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
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /grants-bounties/proposals
grantsBountiesRouter.get('/proposals', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const offset = Number(req.query.offset) || 0;
  try {
    const items = await prisma.governanceProposal.findMany({
      skip: offset,
      take: limit,
      orderBy: { createdAt: 'desc' },
    });
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /grants-bounties/streams
grantsBountiesRouter.get('/streams', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const offset = Number(req.query.offset) || 0;
  try {
    const items = await prisma.treasuryPayoutStream.findMany({
      skip: offset,
      take: limit,
      orderBy: { createdAt: 'desc' },
    });
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /grants-bounties/leaderboard
grantsBountiesRouter.get('/leaderboard', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 10, 50);
  try {
    const rows = await prisma.treasuryTransaction.groupBy({
      by: ['recipient'],
      _sum: { amount: true },
      orderBy: { _sum: { amount: 'desc' } },
      take: limit,
    });
    res.json(rows.map(r => ({ recipient: r.recipient, total: r._sum.amount ?? 0 })));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /grants-bounties/milestones
grantsBountiesRouter.get('/milestones', async (req, res) => {
  const proposalId = String(req.query.proposalId || '');
  if (!proposalId) return res.status(400).json({ error: 'proposalId required' });
  try {
    const votes = await prisma.governanceVote.findMany({
      where: { proposalId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json(votes);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
