import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prismaRead } from '../db';
import { asyncHandler } from '../middleware/asyncHandler';

/**
 * @swagger
 * tags:
 *   name: Hydration
 *   description: Lightweight entity summaries used to rehydrate the mobile SDK's on-device cache
 */

/**
 * POST /hydration/entities
 *
 * Stateless batch lookup that returns a compact display summary for each
 * entity ref the client has persisted locally (recent searches, watchlist,
 * last-viewed). Only the handful of fields needed to render a list row are
 * selected, keeping the payload small on flaky networks.
 *
 * The client's local snapshot stays the source of truth; this endpoint only
 * fills in labels/status for refs it already holds.
 */

export const hydrationRouter = Router();

const ENTITY_TYPES = ['contract', 'wallet', 'transaction', 'event', 'token', 'proposal'] as const;
type EntityType = (typeof ENTITY_TYPES)[number];

const MAX_REFS = 50;

const entityRefSchema = z.object({
  type: z.enum(['contract', 'wallet', 'transaction', 'event', 'token', 'proposal']),
  id: z.string().min(1).max(128),
});

const hydrationRequestSchema = z.object({
  refs: z
    .array(entityRefSchema)
    .min(1, 'At least one ref is required')
    .max(MAX_REFS, `At most ${MAX_REFS} refs are allowed per request`),
});

interface HydrationSummary {
  type: EntityType;
  id: string;
  label: string;
  sublabel?: string;
  status?: string;
  updatedAt?: string;
}

/**
 * The project compiles with `strictNullChecks: false`, which makes zod infer
 * object fields as optional. The schema still enforces both fields at runtime,
 * so narrow them explicitly where the typed values are required.
 */
interface ParsedEntityRef {
  type?: EntityType;
  id?: string;
}

function uniqueIds(refs: ParsedEntityRef[], type: EntityType): string[] {
  const ids = new Set<string>();
  for (const ref of refs) {
    if (ref.type === type && typeof ref.id === 'string') ids.add(ref.id);
  }
  return [...ids];
}

function compact(label: string | null | undefined, fallback: string): string {
  return label && label.trim().length > 0 ? label : fallback;
}

async function loadContracts(ids: string[]): Promise<HydrationSummary[]> {
  if (ids.length === 0) return [];
  const rows = await prismaRead.contract.findMany({
    where: { address: { in: ids } },
    select: {
      address: true,
      name: true,
      tokenName: true,
      tokenSymbol: true,
      isToken: true,
      isVerified: true,
      updatedAt: true,
    },
  });
  return rows.map((contract) => ({
    type: 'contract',
    id: contract.address,
    label: compact(contract.name ?? contract.tokenName, contract.tokenSymbol ?? contract.address),
    sublabel: contract.isToken ? (contract.tokenSymbol ?? 'Token') : 'Contract',
    status: contract.isVerified ? 'verified' : 'unverified',
    updatedAt: contract.updatedAt.toISOString(),
  }));
}

async function loadWallets(ids: string[]): Promise<HydrationSummary[]> {
  if (ids.length === 0) return [];
  const rows = await prismaRead.stellarAccount.findMany({
    where: { address: { in: ids } },
    select: {
      address: true,
      homeDomain: true,
      xlmBalance: true,
      isActivated: true,
      lastActivity: true,
    },
  });
  return rows.map((account) => {
    const summary: HydrationSummary = {
      type: 'wallet',
      id: account.address,
      label: compact(account.homeDomain, account.address),
      sublabel: `${account.xlmBalance.toString()} XLM`,
    };
    if (!account.isActivated) summary.status = 'unfunded';
    if (account.lastActivity) summary.updatedAt = account.lastActivity.toISOString();
    return summary;
  });
}

async function loadTransactions(ids: string[]): Promise<HydrationSummary[]> {
  if (ids.length === 0) return [];
  const rows = await prismaRead.transaction.findMany({
    where: { hash: { in: ids } },
    select: {
      hash: true,
      functionName: true,
      status: true,
      ledgerSequence: true,
      ledgerCloseTime: true,
    },
  });
  return rows.map((tx) => ({
    type: 'transaction',
    id: tx.hash,
    label: tx.functionName ? `${tx.functionName}()` : 'Transaction',
    sublabel: `Ledger ${tx.ledgerSequence}`,
    status: tx.status,
    updatedAt: tx.ledgerCloseTime.toISOString(),
  }));
}

async function loadEvents(ids: string[]): Promise<HydrationSummary[]> {
  if (ids.length === 0) return [];
  const rows = await prismaRead.event.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      eventType: true,
      topicSymbol: true,
      contractAddress: true,
      ledgerSequence: true,
      ledgerCloseTime: true,
    },
  });
  return rows.map((event) => ({
    type: 'event',
    id: event.id,
    label: compact(event.topicSymbol, event.eventType),
    sublabel: `Contract ${event.contractAddress} · Ledger ${event.ledgerSequence}`,
    updatedAt: event.ledgerCloseTime.toISOString(),
  }));
}

async function loadTokens(ids: string[]): Promise<HydrationSummary[]> {
  if (ids.length === 0) return [];
  const rows = await prismaRead.token.findMany({
    where: { address: { in: ids } },
    select: {
      address: true,
      name: true,
      symbol: true,
      holderCount: true,
      updatedAt: true,
    },
  });
  return rows.map((token) => ({
    type: 'token',
    id: token.address,
    label: compact(token.name, token.symbol ?? token.address),
    sublabel: token.symbol
      ? `${token.symbol} · ${token.holderCount} holders`
      : `${token.holderCount} holders`,
    updatedAt: token.updatedAt.toISOString(),
  }));
}

async function loadProposals(ids: string[]): Promise<HydrationSummary[]> {
  if (ids.length === 0) return [];
  const rows = await prismaRead.governanceProposal.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      title: true,
      status: true,
      contractAddress: true,
      updatedAt: true,
    },
  });
  return rows.map((proposal) => ({
    type: 'proposal',
    id: proposal.id,
    label: compact(proposal.title, `Proposal ${proposal.id}`),
    sublabel: `Contract ${proposal.contractAddress}`,
    status: proposal.status,
    updatedAt: proposal.updatedAt.toISOString(),
  }));
}

/**
 * @swagger
 * /hydration/entities:
 *   post:
 *     summary: Batch-fetch compact entity summaries for on-device cache rehydration
 *     tags: [Hydration]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refs]
 *             properties:
 *               refs:
 *                 type: array
 *                 maxItems: 50
 *                 items:
 *                   type: object
 *                   required: [type, id]
 *                   properties:
 *                     type: { type: string, enum: [contract, wallet, transaction, event, token, proposal] }
 *                     id: { type: string }
 *             example:
 *               refs:
 *                 - { type: contract, id: CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5 }
 *                 - { type: wallet, id: GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI }
 *     responses:
 *       200:
 *         description: Summaries for the refs that exist (unknown refs are omitted)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 entities:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       type: { type: string }
 *                       id: { type: string }
 *                       label: { type: string }
 *                       sublabel: { type: string }
 *                       status: { type: string }
 *                       updatedAt: { type: string, format: date-time }
 *       400:
 *         description: Invalid request body
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/Error'
 *               example: { error: 'Invalid hydration request' }
 */
// POST /hydration/entities
hydrationRouter.post(
  '/entities',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = hydrationRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid hydration request',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const { refs } = parsed.data;

    const [contracts, wallets, transactions, events, tokens, proposals] = await Promise.all([
      loadContracts(uniqueIds(refs, 'contract')),
      loadWallets(uniqueIds(refs, 'wallet')),
      loadTransactions(uniqueIds(refs, 'transaction')),
      loadEvents(uniqueIds(refs, 'event')),
      loadTokens(uniqueIds(refs, 'token')),
      loadProposals(uniqueIds(refs, 'proposal')),
    ]);

    const byKey = new Map<string, HydrationSummary>();
    for (const summary of [
      ...contracts,
      ...wallets,
      ...transactions,
      ...events,
      ...tokens,
      ...proposals,
    ]) {
      byKey.set(`${summary.type}:${summary.id}`, summary);
    }

    // Preserve the caller's ordering and drop refs that no longer resolve, so
    // the client can cheaply prune stale watchlist/last-viewed entries.
    const entities = refs
      .filter(
        (ref): ref is { type: EntityType; id: string } =>
          typeof ref.type === 'string' && typeof ref.id === 'string',
      )
      .map((ref) => byKey.get(`${ref.type}:${ref.id}`))
      .filter((summary): summary is HydrationSummary => summary !== undefined);

    return res.json({ entities });
  }),
);
