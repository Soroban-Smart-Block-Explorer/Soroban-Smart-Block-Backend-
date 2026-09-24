import { Router, Request, Response } from 'express';
import { container } from '../services/container';
import { z } from 'zod';
import { validateAddressParam } from '../middleware/sanitize';
import { asyncHandler } from '../middleware/asyncHandler';
import {
  fetchHorizonOperations as fetchHorizonOperationsTyped,
  type HorizonOperation,
} from '../stellar/horizon-client';

/**
 * @swagger
 * tags:
 *   name: Wallets
 *   description: Per-account activity - Soroban transactions, events, and unified history
 */

export const walletRouter = Router();

const paginationSchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
});

/**
 * @swagger
 * /wallets/{address}/transactions:
 *   get:
 *     summary: List a wallet's Soroban transactions (offset-paginated)
 *     description: Transactions where this address is the source account, newest first.
 *     tags: [Wallets]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *         description: Stellar account address (G...) whose transactions to list
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *         description: 1-based page number (offset pagination)
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
 *         description: Page size
 *     responses:
 *       200:
 *         description: Paginated transactions for the wallet (summary fields only)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     description: Transaction summary (subset of the full Transaction record)
 *                     properties:
 *                       hash: { type: string }
 *                       ledgerSequence: { type: integer }
 *                       ledgerCloseTime: { type: string, format: date-time }
 *                       contractAddress: { type: string, nullable: true }
 *                       functionName: { type: string, nullable: true }
 *                       status: { type: string, description: 'success | failed' }
 *                       humanReadable: { type: string, nullable: true }
 *                 total: { type: integer, description: 'Total transactions sourced by this wallet' }
 *                 page: { type: integer }
 *                 limit: { type: integer }
 *               example:
 *                 data:
 *                   - hash: '3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566'
 *                     ledgerSequence: 3168075
 *                     ledgerCloseTime: '2026-06-19T07:24:26.000Z'
 *                     contractAddress: CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5
 *                     functionName: swap
 *                     status: success
 *                     humanReadable: 'GBZX...swapped 100 USDC for 98.7 XLM on StellarSwap'
 *                 total: 42
 *                 page: 1
 *                 limit: 20
 *       400:
 *         description: Invalid Stellar address or query parameters
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/Error'
 *               example:
 *                 error: 'Invalid Stellar address: GBADDRESS'
 */
// GET /wallets/:address/transactions
walletRouter.get(
  '/:address/transactions',
  validateAddressParam('address'),
  asyncHandler(async (req: Request, res: Response) => {
    const prismaRead = container.getPrismaRead();
    const { page, limit } = paginationSchema.parse(req.query);
    const skip = (page - 1) * limit;

    const [transactions, total] = await Promise.all([
      prismaRead.transaction.findMany({
        where: { sourceAccount: req.params.address },
        orderBy: { ledgerSequence: 'desc' },
        skip,
        take: limit,
        select: {
          hash: true,
          ledgerSequence: true,
          ledgerCloseTime: true,
          contractAddress: true,
          functionName: true,
          status: true,
          humanReadable: true,
        },
      }),
      prismaRead.transaction.count({ where: { sourceAccount: req.params.address } }),
    ]);

    res.json({ data: transactions, total, page, limit });
  }),
);

/**
 * @swagger
 * /wallets/{address}/events:
 *   get:
 *     summary: List events involving a wallet (offset-paginated)
 *     description: >-
 *       Full event records whose decoded payload references this address as either
 *       `from` or `to`, newest first.
 *     tags: [Wallets]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *         description: Stellar account address (G...) referenced in the event payload
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *         description: 1-based page number (offset pagination)
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
 *         description: Page size
 *     responses:
 *       200:
 *         description: Paginated full event records involving the wallet
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/Event' }
 *                 total: { type: integer, description: 'Total events involving this wallet', example: 17 }
 *                 page: { type: integer, example: 1 }
 *                 limit: { type: integer, example: 20 }
 *       400:
 *         description: Invalid Stellar address or query parameters
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/Error'
 *               example:
 *                 error: 'Invalid Stellar address: GBADDRESS'
 */
// GET /wallets/:address/events — events involving this address
walletRouter.get(
  '/:address/events',
  validateAddressParam('address'),
  asyncHandler(async (req: Request, res: Response) => {
    const prismaRead = container.getPrismaRead();
    const { page, limit } = paginationSchema.parse(req.query);
    const skip = (page - 1) * limit;
    const address = req.params.address;

    // Fetch events where decoded JSON contains this address as from/to
    const [events, total] = await Promise.all([
      prismaRead.event.findMany({
        where: {
          OR: [
            { decoded: { path: ['from'], equals: address } },
            { decoded: { path: ['to'], equals: address } },
          ],
        },
        orderBy: { ledgerSequence: 'desc' },
        skip,
        take: limit,
      }),
      prismaRead.event.count({
        where: {
          OR: [
            { decoded: { path: ['from'], equals: address } },
            { decoded: { path: ['to'], equals: address } },
          ],
        },
      }),
    ]);

    res.json({ data: events, total, page, limit });
  }),
);

/**
 * @swagger
 * /wallets/{address}/history:
 *   get:
 *     summary: Unified Soroban + classic Stellar history for a wallet
 *     description: >-
 *       Merges indexed Soroban transactions with classic Horizon operations for the
 *       account into a single timeline, sorted newest first, then paginated. Each item
 *       is tagged `type: soroban | classic`; fields not applicable to a given type are
 *       null. If Horizon is unavailable the classic half is silently omitted.
 *     tags: [Wallets]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *         description: Stellar account address (G...) whose history to assemble
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *         description: 1-based page number applied to the merged timeline
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
 *         description: Page size
 *     responses:
 *       200:
 *         description: Paginated unified history items
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     description: Unified history item (Soroban transaction or classic Horizon operation)
 *                     properties:
 *                       type: { type: string, enum: [soroban, classic] }
 *                       timestamp: { type: string, format: date-time }
 *                       hash: { type: string }
 *                       ledgerSequence: { type: integer, nullable: true, description: 'Null for classic operations' }
 *                       status: { type: string, description: 'success | failed' }
 *                       contractAddress: { type: string, nullable: true, description: 'Soroban only' }
 *                       functionName: { type: string, nullable: true, description: 'Soroban only' }
 *                       humanReadable: { type: string, nullable: true, description: 'Soroban only' }
 *                       operationType: { type: string, nullable: true, description: 'Classic only, e.g. payment, create_account' }
 *                       amount: { type: string, nullable: true, description: 'Classic only' }
 *                       asset: { type: string, nullable: true, description: 'Classic only; "XLM" for native' }
 *                       from: { type: string, nullable: true, description: 'Classic only' }
 *                       to: { type: string, nullable: true, description: 'Classic only' }
 *                 total: { type: integer, description: 'Size of the merged timeline before pagination' }
 *                 page: { type: integer }
 *                 limit: { type: integer }
 *               example:
 *                 data:
 *                   - type: soroban
 *                     timestamp: '2026-06-19T07:24:26.000Z'
 *                     hash: '3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566'
 *                     ledgerSequence: 3168075
 *                     status: success
 *                     contractAddress: CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5
 *                     functionName: swap
 *                     humanReadable: 'GBZX...swapped 100 USDC for 98.7 XLM on StellarSwap'
 *                     operationType: null
 *                     amount: null
 *                     asset: null
 *                     from: null
 *                     to: null
 *                   - type: classic
 *                     timestamp: '2026-06-19T07:20:00.000Z'
 *                     hash: '9f0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f'
 *                     ledgerSequence: null
 *                     status: success
 *                     contractAddress: null
 *                     functionName: null
 *                     humanReadable: null
 *                     operationType: payment
 *                     amount: '100.0000000'
 *                     asset: XLM
 *                     from: GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI
 *                     to: GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN
 *                 total: 134
 *                 page: 1
 *                 limit: 20
 *       400:
 *         description: Invalid query parameters
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/Error'
 *               example:
 *                 error: 'limit must be less than or equal to 100'
 */
// GET /wallets/:address/history — unified Soroban + classic Stellar history
walletRouter.get(
  '/:address/history',
  asyncHandler(async (req: Request, res: Response) => {
    const prismaRead = container.getPrismaRead();
    const { page, limit } = paginationSchema.parse(req.query);
    const address = req.params.address;

    // Fetch Soroban transactions and classic Horizon operations in parallel
    const [sorobanTxs, horizonOps] = await Promise.all([
      prismaRead.transaction.findMany({
        where: { sourceAccount: address },
        orderBy: { ledgerCloseTime: 'desc' },
        take: limit * 2, // over-fetch to allow merged sort
        select: {
          hash: true,
          ledgerSequence: true,
          ledgerCloseTime: true,
          contractAddress: true,
          functionName: true,
          status: true,
          humanReadable: true,
        },
      }),
      fetchHorizonOperationsTyped(address, limit * 2).then((r) => r.records),
    ]);

    // Normalise into a unified shape
    type WalletHistoryItem = {
      type: 'soroban' | 'classic';
      timestamp: Date;
      hash: string;
      ledgerSequence: number | null;
      status: string | null;
      contractAddress: string | null;
      functionName: string | null;
      humanReadable: string | null;
      operationType: string | null;
      amount: string | null;
      asset: string | null;
      from: string | null;
      to: string | null;
    };

    const sorobanItems = sorobanTxs.map((tx): WalletHistoryItem => ({
      type: 'soroban',
      timestamp: tx.ledgerCloseTime,
      hash: tx.hash,
      ledgerSequence: tx.ledgerSequence,
      status: tx.status,
      contractAddress: tx.contractAddress ?? null,
      functionName: tx.functionName ?? null,
      humanReadable: tx.humanReadable ?? null,
      // classic fields not applicable
      operationType: null,
      amount: null,
      asset: null,
      from: null,
      to: null,
    }));

    const classicItems = horizonOps.map((op: HorizonOperation): WalletHistoryItem => ({
      type: 'classic',
      timestamp: new Date(op.created_at),
      hash: op.transaction_hash,
      ledgerSequence: null,
      status: op.transaction_successful ? 'success' : 'failed',
      contractAddress: null,
      functionName: null,
      humanReadable: null,
      operationType: op.type,
      amount:
        (op.amount as string | undefined) ?? (op.starting_balance as string | undefined) ?? null,
      asset: op.asset_type === 'native' ? 'XLM' : ((op.asset_code as string | undefined) ?? null),
      from: (op.from as string | undefined) ?? (op.funder as string | undefined) ?? null,
      to: (op.to as string | undefined) ?? (op.account as string | undefined) ?? null,
    }));

    // Merge and sort descending by timestamp
    const merged = [...sorobanItems, ...classicItems].sort(
      (a, b) => b.timestamp.getTime() - a.timestamp.getTime(),
    );

    // Apply pagination on merged result
    const skip = (page - 1) * limit;
    const paginated = merged.slice(skip, skip + limit);

    res.json({ data: paginated, total: merged.length, page, limit });
  }),
);

// ═════════════════════════════════════════════════════════════════════════════
// Unified journey — one chronological timeline per address.
//
// Merges four indexed sources onto a single time axis (ledger close time):
//   • transaction     — Soroban transactions sourced by the address
//   • event           — decoded non-token contract events touching the address
//   • token_change    — transfer/mint/burn events, resolved to a signed balance
//                       delta (in/out/self) rather than a raw event
//   • governance_vote — governance votes cast by the address
//
// Token movements are *partitioned* out of the event stream, so a given event
// surfaces as either `token_change` (when it moves a token) or `event` (when it
// does not) — never both. Pagination walks time, not offsets: each page takes
// `limit` merged items strictly older than `before` and returns the oldest
// returned timestamp as `nextCursor`.
// ═════════════════════════════════════════════════════════════════════════════

type JourneyItemType = 'transaction' | 'event' | 'governance_vote' | 'token_change';

interface JourneyItemBase {
  type: JourneyItemType;
  /** Stable identifier, unique within its source (tx hash / event id / vote id). */
  id: string;
  /** ISO-8601 ledger close time — the single axis every source is aligned to. */
  timestamp: string;
  ledgerSequence: number | null;
  transactionHash: string | null;
}

export interface JourneyTransactionItem extends JourneyItemBase {
  type: 'transaction';
  status: string;
  contractAddress: string | null;
  functionName: string | null;
  humanReadable: string | null;
}

export interface JourneyEventItem extends JourneyItemBase {
  type: 'event';
  contractAddress: string;
  eventType: string;
  topicSymbol: string | null;
  decoded: unknown;
}

export interface JourneyGovernanceVoteItem extends JourneyItemBase {
  type: 'governance_vote';
  contractAddress: string;
  proposalId: string;
  support: string | null;
  weight: string | null;
  reason: string | null;
}

export type TokenChangeDirection = 'in' | 'out' | 'self';

export interface JourneyTokenChangeItem extends JourneyItemBase {
  type: 'token_change';
  contractAddress: string;
  asset: string | null;
  direction: TokenChangeDirection;
  amount: string;
  /** Signed balance delta: `+amount` in, `-amount` out, `0` for a self-transfer. */
  delta: string;
  from: string | null;
  to: string | null;
  counterparty: string | null;
}

export type JourneyItem =
  JourneyTransactionItem | JourneyEventItem | JourneyGovernanceVoteItem | JourneyTokenChangeItem;

const TOKEN_EVENT_TYPES = new Set(['transfer', 'mint', 'burn']);
const DECODED_FROM_KEYS = ['from', 'sender', 'source'];
const DECODED_TO_KEYS = ['to', 'receiver', 'recipient', 'destination'];
const DECODED_AMOUNT_KEYS = ['amount', 'value', 'quantity'];
const DECODED_ASSET_KEYS = ['asset', 'asset_code', 'token', 'token_symbol', 'symbol'];

/** Human narrative order when two items share a timestamp and ledger. */
const JOURNEY_TYPE_ORDER: Record<JourneyItemType, number> = {
  token_change: 0,
  event: 1,
  transaction: 2,
  governance_vote: 3,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstValue(record: Record<string, unknown> | null, keys: string[]): unknown {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function firstString(record: Record<string, unknown> | null, keys: string[]): string | null {
  const value = firstValue(record, keys);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Normalise a decoded amount (`string | number | bigint`) to a decimal string. */
function amountString(value: unknown): string | null {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim())) return value.trim();
  return null;
}

function signedDelta(amount: string, direction: TokenChangeDirection): string {
  if (direction === 'self') return '0';
  return direction === 'in' ? `+${amount}` : `-${amount}`;
}

interface RawJourneyEvent {
  id: string;
  transactionHash: string;
  contractAddress: string;
  eventType: string;
  topicSymbol: string | null;
  decoded: unknown;
  ledgerSequence: number;
  ledgerCloseTime: Date;
}

/** Resolve a token-moving event into a signed balance change, or null if it isn't one. */
function asTokenChange(event: RawJourneyEvent, address: string): JourneyTokenChangeItem | null {
  if (!TOKEN_EVENT_TYPES.has(event.eventType.toLowerCase())) return null;
  const decoded = asRecord(event.decoded);
  if (!decoded) return null;
  const amount = amountString(firstValue(decoded, DECODED_AMOUNT_KEYS));
  if (amount === null) return null;

  const from = firstString(decoded, DECODED_FROM_KEYS);
  const to = firstString(decoded, DECODED_TO_KEYS);
  const isFrom = from === address;
  const isTo = to === address;
  if (!isFrom && !isTo) return null;

  const direction: TokenChangeDirection = isFrom && isTo ? 'self' : isFrom ? 'out' : 'in';
  return {
    type: 'token_change',
    id: event.id,
    timestamp: event.ledgerCloseTime.toISOString(),
    ledgerSequence: event.ledgerSequence,
    transactionHash: event.transactionHash,
    contractAddress: event.contractAddress,
    asset: firstString(decoded, DECODED_ASSET_KEYS),
    direction,
    amount,
    delta: signedDelta(amount, direction),
    from,
    to,
    counterparty: direction === 'in' ? from : direction === 'out' ? to : null,
  };
}

function asEventItem(event: RawJourneyEvent): JourneyEventItem {
  return {
    type: 'event',
    id: event.id,
    timestamp: event.ledgerCloseTime.toISOString(),
    ledgerSequence: event.ledgerSequence,
    transactionHash: event.transactionHash,
    contractAddress: event.contractAddress,
    eventType: event.eventType,
    topicSymbol: event.topicSymbol,
    decoded: event.decoded,
  };
}

/** Newest first, then by ledger, then by source, then by id — a total order. */
function compareJourneyItems(a: JourneyItem, b: JourneyItem): number {
  const byTime = new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
  if (byTime !== 0) return byTime;
  const byLedger = (b.ledgerSequence ?? -1) - (a.ledgerSequence ?? -1);
  if (byLedger !== 0) return byLedger;
  const byType = JOURNEY_TYPE_ORDER[a.type] - JOURNEY_TYPE_ORDER[b.type];
  if (byType !== 0) return byType;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

const journeyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /** Exclusive time cursor: return items strictly older than this ISO-8601 instant. */
  before: z.string().datetime({ offset: true }).optional(),
});

/**
 * @swagger
 * /wallets/{address}/journey:
 *   get:
 *     summary: Chronological journey for a wallet (transactions + events + votes + token changes)
 *     description: >-
 *       Merges every indexed source that touches an address onto one time axis,
 *       newest first. Each item is tagged with a discriminated `type`
 *       (`transaction | event | token_change | governance_vote`). Token-moving
 *       transfer/mint/burn events are emitted as `token_change` items carrying a
 *       signed `delta` (in/out/self) instead of raw events, so the timeline reads
 *       as a story rather than four separate scans. Pagination walks time: pass
 *       the previous response's `nextCursor` as `before` to fetch the next page.
 *     tags: [Wallets]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *         description: Stellar account address (G...) whose journey to assemble
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
 *         description: Maximum number of timeline items per page
 *       - in: query
 *         name: before
 *         schema: { type: string, format: date-time }
 *         description: Exclusive time cursor — return items strictly older than this instant (use the previous page's nextCursor)
 *     responses:
 *       200:
 *         description: A page of the merged timeline
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     description: Discriminated timeline item; fields outside the item's type are absent
 *                     required: [type, id, timestamp]
 *                     properties:
 *                       type: { type: string, enum: [transaction, event, token_change, governance_vote] }
 *                       id: { type: string }
 *                       timestamp: { type: string, format: date-time }
 *                       ledgerSequence: { type: integer, nullable: true }
 *                       transactionHash: { type: string, nullable: true }
 *                       status: { type: string, description: 'transaction only' }
 *                       contractAddress: { type: string, nullable: true }
 *                       functionName: { type: string, nullable: true, description: 'transaction only' }
 *                       humanReadable: { type: string, nullable: true, description: 'transaction only' }
 *                       eventType: { type: string, description: 'event only' }
 *                       topicSymbol: { type: string, nullable: true, description: 'event only' }
 *                       decoded: { type: object, nullable: true, description: 'event only' }
 *                       proposalId: { type: string, description: 'governance_vote only' }
 *                       support: { type: string, nullable: true, description: 'governance_vote only' }
 *                       weight: { type: string, nullable: true, description: 'governance_vote only' }
 *                       reason: { type: string, nullable: true, description: 'governance_vote only' }
 *                       asset: { type: string, nullable: true, description: 'token_change only' }
 *                       direction: { type: string, enum: [in, out, self], description: 'token_change only' }
 *                       amount: { type: string, description: 'token_change only' }
 *                       delta: { type: string, description: 'token_change only; signed, e.g. +100 or -42' }
 *                       from: { type: string, nullable: true, description: 'token_change only' }
 *                       to: { type: string, nullable: true, description: 'token_change only' }
 *                       counterparty: { type: string, nullable: true, description: 'token_change only' }
 *                 limit: { type: integer }
 *                 before: { type: string, format: date-time, nullable: true, description: 'Cursor this page was built from' }
 *                 nextCursor: { type: string, format: date-time, nullable: true, description: 'Pass as `before` for the next page' }
 *                 hasMore: { type: boolean }
 *                 counts: { type: object, description: 'Per-type counts within this page' }
 *               example:
 *                 data:
 *                   - type: token_change
 *                     id: '3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566-AAAADwAAAAh0cmFuc2Zlcg=='
 *                     timestamp: '2026-06-19T07:24:26.000Z'
 *                     ledgerSequence: 3168075
 *                     transactionHash: '3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566'
 *                     contractAddress: CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5
 *                     asset: USDC
 *                     direction: in
 *                     amount: '100.0000000'
 *                     delta: '+100.0000000'
 *                     from: GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI
 *                     to: GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN
 *                     counterparty: GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI
 *                   - type: governance_vote
 *                     id: 'vote-1'
 *                     timestamp: '2026-06-19T07:20:00.000Z'
 *                     ledgerSequence: 3168070
 *                     transactionHash: null
 *                     contractAddress: CGOVCONTRACT1
 *                     proposalId: '7'
 *                     support: for
 *                     weight: '500'
 *                     reason: null
 *                 limit: 20
 *                 before: null
 *                 nextCursor: '2026-06-19T07:20:00.000Z'
 *                 hasMore: true
 *                 counts: { transaction: 0, event: 0, token_change: 1, governance_vote: 1 }
 *       400:
 *         description: Invalid Stellar address or query parameters
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/Error'
 *               example:
 *                 error: 'Invalid Stellar address: GBADDRESS'
 */
// GET /wallets/:address/journey — one chronological timeline for the address
walletRouter.get(
  '/:address/journey',
  validateAddressParam('address'),
  asyncHandler(async (req: Request, res: Response) => {
    const prismaRead = container.getPrismaRead();
    const { limit, before } = journeyQuerySchema.parse(req.query);
    const address = req.params.address;
    const beforeDate = before ? new Date(before) : undefined;
    const timeFilter = beforeDate ? { lt: beforeDate } : undefined;

    // Every source is bounded by the same exclusive time cursor so the merged
    // page is a true window, not four independently paginated lists.
    const [transactions, events, votes] = await Promise.all([
      prismaRead.transaction.findMany({
        where: {
          sourceAccount: address,
          ...(timeFilter ? { ledgerCloseTime: timeFilter } : {}),
        },
        orderBy: [{ ledgerCloseTime: 'desc' }, { ledgerSequence: 'desc' }],
        take: limit,
        select: {
          hash: true,
          ledgerSequence: true,
          ledgerCloseTime: true,
          status: true,
          contractAddress: true,
          functionName: true,
          humanReadable: true,
        },
      }),
      prismaRead.event.findMany({
        where: {
          OR: [
            { decoded: { path: ['from'], equals: address } },
            { decoded: { path: ['to'], equals: address } },
          ],
          ...(timeFilter ? { ledgerCloseTime: timeFilter } : {}),
        },
        orderBy: [{ ledgerCloseTime: 'desc' }, { ledgerSequence: 'desc' }],
        take: limit,
        select: {
          id: true,
          transactionHash: true,
          contractAddress: true,
          eventType: true,
          topicSymbol: true,
          decoded: true,
          ledgerSequence: true,
          ledgerCloseTime: true,
        },
      }),
      prismaRead.governanceVote.findMany({
        where: {
          voter: address,
          ...(timeFilter ? { createdAt: timeFilter } : {}),
        },
        orderBy: [{ createdAt: 'desc' }],
        take: limit,
        select: {
          id: true,
          contractAddress: true,
          proposalId: true,
          support: true,
          weight: true,
          reason: true,
          transactionHash: true,
          ledgerSequence: true,
          createdAt: true,
        },
      }),
    ]);

    // Align votes to ledger close time (their `createdAt` is indexer wall-clock).
    const voteLedgers = votes
      .map((vote) => vote.ledgerSequence)
      .filter((seq): seq is number => seq !== null);
    const ledgerCloseTimes = new Map<number, Date>();
    if (voteLedgers.length > 0) {
      const ledgers = await prismaRead.ledger.findMany({
        where: { sequence: { in: voteLedgers } },
        select: { sequence: true, closeTime: true },
      });
      for (const ledger of ledgers) ledgerCloseTimes.set(ledger.sequence, ledger.closeTime);
    }

    const transactionItems: JourneyTransactionItem[] = transactions.map((tx) => ({
      type: 'transaction',
      id: tx.hash,
      timestamp: tx.ledgerCloseTime.toISOString(),
      ledgerSequence: tx.ledgerSequence,
      transactionHash: tx.hash,
      status: tx.status,
      contractAddress: tx.contractAddress ?? null,
      functionName: tx.functionName ?? null,
      humanReadable: tx.humanReadable ?? null,
    }));

    // A token-moving event becomes a `token_change`; everything else stays an `event`.
    const eventItems: JourneyItem[] = [];
    for (const event of events) {
      const raw: RawJourneyEvent = { ...event };
      eventItems.push(asTokenChange(raw, address) ?? asEventItem(raw));
    }

    const voteItems: JourneyGovernanceVoteItem[] = votes.map((vote) => {
      const alignedClose =
        vote.ledgerSequence !== null ? ledgerCloseTimes.get(vote.ledgerSequence) : undefined;
      return {
        type: 'governance_vote',
        id: vote.id,
        timestamp: (alignedClose ?? vote.createdAt).toISOString(),
        ledgerSequence: vote.ledgerSequence ?? null,
        transactionHash: vote.transactionHash ?? null,
        contractAddress: vote.contractAddress,
        proposalId: vote.proposalId,
        support: vote.support ?? null,
        weight: vote.weight ?? null,
        reason: vote.reason ?? null,
      };
    });

    const merged = [...transactionItems, ...eventItems, ...voteItems].sort(compareJourneyItems);
    const page = merged.slice(0, limit);
    const counts: Record<JourneyItemType, number> = {
      transaction: 0,
      event: 0,
      governance_vote: 0,
      token_change: 0,
    };
    for (const item of page) counts[item.type] += 1;

    // A source hitting `limit` may hold older items we didn't fetch yet, so a
    // saturated source also signals more pages even when the merge is short.
    const saturated =
      transactions.length === limit || events.length === limit || votes.length === limit;
    const hasMore = merged.length > limit || saturated;
    const nextCursor = page.length > 0 ? page[page.length - 1].timestamp : null;

    res.json({
      data: page,
      limit,
      before: before ?? null,
      nextCursor,
      hasMore,
      counts,
    });
  }),
);
