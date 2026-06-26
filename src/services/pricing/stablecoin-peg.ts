import { prismaRead, prismaWrite } from '../../db';

const KNOWN_STABLECOINS: Record<string, { peg: string; targetPrice: number }> = {
  USDC: { peg: 'USD', targetPrice: 1.0 },
  EURC: { peg: 'EUR', targetPrice: 1.0 },
  USDT: { peg: 'USD', targetPrice: 1.0 },
  DAI: { peg: 'USD', targetPrice: 1.0 },
  BUSD: { peg: 'USD', targetPrice: 1.0 },
  GUSD: { peg: 'USD', targetPrice: 1.0 },
  USDD: { peg: 'USD', targetPrice: 1.0 },
  USD: { peg: 'USD', targetPrice: 1.0 },
  USDGLO: { peg: 'USD', targetPrice: 1.0 },
};

const STABLE_DETECTION_PERIOD_DAYS = 7;
const STABLE_PRICE_TOLERANCE = 0.05;

export function getStablecoinInfo(
  symbol: string | null | undefined,
): { peg: string; targetPrice: number } | null {
  if (!symbol) return null;
  const info = KNOWN_STABLECOINS[symbol.toUpperCase()];
  return info ?? null;
}

export function isStablecoin(symbol: string | null | undefined): boolean {
  return getStablecoinInfo(symbol) !== null;
}

export function calculatePegDeviation(priceUsd: number, targetPrice: number): number {
  if (targetPrice <= 0) return 0;
  return Math.abs(priceUsd - targetPrice) / targetPrice;
}

export function detectFlashCrash(
  prices: Array<{ priceUsd: number; timestamp: Date }>,
  targetPrice: number,
): boolean {
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;
  const recentPrices = prices.filter((p) => p.timestamp.getTime() >= oneHourAgo);
  if (recentPrices.length < 2) return false;

  const maxDeviation = Math.max(
    ...recentPrices.map((p) => calculatePegDeviation(p.priceUsd, targetPrice)),
  );
  return maxDeviation > 0.05;
}

export function computePegStabilityScore(
  prices: Array<{ priceUsd: number; timestamp: Date }>,
  targetPrice: number,
): number {
  if (prices.length === 0) return 100;

  const deviations = prices.map((p) => calculatePegDeviation(p.priceUsd, targetPrice));
  const avgDeviation = deviations.reduce((s, d) => s + d, 0) / deviations.length;
  const maxDeviation = Math.max(...deviations);

  const recentPrices = prices.slice(-Math.min(24, prices.length));
  const recentDeviations = recentPrices.map((p) => {
    const d = calculatePegDeviation(p.priceUsd, targetPrice);
    return d * d;
  });
  const variance = recentDeviations.reduce((s, v) => s + v, 0) / recentDeviations.length;

  const deviationScore = Math.max(0, 100 - avgDeviation * 500);
  const volatilityScore = Math.max(0, 100 - variance * 1000);
  const maxScore = Math.max(0, 100 - maxDeviation * 200);

  return Math.round(deviationScore * 0.4 + volatilityScore * 0.3 + maxScore * 0.3);
}

export async function autoDetectStablecoin(tokenAddress: string): Promise<boolean> {
  const history = await prismaRead.tokenPriceHistory.findMany({
    where: {
      tokenAddress,
      timestamp: { gte: new Date(Date.now() - STABLE_DETECTION_PERIOD_DAYS * 24 * 60 * 60 * 1000) },
    },
    orderBy: { timestamp: 'asc' },
    select: { priceUsd: true, timestamp: true },
  });

  if (history.length < 10) return false;

  const prices = history.map((h) => Number(h.priceUsd));
  const avgPrice = prices.reduce((s, p) => s + p, 0) / prices.length;

  if (avgPrice <= 0) return false;

  const nearDollar = avgPrice > 0.95 && avgPrice < 1.05;
  if (!nearDollar) return false;

  const deviations = prices.map((p) => Math.abs(p - 1));
  const avgDeviation = deviations.reduce((s, d) => s + d, 0) / deviations.length;

  return avgDeviation < STABLE_PRICE_TOLERANCE;
}

export async function updateStablecoinMonitoring(): Promise<void> {
  const tokenMarketData = await prismaRead.tokenMarketData.findMany({
    where: { isStablecoin: true },
  });

  for (const data of tokenMarketData) {
    const stableInfo = getStablecoinInfo(data.symbol);
    if (!stableInfo) continue;

    const priceRecord = await prismaRead.tokenPrice.findUnique({
      where: { tokenAddress: data.tokenAddress },
    });

    if (!priceRecord) continue;

    const priceUsd = Number(priceRecord.priceUsd);
    const deviation = calculatePegDeviation(priceUsd, stableInfo.targetPrice);

    const history24h = await prismaRead.tokenPriceHistory.findMany({
      where: {
        tokenAddress: data.tokenAddress,
        timestamp: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
      orderBy: { timestamp: 'asc' },
      select: { priceUsd: true, timestamp: true },
    });

    const maxDeviation24h =
      history24h.length > 0
        ? Math.max(
            ...history24h.map((h) =>
              calculatePegDeviation(Number(h.priceUsd), stableInfo.targetPrice),
            ),
          )
        : deviation;

    const pegStabilityScore = computePegStabilityScore(
      history24h.map((h) => ({ priceUsd: Number(h.priceUsd), timestamp: h.timestamp })),
      stableInfo.targetPrice,
    );

    await prismaWrite.tokenMarketData.update({
      where: { id: data.id },
      data: {
        pegDeviation24h: maxDeviation24h,
        pegStabilityScore,
      },
    });
  }

  const allTokens = await prismaRead.contract.findMany({
    where: { isToken: true },
    select: { address: true, tokenSymbol: true },
  });

  for (const token of allTokens) {
    if (token.tokenSymbol && isStablecoin(token.tokenSymbol)) {
      const existing = await prismaRead.tokenMarketData.findUnique({
        where: { tokenAddress: token.address },
      });
      if (existing && !existing.isStablecoin) {
        await prismaWrite.tokenMarketData.update({
          where: { tokenAddress: token.address },
          data: {
            isStablecoin: true,
            stablecoinPeg: KNOWN_STABLECOINS[token.tokenSymbol.toUpperCase()]?.peg ?? 'USD',
            tags: { push: ['stablecoin'] },
          },
        });
      } else if (!existing) {
        await prismaWrite.tokenMarketData.create({
          data: {
            tokenAddress: token.address,
            symbol: token.tokenSymbol,
            isStablecoin: true,
            stablecoinPeg: KNOWN_STABLECOINS[token.tokenSymbol.toUpperCase()]?.peg ?? 'USD',
            tags: ['stablecoin'],
          },
        });
      }
    }
  }
}
