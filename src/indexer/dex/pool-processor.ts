/**
 * DEX analytics background processor.
 *
 * Periodically recomputes the price registry, per-pool metrics (TVL, windowed
 * volume, fees, APR, IL-risk), writes historical snapshots, and rescans for
 * arbitrage. Scheduling mirrors the other indexer background jobs (run once on
 * start, then on a fixed interval). The metric maths live in {@link pool-math}
 * and are unit tested independently; this module is the DB-bound orchestration.
 */

import { prismaWrite, prismaRead } from '../../db';
import { aprPct, toHuman, tvlUsd } from './pool-math';
import { refreshTokenPrices } from './pricing';
import { scanArbitrage } from './arbitrage';

const INTERVAL_MS = Number(process.env.DEX_ANALYTICS_INTERVAL_MS ?? 60_000);
const WINDOWS = {
  h1: 3_600_000,
  h24: 86_400_000,
  d7: 7 * 86_400_000,
  d30: 30 * 86_400_000,
} as const;

let timer: NodeJS.Timeout | null = null;

interface SwapRow {
  ledgerCloseTime: Date;
  tokenIn: string;
  amountIn: string;
}

/** Sum USD volume of swaps newer than `since`, valuing each by its input token. */
function sumVolumeUsd(
  swaps: SwapRow[],
  since: number,
  tokenA: string,
  decA: number,
  priceA: number | null,
  decB: number,
  priceB: number | null,
): number {
  let total = 0;
  for (const s of swaps) {
    if (s.ledgerCloseTime.getTime() < since) continue;
    const inIsA = s.tokenIn === tokenA;
    const price = inIsA ? priceA : priceB;
    if (price == null) continue;
    total += toHuman(BigInt(s.amountIn), inIsA ? decA : decB) * price;
  }
  return total;
}

/**
 * Heuristic 0-100 IL / concentrated-liquidity risk: higher turnover (volume
 * relative to TVL) and reserve-value imbalance both raise the risk of
 * impermanent loss for liquidity providers.
 */
export function ilRiskScore(tvl: number, volume24h: number, valueA: number, valueB: number): number {
  if (tvl <= 0) return 0;
  const turnover = Math.min(1, volume24h / tvl); // 0..1
  const balance = valueA + valueB > 0 ? Math.abs(valueA - valueB) / (valueA + valueB) : 0; // 0..1
  const score = turnover * 60 + balance * 40;
  return Math.round(Math.max(0, Math.min(100, score)));
}

/** Recompute and persist metrics + a historical snapshot for one pool. */
export async function computePoolMetrics(poolAddress: string): Promise<void> {
  const pool = await prismaRead.dexPool.findUnique({ where: { poolAddress } });
  if (!pool) return;

  const [priceARow, priceBRow] = await Promise.all([
    prismaRead.tokenPrice.findUnique({ where: { tokenAddress: pool.tokenA }, select: { priceUsd: true } }),
    prismaRead.tokenPrice.findUnique({ where: { tokenAddress: pool.tokenB }, select: { priceUsd: true } }),
  ]);
  const priceA = priceARow?.priceUsd ?? null;
  const priceB = priceBRow?.priceUsd ?? null;

  const reserveAHuman = toHuman(BigInt(pool.reserveA), pool.tokenADecimals);
  const reserveBHuman = toHuman(BigInt(pool.reserveB), pool.tokenBDecimals);
  const tvl = tvlUsd(reserveAHuman, priceA, reserveBHuman, priceB);

  const swaps = await prismaRead.poolSwap.findMany({
    where: { poolAddress, ledgerCloseTime: { gte: new Date(Date.now() - WINDOWS.d30) } },
    select: { ledgerCloseTime: true, tokenIn: true, amountIn: true },
  });

  const now = Date.now();
  const vol = (w: number) =>
    sumVolumeUsd(swaps, now - w, pool.tokenA, pool.tokenADecimals, priceA, pool.tokenBDecimals, priceB);
  const volume1h = vol(WINDOWS.h1);
  const volume24h = vol(WINDOWS.h24);
  const volume7d = vol(WINDOWS.d7);
  const volume30d = vol(WINDOWS.d30);

  const fees24h = (volume24h * pool.feeBps) / 10_000;
  const apr = aprPct(fees24h, tvl);
  const risk = ilRiskScore(
    tvl,
    volume24h,
    priceA != null ? reserveAHuman * priceA : 0,
    priceB != null ? reserveBHuman * priceB : 0,
  );

  await prismaWrite.dexPool.update({
    where: { poolAddress },
    data: {
      tvlUsd: tvl,
      volume1hUsd: volume1h,
      volume24hUsd: volume24h,
      volume7dUsd: volume7d,
      volume30dUsd: volume30d,
      fees24hUsd: fees24h,
      aprPct: apr,
      priceAUsd: priceA,
      priceBUsd: priceB,
      ilRiskScore: risk,
      lastSyncedAt: new Date(),
    },
  });

  await prismaWrite.poolSnapshot.create({
    data: {
      poolAddress,
      ledgerSequence: pool.lastEventLedger ?? undefined,
      reserveA: pool.reserveA,
      reserveB: pool.reserveB,
      tvlUsd: tvl,
      volume24hUsd: volume24h,
      fees24hUsd: fees24h,
      aprPct: apr,
      priceAUsd: priceA,
      priceBUsd: priceB,
    },
  });
}

/** One full analytics cycle: prices → per-pool metrics → arbitrage scan. */
export async function runDexAnalytics(): Promise<void> {
  await refreshTokenPrices();
  const pools = await prismaRead.dexPool.findMany({ select: { poolAddress: true } });
  for (const p of pools) {
    await computePoolMetrics(p.poolAddress).catch((e) =>
      console.error(`[dex-analytics] metrics failed for ${p.poolAddress}:`, e),
    );
  }
  await scanArbitrage().catch((e) => console.error('[dex-analytics] arbitrage scan failed:', e));
}

/** Schedule the analytics processor: run immediately, then every interval. */
export function scheduleDexAnalytics(): void {
  if (timer) return;
  console.log('[dex-analytics] scheduled every', INTERVAL_MS, 'ms');
  runDexAnalytics().catch((e) => console.error('[dex-analytics] run error:', e));
  timer = setInterval(() => {
    runDexAnalytics().catch((e) => console.error('[dex-analytics] run error:', e));
  }, INTERVAL_MS);
}

export function stopDexAnalytics(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
