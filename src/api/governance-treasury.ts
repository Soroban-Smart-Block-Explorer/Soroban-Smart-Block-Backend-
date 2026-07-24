/**
 * src/api/governance-treasury.ts
 *
 * DAO treasury endpoints (issue #567, docs/governance-framework.md §7),
 * mounted under /api/v1/governance/treasury. Backed by the TreasuryAccount /
 * TreasuryAsset / TreasuryPayoutStream / TreasuryTransaction models; the
 * legacy stub at src/api/treasury.ts is superseded by this router and stays
 * unmounted.
 *
 * Registration is signature-authenticated (same governance:<action> message
 * convention as the governance write path). Balances and transactions are
 * indexer-maintained; streams are created by fund_transfer proposals and
 * registered here after execution.
 */
import { Router, Request, Response } from 'express';
import { Keypair } from '@stellar/stellar-sdk';
import { z } from 'zod';
import { prismaRead, prismaWrite } from '../db';
import { asyncHandler } from '../middleware/asyncHandler';
import { logger } from '../logger';
import {
  blendReputationPower,
  bucketFlows,
  categoryBreakdown,
  claimableAmount,
  isTreasuryAssetType,
  outstandingCommitment,
  runwayDays,
  TREASURY_ASSET_TYPES,
  type FlowRow,
  type StreamData,
} from '../services/governance/treasury';
import { toBigInt } from '../services/governance';

export const governanceTreasuryRouter = Router();

// ── Shared auth helpers (same convention as the governance write path) ───────

const signedActionSchema = z.object({
  address: z.string().regex(/^G[A-Z2-7]{55}$/, 'must be a Stellar account address'),
  signature: z.string().min(16),
  signedAt: z.coerce.number().int(),
});

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

function checkFreshness(signedAt: number): string | null {
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - signedAt) > 300) return 'signature timestamp outside the 5-minute window';
  return null;
}

// ── POST / — register a treasury for a governance contract ───────────────────

const registerSchema = z.object({
  contract: z.string().min(1),
  accountAddress: z.string().min(1),
  name: z.string().max(120).optional(),
  reputationWeight: z.number().min(0).max(1).default(0),
  auth: signedActionSchema,
});

governanceTreasuryRouter.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const body = registerSchema.parse(req.body);
    const stale = checkFreshness(body.auth.signedAt);
    if (stale) return res.status(401).json({ error: stale });

    const message = `governance:treasury-register:${body.contract}:${body.accountAddress}:${body.auth.signedAt}`;
    if (
      !verifySignedAction({ address: body.auth.address, message, signature: body.auth.signature })
    ) {
      return res.status(401).json({ error: 'Invalid signature', expectedMessage: message });
    }

    const govContract = await prismaRead.governanceContract.findUnique({
      where: { contractAddress: body.contract },
      select: { guardian: true },
    });
    if (!govContract) return res.status(404).json({ error: 'Governance contract not found' });
    // Only the configured guardian may register treasuries; contracts without
    // a guardian accept registration from any signed caller (open DAOs).
    if (govContract.guardian && govContract.guardian !== body.auth.address) {
      return res
        .status(403)
        .json({ error: 'Only the governance guardian may register a treasury' });
    }

    const treasury = await prismaWrite.treasuryAccount.upsert({
      where: { accountAddress: body.accountAddress },
      update: { name: body.name, reputationWeight: body.reputationWeight },
      create: {
        contractAddress: body.contract,
        accountAddress: body.accountAddress,
        name: body.name,
        reputationWeight: body.reputationWeight,
      },
    });
    logger.info('treasury registered', {
      contract: body.contract,
      treasury: body.accountAddress,
      by: body.auth.address,
    });
    return res.status(201).json({ treasury });
  }),
);

// ── GET / — list treasuries (optionally by governance contract) ──────────────

const listSchema = z.object({ contract: z.string().optional() });

governanceTreasuryRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const { contract } = listSchema.parse(req.query);
    const treasuries = await prismaRead.treasuryAccount.findMany({
      where: contract ? { contractAddress: contract } : undefined,
      include: { assets: true },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    res.json({
      treasuries: treasuries.map((t) => ({
        ...t,
        totalValueUsd: t.assets.reduce((sum, a) => sum + (a.valueUsd ?? 0), 0),
      })),
      supportedAssetTypes: TREASURY_ASSET_TYPES,
    });
  }),
);

// ── GET /:accountAddress — treasury detail with balances ─────────────────────

governanceTreasuryRouter.get(
  '/:accountAddress',
  asyncHandler(async (req: Request, res: Response) => {
    const treasury = await prismaRead.treasuryAccount.findUnique({
      where: { accountAddress: req.params.accountAddress },
      include: { assets: { orderBy: { valueUsd: 'desc' } } },
    });
    if (!treasury) return res.status(404).json({ error: 'Treasury not found' });

    const now = new Date();
    const activeStreams = await prismaRead.treasuryPayoutStream.findMany({
      where: { treasuryId: treasury.id, status: 'active' },
    });
    const committed = activeStreams.reduce(
      (sum, s) => sum + outstandingCommitment(s as StreamData, now),
      0n,
    );

    res.json({
      treasury: {
        ...treasury,
        totalValueUsd: treasury.assets.reduce((sum, a) => sum + (a.valueUsd ?? 0), 0),
      },
      activeStreams: activeStreams.length,
      outstandingStreamCommitments: committed.toString(),
    });
  }),
);

// ── Payout streams ────────────────────────────────────────────────────────────

const createStreamSchema = z.object({
  recipient: z.string().regex(/^G[A-Z2-7]{55}$/),
  assetCode: z.string().min(1).max(12),
  tokenAddress: z.string().optional(),
  assetType: z.string().refine(isTreasuryAssetType, {
    message: `assetType must be one of: ${TREASURY_ASSET_TYPES.join(', ')}`,
  }),
  amountPerPeriod: z.string().regex(/^\d+$/),
  periodSeconds: z.number().int().min(60),
  startAt: z.coerce.date(),
  endAt: z.coerce.date().optional(),
  proposalId: z.string().optional(),
  auth: signedActionSchema,
});

governanceTreasuryRouter.post(
  '/:accountAddress/streams',
  asyncHandler(async (req: Request, res: Response) => {
    const body = createStreamSchema.parse(req.body);
    const stale = checkFreshness(body.auth.signedAt);
    if (stale) return res.status(401).json({ error: stale });

    const message = `governance:stream-create:${req.params.accountAddress}:${body.recipient}:${body.amountPerPeriod}:${body.auth.signedAt}`;
    if (
      !verifySignedAction({ address: body.auth.address, message, signature: body.auth.signature })
    ) {
      return res.status(401).json({ error: 'Invalid signature', expectedMessage: message });
    }

    const treasury = await prismaRead.treasuryAccount.findUnique({
      where: { accountAddress: req.params.accountAddress },
      select: { id: true, contractAddress: true },
    });
    if (!treasury) return res.status(404).json({ error: 'Treasury not found' });

    const govContract = await prismaRead.governanceContract.findUnique({
      where: { contractAddress: treasury.contractAddress },
      select: { guardian: true },
    });
    if (govContract?.guardian && govContract.guardian !== body.auth.address) {
      return res.status(403).json({ error: 'Only the governance guardian may register streams' });
    }

    if (body.endAt && body.endAt <= body.startAt) {
      return res.status(400).json({ error: 'endAt must be after startAt' });
    }

    // Streams originate from executed fund_transfer proposals (docs §7);
    // when a proposalId is given it must exist and be executed.
    if (body.proposalId) {
      const proposal = await prismaRead.governanceProposal.findUnique({
        where: {
          contractAddress_proposalId: {
            contractAddress: treasury.contractAddress,
            proposalId: body.proposalId,
          },
        },
        select: { status: true, template: true },
      });
      if (!proposal) return res.status(404).json({ error: 'Originating proposal not found' });
      if (proposal.status !== 'executed') {
        return res
          .status(409)
          .json({ error: `Originating proposal is ${proposal.status}; must be executed` });
      }
    }

    const stream = await prismaWrite.treasuryPayoutStream.create({
      data: {
        treasuryId: treasury.id,
        recipient: body.recipient,
        assetCode: body.assetCode.toUpperCase(),
        tokenAddress: body.tokenAddress,
        amountPerPeriod: body.amountPerPeriod,
        periodSeconds: body.periodSeconds,
        startAt: body.startAt,
        endAt: body.endAt,
        proposalId: body.proposalId,
      },
    });
    return res.status(201).json({ stream });
  }),
);

governanceTreasuryRouter.get(
  '/:accountAddress/streams',
  asyncHandler(async (req: Request, res: Response) => {
    const treasury = await prismaRead.treasuryAccount.findUnique({
      where: { accountAddress: req.params.accountAddress },
      select: { id: true },
    });
    if (!treasury) return res.status(404).json({ error: 'Treasury not found' });

    const streams = await prismaRead.treasuryPayoutStream.findMany({
      where: { treasuryId: treasury.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const now = new Date();
    res.json({
      streams: streams.map((s) => ({
        ...s,
        claimable: claimableAmount(s as StreamData, now).toString(),
        outstanding: outstandingCommitment(s as StreamData, now).toString(),
      })),
    });
  }),
);

// ── Analytics: flows, allocation, runway ──────────────────────────────────────

const analyticsSchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(90),
});

governanceTreasuryRouter.get(
  '/:accountAddress/analytics',
  asyncHandler(async (req: Request, res: Response) => {
    const { days } = analyticsSchema.parse(req.query);
    const treasury = await prismaRead.treasuryAccount.findUnique({
      where: { accountAddress: req.params.accountAddress },
      include: { assets: true },
    });
    if (!treasury) return res.status(404).json({ error: 'Treasury not found' });

    const now = new Date();
    const since = new Date(now.getTime() - days * 24 * 3600 * 1000);
    const rows = (await prismaRead.treasuryTransaction.findMany({
      where: { treasuryId: treasury.id, timestamp: { gte: since } },
      select: {
        direction: true,
        assetCode: true,
        amount: true,
        category: true,
        timestamp: true,
      },
      orderBy: { timestamp: 'asc' },
    })) as FlowRow[];

    // Liquid balance for runway: native + sep41 balances (LP/wrapped excluded
    // as they are not immediately spendable without an unwind step).
    const liquid = treasury.assets
      .filter((a) => a.assetType === 'native' || a.assetType === 'sep41')
      .reduce((sum, a) => sum + toBigInt(a.balance), 0n);

    res.json({
      windowDays: days,
      flows: bucketFlows(rows, days, now),
      allocation: categoryBreakdown(rows),
      assets: treasury.assets.map((a) => ({
        assetCode: a.assetCode,
        assetType: a.assetType,
        balance: a.balance,
        valueUsd: a.valueUsd,
      })),
      liquidBalance: liquid.toString(),
      runwayDays: runwayDays({ liquidBalance: liquid, rows, windowDays: days, now }),
    });
  }),
);

// ── GET /:accountAddress/voting-power/:address — reputation-weighted blend ───

governanceTreasuryRouter.get(
  '/:accountAddress/voting-power/:address',
  asyncHandler(async (req: Request, res: Response) => {
    const treasury = await prismaRead.treasuryAccount.findUnique({
      where: { accountAddress: req.params.accountAddress },
      select: { reputationWeight: true, contractAddress: true },
    });
    if (!treasury) return res.status(404).json({ error: 'Treasury not found' });

    // Token power comes from the vote weights the indexer has recorded; the
    // repo-wide reputation profile supplies the blend's second input.
    const [voteAggregate, profile] = await Promise.all([
      prismaRead.governanceVote.findFirst({
        where: { contractAddress: treasury.contractAddress, voter: req.params.address },
        orderBy: { createdAt: 'desc' },
        select: { weight: true },
      }),
      prismaRead.reputationProfile.findUnique({
        where: { address: req.params.address },
        select: { combinedScore: true },
      }),
    ]);

    const tokenPower = toBigInt(voteAggregate?.weight);
    const reputationScore = profile?.combinedScore ?? 0;
    const blended = blendReputationPower({
      tokenPower,
      reputationScore,
      totalPower: tokenPower > 0n ? tokenPower : 1n,
      weight: treasury.reputationWeight,
    });

    res.json({
      address: req.params.address,
      tokenPower: tokenPower.toString(),
      reputationScore,
      reputationWeight: treasury.reputationWeight,
      blendedPower: blended.toString(),
    });
  }),
);
