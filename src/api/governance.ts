import { Router, Request, Response } from 'express';
import { prismaRead as prisma } from '../db';
import { z } from 'zod';
import { validateAddressParam } from '../middleware/sanitize';

export const governanceRouter = Router();

const listProposalsSchema = z.object({
  contract: z.string().optional(),
  status: z.string().optional(),
  proposer: z.string().optional(),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
});

const proposalQuerySchema = z.object({
  contract: z.string(),
  proposalId: z.string(),
});



// GET /governance/proposals
governanceRouter.get('/proposals', async (req: Request, res: Response) => {
  try {
    const { contract, status, proposer, page, limit } = listProposalsSchema.parse(req.query);
    const skip = (page - 1) * limit;
    const where: any = {
      ...(contract ? { contractAddress: contract } : {}),
      ...(status ? { status } : {}),
      ...(proposer ? { proposer } : {}),
    };

    const [data, total] = await Promise.all([
      prisma.governanceProposal.findMany({
        where,
        orderBy: { startBlock: 'desc' },
        skip,
        take: limit,
        select: {
          contractAddress: true,
          proposalId: true,
          proposer: true,
          title: true,
          status: true,
          startBlock: true,
          endBlock: true,
          votesFor: true,
          votesAgainst: true,
          votesAbstain: true,
          quorum: true,
          executionTxHash: true,
          executedAt: true,
          updatedAt: true,
        },
      }),
      prisma.governanceProposal.count({ where }),
    ]);

    res.json({ data, total, page, limit });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// GET /governance/proposals/:contract/:proposalId
governanceRouter.get(
  '/proposals/:contract/:proposalId',
  validateAddressParam('contract'),
  async (req: Request, res: Response) => {
    try {
      const { contract, proposalId } = proposalQuerySchema.parse(req.params);
      const proposal = await prisma.governanceProposal.findUnique({
        where: { contractAddress_proposalId: { contractAddress: contract, proposalId } },
        include: { votes: true },
      });
      if (!proposal) return res.status(404).json({ error: 'Proposal not found' });

      const totalVotes = proposal.votes.length;
      const forVotes = proposal.votes.filter((v) => v.support === 'for').length;
      const againstVotes = proposal.votes.filter((v) => v.support === 'against').length;
      const abstainVotes = proposal.votes.filter((v) => v.support === 'abstain').length;

      res.json({
        proposal,
        voteSummary: {
          totalVotes,
          votesFor: proposal.votesFor,
          votesAgainst: proposal.votesAgainst,
          votesAbstain: proposal.votesAbstain,
          forCount: forVotes,
          againstCount: againstVotes,
          abstainCount: abstainVotes,
        },
      });
    } catch (e) {
      res.status(400).json({ error: String(e) });
    }
  },
);

// GET /governance/proposals/:contract/:proposalId/votes
governanceRouter.get(
  '/proposals/:contract/:proposalId/votes',
  validateAddressParam('contract'),
  async (req: Request, res: Response) => {
    try {
      const { contract, proposalId } = proposalQuerySchema.parse(req.params);
      const votes = await prisma.governanceVote.findMany({
        where: { contractAddress: contract, proposalId },
        orderBy: { ledgerSequence: 'asc' },
        select: { voter: true, weight: true, support: true, reason: true },
      });

      const uniqueVoters = new Set(votes.map((vote) => vote.voter));
      const participation =
        uniqueVoters.size === 0 ? 0 : uniqueVoters.size / Math.max(1, votes.length);

      res.json({
        votes,
        totalVoters: uniqueVoters.size,
        voterParticipation: participation,
      });
    } catch (e) {
      res.status(400).json({ error: String(e) });
    }
  },
);

// GET /governance/contracts/:address
governanceRouter.get(
  '/contracts/:address',
  validateAddressParam('address'),
  async (req: Request, res: Response) => {
    try {
      const address = req.params.address;
      const contract = await prisma.governanceContract.findUnique({
        where: { contractAddress: address },
        include: {
          proposals: true,
          votes: true,
          delegates: true,
        },
      });
      if (!contract) return res.status(404).json({ error: 'Governance contract not found' });

      const totalProposals = contract.proposals.length;
      const executedProposals = contract.proposals.filter((p) => p.status === 'executed').length;
      const defeatedProposals = contract.proposals.filter((p) => p.status === 'defeated').length;
      const cancelledProposals = contract.proposals.filter((p) => p.status === 'cancelled').length;
      const activeProposals = contract.proposals.filter((p) => p.status === 'active').length;
      const topProposers = await prisma.governanceProposal.groupBy({
        by: ['proposer'],
        where: { contractAddress: address },
        _count: { proposer: true },
        orderBy: { _count: { proposer: 'desc' } },
        take: 10,
      });
      const topVoters = await prisma.governanceVote.groupBy({
        by: ['voter'],
        where: { contractAddress: address },
        _count: { voter: true },
        orderBy: { _count: { voter: 'desc' } },
        take: 10,
      });

      res.json({
        contract: address,
        governanceType: contract.governanceType,
        votingToken: contract.votingToken,
        totalProposals,
        executedProposals,
        defeatedProposals,
        cancelledProposals,
        activeProposals,
        averageParticipation: 0,
        averageQuorumReached: 0,
        topProposers: topProposers.map((item) => ({
          address: item.proposer,
          proposalsCreated: item._count.proposer,
        })),
        topVoters: topVoters.map((item) => ({
          address: item.voter,
          votesCast: item._count.voter,
          votingPower: '0 TOKEN',
        })),
      });
    } catch (e) {
      res.status(400).json({ error: String(e) });
    }
  },
);

// GET /governance/contracts/:address/delegates
governanceRouter.get(
  '/contracts/:address/delegates',
  validateAddressParam('address'),
  async (req: Request, res: Response) => {
    try {
      const address = req.params.address;
      const delegates = await prisma.governanceDelegate.findMany({
        where: { contractAddress: address },
        orderBy: { delegatedVotes: 'desc' },
        take: 50,
      });
      res.json({ delegates });
    } catch (e) {
      res.status(400).json({ error: String(e) });
    }
  },
);

// GET /governance/stats
governanceRouter.get('/stats', async (_req: Request, res: Response) => {
  try {
    const totalGovernanceContracts = await prisma.governanceContract.count();
    const totalProposals = await prisma.governanceProposal.count();
    const totalVotesCast = await prisma.governanceVote.count();
    const mostActive = await prisma.governanceProposal.groupBy({
      by: ['contractAddress'],
      _count: { contractAddress: true },
      orderBy: { _count: { contractAddress: 'desc' } },
      take: 1,
    });

    res.json({
      totalGovernanceContracts,
      totalProposals,
      totalVotesCast,
      avgParticipationRate: 0,
      mostActiveGovernance: mostActive[0]
        ? {
            contract: mostActive[0].contractAddress,
            proposals: mostActive[0]._count.contractAddress,
          }
        : null,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /governance/calendar
governanceRouter.get('/calendar', async (_req: Request, res: Response) => {
  try {
    const upcoming = await prisma.governanceProposal.findMany({
      where: { status: 'active' },
      orderBy: { endBlock: 'asc' },
      take: 50,
      select: {
        contractAddress: true,
        proposalId: true,
        title: true,
        endBlock: true,
        status: true,
        startBlock: true,
      },
    });
    const queued = await prisma.governanceProposal.findMany({
      where: { status: 'queued' },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      select: {
        contractAddress: true,
        proposalId: true,
        title: true,
        status: true,
        executionTxHash: true,
      },
    });

    res.json({ upcoming, queued });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});
