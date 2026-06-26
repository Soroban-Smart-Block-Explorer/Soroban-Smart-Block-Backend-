import { prismaRead, prismaWrite } from '../../db';
import { discoverDexPrice } from './dex-price-source';
import { discoverExternalPrice } from './external-api-source';
import { getStablecoinInfo } from './stablecoin-peg';
import { cacheGet, cacheSet } from '../../cache';

export interface CompositePrice {
  priceUsd: number;
  priceXlm: number;
  source: string;
  confidence: number;
  volume24hUsd: number;
  liquidityUsd: number;
  marketCapUsd: number | null;
  priceChange1h: number | null;
  priceChange24h: number | null;
  priceChange7d: number | null;
  twap1h: number;
  twap24h: number;
  breakdown: Array<{ source: string; price: number; confidence: number }>;
}

export async function computeCompositePrice(
  tokenAddress: string,
  tokenSymbol?: string | null,
): Promise<CompositePrice> {
  const cacheKey = `composite_price:${tokenAddress}`;
  const cached = await cacheGet<CompositePrice>(cacheKey);
  if (cached) return cached;

  const breakdown: Array<{ source: string; price: number; confidence: number }> = [];
  let selectedPrice = 0;
  let selectedSource = 'none';
  let selectedConfidence = 0;
  let volume24hUsd = 0;
  let liquidityUsd = 0;
  let marketCapUsd: number | null = null;
  let priceChange1h: number | null = null;
  let priceChange24h: number | null = null;
  let priceChange7d: number | null = null;
  let twap1h = 0;
  let twap24h = 0;

  const stableInfo = tokenSymbol ? getStablecoinInfo(tokenSymbol) : null;
  if (stableInfo) {
    const pegPrice = stableInfo.targetPrice;
    breakdown.push({ source: 'peg', price: pegPrice, confidence: 1.0 });
    selectedPrice = pegPrice;
    selectedSource = 'peg';
    selectedConfidence = 1.0;
  }

  const dexPrice = await discoverDexPrice(tokenAddress);
  if (dexPrice) {
    breakdown.push({ source: 'dex', price: dexPrice.priceUsd, confidence: dexPrice.confidence });
    volume24hUsd = dexPrice.volume24hUsd;
    liquidityUsd = dexPrice.liquidityUsd;
    twap1h = dexPrice.twap1h;
    twap24h = dexPrice.twap24h;

    if (dexPrice.confidence > selectedConfidence) {
      selectedPrice = dexPrice.priceUsd;
      selectedSource = 'dex';
      selectedConfidence = dexPrice.confidence;
    }
  }

  const extPrice = await discoverExternalPrice(tokenAddress, tokenSymbol);
  if (extPrice) {
    breakdown.push({
      source: extPrice.source,
      price: extPrice.priceUsd,
      confidence: extPrice.confidence,
    });
    marketCapUsd = extPrice.marketCapUsd ?? marketCapUsd;
    priceChange1h = extPrice.priceChange1h ?? priceChange1h;
    priceChange24h = extPrice.priceChange24h ?? priceChange24h;
    priceChange7d = extPrice.priceChange7d ?? priceChange7d;

    if (extPrice.confidence > selectedConfidence) {
      selectedPrice = extPrice.priceUsd;
      selectedSource = extPrice.source;
      selectedConfidence = extPrice.confidence;
    }
  }

  if (selectedPrice <= 0 && breakdown.length > 0) {
    selectedPrice = breakdown[0].price;
    selectedSource = breakdown[0].source;
    selectedConfidence = breakdown[0].confidence;
  }

  const result: CompositePrice = {
    priceUsd: selectedPrice,
    priceXlm: selectedPrice * 2.5,
    source: selectedSource,
    confidence: selectedConfidence,
    volume24hUsd,
    liquidityUsd,
    marketCapUsd,
    priceChange1h,
    priceChange24h,
    priceChange7d,
    twap1h,
    twap24h,
    breakdown,
  };

  await cacheSet(cacheKey, result, 5);

  if (selectedPrice > 0) {
    await persistPrice(tokenAddress, result, selectedSource);
  }

  return result;
}

async function persistPrice(
  tokenAddress: string,
  price: CompositePrice,
  source: string,
): Promise<void> {
  const now = new Date();

  await prismaWrite.tokenPrice.upsert({
    where: { tokenAddress },
    create: {
      tokenAddress,
      priceUsd: price.priceUsd,
      priceXlm: price.priceXlm,
      source,
      confidence: price.confidence,
      volume24hUsd: price.volume24hUsd || null,
      marketCapUsd: price.marketCapUsd || null,
      liquidityUsd: price.liquidityUsd || null,
      priceChange1h: price.priceChange1h,
      priceChange24h: price.priceChange24h,
      priceChange7d: price.priceChange7d,
      twap1h: price.twap1h || null,
      twap24h: price.twap24h || null,
      updatedAt: now,
    },
    update: {
      priceUsd: price.priceUsd,
      priceXlm: price.priceXlm,
      source,
      confidence: price.confidence,
      volume24hUsd: price.volume24hUsd || null,
      marketCapUsd: price.marketCapUsd || null,
      liquidityUsd: price.liquidityUsd || null,
      priceChange1h: price.priceChange1h,
      priceChange24h: price.priceChange24h,
      priceChange7d: price.priceChange7d,
      twap1h: price.twap1h || null,
      twap24h: price.twap24h || null,
      updatedAt: now,
    },
  });

  const lastHistory = await prismaRead.tokenPriceHistory.findFirst({
    where: { tokenAddress },
    orderBy: { timestamp: 'desc' },
    select: { priceUsd: true, timestamp: true },
  });

  const shouldRecord =
    !lastHistory ||
    now.getTime() - lastHistory.timestamp.getTime() > 60_000 ||
    Math.abs(Number(lastHistory.priceUsd) - price.priceUsd) / price.priceUsd > 0.001;

  if (shouldRecord) {
    await prismaWrite.tokenPriceHistory.create({
      data: {
        tokenAddress,
        priceUsd: price.priceUsd,
        priceXlm: price.priceXlm,
        source,
        confidence: price.confidence,
        volume24hUsd: price.volume24hUsd || null,
        marketCapUsd: price.marketCapUsd || null,
        timestamp: now,
      },
    });
  }
}

export async function computeBatchPrices(
  tokens: string[],
): Promise<Record<string, CompositePrice>> {
  const result: Record<string, CompositePrice> = {};

  const batchSize = 10;
  for (let i = 0; i < tokens.length; i += batchSize) {
    const batch = tokens.slice(i, i + batchSize);
    const prices = await Promise.allSettled(batch.map((addr) => computeCompositePrice(addr)));
    for (let j = 0; j < batch.length; j++) {
      const p = prices[j];
      if (p.status === 'fulfilled') {
        result[batch[j]] = p.value;
      }
    }
  }

  return result;
}
