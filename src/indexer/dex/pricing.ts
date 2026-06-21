/**
 * Token USD pricing for the DEX analytics engine.
 *
 * On Soroban there is no single canonical USD oracle covering every token, so
 * prices are derived from on-chain liquidity: known stablecoins anchor at $1,
 * and every other token's price is implied from the deepest pool that connects
 * it (directly or transitively) to an already-priced token. The derivation is
 * a pure function ({@link deriveTokenPrices}) so it is fully unit testable; the
 * DB read/write helpers wrap it for the live path.
 */

import { prismaWrite, prismaRead } from '../../db';

/** Symbols treated as USD stablecoins (≈ $1.00). */
const STABLE_SYMBOLS = new Set(['USDC', 'USDT', 'DAI', 'USDX', 'USDD', 'BUSD', 'GUSD', 'USD', 'USDGLO']);

export function isStableSymbol(symbol: string | null | undefined): boolean {
  return symbol != null && STABLE_SYMBOLS.has(symbol.toUpperCase());
}

export interface PricedToken {
  priceUsd: number;
  source: 'stable' | 'pool';
  confidence: number; // 0..1
}

/** Minimal pool shape the pricing pass needs (reserves already in human units). */
export interface PricingPool {
  poolAddress: string;
  tokenA: string;
  tokenB: string;
  symbolA?: string | null;
  symbolB?: string | null;
  reserveAHuman: number;
  reserveBHuman: number;
}

/**
 * Derive USD prices for every token reachable from a stablecoin through the
 * given pools. Stablecoins anchor at $1; other prices are implied from the
 * deepest priced pool side. Confidence decays with each hop from a stable.
 */
export function deriveTokenPrices(pools: PricingPool[]): Map<string, PricedToken> {
  const prices = new Map<string, PricedToken>();
  // Track the USD depth of the reference side used for each derived price, so a
  // deeper pool can overwrite a shallower one.
  const refDepth = new Map<string, number>();

  // Seed stablecoins.
  for (const p of pools) {
    if (isStableSymbol(p.symbolA) && !prices.has(p.tokenA)) {
      prices.set(p.tokenA, { priceUsd: 1, source: 'stable', confidence: 1 });
      refDepth.set(p.tokenA, Infinity);
    }
    if (isStableSymbol(p.symbolB) && !prices.has(p.tokenB)) {
      prices.set(p.tokenB, { priceUsd: 1, source: 'stable', confidence: 1 });
      refDepth.set(p.tokenB, Infinity);
    }
  }

  // Propagate across pools. A handful of passes converges for realistic graphs.
  for (let pass = 0; pass < 5; pass++) {
    let changed = false;
    for (const p of pools) {
      if (p.reserveAHuman <= 0 || p.reserveBHuman <= 0) continue;
      const a = prices.get(p.tokenA);
      const b = prices.get(p.tokenB);

      // Price B from A.
      if (a && (!b || b.source !== 'stable')) {
        const sideUsd = p.reserveAHuman * a.priceUsd;
        const impliedB = sideUsd / p.reserveBHuman;
        if (sideUsd > (refDepth.get(p.tokenB) ?? 0)) {
          prices.set(p.tokenB, {
            priceUsd: impliedB,
            source: 'pool',
            confidence: Math.max(0.1, a.confidence * 0.9),
          });
          refDepth.set(p.tokenB, sideUsd);
          changed = true;
        }
      }

      // Price A from B.
      if (b && (!a || a.source !== 'stable')) {
        const sideUsd = p.reserveBHuman * b.priceUsd;
        const impliedA = sideUsd / p.reserveAHuman;
        if (sideUsd > (refDepth.get(p.tokenA) ?? 0)) {
          prices.set(p.tokenA, {
            priceUsd: impliedA,
            source: 'pool',
            confidence: Math.max(0.1, b.confidence * 0.9),
          });
          refDepth.set(p.tokenA, sideUsd);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  return prices;
}

/** Load all pools (human reserves) and recompute + persist the price registry. */
export async function refreshTokenPrices(): Promise<Map<string, PricedToken>> {
  const pools = await prismaRead.dexPool.findMany({
    select: {
      poolAddress: true,
      tokenA: true,
      tokenB: true,
      tokenASymbol: true,
      tokenBSymbol: true,
      tokenADecimals: true,
      tokenBDecimals: true,
      reserveA: true,
      reserveB: true,
    },
  });

  const pricingPools: PricingPool[] = pools.map((p) => ({
    poolAddress: p.poolAddress,
    tokenA: p.tokenA,
    tokenB: p.tokenB,
    symbolA: p.tokenASymbol,
    symbolB: p.tokenBSymbol,
    reserveAHuman: Number(BigInt(p.reserveA)) / 10 ** p.tokenADecimals,
    reserveBHuman: Number(BigInt(p.reserveB)) / 10 ** p.tokenBDecimals,
  }));

  const prices = deriveTokenPrices(pricingPools);

  const symbolByToken = new Map<string, string | null>();
  for (const p of pools) {
    symbolByToken.set(p.tokenA, p.tokenASymbol);
    symbolByToken.set(p.tokenB, p.tokenBSymbol);
  }

  await Promise.all(
    [...prices.entries()].map(([tokenAddress, priced]) =>
      prismaWrite.tokenPrice.upsert({
        where: { tokenAddress },
        create: {
          tokenAddress,
          symbol: symbolByToken.get(tokenAddress) ?? null,
          priceUsd: priced.priceUsd,
          source: priced.source,
          confidence: priced.confidence,
        },
        update: {
          priceUsd: priced.priceUsd,
          source: priced.source,
          confidence: priced.confidence,
        },
      }),
    ),
  );

  return prices;
}

/** Read a token's latest USD price from the persisted registry. */
export async function getTokenPriceUsd(tokenAddress: string): Promise<number | null> {
  const row = await prismaRead.tokenPrice.findUnique({
    where: { tokenAddress },
    select: { priceUsd: true },
  });
  return row?.priceUsd ?? null;
}
