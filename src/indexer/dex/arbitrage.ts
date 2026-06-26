/**
 * Phase 3 — Arbitrage detection.
 *
 * Compares the exchange rate of the same token pair across every pool that
 * trades it. When two pools quote rates that differ by more than the combined
 * fee plus a configurable threshold, a profitable arbitrage exists: buy the
 * base token where it is cheap and sell where it is dear. The core
 * ({@link findArbitrageOpportunities}) is a pure function; `scanArbitrage`
 * loads pools, runs it, and reconciles the persisted opportunity set.
 */

import { prismaWrite, prismaRead } from '../../db';

export interface ArbPool {
  poolAddress: string;
  pairKey: string; // canonical "tokenA|tokenB"
  tokenA: string; // base
  tokenB: string; // quote
  reserveAHuman: number;
  reserveBHuman: number;
  feeBps: number;
  /** USD price of the quote token (tokenB), when known. Enables USD profit. */
  quotePriceUsd?: number | null;
}

export interface ArbitrageOpportunity {
  pairKey: string;
  tokenA: string;
  tokenB: string;
  buyPool: string; // cheapest base token
  sellPool: string; // dearest base token
  buyRate: number; // quote per base in the buy pool
  sellRate: number;
  spreadPct: number;
  estProfitUsd: number;
  optimalTradeUsd: number;
}

export interface ArbOptions {
  /** Minimum net spread (after fees), in %, to report. Default 0.3%. */
  minSpreadPct?: number;
}

/** Canonical pair key for two token addresses. */
export function pairKeyOf(t0: string, t1: string): string {
  return t0 <= t1 ? `${t0}|${t1}` : `${t1}|${t0}`;
}

/**
 * Find arbitrage opportunities across pools. Pools are grouped by token pair;
 * within each group the cheapest and dearest quoting pools are compared. The
 * reported spread is net of both legs' fees, and the trade size is bounded so
 * the price impact stays within the edge.
 */
export function findArbitrageOpportunities(pools: ArbPool[], opts: ArbOptions = {}): ArbitrageOpportunity[] {
  const minSpreadPct = opts.minSpreadPct ?? 0.3;
  const groups = new Map<string, ArbPool[]>();
  for (const p of pools) {
    if (p.reserveAHuman <= 0 || p.reserveBHuman <= 0) continue;
    const arr = groups.get(p.pairKey) ?? [];
    arr.push(p);
    groups.set(p.pairKey, arr);
  }

  const out: ArbitrageOpportunity[] = [];

  for (const [pairKey, group] of groups) {
    if (group.length < 2) continue;

    // rate = quote per base (tokenB per tokenA).
    const rated = group.map((p) => ({ pool: p, rate: p.reserveBHuman / p.reserveAHuman }));
    let cheap = rated[0]; // lowest rate = base is cheapest here → buy
    let dear = rated[0]; // highest rate = base is dearest here → sell
    for (const r of rated) {
      if (r.rate < cheap.rate) cheap = r;
      if (r.rate > dear.rate) dear = r;
    }
    if (cheap.pool.poolAddress === dear.pool.poolAddress) continue;
    if (cheap.rate <= 0) continue;

    const grossSpread = (dear.rate - cheap.rate) / cheap.rate; // fraction
    const feeFraction = (cheap.pool.feeBps + dear.pool.feeBps) / 10_000;
    const netEdge = grossSpread - feeFraction;
    const spreadPct = grossSpread * 100;
    if (spreadPct < minSpreadPct || netEdge <= 0) continue;

    // Bound trade size by the shallower pool so price impact stays within edge.
    const boundFraction = Math.min(0.3, netEdge);
    const tradeQuote = Math.min(cheap.pool.reserveBHuman, dear.pool.reserveBHuman) * boundFraction;
    const quotePriceUsd = dear.pool.quotePriceUsd ?? cheap.pool.quotePriceUsd ?? null;
    const optimalTradeUsd = quotePriceUsd != null ? tradeQuote * quotePriceUsd : tradeQuote;
    const estProfitUsd = optimalTradeUsd * netEdge;

    out.push({
      pairKey,
      tokenA: cheap.pool.tokenA,
      tokenB: cheap.pool.tokenB,
      buyPool: cheap.pool.poolAddress,
      sellPool: dear.pool.poolAddress,
      buyRate: cheap.rate,
      sellRate: dear.rate,
      spreadPct,
      estProfitUsd,
      optimalTradeUsd,
    });
  }

  return out.sort((a, b) => b.estProfitUsd - a.estProfitUsd);
}

/**
 * Scan all pools for arbitrage and reconcile the persisted opportunity set:
 * upsert currently-open opportunities and close ones that have disappeared.
 */
export async function scanArbitrage(opts: ArbOptions = {}): Promise<ArbitrageOpportunity[]> {
  const pools = await prismaRead.dexPool.findMany({
    select: {
      poolAddress: true,
      tokenA: true,
      tokenB: true,
      tokenADecimals: true,
      tokenBDecimals: true,
      reserveA: true,
      reserveB: true,
      feeBps: true,
      priceBUsd: true,
    },
  });

  const arbPools: ArbPool[] = pools.map((p) => ({
    poolAddress: p.poolAddress,
    pairKey: pairKeyOf(p.tokenA, p.tokenB),
    tokenA: p.tokenA,
    tokenB: p.tokenB,
    reserveAHuman: Number(BigInt(p.reserveA)) / 10 ** p.tokenADecimals,
    reserveBHuman: Number(BigInt(p.reserveB)) / 10 ** p.tokenBDecimals,
    feeBps: p.feeBps,
    quotePriceUsd: p.priceBUsd,
  }));

  const opportunities = findArbitrageOpportunities(arbPools, opts);

  // Reconcile: close previously-open opportunities for pairs no longer arbing.
  const liveKeys = new Set(opportunities.map((o) => o.pairKey));
  const open = await prismaRead.arbitrageOpportunity.findMany({
    where: { status: 'open' },
    select: { id: true, pairKey: true },
  });
  await Promise.all(
    open
      .filter((o) => !liveKeys.has(o.pairKey))
      .map((o) =>
        prismaWrite.arbitrageOpportunity.update({
          where: { id: o.id },
          data: { status: 'closed', closedAt: new Date() },
        }),
      ),
  );

  // Upsert current opportunities (one open row per pair).
  for (const o of opportunities) {
    const existing = await prismaWrite.arbitrageOpportunity.findFirst({
      where: { pairKey: o.pairKey, status: 'open' },
      select: { id: true },
    });
    const data = {
      tokenA: o.tokenA,
      tokenB: o.tokenB,
      pairKey: o.pairKey,
      buyPool: o.buyPool,
      sellPool: o.sellPool,
      buyPriceUsd: o.buyRate,
      sellPriceUsd: o.sellRate,
      spreadPct: o.spreadPct,
      estProfitUsd: o.estProfitUsd,
      optimalTradeUsd: o.optimalTradeUsd,
      status: 'open',
    };
    if (existing) {
      await prismaWrite.arbitrageOpportunity.update({ where: { id: existing.id }, data });
    } else {
      await prismaWrite.arbitrageOpportunity.create({ data });
    }
  }

  return opportunities;
}
