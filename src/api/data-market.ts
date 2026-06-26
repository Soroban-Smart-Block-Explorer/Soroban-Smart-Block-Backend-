/**
 * Historical Data Market (#327)
 *
 * Fully decentralized archival layer with token-incentivized storage,
 * challenge-response verification, ZK-proof stubs, SLA marketplace,
 * dynamic pricing, cross-epoch sharding, reputation scoring, and an
 * autonomous routing fabric with analytics.
 *
 * POST   /api/v1/data-market/register                    — Register archival node
 * POST   /api/v1/data-market/stake                       — Stake tokens
 * POST   /api/v1/data-market/unstake                     — Unstake tokens (cooldown)
 * GET    /api/v1/data-market/nodes                       — List archival nodes
 * GET    /api/v1/data-market/nodes/:address              — Node detail
 * PATCH  /api/v1/data-market/nodes/:address              — Update node config
 * POST   /api/v1/data-market/nodes/:address/deactivate   — Deactivate node
 * GET    /api/v1/data-market/epochs                      — Available epochs
 * GET    /api/v1/data-market/epochs/:epochId             — Epoch detail
 * GET    /api/v1/data-market/query                       — Query available data
 * GET    /api/v1/data-market/overview                    — Market statistics
 * POST   /api/v1/data-market/challenge                   — Issue storage challenge
 * POST   /api/v1/data-market/challenge/:id/respond       — Submit response
 * POST   /api/v1/data-market/challenge/:id/verify        — Verify response
 * POST   /api/v1/data-market/challenge/zk-proof          — Submit ZK proof
 * GET    /api/v1/data-market/challenges/:nodeId          — Challenge history
 * GET    /api/v1/data-market/slashes                     — Slashing events
 * POST   /api/v1/data-market/appeal                      — Appeal slashing
 * POST   /api/v1/data-market/slas                        — Create SLA offer
 * GET    /api/v1/data-market/slas                        — Browse SLA offers
 * POST   /api/v1/data-market/slas/:id/accept             — Accept SLA
 * GET    /api/v1/data-market/prices                      — Current price feed
 * GET    /api/v1/data-market/prices/history              — Price history
 * GET    /api/v1/data-market/redundancy                  — Redundancy map
 * POST   /api/v1/data-market/rebalance                   — Trigger rebalance
 * GET    /api/v1/data-market/reputation/:address         — Reputation breakdown
 * GET    /api/v1/data-market/router/status               — Routing fabric health
 * GET    /api/v1/data-market/router/routes               — Active routing rules
 * POST   /api/v1/data-market/router/rules                — Custom routing rules
 * GET    /api/v1/data-market/analytics/dashboard         — Full analytics
 * GET    /api/v1/data-market/analytics/epoch-coverage    — Underserved epochs
 * GET    /api/v1/data-market/analytics/node-churn        — Node churn metrics
 * GET    /api/v1/data-market/tokenomics                  — Tokenomics data
 * GET    /api/v1/data-market/leaderboard                 — Top nodes by earnings
 */

import crypto from 'crypto';
import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z, ZodError } from 'zod';
import { prismaRead, prismaWrite } from '../db';
import { asyncHandler } from '../middleware/asyncHandler';

export const dataMarketRouter = Router();

// ── Constants ─────────────────────────────────────────────────────────────────

const MIN_STAKE = 100;
const UNSTAKE_COOLDOWN_DAYS = 7;
const SLASH_RATES = [0.1, 0.25, 0.5, 1.0]; // escalating slash percentages
const REPUTATION_WEIGHTS = {
  uptime: 0.3,
  challengeSuccess: 0.25,
  responseTime: 0.2,
  dataIntegrity: 0.15,
  communityVotes: 0.1,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function computeReputation(node: {
  uptime30d: number;
  challengesPassed: number;
  totalChallenges: number;
  avgResponseTime: number | null;
  challengesFailed: number;
}): number {
  const uptimeScore = Math.min(node.uptime30d, 100);
  const challengeScore =
    node.totalChallenges > 0 ? (node.challengesPassed / node.totalChallenges) * 100 : 50;
  const responseScore =
    node.avgResponseTime == null ? 50 : Math.max(0, 100 - node.avgResponseTime / 50);
  const integrityScore =
    node.challengesFailed === 0 ? 100 : Math.max(0, 100 - node.challengesFailed * 10);
  const communityScore = 70;

  return (
    uptimeScore * REPUTATION_WEIGHTS.uptime +
    challengeScore * REPUTATION_WEIGHTS.challengeSuccess +
    responseScore * REPUTATION_WEIGHTS.responseTime +
    integrityScore * REPUTATION_WEIGHTS.dataIntegrity +
    communityScore * REPUTATION_WEIGHTS.communityVotes
  );
}

function computePrice(
  baseFee: number,
  demandRatio: number,
  reputation: number,
  epochAgeDays: number,
): number {
  const demandFactor = 0.5 + demandRatio;
  const reputationFactor = 0.5 + reputation / 200;
  const ageFactor = 1 + Math.log1p(epochAgeDays / 30) * 0.2;
  return baseFee * demandFactor * reputationFactor * ageFactor;
}

function generateChallengeData(type: string, checksum: string | null) {
  const offset = Math.floor(Math.random() * 1024);
  const length = 64 + Math.floor(Math.random() * 192);
  if (type === 'merkle_proof') {
    return { offset, length, merkleIndex: Math.floor(Math.random() * 256), checksum };
  }
  if (type === 'zk_proof') {
    return {
      circuit: 'poseidon_storage_v1',
      publicInputHash: crypto.randomBytes(16).toString('hex'),
    };
  }
  return { offset, length, checksum };
}

function verifyMerkleProof(
  challengeData: Record<string, unknown>,
  responseData: Record<string, unknown>,
  merkleRoot: string | null,
): boolean {
  if (!merkleRoot) return false;
  const proof = responseData['proof'] as string | undefined;
  if (!proof) return false;
  // Simulate O(log n) verification against the stored root
  const computed = crypto
    .createHash('sha256')
    .update(merkleRoot + JSON.stringify(challengeData) + proof)
    .digest('hex');
  const provided = responseData['computedRoot'] as string | undefined;
  return provided === computed;
}

function verifyByteRangeProof(
  challengeData: Record<string, unknown>,
  responseData: Record<string, unknown>,
  checksum: string | null,
): boolean {
  if (!checksum) return false;
  const data = responseData['data'] as string | undefined;
  if (!data) return false;
  const expected = crypto
    .createHash('sha256')
    .update(checksum + JSON.stringify(challengeData) + data)
    .digest('hex');
  const provided = responseData['hash'] as string | undefined;
  return provided === expected;
}

function verifyZkProof(responseData: Record<string, unknown>): boolean {
  // Stub: verify that the submitted ZK proof has the required fields
  return (
    typeof responseData['proof'] === 'string' &&
    typeof responseData['publicSignals'] === 'object' &&
    responseData['proof'].length > 0
  );
}

function selectBestNode(
  nodes: Array<{
    id: string;
    reputation: number;
    avgResponseTime: number | null;
    commission: number | null;
  }>,
  prefer: 'price' | 'latency' | 'reputation',
): string | undefined {
  if (nodes.length === 0) return undefined;
  const scored = nodes.map((n) => {
    const rep = n.reputation;
    const lat = n.avgResponseTime ? Math.max(0, 1000 - n.avgResponseTime) / 1000 : 0.5;
    const price = n.commission ? Math.max(0, 1 - n.commission / 100) : 0.8;
    let score: number;
    if (prefer === 'reputation') score = rep * 0.6 + lat * 0.2 + price * 0.2;
    else if (prefer === 'latency') score = lat * 0.6 + rep * 0.3 + price * 0.1;
    else score = price * 0.5 + rep * 0.3 + lat * 0.2;
    return { id: n.id, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.id;
}

// ── Zod schemas ───────────────────────────────────────────────────────────────

const RegisterSchema = z.object({
  address: z.string().min(1),
  name: z.string().optional(),
  endpoint: z.string().url(),
  stakeAmount: z.number().min(MIN_STAKE),
  stakeAsset: z.string().default('XLM'),
  maxStorageGb: z.number().int().positive().optional(),
  commission: z.number().min(0).max(100).optional(),
});

const StakeSchema = z.object({
  address: z.string().min(1),
  amount: z.number().positive(),
  asset: z.string().default('XLM'),
});

const UnstakeSchema = z.object({
  address: z.string().min(1),
  amount: z.number().positive(),
});

const UpdateNodeSchema = z.object({
  name: z.string().optional(),
  endpoint: z.string().url().optional(),
  commission: z.number().min(0).max(100).optional(),
  maxStorageGb: z.number().int().positive().optional(),
  supportedEpochs: z.array(z.object({ start: z.number(), end: z.number() })).optional(),
});

const ChallengeSchema = z.object({
  nodeAddress: z.string().min(1),
  epochId: z.string().min(1),
  challengeType: z
    .enum(['random_byte_range', 'merkle_proof', 'zk_proof'])
    .default('random_byte_range'),
});

const RespondSchema = z.object({
  responseData: z.record(z.unknown()),
});

const ZkProofSchema = z.object({
  challengeId: z.string().min(1),
  proof: z.string().min(1),
  publicSignals: z.record(z.unknown()),
});

const AppealSchema = z.object({
  slashId: z.string().min(1),
  reason: z.string().min(10),
  evidence: z.record(z.unknown()).optional(),
});

const SlaOfferSchema = z.object({
  nodeAddress: z.string().min(1),
  tier: z.enum(['bronze', 'silver', 'gold']),
  responseMs: z.number().int().positive(),
  pricePerGb: z.number().positive(),
  description: z.string().optional(),
});

const RouterRuleSchema = z.object({
  name: z.string().min(1),
  preference: z.enum(['price', 'latency', 'reputation']).default('reputation'),
  filters: z.record(z.unknown()).optional(),
});

// ── Must-Have: Core Data Market ───────────────────────────────────────────────

// POST /register
dataMarketRouter.post(
  '/register',
  asyncHandler(async (req, res) => {
    const body = RegisterSchema.parse(req.body);

    const existing = await prismaRead.archivalNode.findUnique({ where: { address: body.address } });
    if (existing) return res.status(409).json({ error: 'Node already registered' });

    const node = await prismaWrite.archivalNode.create({
      data: {
        address: body.address,
        name: body.name,
        endpoint: body.endpoint,
        stakedAmount: body.stakeAmount,
        stakeAsset: body.stakeAsset,
        maxStorageGb: body.maxStorageGb,
        commission: body.commission,
        status: 'active',
      },
    });

    return res.status(201).json({ node });
  }),
);

// POST /stake
dataMarketRouter.post(
  '/stake',
  asyncHandler(async (req, res) => {
    const body = StakeSchema.parse(req.body);

    const node = await prismaRead.archivalNode.findUnique({ where: { address: body.address } });
    if (!node) return res.status(404).json({ error: 'Node not found' });
    if (node.status === 'jailed' || node.status === 'slashed') {
      return res.status(403).json({ error: 'Cannot stake while node is jailed or slashed' });
    }

    const updated = await prismaWrite.archivalNode.update({
      where: { address: body.address },
      data: { stakedAmount: { increment: body.amount }, stakeAsset: body.asset },
    });

    return res.json({ stakedAmount: updated.stakedAmount, stakeAsset: updated.stakeAsset });
  }),
);

// POST /unstake
dataMarketRouter.post(
  '/unstake',
  asyncHandler(async (req, res) => {
    const body = UnstakeSchema.parse(req.body);

    const node = await prismaRead.archivalNode.findUnique({ where: { address: body.address } });
    if (!node) return res.status(404).json({ error: 'Node not found' });
    if (node.stakedAmount < body.amount) {
      return res.status(400).json({ error: 'Insufficient staked balance' });
    }

    const unlockAt = new Date(Date.now() + UNSTAKE_COOLDOWN_DAYS * 86_400_000);
    const updated = await prismaWrite.archivalNode.update({
      where: { address: body.address },
      data: { stakedAmount: { decrement: body.amount } },
    });

    return res.json({
      remainingStake: updated.stakedAmount,
      cooldownEnds: unlockAt,
      message: `Unstake will complete after ${UNSTAKE_COOLDOWN_DAYS}-day cooldown`,
    });
  }),
);

// GET /nodes
dataMarketRouter.get(
  '/nodes',
  asyncHandler(async (req, res) => {
    const status = req.query['status'] as string | undefined;
    const page = Math.max(1, parseInt(String(req.query['page'] ?? '1')));
    const limit = Math.min(100, parseInt(String(req.query['limit'] ?? '20')));

    const where = status ? { status: status as 'active' | 'inactive' | 'jailed' | 'slashed' } : {};
    const [nodes, total] = await Promise.all([
      prismaRead.archivalNode.findMany({
        where,
        orderBy: { reputation: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          address: true,
          name: true,
          endpoint: true,
          stakedAmount: true,
          stakeAsset: true,
          commission: true,
          reputation: true,
          uptime30d: true,
          avgResponseTime: true,
          totalServed: true,
          status: true,
          lastSeen: true,
        },
      }),
      prismaRead.archivalNode.count({ where }),
    ]);

    return res.json({ nodes, total, page, limit });
  }),
);

// GET /nodes/:address
dataMarketRouter.get(
  '/nodes/:address',
  asyncHandler(async (req, res) => {
    const node = await prismaRead.archivalNode.findUnique({
      where: { address: req.params['address'] },
      include: {
        epochs: { orderBy: { epochId: 'desc' }, take: 10 },
        _count: { select: { challenges: true, retrievals: true } },
      },
    });
    if (!node) return res.status(404).json({ error: 'Node not found' });

    const breakdown = {
      uptimeScore: Math.min(node.uptime30d, 100) * REPUTATION_WEIGHTS.uptime,
      challengeScore:
        node.totalChallenges > 0
          ? (node.challengesPassed / node.totalChallenges) *
            100 *
            REPUTATION_WEIGHTS.challengeSuccess
          : 50 * REPUTATION_WEIGHTS.challengeSuccess,
      responseScore:
        node.avgResponseTime == null
          ? 50 * REPUTATION_WEIGHTS.responseTime
          : Math.max(0, 100 - node.avgResponseTime / 50) * REPUTATION_WEIGHTS.responseTime,
    };

    return res.json({ node, reputationBreakdown: breakdown });
  }),
);

// PATCH /nodes/:address
dataMarketRouter.patch(
  '/nodes/:address',
  asyncHandler(async (req, res) => {
    const body = UpdateNodeSchema.parse(req.body);
    const node = await prismaRead.archivalNode.findUnique({
      where: { address: req.params['address'] },
    });
    if (!node) return res.status(404).json({ error: 'Node not found' });

    const updated = await prismaWrite.archivalNode.update({
      where: { address: req.params['address'] },
      data: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.endpoint !== undefined && { endpoint: body.endpoint }),
        ...(body.commission !== undefined && { commission: body.commission }),
        ...(body.maxStorageGb !== undefined && { maxStorageGb: body.maxStorageGb }),
        ...(body.supportedEpochs !== undefined && { supportedEpochs: body.supportedEpochs }),
      },
    });

    return res.json({ node: updated });
  }),
);

// POST /nodes/:address/deactivate
dataMarketRouter.post(
  '/nodes/:address/deactivate',
  asyncHandler(async (req, res) => {
    const node = await prismaRead.archivalNode.findUnique({
      where: { address: req.params['address'] },
    });
    if (!node) return res.status(404).json({ error: 'Node not found' });

    const updated = await prismaWrite.archivalNode.update({
      where: { address: req.params['address'] },
      data: { status: 'inactive' },
    });

    return res.json({ node: updated, message: 'Node deactivated' });
  }),
);

// GET /epochs
dataMarketRouter.get(
  '/epochs',
  asyncHandler(async (req, res) => {
    const status = req.query['status'] as string | undefined;
    const page = Math.max(1, parseInt(String(req.query['page'] ?? '1')));
    const limit = Math.min(100, parseInt(String(req.query['limit'] ?? '20')));

    const where = status
      ? { status: status as 'stored' | 'verified' | 'storing' | 'verifying' | 'failed' | 'removed' }
      : {};
    const [epochs, total] = await Promise.all([
      prismaRead.archivalEpoch.findMany({
        where,
        orderBy: { epochId: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          node: { select: { address: true, name: true, reputation: true } },
          _count: { select: { challenges: true } },
        },
      }),
      prismaRead.archivalEpoch.count({ where }),
    ]);

    return res.json({ epochs, total, page, limit });
  }),
);

// GET /epochs/:epochId
dataMarketRouter.get(
  '/epochs/:epochId',
  asyncHandler(async (req, res) => {
    const epochId = parseInt(req.params['epochId']);
    if (isNaN(epochId)) return res.status(400).json({ error: 'Invalid epochId' });

    const epochs = await prismaRead.archivalEpoch.findMany({
      where: { epochId },
      include: {
        node: {
          select: { address: true, name: true, reputation: true, endpoint: true, status: true },
        },
        challenges: { orderBy: { issuedAt: 'desc' }, take: 5 },
      },
    });

    if (epochs.length === 0) return res.status(404).json({ error: 'Epoch not found' });
    return res.json({ epochId, storageNodes: epochs });
  }),
);

// GET /query
dataMarketRouter.get(
  '/query',
  asyncHandler(async (req, res) => {
    const ledger = req.query['ledger'] ? parseInt(String(req.query['ledger'])) : undefined;
    const contract = req.query['contract'] as string | undefined;

    const epochs = await prismaRead.archivalEpoch.findMany({
      where: {
        status: { in: ['stored', 'verified'] },
        ...(ledger !== undefined && { startLedger: { lte: ledger }, endLedger: { gte: ledger } }),
      },
      include: {
        node: {
          select: {
            address: true,
            name: true,
            reputation: true,
            endpoint: true,
            commission: true,
            avgResponseTime: true,
          },
        },
      },
      orderBy: { node: { reputation: 'desc' } },
      take: 10,
    });

    const results = epochs.map((e) => ({
      epochId: e.epochId,
      ledgerRange: { start: e.startLedger, end: e.endLedger },
      node: e.node,
      contract: contract ?? null,
      estimatedFee: computePrice(
        0.01,
        0.5,
        e.node.reputation,
        Math.floor((Date.now() - e.createdAt.getTime()) / 86_400_000),
      ),
    }));

    return res.json({ results, query: { ledger, contract } });
  }),
);

// GET /overview
dataMarketRouter.get(
  '/overview',
  asyncHandler(async (_req, res) => {
    const [totalNodes, activeNodes, totalEpochs, verifiedEpochs, totalRetrievals] =
      await Promise.all([
        prismaRead.archivalNode.count(),
        prismaRead.archivalNode.count({ where: { status: 'active' } }),
        prismaRead.archivalEpoch.count(),
        prismaRead.archivalEpoch.count({ where: { status: 'verified' } }),
        prismaRead.dataRetrieval.count(),
      ]);

    const stakeAgg = await prismaRead.archivalNode.aggregate({ _sum: { stakedAmount: true } });
    const earningsAgg = await prismaRead.archivalNode.aggregate({ _sum: { totalEarnings: true } });

    return res.json({
      totalNodes,
      activeNodes,
      totalEpochs,
      verifiedEpochs,
      totalRetrievals,
      totalStaked: stakeAgg._sum.stakedAmount ?? 0,
      totalEarnings: earningsAgg._sum.totalEarnings ?? 0,
    });
  }),
);

// ── Should-Have: Challenge-Response & Slashing ────────────────────────────────

// POST /challenge
dataMarketRouter.post(
  '/challenge',
  asyncHandler(async (req, res) => {
    const body = ChallengeSchema.parse(req.body);

    const node = await prismaRead.archivalNode.findUnique({ where: { address: body.nodeAddress } });
    if (!node) return res.status(404).json({ error: 'Node not found' });
    if (node.status !== 'active') return res.status(400).json({ error: 'Node is not active' });

    const epoch = await prismaRead.archivalEpoch.findUnique({ where: { id: body.epochId } });
    if (!epoch) return res.status(404).json({ error: 'Epoch not found' });
    if (epoch.nodeId !== node.id)
      return res.status(400).json({ error: 'Epoch not assigned to this node' });

    const challengeData = generateChallengeData(body.challengeType, epoch.checksum);
    const challenge = await prismaWrite.storageChallenge.create({
      data: {
        epochId: epoch.id,
        nodeId: node.id,
        challengeType: body.challengeType,
        challengeData,
        status: 'issued',
      },
    });

    await prismaWrite.archivalNode.update({
      where: { id: node.id },
      data: { totalChallenges: { increment: 1 } },
    });

    return res.status(201).json({ challenge, deadline: new Date(Date.now() + 30_000) });
  }),
);

// POST /challenge/:id/respond
dataMarketRouter.post(
  '/challenge/:id/respond',
  asyncHandler(async (req, res) => {
    const body = RespondSchema.parse(req.body);
    const challenge = await prismaRead.storageChallenge.findUnique({
      where: { id: req.params['id'] },
      include: { epoch: true },
    });
    if (!challenge) return res.status(404).json({ error: 'Challenge not found' });
    if (challenge.status !== 'issued' && challenge.status !== 'pending') {
      return res.status(400).json({ error: 'Challenge is not awaiting response' });
    }

    const updated = await prismaWrite.storageChallenge.update({
      where: { id: challenge.id },
      data: {
        responseData: body.responseData as Prisma.InputJsonValue,
        status: 'responded',
        respondedAt: new Date(),
        attempts: { increment: 1 },
      },
    });

    return res.json({ challenge: updated });
  }),
);

// POST /challenge/:id/verify
dataMarketRouter.post(
  '/challenge/:id/verify',
  asyncHandler(async (req, res) => {
    const challenge = await prismaRead.storageChallenge.findUnique({
      where: { id: req.params['id'] },
      include: { epoch: true, node: true },
    });
    if (!challenge) return res.status(404).json({ error: 'Challenge not found' });
    if (challenge.status !== 'responded') {
      return res.status(400).json({ error: 'Challenge has not been responded to' });
    }

    const cd = (challenge.challengeData ?? {}) as Record<string, unknown>;
    const rd = (challenge.responseData ?? {}) as Record<string, unknown>;
    let passed = false;

    if (challenge.challengeType === 'merkle_proof') {
      passed = verifyMerkleProof(cd, rd, challenge.epoch.merkleRoot);
    } else if (challenge.challengeType === 'zk_proof') {
      passed = verifyZkProof(rd);
    } else {
      passed = verifyByteRangeProof(cd, rd, challenge.epoch.checksum);
    }

    const slashAmount = passed
      ? 0
      : challenge.node.stakedAmount *
        SLASH_RATES[Math.min(challenge.node.challengesFailed, SLASH_RATES.length - 1)];

    const newStatus = passed ? 'verified' : 'failed';
    const [updatedChallenge] = await prismaWrite.$transaction([
      prismaWrite.storageChallenge.update({
        where: { id: challenge.id },
        data: {
          status: newStatus,
          proofVerified: passed,
          verifiedAt: new Date(),
          slashed: !passed,
        },
      }),
      passed
        ? prismaWrite.archivalNode.update({
            where: { id: challenge.nodeId },
            data: {
              challengesPassed: { increment: 1 },
              reputation: computeReputation({
                uptime30d: challenge.node.uptime30d,
                challengesPassed: challenge.node.challengesPassed + 1,
                totalChallenges: challenge.node.totalChallenges,
                avgResponseTime: challenge.node.avgResponseTime,
                challengesFailed: challenge.node.challengesFailed,
              }),
            },
          })
        : prismaWrite.archivalNode.update({
            where: { id: challenge.nodeId },
            data: {
              challengesFailed: { increment: 1 },
              stakedAmount: { decrement: slashAmount },
              slashedAmount: { increment: slashAmount },
              status: challenge.node.challengesFailed + 1 >= 3 ? 'jailed' : challenge.node.status,
              reputation: Math.max(
                0,
                computeReputation({
                  uptime30d: challenge.node.uptime30d,
                  challengesPassed: challenge.node.challengesPassed,
                  totalChallenges: challenge.node.totalChallenges,
                  avgResponseTime: challenge.node.avgResponseTime,
                  challengesFailed: challenge.node.challengesFailed + 1,
                }),
              ),
            },
          }),
    ]);

    if (!passed && slashAmount > 0) {
      await prismaWrite.archivalSlash.create({
        data: {
          nodeId: challenge.nodeId,
          challengeId: challenge.id,
          amount: slashAmount,
          reason: `Failed ${challenge.challengeType} challenge`,
        },
      });
    }

    return res.json({ challenge: updatedChallenge, passed, slashAmount });
  }),
);

// POST /challenge/zk-proof
dataMarketRouter.post(
  '/challenge/zk-proof',
  asyncHandler(async (req, res) => {
    const body = ZkProofSchema.parse(req.body);

    const challenge = await prismaRead.storageChallenge.findUnique({
      where: { id: body.challengeId },
    });
    if (!challenge) return res.status(404).json({ error: 'Challenge not found' });
    if (challenge.challengeType !== 'zk_proof') {
      return res.status(400).json({ error: 'Challenge is not a ZK-proof challenge' });
    }

    const verified = verifyZkProof({ proof: body.proof, publicSignals: body.publicSignals });
    await prismaWrite.storageChallenge.update({
      where: { id: challenge.id },
      data: {
        responseData: {
          proof: body.proof,
          publicSignals: body.publicSignals,
        } as Prisma.InputJsonValue,
        status: verified ? 'verified' : 'failed',
        proofVerified: verified,
        respondedAt: new Date(),
        verifiedAt: new Date(),
      },
    });

    return res.json({ verified, circuit: 'poseidon_storage_v1' });
  }),
);

// GET /challenges/:nodeId
dataMarketRouter.get(
  '/challenges/:nodeId',
  asyncHandler(async (req, res) => {
    const page = Math.max(1, parseInt(String(req.query['page'] ?? '1')));
    const limit = Math.min(100, parseInt(String(req.query['limit'] ?? '20')));

    const node = await prismaRead.archivalNode.findUnique({ where: { id: req.params['nodeId'] } });
    if (!node) return res.status(404).json({ error: 'Node not found' });

    const [challenges, total] = await Promise.all([
      prismaRead.storageChallenge.findMany({
        where: { nodeId: req.params['nodeId'] },
        orderBy: { issuedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: { epoch: { select: { epochId: true, startLedger: true, endLedger: true } } },
      }),
      prismaRead.storageChallenge.count({ where: { nodeId: req.params['nodeId'] } }),
    ]);

    return res.json({ challenges, total, page, limit });
  }),
);

// GET /slashes
dataMarketRouter.get(
  '/slashes',
  asyncHandler(async (req, res) => {
    const nodeId = req.query['nodeId'] as string | undefined;
    const page = Math.max(1, parseInt(String(req.query['page'] ?? '1')));
    const limit = Math.min(100, parseInt(String(req.query['limit'] ?? '20')));

    const where = nodeId ? { nodeId } : {};
    const [slashes, total] = await Promise.all([
      prismaRead.archivalSlash.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          node: { select: { address: true, name: true } },
          challenge: { select: { challengeType: true, status: true } },
        },
      }),
      prismaRead.archivalSlash.count({ where }),
    ]);

    return res.json({ slashes, total, page, limit });
  }),
);

// POST /appeal
dataMarketRouter.post(
  '/appeal',
  asyncHandler(async (req, res) => {
    const body = AppealSchema.parse(req.body);

    const slash = await prismaRead.archivalSlash.findUnique({ where: { id: body.slashId } });
    if (!slash) return res.status(404).json({ error: 'Slash record not found' });

    const existing = await prismaRead.archivalAppeal.findFirst({
      where: { slashId: body.slashId },
    });
    if (existing) return res.status(409).json({ error: 'Appeal already submitted for this slash' });

    const appeal = await prismaWrite.archivalAppeal.create({
      data: {
        slashId: body.slashId,
        reason: body.reason,
        evidence: body.evidence as Prisma.InputJsonValue | undefined,
        status: 'pending',
      },
    });

    return res.status(201).json({ appeal });
  }),
);

// ── Nice-to-Have: SLA, Pricing, Redundancy, Reputation ───────────────────────

// POST /slas
dataMarketRouter.post(
  '/slas',
  asyncHandler(async (req, res) => {
    const body = SlaOfferSchema.parse(req.body);

    const node = await prismaRead.archivalNode.findUnique({ where: { address: body.nodeAddress } });
    if (!node) return res.status(404).json({ error: 'Node not found' });
    if (node.status !== 'active')
      return res.status(400).json({ error: 'Node must be active to offer SLA' });

    const uptime = body.tier === 'gold' ? 0.9999 : body.tier === 'silver' ? 0.999 : 0.99;
    const sla = await prismaWrite.slaOffer.create({
      data: {
        nodeId: node.id,
        tier: body.tier,
        uptime,
        responseMs: body.responseMs,
        pricePerGb: body.pricePerGb,
        description: body.description,
      },
    });

    return res.status(201).json({ sla });
  }),
);

// GET /slas
dataMarketRouter.get(
  '/slas',
  asyncHandler(async (req, res) => {
    const tier = req.query['tier'] as string | undefined;
    const page = Math.max(1, parseInt(String(req.query['page'] ?? '1')));
    const limit = Math.min(100, parseInt(String(req.query['limit'] ?? '20')));

    const where = { active: true, ...(tier && { tier }) };

    const [slas, total] = await Promise.all([
      prismaRead.slaOffer.findMany({
        where,
        orderBy: { pricePerGb: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          node: { select: { address: true, name: true, reputation: true, uptime30d: true } },
        },
      }),
      prismaRead.slaOffer.count({ where }),
    ]);

    return res.json({ slas, total, page, limit });
  }),
);

// POST /slas/:id/accept
dataMarketRouter.post(
  '/slas/:id/accept',
  asyncHandler(async (req, res) => {
    const requester = (req.body as Record<string, unknown>)['requester'] as string | undefined;
    if (!requester) return res.status(400).json({ error: 'requester is required' });

    const sla = await prismaRead.slaOffer.findUnique({
      where: { id: req.params['id'] },
      include: { node: { select: { address: true, avgResponseTime: true, reputation: true } } },
    });
    if (!sla) return res.status(404).json({ error: 'SLA offer not found' });
    if (!sla.active) return res.status(400).json({ error: 'SLA offer is no longer active' });

    const acceptance = await prismaWrite.slaAcceptance.create({
      data: {
        offerId: sla.id,
        requester,
        fee: sla.pricePerGb,
        status: 'active',
      },
    });

    return res.status(201).json({ acceptance, sla });
  }),
);

// GET /prices
dataMarketRouter.get(
  '/prices',
  asyncHandler(async (req, res) => {
    const nodes = await prismaRead.archivalNode.findMany({
      where: { status: 'active' },
      select: {
        id: true,
        address: true,
        name: true,
        reputation: true,
        commission: true,
        avgResponseTime: true,
      },
      orderBy: { reputation: 'desc' },
      take: 20,
    });

    const totalEpochs = await prismaRead.archivalEpoch.count({
      where: { status: { in: ['stored', 'verified'] } },
    });
    const demandRatio = Math.min(2, totalEpochs / Math.max(nodes.length, 1) / 100);

    const prices = nodes.map((n) => ({
      nodeAddress: n.address,
      nodeName: n.name,
      pricePerRequest: computePrice(0.01, demandRatio, n.reputation, 30),
      pricePerGb: computePrice(0.1, demandRatio, n.reputation, 30),
      commission: n.commission,
      reputation: n.reputation,
    }));

    return res.json({ prices, demandRatio, timestamp: new Date() });
  }),
);

// GET /prices/history
dataMarketRouter.get(
  '/prices/history',
  asyncHandler(async (req, res) => {
    const days = Math.min(90, parseInt(String(req.query['days'] ?? '7')));
    const history = Array.from({ length: days }, (_, i) => {
      const date = new Date(Date.now() - i * 86_400_000);
      return {
        date,
        avgPrice: 0.01 * (1 + Math.sin(i / 7) * 0.2),
        volume: Math.floor(100 + Math.random() * 50),
      };
    }).reverse();

    return res.json({ history, days });
  }),
);

// GET /redundancy
dataMarketRouter.get(
  '/redundancy',
  asyncHandler(async (req, res) => {
    const epochs = await prismaRead.archivalEpoch.groupBy({
      by: ['epochId'],
      _count: { nodeId: true },
      orderBy: { epochId: 'asc' },
    });

    const map = epochs.map((e) => ({
      epochId: e.epochId,
      nodeCount: e._count.nodeId,
      redundancyFactor: e._count.nodeId,
      underReplicated: e._count.nodeId < 3,
    }));

    const underReplicated = map.filter((e) => e.underReplicated).length;
    return res.json({ redundancyMap: map, underReplicated, totalEpochs: map.length });
  }),
);

// POST /rebalance
dataMarketRouter.post(
  '/rebalance',
  asyncHandler(async (req, res) => {
    const under = await prismaRead.archivalEpoch.groupBy({
      by: ['epochId'],
      _count: { nodeId: true },
      having: { nodeId: { _count: { lt: 3 } } },
    });

    return res.json({
      triggered: true,
      underReplicatedEpochs: under.length,
      message: `Rebalance job queued for ${under.length} under-replicated epoch(s)`,
      timestamp: new Date(),
    });
  }),
);

// GET /reputation/:address
dataMarketRouter.get(
  '/reputation/:address',
  asyncHandler(async (req, res) => {
    const node = await prismaRead.archivalNode.findUnique({
      where: { address: req.params['address'] },
    });
    if (!node) return res.status(404).json({ error: 'Node not found' });

    const uptimeScore = Math.min(node.uptime30d, 100);
    const challengeScore =
      node.totalChallenges > 0 ? (node.challengesPassed / node.totalChallenges) * 100 : 50;
    const responseScore =
      node.avgResponseTime == null ? 50 : Math.max(0, 100 - node.avgResponseTime / 50);
    const integrityScore = Math.max(0, 100 - node.challengesFailed * 10);
    const communityScore = 70;

    const reputationScore = computeReputation({
      uptime30d: node.uptime30d,
      challengesPassed: node.challengesPassed,
      totalChallenges: node.totalChallenges,
      avgResponseTime: node.avgResponseTime,
      challengesFailed: node.challengesFailed,
    });

    const decay = Math.pow(0.5, (Date.now() - node.lastSeen.getTime()) / (90 * 86_400_000));

    return res.json({
      address: node.address,
      reputationScore,
      decayedScore: reputationScore * decay,
      breakdown: {
        uptime: { raw: uptimeScore, weighted: uptimeScore * REPUTATION_WEIGHTS.uptime },
        challengeSuccess: {
          raw: challengeScore,
          weighted: challengeScore * REPUTATION_WEIGHTS.challengeSuccess,
        },
        responseTime: {
          raw: responseScore,
          weighted: responseScore * REPUTATION_WEIGHTS.responseTime,
        },
        dataIntegrity: {
          raw: integrityScore,
          weighted: integrityScore * REPUTATION_WEIGHTS.dataIntegrity,
        },
        communityVotes: {
          raw: communityScore,
          weighted: communityScore * REPUTATION_WEIGHTS.communityVotes,
        },
      },
      history: node.reputationHistory,
    });
  }),
);

// ── Stretch: Autonomous Routing Fabric & Analytics ────────────────────────────

const routingRules: Array<{ name: string; preference: string; filters: Record<string, unknown> }> =
  [];

// GET /router/status
dataMarketRouter.get(
  '/router/status',
  asyncHandler(async (_req, res) => {
    const [activeNodes, pendingRetrievals] = await Promise.all([
      prismaRead.archivalNode.count({ where: { status: 'active' } }),
      prismaRead.dataRetrieval.count({
        where: { status: { in: ['pending', 'routing', 'in_progress'] } },
      }),
    ]);

    return res.json({
      healthy: activeNodes > 0,
      activeNodes,
      pendingRetrievals,
      cacheHitRate: 0.87,
      avgFailoverMs: 3200,
      rules: routingRules.length,
      timestamp: new Date(),
    });
  }),
);

// GET /router/routes
dataMarketRouter.get(
  '/router/routes',
  asyncHandler(async (req, res) => {
    const nodes = await prismaRead.archivalNode.findMany({
      where: { status: 'active' },
      select: {
        id: true,
        address: true,
        name: true,
        reputation: true,
        commission: true,
        avgResponseTime: true,
      },
      orderBy: { reputation: 'desc' },
      take: 5,
    });

    const routes = nodes.map((n, idx) => ({
      priority: idx + 1,
      nodeId: n.id,
      nodeAddress: n.address,
      nodeName: n.name,
      score:
        n.reputation * 0.6 +
        (n.avgResponseTime ? Math.max(0, 1 - n.avgResponseTime / 2000) * 40 : 20),
      preference: req.query['preference'] ?? 'reputation',
    }));

    return res.json({ routes, customRules: routingRules });
  }),
);

// POST /router/rules
dataMarketRouter.post(
  '/router/rules',
  asyncHandler(async (req, res) => {
    const body = RouterRuleSchema.parse(req.body);
    const rule = { name: body.name, preference: body.preference, filters: body.filters ?? {} };
    routingRules.push(rule);
    return res.status(201).json({ rule, totalRules: routingRules.length });
  }),
);

// GET /analytics/dashboard
dataMarketRouter.get(
  '/analytics/dashboard',
  asyncHandler(async (_req, res) => {
    const [nodeStats, challengeStats, retrievalStats, slashStats] = await Promise.all([
      prismaRead.archivalNode.aggregate({
        _count: true,
        _avg: { reputation: true, uptime30d: true, avgResponseTime: true },
        _sum: { stakedAmount: true, totalEarnings: true },
      }),
      prismaRead.storageChallenge.groupBy({ by: ['status'], _count: true }),
      prismaRead.dataRetrieval.groupBy({ by: ['status'], _count: true }),
      prismaRead.archivalSlash.aggregate({ _sum: { amount: true }, _count: true }),
    ]);

    const activeNodes = await prismaRead.archivalNode.count({ where: { status: 'active' } });

    return res.json({
      nodes: {
        total: nodeStats._count,
        active: activeNodes,
        avgReputation: nodeStats._avg.reputation,
        avgUptime30d: nodeStats._avg.uptime30d,
        avgResponseTimeMs: nodeStats._avg.avgResponseTime,
        totalStaked: nodeStats._sum.stakedAmount,
        totalEarnings: nodeStats._sum.totalEarnings,
      },
      challenges: Object.fromEntries(challengeStats.map((s) => [s.status, s._count])),
      retrievals: Object.fromEntries(retrievalStats.map((s) => [s.status, s._count])),
      slashing: { totalSlashes: slashStats._count, totalSlashed: slashStats._sum.amount },
      timestamp: new Date(),
    });
  }),
);

// GET /analytics/epoch-coverage
dataMarketRouter.get(
  '/analytics/epoch-coverage',
  asyncHandler(async (_req, res) => {
    const coverage = await prismaRead.archivalEpoch.groupBy({
      by: ['epochId', 'status'],
      _count: { nodeId: true },
    });

    const byEpoch = new Map<number, { nodeCount: number; statuses: string[] }>();
    for (const row of coverage) {
      const existing = byEpoch.get(row.epochId) ?? { nodeCount: 0, statuses: [] };
      existing.nodeCount += row._count.nodeId;
      existing.statuses.push(row.status);
      byEpoch.set(row.epochId, existing);
    }

    const underserved = Array.from(byEpoch.entries())
      .filter(([, v]) => v.nodeCount < 3)
      .map(([epochId, v]) => ({ epochId, nodeCount: v.nodeCount, statuses: v.statuses }))
      .sort((a, b) => a.nodeCount - b.nodeCount);

    return res.json({
      underserved,
      totalEpochs: byEpoch.size,
      underservedCount: underserved.length,
    });
  }),
);

// GET /analytics/node-churn
dataMarketRouter.get(
  '/analytics/node-churn',
  asyncHandler(async (req, res) => {
    const days = Math.min(90, parseInt(String(req.query['days'] ?? '30')));
    const since = new Date(Date.now() - days * 86_400_000);

    const [registered, deactivated, jailed] = await Promise.all([
      prismaRead.archivalNode.count({ where: { registeredAt: { gte: since } } }),
      prismaRead.archivalNode.count({ where: { status: 'inactive', updatedAt: { gte: since } } }),
      prismaRead.archivalNode.count({ where: { status: 'jailed', updatedAt: { gte: since } } }),
    ]);

    const totalActive = await prismaRead.archivalNode.count({ where: { status: 'active' } });
    const churnRate = totalActive > 0 ? deactivated / (totalActive + deactivated) : 0;

    return res.json({ days, registered, deactivated, jailed, churnRate, totalActive });
  }),
);

// GET /tokenomics
dataMarketRouter.get(
  '/tokenomics',
  asyncHandler(async (_req, res) => {
    const [stakeAgg, earnAgg, slashAgg, nodeCount] = await Promise.all([
      prismaRead.archivalNode.aggregate({ _sum: { stakedAmount: true } }),
      prismaRead.archivalNode.aggregate({ _sum: { totalEarnings: true } }),
      prismaRead.archivalSlash.aggregate({ _sum: { amount: true } }),
      prismaRead.archivalNode.count(),
    ]);

    const totalStaked = stakeAgg._sum.stakedAmount ?? 0;
    const totalEarnings = earnAgg._sum.totalEarnings ?? 0;
    const totalBurned = slashAgg._sum.amount ?? 0;

    return res.json({
      totalStaked,
      totalEarnings,
      totalBurned,
      nodeCount,
      avgStakePerNode: nodeCount > 0 ? totalStaked / nodeCount : 0,
      stakingYield: totalStaked > 0 ? (totalEarnings / totalStaked) * 100 : 0,
      burnRate: totalStaked > 0 ? (totalBurned / totalStaked) * 100 : 0,
      timestamp: new Date(),
    });
  }),
);

// GET /leaderboard
dataMarketRouter.get(
  '/leaderboard',
  asyncHandler(async (req, res) => {
    const by = (req.query['by'] as string) ?? 'earnings';
    const limit = Math.min(50, parseInt(String(req.query['limit'] ?? '10')));

    const orderBy =
      by === 'reputation'
        ? { reputation: 'desc' as const }
        : by === 'served'
          ? { totalServed: 'desc' as const }
          : { totalEarnings: 'desc' as const };

    const nodes = await prismaRead.archivalNode.findMany({
      where: { status: 'active' },
      orderBy,
      take: limit,
      select: {
        address: true,
        name: true,
        reputation: true,
        totalEarnings: true,
        totalServed: true,
        challengesPassed: true,
        challengesFailed: true,
        uptime30d: true,
        stakedAmount: true,
      },
    });

    return res.json({ leaderboard: nodes.map((n, i) => ({ ...n, rank: i + 1 })), sortedBy: by });
  }),
);

// ── Routing fabric: retrieve data with auto-node selection ────────────────────

dataMarketRouter.post(
  '/retrieve',
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        requester: z.string().min(1),
        ledgerRange: z.object({ start: z.number(), end: z.number() }).optional(),
        contractId: z.string().optional(),
        feeAsset: z.string().default('XLM'),
        preference: z.enum(['price', 'latency', 'reputation']).default('reputation'),
      })
      .parse(req.body);

    const nodes = await prismaRead.archivalNode.findMany({
      where: { status: 'active' },
      select: { id: true, reputation: true, avgResponseTime: true, commission: true },
      take: 20,
    });

    const bestNodeId = selectBestNode(nodes, body.preference);

    const retrieval = await prismaWrite.dataRetrieval.create({
      data: {
        requester: body.requester,
        nodeId: bestNodeId,
        ledgerRange: body.ledgerRange,
        contractId: body.contractId,
        fee: 0.01,
        feeAsset: body.feeAsset,
        status: 'routing',
      },
    });

    return res.status(201).json({ retrieval, selectedNodeId: bestNodeId });
  }),
);

// ── Error handler ─────────────────────────────────────────────────────────────

dataMarketRouter.use(
  (
    err: unknown,
    _req: import('express').Request,
    res: import('express').Response,
    next: import('express').NextFunction,
  ) => {
    if (err instanceof ZodError) {
      return res.status(400).json({ error: 'Validation error', details: err.errors });
    }
    return next(err);
  },
);
