import { prismaRead } from '../../db';
import { cacheGet, cacheSet } from '../../cache';

const MIN_LIQUIDITY_THRESHOLD_USD = 1000;
const FLASH_LOAN_TIME_WINDOW_MS = 2000;

export interface DexPrice {
  priceUsd: number;
  priceXlm: number;
  source: string;
  confidence: number;
  volume24hUsd: number;
  liquidityUsd: number;
  twap1h: number;
  twap24h: number;
}

export interface PoolReserve {
  poolAddress: string;
  dexName: string;
  tokenA: string;
  tokenB: string;
  reserveA: bigint;
  reserveB: bigint;
  tokenADecimals: number;
  tokenBDecimals: number;
  tokenASymbol: string | null;
  tokenBSymbol: string | null;
  priceAUsd: number | null;
  priceBUsd: number | null;
  volume24hUsd: number | null;
  feeBps: number | null;
}

export function isFlashLoanSwap(
  swaps: Array<{ timestamp: Date; amountIn: string; amountOut: string }>,
): boolean {
  if (swaps.length < 2) return false;
  const sorted = swaps.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const first = sorted[0].timestamp.getTime();
  const last = sorted[sorted.length - 1].timestamp.getTime();
  const timeSpan = last - first;
  if (timeSpan > FLASH_LOAN_TIME_WINDOW_MS) return false;
  const firstIn = BigInt(sorted[0].amountIn);
  const lastOut = BigInt(sorted[sorted.length - 1].amountOut);
  if (firstIn <= 0n) return false;
  const ratio = Number(lastOut) / Number(firstIn);
  return ratio > 0.95 && ratio < 1.05;
}

export function detectPoolManipulation(
  reserveA: bigint,
  reserveB: bigint,
  prevReserveA: bigint,
  prevReserveB: bigint,
): boolean {
  if (prevReserveA === 0n || prevReserveB === 0n) return false;
  const ratioNow = Number(reserveA) / Number(reserveB);
  const ratioPrev = Number(prevReserveA) / Number(prevReserveB);
  if (ratioPrev === 0) return false;
  const change = Math.abs(ratioNow / ratioPrev - 1);
  return change > 0.5;
}

export function computeSpotPrice(
  reserveA: bigint,
  reserveB: bigint,
  decimalsA: number,
  decimalsB: number,
  feeBps: number | null,
): number {
  if (reserveA <= 0n || reserveB <= 0n) return 0;
  const feeFactor = 1 - (feeBps ?? 30) / 10000;
  const amountA = Number(reserveA) / 10 ** decimalsA;
  const amountB = Number(reserveB) / 10 ** decimalsB;
  if (amountA <= 0) return 0;
  return (amountB / amountA) * feeFactor;
}

export function computeTWAP(
  prices: Array<{ price: number; timestamp: Date }>,
  windowMs: number,
): number {
  const cutoff = Date.now() - windowMs;
  const filtered = prices.filter((p) => p.timestamp.getTime() >= cutoff);
  if (filtered.length === 0) return 0;
  let weightedSum = 0;
  let totalWeight = 0;
  for (let i = 1; i < filtered.length; i++) {
    const timeWeight = filtered[i].timestamp.getTime() - filtered[i - 1].timestamp.getTime();
    weightedSum += filtered[i - 1].price * timeWeight;
    totalWeight += timeWeight;
  }
  if (totalWeight <= 0) return filtered[filtered.length - 1].price;
  return weightedSum / totalWeight;
}

export function estimateSlippage(
  reserveA: bigint,
  reserveB: bigint,
  tradeSizeUsd: number,
  priceUsd: number,
): number {
  if (reserveA <= 0n || reserveB <= 0n || priceUsd <= 0) return 0;
  const poolValueUsd = (Number(reserveA) * priceUsd) / 10 ** 7;
  if (poolValueUsd <= 0) return Infinity;
  return tradeSizeUsd / poolValueUsd;
}

export function computeVolumeWeightedMedian(
  prices: Array<{ price: number; volume24hUsd: number }>,
): number {
  const sorted = [...prices].sort((a, b) => a.price - b.price);
  const totalVolume = sorted.reduce((sum, p) => sum + p.volume24hUsd, 0);
  if (totalVolume <= 0) return prices.length > 0 ? prices[0].price : 0;
  let cumulativeVolume = 0;
  const halfVolume = totalVolume / 2;
  for (const p of sorted) {
    cumulativeVolume += p.volume24hUsd;
    if (cumulativeVolume >= halfVolume) return p.price;
  }
  return sorted[sorted.length - 1].price;
}

export function getConfidenceWeight(dexName: string): number {
  const weights: Record<string, number> = {
    soroswap: 1.0,
    phoenix: 0.95,
    aquarius: 0.9,
    stellar_swap: 0.85,
  };
  return weights[dexName.toLowerCase()] ?? 0.5;
}

export async function discoverDexPrice(tokenAddress: string): Promise<DexPrice | null> {
  const cacheKey = `dex_price:${tokenAddress}`;
  const cached = await cacheGet<DexPrice>(cacheKey);
  if (cached) return cached;

  const pools = await prismaRead.dexPool.findMany({
    where: {
      OR: [{ tokenA: tokenAddress }, { tokenB: tokenAddress }],
      isActive: true,
    },
    orderBy: { tvlUsd: 'desc' },
  });

  if (pools.length === 0) return null;

  const tokenPrices: Array<{
    price: number;
    volume24hUsd: number;
    liquidityUsd: number;
    dexName: string;
    priceXlm: number;
  }> = [];

  for (const pool of pools) {
    const isTokenA = pool.tokenA === tokenAddress;
    const reserveToken = isTokenA
      ? BigInt(pool.reserveA?.toString() ?? '0')
      : BigInt(pool.reserveB?.toString() ?? '0');
    const reserveOther = isTokenA
      ? BigInt(pool.reserveB?.toString() ?? '0')
      : BigInt(pool.reserveA?.toString() ?? '0');
    const decimalsToken = isTokenA ? (pool.tokenADecimals ?? 7) : (pool.tokenBDecimals ?? 7);
    const decimalsOther = isTokenA ? (pool.tokenBDecimals ?? 7) : (pool.tokenADecimals ?? 7);

    if (reserveToken <= 0n || reserveOther <= 0n) continue;

    const knownPrice = isTokenA ? pool.priceBUsd : pool.priceAUsd;

    let priceUsd = 0;
    const priceXlm = 0;

    if (knownPrice && Number(knownPrice) > 0) {
      const amountToken = Number(reserveToken) / 10 ** decimalsToken;
      const amountOther = Number(reserveOther) / 10 ** decimalsOther;
      if (amountToken > 0) {
        const kp = Number(knownPrice);
        if (isTokenA) {
          priceUsd = (kp * amountOther) / amountToken;
        } else {
          priceUsd = (kp * amountToken) / amountOther;
        }
      }
    }

    if (priceUsd <= 0) continue;

    const volumeFilter = Number(pool.volume24hUsd ?? 0) >= MIN_LIQUIDITY_THRESHOLD_USD;
    if (!volumeFilter) continue;

    const volumeUsd = pool.volume24hUsd ? Number(pool.volume24hUsd) : 0;
    const liqUsd = pool.tvlUsd ? Number(pool.tvlUsd) : 0;

    tokenPrices.push({
      price: priceUsd,
      volume24hUsd: volumeUsd,
      liquidityUsd: liqUsd,
      dexName: pool.dexName,
      priceXlm,
    });
  }

  if (tokenPrices.length === 0) return null;

  const volumeWeightedPrice = computeVolumeWeightedMedian(tokenPrices);
  const totalVolume = tokenPrices.reduce((s, p) => s + p.volume24hUsd, 0);
  const totalLiquidity = tokenPrices.reduce((s, p) => s + p.liquidityUsd, 0);
  const avgConfidence =
    tokenPrices.reduce((s, p) => s + getConfidenceWeight(p.dexName), 0) / tokenPrices.length;

  const now = Date.now();
  const priceHistory = await prismaRead.tokenPriceHistory.findMany({
    where: {
      tokenAddress,
      timestamp: { gte: new Date(now - 24 * 60 * 60 * 1000) },
    },
    orderBy: { timestamp: 'asc' },
    select: { priceUsd: true, timestamp: true },
  });

  const pricesWithTime = priceHistory.map((h) => ({
    price: Number(h.priceUsd),
    timestamp: h.timestamp,
  }));

  const twap1h = computeTWAP(pricesWithTime, 60 * 60 * 1000);
  const twap24h = computeTWAP(pricesWithTime, 24 * 60 * 60 * 1000);

  const result: DexPrice = {
    priceUsd: volumeWeightedPrice,
    priceXlm: volumeWeightedPrice * 2.5,
    source: 'dex',
    confidence: Math.min(1, avgConfidence),
    volume24hUsd: totalVolume,
    liquidityUsd: totalLiquidity,
    twap1h,
    twap24h,
  };

  await cacheSet<DexPrice>(cacheKey, result, 5);
  return result;
}

export async function discoverAllDexPrices(): Promise<Map<string, DexPrice>> {
  const tokens = await prismaRead.contract.findMany({
    where: { isToken: true },
    select: { address: true },
  });

  const results = new Map<string, DexPrice>();
  const batchSize = 20;
  for (let i = 0; i < tokens.length; i += batchSize) {
    const batch = tokens.slice(i, i + batchSize);
    const prices = await Promise.allSettled(batch.map((t) => discoverDexPrice(t.address)));
    for (let j = 0; j < batch.length; j++) {
      const price = prices[j];
      if (price.status === 'fulfilled' && price.value) {
        results.set(batch[j].address, price.value);
      }
    }
  }
  return results;
}
