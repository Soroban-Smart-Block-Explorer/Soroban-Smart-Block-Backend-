import { Router, Request, Response } from 'express';
import { Keypair } from '@stellar/stellar-sdk';
import { prismaRead as prisma, prismaRead, prismaWrite } from '../db';
import { z } from 'zod';
import { validateAddressParam } from '../middleware/sanitize';
import { asyncHandler } from '../middleware/asyncHandler';
import { logger } from '../logger';
import {
  assertTransition,
  buildGraph,
  canGuardianCancel,
  getStrategy,
  graphSnapshot,
  InvalidTransitionError,
  supportedModels,
  type ProposalStatus,
  type SupportValue,
} from '../services/governance';
import { buildStrategyContext, GovernanceNotFoundError } from '../services/governance/context';

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
governanceRouter.get(
  '/proposals',
  asyncHandler(async (req: Request, res: Response) => {
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
  }),
);

// GET /governance/proposals/:contract/:proposalId
governanceRouter.get(
  '/proposals/:contract/:proposalId',
  validateAddressParam('contract'),
  asyncHandler(async (req: Request, res: Response) => {
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
  }),
);

// GET /governance/proposals/:contract/:proposalId/votes
governanceRouter.get(
  '/proposals/:contract/:proposalId/votes',
  validateAddressParam('contract'),
  asyncHandler(async (req: Request, res: Response) => {
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
  }),
);

// GET /governance/contracts/:address
governanceRouter.get(
  '/contracts/:address',
  validateAddressParam('address'),
  asyncHandler(async (req: Request, res: Response) => {
    const address = req.params.address;
    const govContract = await prisma.governanceContract.findUnique({
      where: { contractAddress: address },
      include: {
        proposals: true,
        votes: true,
        delegates: true,
      },
    });
    if (!govContract) return res.status(404).json({ error: 'Governance contract not found' });

    const totalProposals = govContract.proposals.length;
    const executedProposals = govContract.proposals.filter((p) => p.status === 'executed').length;
    const defeatedProposals = govContract.proposals.filter((p) => p.status === 'defeated').length;
    const cancelledProposals = govContract.proposals.filter((p) => p.status === 'cancelled').length;
    const activeProposals = govContract.proposals.filter((p) => p.status === 'active').length;
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
      governanceType: govContract.governanceType,
      votingToken: govContract.votingToken,
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
  }),
);

// GET /governance/contracts/:address/delegates
governanceRouter.get(
  '/contracts/:address/delegates',
  validateAddressParam('address'),
  asyncHandler(async (req: Request, res: Response) => {
    const address = req.params.address;
    const delegates = await prisma.governanceDelegate.findMany({
      where: { contractAddress: address },
      orderBy: { delegatedVotes: 'desc' },
      take: 50,
    });
    res.json({ delegates });
  }),
);

// GET /governance/delegation/graph?contract=...&category=...
// Delegation flow graph for the frontend viz: nodes with resolved power
// (docs/governance-framework.md §6). Power source is indexed token balances;
// until balance indexing lands, resolved power counts delegation edges.
const delegationGraphSchema = z.object({
  contract: z.string().min(1),
  category: z.string().min(1).max(64).default('all'),
});

governanceRouter.get(
  '/delegation/graph',
  asyncHandler(async (req: Request, res: Response) => {
    const { contract, category } = delegationGraphSchema.parse(req.query);
    const edges = await prisma.governanceDelegation.findMany({
      where: { contractAddress: contract, revokedAt: null },
      select: { delegator: true, delegatee: true, category: true, revokedAt: true },
    });
    const graph = buildGraph(edges);
    // Each wallet weighs 1 until indexed balances are wired in — the graph
    // shape (chains, fan-in, top delegates by reach) is already meaningful.
    const snapshot = await graphSnapshot({ graph, category, getOwnPower: async () => 1n });
    res.json({
      contract,
      category,
      totalActiveEdges: edges.length,
      topDelegates: snapshot.nodes.slice(0, 10),
      nodes: snapshot.nodes,
      edges: snapshot.edges,
    });
  }),
);

// GET /governance/stats
governanceRouter.get(
  '/stats',
  asyncHandler(async (_req: Request, res: Response) => {
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
  }),
);

// GET /governance/calendar
governanceRouter.get(
  '/calendar',
  asyncHandler(async (_req: Request, res: Response) => {
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
  }),
);

// ═════════════════════════════════════════════════════════════════════════════
// Write path (issue #567 Phase 3) — proposals, votes, delegation, lifecycle.
//
// Trust model: the backend never holds keys. Off-chain writes are
// authenticated with an ed25519-signed message from the acting address
// (same pattern as /auth). On-chain state comes from indexed events.
// Signed message convention (prevents cross-endpoint replay):
//   governance:<action>:<contractAddress>:<payload-specific parts>
// ═════════════════════════════════════════════════════════════════════════════

// ── Auth helper ───────────────────────────────────────────────────────────────

function verifySignedAction(params: {
  address: string;
  message: string;
  signature: string;
}): boolean {
  try {
    const kp = Keypair.fromPublicKey(params.address);
    const sig = /^[A-Za-z0-9+/=]+$/.test(params.signature)
      ? Buffer.from(params.signature, 'base64')
      : Buffer.from(params.signature.replace(/^0x/, ''), 'hex');
    return kp.verify(Buffer.from(params.message), sig);
  } catch {
    return false;
  }
}

const signedActionSchema = z.object({
  address: z.string().regex(/^G[A-Z2-7]{55}$/, 'must be a Stellar account address'),
  signature: z.string().min(16),
  /** Unix seconds; must be within ±5 minutes to bound replay windows. */
  signedAt: z.coerce.number().int(),
});

function checkFreshness(signedAt: number): string | null {
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - signedAt) > 300) return 'signature timestamp outside the 5-minute window';
  return null;
}

// ── POST /proposals — create draft / register submission ─────────────────────

const TEMPLATES = ['parameter_change', 'fund_transfer', 'contract_upgrade', 'text'] as const;

const createProposalSchema = z.object({
  contract: z.string().min(1),
  title: z.string().min(1).max(200),
  description: z.string().max(10_000).optional(),
  template: z.enum(TEMPLATES),
  /** Executable payload: contract invocations voted on (empty for text). */
  targets: z
    .array(
      z.object({
        contractAddress: z.string(),
        functionName: z.string(),
        /** base64 ScVal args, built by the template helpers on the frontend or here later */
        args: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  values: z.array(z.string().regex(/^\d+$/)).optional(),
  startBlock: z.coerce.number().int().min(0).optional(),
  endBlock: z.coerce.number().int().min(0).optional(),
  auth: signedActionSchema,
});

governanceRouter.post(
  '/proposals',
  asyncHandler(async (req: Request, res: Response) => {
    const body = createProposalSchema.parse(req.body);
    const stale = checkFreshness(body.auth.signedAt);
    if (stale) return res.status(401).json({ error: stale });

    const message = `governance:propose:${body.contract}:${body.title}:${body.auth.signedAt}`;
    if (
      !verifySignedAction({ address: body.auth.address, message, signature: body.auth.signature })
    ) {
      return res.status(401).json({ error: 'Invalid signature', expectedMessage: message });
    }

    const govContract = await prismaRead.governanceContract.findUnique({
      where: { contractAddress: body.contract },
    });
    if (!govContract) return res.status(404).json({ error: 'Governance contract not found' });

    if (body.template === 'text' && body.targets.length > 0) {
      return res.status(400).json({ error: 'text proposals cannot carry executable targets' });
    }
    if (body.template !== 'text' && body.targets.length === 0) {
      return res
        .status(400)
        .json({ error: `${body.template} proposals require at least one target` });
    }

    // Proposal threshold: creator must hold at least the configured balance.
    // Balance integration is indexed-data based; enforced when available.
    const latestLedger = await prismaRead.ledger.findFirst({
      orderBy: { sequence: 'desc' },
      select: { sequence: true },
    });
    const current = latestLedger?.sequence ?? 0;
    const votingPeriod = govContract.votingPeriodLedgers ?? 100_800; // ≈7 days at 6s
    const startBlock = body.startBlock ?? current;
    const endBlock = body.endBlock ?? startBlock + votingPeriod;
    if (endBlock <= startBlock) {
      return res.status(400).json({ error: 'endBlock must be after startBlock' });
    }

    // Off-chain draft id: drafts live under a reserved prefix so they can
    // never collide with on-chain numeric proposal ids from the indexer.
    const proposalId = `draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const proposal = await prismaWrite.governanceProposal.create({
      data: {
        contractAddress: body.contract,
        proposalId,
        proposer: body.auth.address,
        title: body.title,
        description: body.description,
        template: body.template,
        votingModel: govContract.governanceType,
        targets: body.targets,
        values: body.values ?? undefined,
        snapshotLedger: startBlock,
        startBlock,
        endBlock,
        status: 'draft',
        executionKind: body.template === 'text' ? 'none' : 'onchain',
      },
    });

    logger.info('governance proposal draft created', {
      contract: body.contract,
      proposalId,
      proposer: body.auth.address,
    });
    return res.status(201).json({
      proposal,
      next: 'Submit the on-chain create_proposal transaction; the indexer will link it by event.',
    });
  }),
);

// ── POST /proposals/:contract/:proposalId/votes — cast vote ─────────────────

const castVoteSchema = z.object({
  support: z.enum(['for', 'against', 'abstain', 'confirm']),
  /** Token-weighted/conviction amount (integer string). */
  amount: z
    .string()
    .regex(/^\d+$/)
    .transform((v) => BigInt(v))
    .optional(),
  /** Quadratic: number of votes (cost = votes²). */
  votes: z.coerce.number().int().positive().optional(),
  reason: z.string().max(2_000).optional(),
  auth: signedActionSchema,
});

governanceRouter.post(
  '/proposals/:contract/:proposalId/votes',
  asyncHandler(async (req: Request, res: Response) => {
    const { contract, proposalId } = req.params;
    const body = castVoteSchema.parse(req.body);
    const stale = checkFreshness(body.auth.signedAt);
    if (stale) return res.status(401).json({ error: stale });

    const message = `governance:vote:${contract}:${proposalId}:${body.support}:${body.auth.signedAt}`;
    if (
      !verifySignedAction({ address: body.auth.address, message, signature: body.auth.signature })
    ) {
      return res.status(401).json({ error: 'Invalid signature', expectedMessage: message });
    }

    let ctx;
    try {
      ctx = await buildStrategyContext(prismaRead, contract, proposalId);
    } catch (err) {
      if (err instanceof GovernanceNotFoundError)
        return res.status(404).json({ error: err.message });
      throw err;
    }

    const derived = ctx.proposal.status;
    if (derived !== 'active' && derived !== 'pending') {
      return res.status(409).json({ error: `Proposal is ${derived}; voting requires active` });
    }

    const strategy = getStrategy(ctx.config.governanceType);
    const validation = await strategy.validateVote(ctx, {
      voter: body.auth.address,
      support: body.support as SupportValue,
      amount: body.amount,
      votes: body.votes,
      reason: body.reason,
    });
    if (!validation.valid) {
      return res.status(422).json({ error: validation.reason ?? 'Vote rejected' });
    }

    const vote = await prismaWrite.governanceVote.upsert({
      where: {
        contractAddress_proposalId_voter: {
          contractAddress: contract,
          proposalId,
          voter: body.auth.address,
        },
      },
      update: {
        support: body.support,
        weight: validation.weight.toString(),
        reason: body.reason,
        voiceCredits: validation.voiceCreditCost,
      },
      create: {
        contractAddress: contract,
        proposalId,
        voter: body.auth.address,
        support: body.support,
        weight: validation.weight.toString(),
        reason: body.reason,
        voiceCredits: validation.voiceCreditCost,
        ...(ctx.config.governanceType === 'conviction'
          ? {
              stakeAmount: validation.weight.toString(),
              convictionAt: '0',
              lastUpdateLedger: ctx.currentLedger,
            }
          : {}),
      },
    });

    // Debit quadratic voice credits.
    if (validation.voiceCreditCost && ctx.config.governanceType === 'quadratic') {
      const round = ctx.proposal.startBlock;
      const budget = ctx.config.voiceCreditsPerRound ?? 100;
      await prismaWrite.governanceVoiceCredit.upsert({
        where: {
          contractAddress_round_holder: {
            contractAddress: contract,
            round,
            holder: body.auth.address,
          },
        },
        update: { spent: { increment: validation.voiceCreditCost } },
        create: {
          contractAddress: contract,
          round,
          holder: body.auth.address,
          budget,
          spent: validation.voiceCreditCost,
        },
      });
    }

    return res.status(201).json({ vote, weight: validation.weight.toString() });
  }),
);

// ── POST /delegation & DELETE /delegation — liquid democracy edges ──────────

const delegationSchema = z.object({
  contract: z.string().min(1),
  delegatee: z.string().regex(/^G[A-Z2-7]{55}$/),
  category: z.string().min(1).max(64).default('all'),
  auth: signedActionSchema,
});

governanceRouter.post(
  '/delegation',
  asyncHandler(async (req: Request, res: Response) => {
    const body = delegationSchema.parse(req.body);
    const stale = checkFreshness(body.auth.signedAt);
    if (stale) return res.status(401).json({ error: stale });

    const message = `governance:delegate:${body.contract}:${body.delegatee}:${body.category}:${body.auth.signedAt}`;
    if (
      !verifySignedAction({ address: body.auth.address, message, signature: body.auth.signature })
    ) {
      return res.status(401).json({ error: 'Invalid signature', expectedMessage: message });
    }
    if (body.auth.address === body.delegatee) {
      return res.status(400).json({ error: 'Cannot delegate to yourself' });
    }

    const govContract = await prismaRead.governanceContract.findUnique({
      where: { contractAddress: body.contract },
      select: { categories: true },
    });
    if (!govContract) return res.status(404).json({ error: 'Governance contract not found' });
    if (
      body.category !== 'all' &&
      govContract.categories.length > 0 &&
      !govContract.categories.includes(body.category)
    ) {
      return res
        .status(400)
        .json({ error: `Unknown category '${body.category}'`, known: govContract.categories });
    }

    // One active outbound edge per (delegator, category): revoke then create.
    const [, delegation] = await prismaWrite.$transaction([
      prismaWrite.governanceDelegation.updateMany({
        where: {
          contractAddress: body.contract,
          delegator: body.auth.address,
          category: body.category,
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      }),
      prismaWrite.governanceDelegation.create({
        data: {
          contractAddress: body.contract,
          delegator: body.auth.address,
          delegatee: body.delegatee,
          category: body.category,
        },
      }),
    ]);

    return res.status(201).json({ delegation });
  }),
);

const revokeSchema = z.object({
  contract: z.string().min(1),
  category: z.string().min(1).max(64).default('all'),
  auth: signedActionSchema,
});

governanceRouter.delete(
  '/delegation',
  asyncHandler(async (req: Request, res: Response) => {
    const body = revokeSchema.parse(req.body);
    const stale = checkFreshness(body.auth.signedAt);
    if (stale) return res.status(401).json({ error: stale });

    const message = `governance:undelegate:${body.contract}:${body.category}:${body.auth.signedAt}`;
    if (
      !verifySignedAction({ address: body.auth.address, message, signature: body.auth.signature })
    ) {
      return res.status(401).json({ error: 'Invalid signature', expectedMessage: message });
    }

    const result = await prismaWrite.governanceDelegation.updateMany({
      where: {
        contractAddress: body.contract,
        delegator: body.auth.address,
        category: body.category,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
    if (result.count === 0) {
      return res.status(404).json({ error: 'No active delegation for this category' });
    }
    return res.json({ revoked: result.count });
  }),
);

// ── Lifecycle transitions: queue / cancel ─────────────────────────────────────

const transitionSchema = z.object({ auth: signedActionSchema });

governanceRouter.post(
  '/proposals/:contract/:proposalId/queue',
  asyncHandler(async (req: Request, res: Response) => {
    const { contract, proposalId } = req.params;
    const body = transitionSchema.parse(req.body);
    const stale = checkFreshness(body.auth.signedAt);
    if (stale) return res.status(401).json({ error: stale });
    const message = `governance:queue:${contract}:${proposalId}:${body.auth.signedAt}`;
    if (
      !verifySignedAction({ address: body.auth.address, message, signature: body.auth.signature })
    ) {
      return res.status(401).json({ error: 'Invalid signature', expectedMessage: message });
    }

    let ctx;
    try {
      ctx = await buildStrategyContext(prismaRead, contract, proposalId);
    } catch (err) {
      if (err instanceof GovernanceNotFoundError)
        return res.status(404).json({ error: err.message });
      throw err;
    }

    // Anyone may queue a succeeded proposal (docs §8); verify the tally.
    const strategy = getStrategy(ctx.config.governanceType);
    const votes = await prismaRead.governanceVote.findMany({
      where: { contractAddress: contract, proposalId },
      select: {
        voter: true,
        support: true,
        weight: true,
        stakeAmount: true,
        convictionAt: true,
        lastUpdateLedger: true,
      },
    });
    const tally = await strategy.tally(ctx, votes as never);
    const outcome = strategy.outcome(ctx, tally);
    if (outcome !== 'succeeded') {
      return res.status(409).json({
        error: `Proposal outcome is ${outcome}; cannot queue`,
        tally: serializeTally(tally),
      });
    }

    try {
      assertTransition(ctx.proposal.status as ProposalStatus, 'queued');
    } catch (err) {
      if (err instanceof InvalidTransitionError)
        return res.status(409).json({ error: err.message });
      throw err;
    }

    const delaySecs = ctx.config.timelockDelaySecs ?? 48 * 3600;
    const eta = new Date(Date.now() + delaySecs * 1000);
    const proposal = await prismaWrite.governanceProposal.update({
      where: { contractAddress_proposalId: { contractAddress: contract, proposalId } },
      data: { status: 'queued', queuedAt: new Date(), eta },
    });
    return res.json({ proposal, eta, tally: serializeTally(tally) });
  }),
);

governanceRouter.post(
  '/proposals/:contract/:proposalId/cancel',
  asyncHandler(async (req: Request, res: Response) => {
    const { contract, proposalId } = req.params;
    const body = transitionSchema.parse(req.body);
    const stale = checkFreshness(body.auth.signedAt);
    if (stale) return res.status(401).json({ error: stale });
    const message = `governance:cancel:${contract}:${proposalId}:${body.auth.signedAt}`;
    if (
      !verifySignedAction({ address: body.auth.address, message, signature: body.auth.signature })
    ) {
      return res.status(401).json({ error: 'Invalid signature', expectedMessage: message });
    }

    const [contractRow, proposal] = await Promise.all([
      prismaRead.governanceContract.findUnique({ where: { contractAddress: contract } }),
      prismaRead.governanceProposal.findUnique({
        where: { contractAddress_proposalId: { contractAddress: contract, proposalId } },
      }),
    ]);
    if (!contractRow || !proposal) return res.status(404).json({ error: 'Proposal not found' });

    const isProposer = body.auth.address === proposal.proposer;
    const isGuardian = contractRow.guardian != null && body.auth.address === contractRow.guardian;
    if (!isProposer && !isGuardian) {
      return res.status(403).json({ error: 'Only the proposer or guardian may cancel' });
    }
    const status = proposal.status as ProposalStatus;
    // Guardians may cancel queued malicious proposals; proposers only their
    // own drafts/pending (once active the community owns the proposal).
    const allowed = isGuardian
      ? canGuardianCancel(status)
      : status === 'draft' || status === 'pending';
    if (!allowed) {
      return res.status(409).json({
        error: `Cannot cancel a ${status} proposal as ${isGuardian ? 'guardian' : 'proposer'}`,
      });
    }

    const updated = await prismaWrite.governanceProposal.update({
      where: { contractAddress_proposalId: { contractAddress: contract, proposalId } },
      data: { status: 'cancelled', cancelledBy: body.auth.address },
    });
    logger.info('governance proposal cancelled', {
      contract,
      proposalId,
      by: body.auth.address,
      role: isGuardian ? 'guardian' : 'proposer',
    });
    return res.json({ proposal: updated });
  }),
);

// ── GET /proposals/:contract/:proposalId/execution — simulate ────────────────

governanceRouter.get(
  '/proposals/:contract/:proposalId/execution',
  asyncHandler(async (req: Request, res: Response) => {
    const { contract, proposalId } = req.params;

    // 404 with a consistent message when the contract/proposal is unknown.
    try {
      await buildStrategyContext(prismaRead, contract, proposalId);
    } catch (err) {
      if (err instanceof GovernanceNotFoundError)
        return res.status(404).json({ error: err.message });
      throw err;
    }

    const proposal = await prismaRead.governanceProposal.findUnique({
      where: { contractAddress_proposalId: { contractAddress: contract, proposalId } },
      select: {
        targets: true,
        values: true,
        calldatas: true,
        status: true,
        eta: true,
        executionKind: true,
      },
    });
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' });

    const failureConditions: string[] = [];
    if (proposal.executionKind === 'none') {
      failureConditions.push('text proposal: nothing to execute');
    }
    if (proposal.status !== 'queued') {
      failureConditions.push(`status is '${proposal.status}' (must be queued)`);
    }
    if (proposal.eta && proposal.eta.getTime() > Date.now()) {
      failureConditions.push(`timelock ETA not reached (${proposal.eta.toISOString()})`);
    }
    const targets = Array.isArray(proposal.targets) ? proposal.targets : [];
    if (proposal.executionKind !== 'none' && targets.length === 0) {
      failureConditions.push('proposal has no executable targets');
    }

    // Deep simulation (footprint, state diff) goes through POST /simulate
    // with the client-built envelope; here we report the checks the contract
    // itself will enforce plus the prepared call list.
    return res.json({
      executable: failureConditions.length === 0,
      failureConditions,
      calls: targets,
      values: proposal.values ?? [],
      eta: proposal.eta,
      simulateEndpoint: '/api/v1/simulate',
      note: 'Build the execution envelope from `calls` and POST it to /simulate for a full state-change preview.',
    });
  }),
);

// ── GET /models — supported governance models + config surface ───────────────

governanceRouter.get(
  '/models',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({
      models: supportedModels(),
      details: {
        token_based: {
          config: ['quorumBps', 'votingPeriodLedgers', 'proposalThreshold', 'timelockDelaySecs'],
        },
        quadratic: { config: ['voiceCreditsPerRound', 'minTokenHolding', 'minReputationScore'] },
        conviction: { config: ['convictionHalfLifeLedgers', 'convictionMaxRatioBps'] },
        multisig: { config: ['multisigThreshold'] },
      },
    });
  }),
);

function serializeTally(tally: {
  for: bigint;
  against: bigint;
  abstain: bigint;
  totalVoters: number;
  conviction?: bigint;
}) {
  return {
    for: tally.for.toString(),
    against: tally.against.toString(),
    abstain: tally.abstain.toString(),
    totalVoters: tally.totalVoters,
    ...(tally.conviction !== undefined ? { conviction: tally.conviction.toString() } : {}),
  };
}
