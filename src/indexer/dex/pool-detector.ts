/**
 * Phase 1 — Pool detection & real-time reserve tracking.
 *
 * AMM pools are auto-detected from their events (no per-protocol storage
 * readers required): the first swap/liquidity event for an unknown contract
 * registers a {@link DexPool} with its token pair, fee tier, and protocol, and
 * every subsequent event maintains reserves by event-sourcing — `sync`/reserve
 * events set reserves authoritatively, while swap/liquidity events apply the
 * delta. The classification and reserve-delta logic are pure and unit tested;
 * `processPoolEvent` wires them into the live ingestion pipeline.
 */

import { prismaWrite as prisma } from '../../db';
import { getTokenMetadata } from '../token-metadata';

export type DexProtocol = 'soroswap' | 'aquarius' | 'phoenix' | 'comet' | 'unknown';

/**
 * Distinctive event vocabulary per protocol. Matching one of a protocol's
 * signature symbols classifies the pool; this is how 3+ DEXes are told apart
 * without hardcoding mainnet addresses (those can still be supplied via
 * DEX_KNOWN_FACTORIES for exact attribution).
 */
const PROTOCOL_SIGNATURES: Record<Exclude<DexProtocol, 'unknown'>, Set<string>> = {
  phoenix: new Set(['provide_liquidity', 'withdraw_liquidity']),
  comet: new Set(['join_pool', 'exit_pool', 'joinpool', 'exitpool']),
  aquarius: new Set(['trade', 'add_liquidity', 'remove_liquidity']),
  soroswap: new Set(['swap', 'deposit', 'withdraw', 'sync']),
};

/** Symbols that indicate a swap/trade across protocols. */
const SWAP_SYMBOLS = new Set(['swap', 'trade', 'swapexacttokensfortokens']);
/** Symbols that add liquidity. */
const ADD_LIQUIDITY_SYMBOLS = new Set(['deposit', 'add_liquidity', 'provide_liquidity', 'join_pool', 'joinpool']);
/** Symbols that remove liquidity. */
const REMOVE_LIQUIDITY_SYMBOLS = new Set([
  'withdraw',
  'remove_liquidity',
  'withdraw_liquidity',
  'exit_pool',
  'exitpool',
]);
/** Symbols that publish authoritative reserves. */
const SYNC_SYMBOLS = new Set(['sync', 'reserves', 'update_reserves']);

const ALL_POOL_SYMBOLS = new Set<string>([
  ...SWAP_SYMBOLS,
  ...ADD_LIQUIDITY_SYMBOLS,
  ...REMOVE_LIQUIDITY_SYMBOLS,
  ...SYNC_SYMBOLS,
]);

function norm(symbol: string | null): string {
  return (symbol ?? '').toLowerCase().trim();
}

/** Cheap gate: does this event plausibly belong to an AMM pool? */
export function looksLikePoolEvent(eventType: string | null, topicSymbol: string | null): boolean {
  const s = norm(topicSymbol) || norm(eventType);
  return ALL_POOL_SYMBOLS.has(s);
}

/** Classify the originating protocol from an event symbol. */
export function classifyProtocol(topicSymbol: string | null, eventType: string | null): DexProtocol {
  const s = norm(topicSymbol) || norm(eventType);
  for (const [protocol, sigs] of Object.entries(PROTOCOL_SIGNATURES)) {
    if (protocol !== 'soroswap' && sigs.has(s)) return protocol as DexProtocol;
  }
  if (PROTOCOL_SIGNATURES.soroswap.has(s)) return 'soroswap';
  return 'unknown';
}

export type PoolAction = 'swap' | 'add' | 'remove' | 'sync' | 'ignore';

export function poolActionFor(topicSymbol: string | null, eventType: string | null): PoolAction {
  const s = norm(topicSymbol) || norm(eventType);
  if (SWAP_SYMBOLS.has(s)) return 'swap';
  if (SYNC_SYMBOLS.has(s)) return 'sync';
  if (ADD_LIQUIDITY_SYMBOLS.has(s)) return 'add';
  if (REMOVE_LIQUIDITY_SYMBOLS.has(s)) return 'remove';
  return 'ignore';
}

// ── Pure reserve-delta math ─────────────────────────────────────────────────

export interface Reserves {
  reserveA: bigint;
  reserveB: bigint;
}

/**
 * Apply a swap to canonical reserves. `tokenIn === tokenA` means token A was
 * added and token B removed; otherwise the reverse. Reserves never go below 0.
 */
export function applySwap(
  reserves: Reserves,
  tokenA: string,
  tokenIn: string,
  amountIn: bigint,
  amountOut: bigint,
): Reserves {
  const inIsA = tokenIn === tokenA;
  const reserveA = inIsA ? reserves.reserveA + amountIn : reserves.reserveA - amountOut;
  const reserveB = inIsA ? reserves.reserveB - amountOut : reserves.reserveB + amountIn;
  return { reserveA: reserveA < 0n ? 0n : reserveA, reserveB: reserveB < 0n ? 0n : reserveB };
}

/** Apply a liquidity add/remove given per-canonical-token amounts. */
export function applyLiquidity(reserves: Reserves, deltaA: bigint, deltaB: bigint): Reserves {
  const reserveA = reserves.reserveA + deltaA;
  const reserveB = reserves.reserveB + deltaB;
  return { reserveA: reserveA < 0n ? 0n : reserveA, reserveB: reserveB < 0n ? 0n : reserveB };
}

// ── Decoded-field extraction ────────────────────────────────────────────────

function asBig(value: unknown): bigint {
  try {
    if (value == null) return 0n;
    return BigInt(String(value).split('.')[0]);
  } catch {
    return 0n;
  }
}

function asAddr(value: unknown): string {
  return value == null ? '' : String(value);
}

interface SwapFields {
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  amountOut: bigint;
  trader: string;
}

function extractSwap(d: Record<string, unknown>, contractAddress: string): SwapFields | null {
  const tokenIn = asAddr(d.token_in ?? d.tokenIn ?? d.sell_token ?? d.from_asset ?? d.offer_asset);
  const tokenOut = asAddr(d.token_out ?? d.tokenOut ?? d.buy_token ?? d.to_asset ?? d.ask_asset);
  const amountIn = asBig(d.amount_in ?? d.amountIn ?? d.sell_amount ?? d.offer_amount);
  const amountOut = asBig(d.amount_out ?? d.amountOut ?? d.buy_amount ?? d.return_amount);
  if (!tokenIn || !tokenOut || amountIn === 0n) return null;
  const trader = asAddr(d.to ?? d.sender ?? d.trader ?? d.caller ?? contractAddress);
  return { tokenIn, tokenOut, amountIn, amountOut, trader };
}

interface LiquidityFields {
  tokenA: string;
  tokenB: string;
  amountA: bigint;
  amountB: bigint;
}

function extractLiquidity(d: Record<string, unknown>): LiquidityFields | null {
  const tokenA = asAddr(d.token_a ?? d.tokenA ?? d.asset_a ?? d.token_0);
  const tokenB = asAddr(d.token_b ?? d.tokenB ?? d.asset_b ?? d.token_1);
  const amountA = asBig(d.amount_a ?? d.amountA ?? d.desired_a ?? d.amount_0);
  const amountB = asBig(d.amount_b ?? d.amountB ?? d.desired_b ?? d.amount_1);
  if (!tokenA || !tokenB) return null;
  return { tokenA, tokenB, amountA, amountB };
}

// ── Pool registration + live processing ─────────────────────────────────────

export interface PoolEventInput {
  contractAddress: string;
  eventType: string | null;
  topicSymbol: string | null;
  decoded: Record<string, unknown> | null;
  transactionHash: string;
  ledgerSequence: number;
  ledgerCloseTime: Date;
}

/** Canonical token ordering so tokenA/tokenB are stable for a pair. */
function canonicalPair(t0: string, t1: string): [string, string] {
  return t0 <= t1 ? [t0, t1] : [t1, t0];
}

/**
 * Ensure a DexPool row exists for `poolAddress`, creating it (with token
 * metadata + protocol + fee tier) on first sighting. Returns the pool's
 * canonical token ordering and current reserves, or null if the pair is
 * indeterminable from this event.
 */
async function ensurePool(
  poolAddress: string,
  pair: [string, string] | null,
  protocol: DexProtocol,
  ledgerSequence: number,
): Promise<{ tokenA: string; tokenB: string; reserveA: bigint; reserveB: bigint; feeBps: number } | null> {
  const existing = await prisma.dexPool.findUnique({ where: { poolAddress } });
  if (existing) {
    return {
      tokenA: existing.tokenA,
      tokenB: existing.tokenB,
      reserveA: BigInt(existing.reserveA),
      reserveB: BigInt(existing.reserveB),
      feeBps: existing.feeBps,
    };
  }
  if (!pair) return null;

  const [tokenA, tokenB] = canonicalPair(pair[0], pair[1]);
  const [metaA, metaB] = await Promise.all([
    getTokenMetadata(tokenA).catch(() => null),
    getTokenMetadata(tokenB).catch(() => null),
  ]);

  await prisma.dexPool.create({
    data: {
      poolAddress,
      protocol,
      tokenA,
      tokenB,
      tokenASymbol: metaA?.symbol ?? null,
      tokenBSymbol: metaB?.symbol ?? null,
      tokenADecimals: metaA?.decimals ?? 7,
      tokenBDecimals: metaB?.decimals ?? 7,
      feeBps: 30,
      firstSeenLedger: ledgerSequence,
      lastEventLedger: ledgerSequence,
    },
  });

  return { tokenA, tokenB, reserveA: 0n, reserveB: 0n, feeBps: 30 };
}

/**
 * Process a single decoded event for DEX pool analytics: register the pool on
 * first sighting, maintain reserves, and record swaps for volume/arbitrage.
 * No-op for non-pool events. Safe to call for every ingested event.
 */
export async function processPoolEvent(input: PoolEventInput): Promise<void> {
  if (!looksLikePoolEvent(input.eventType, input.topicSymbol)) return;
  const d = input.decoded ?? {};
  const action = poolActionFor(input.topicSymbol, input.eventType);
  if (action === 'ignore') return;

  const protocol = classifyProtocol(input.topicSymbol, input.eventType);
  const poolAddress = input.contractAddress;

  // Determine the token pair this event reveals, to register the pool.
  let pair: [string, string] | null = null;
  const swap = action === 'swap' ? extractSwap(d, poolAddress) : null;
  const liq = action === 'add' || action === 'remove' ? extractLiquidity(d) : null;
  if (swap) pair = [swap.tokenIn, swap.tokenOut];
  else if (liq) pair = [liq.tokenA, liq.tokenB];

  const pool = await ensurePool(poolAddress, pair, protocol, input.ledgerSequence);
  if (!pool) return; // can't establish the pair yet (e.g. a bare sync first)

  let { reserveA, reserveB } = pool;

  if (action === 'swap' && swap) {
    ({ reserveA, reserveB } = applySwap(pool, pool.tokenA, swap.tokenIn, swap.amountIn, swap.amountOut));
    await prisma.poolSwap.create({
      data: {
        poolAddress,
        transactionHash: input.transactionHash,
        ledgerSequence: input.ledgerSequence,
        ledgerCloseTime: input.ledgerCloseTime,
        tokenIn: swap.tokenIn,
        tokenOut: swap.tokenOut,
        amountIn: swap.amountIn.toString(),
        amountOut: swap.amountOut.toString(),
        trader: swap.trader,
      },
    });
  } else if ((action === 'add' || action === 'remove') && liq) {
    // Map the event's token order onto canonical A/B.
    const inIsA = liq.tokenA === pool.tokenA;
    const dA = inIsA ? liq.amountA : liq.amountB;
    const dB = inIsA ? liq.amountB : liq.amountA;
    const sign = action === 'add' ? 1n : -1n;
    ({ reserveA, reserveB } = applyLiquidity(pool, sign * dA, sign * dB));
  } else if (action === 'sync') {
    const r0 = asBig(d.reserve_a ?? d.reserveA ?? d.reserve_0 ?? d.new_reserve_a);
    const r1 = asBig(d.reserve_b ?? d.reserveB ?? d.reserve_1 ?? d.new_reserve_b);
    if (r0 > 0n || r1 > 0n) {
      reserveA = r0;
      reserveB = r1;
    }
  }

  await prisma.dexPool.update({
    where: { poolAddress },
    data: {
      reserveA: reserveA.toString(),
      reserveB: reserveB.toString(),
      lastEventLedger: input.ledgerSequence,
    },
  });
}
