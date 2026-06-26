import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prismaRead } from '../db';
import { asyncHandler } from '../middleware/asyncHandler';
import { computeCompositePrice, computeBatchPrices } from '../services/pricing/composite-price';
import { computeAllIndicators } from '../services/pricing/indicators';
import {
  getStablecoinInfo,
  calculatePegDeviation,
  computePegStabilityScore,
  detectFlashCrash,
} from '../services/pricing/stablecoin-peg';

export const tokenPricesRouter = Router();

const OHLCV_INTERVALS = ['1m', '5m', '1h', '1d', '1w'] as const;

function getIntervalMs(interval: string): number {
  const map: Record<string, number> = {
    '1m': 60_000,
    '5m': 5 * 60_000,
    '1h': 60 * 60_000,
    '1d': 24 * 60 * 60_000,
    '1w': 7 * 24 * 60 * 60_000,
  };
  return map[interval] || 60 * 60_000;
}

tokenPricesRouter.get(
  '/:address/price',
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    const token = await prismaRead.contract.findFirst({
      where: { address, isToken: true },
      select: { tokenSymbol: true },
    });

    const price = await computeCompositePrice(address, token?.tokenSymbol);

    res.json({
      tokenAddress: address,
      symbol: token?.tokenSymbol ?? null,
      priceUsd: price.priceUsd,
      priceXlm: price.priceXlm,
      source: price.source,
      confidence: price.confidence,
      volume24hUsd: price.volume24hUsd,
      liquidityUsd: price.liquidityUsd,
      marketCapUsd: price.marketCapUsd,
      priceChange1h: price.priceChange1h,
      priceChange24h: price.priceChange24h,
      priceChange7d: price.priceChange7d,
      twap1h: price.twap1h,
      twap24h: price.twap24h,
      breakdown: price.breakdown,
      updatedAt: new Date().toISOString(),
    });
  }),
);

tokenPricesRouter.get(
  '/:address/price/history',
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    const querySchema = z.object({
      from: z.string().optional(),
      to: z.string().optional(),
      interval: z.enum(OHLCV_INTERVALS).default('1h'),
    });

    const { from, to, interval } = querySchema.parse(req.query);
    const fromDate = from ? new Date(from) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const toDate = to ? new Date(to) : new Date();

    const history = await prismaRead.tokenPriceHistory.findMany({
      where: {
        tokenAddress: address,
        timestamp: { gte: fromDate, lte: toDate },
      },
      orderBy: { timestamp: 'asc' },
    });

    const bucketSize = getIntervalMs(interval);
    const buckets = new Map<number, { prices: number[]; volumes: number[] }>();

    for (const h of history) {
      const bucketKey = Math.floor(h.timestamp.getTime() / bucketSize) * bucketSize;
      if (!buckets.has(bucketKey)) {
        buckets.set(bucketKey, { prices: [], volumes: [] });
      }
      const bucket = buckets.get(bucketKey)!;
      bucket.prices.push(Number(h.priceUsd));
      if (h.volume24hUsd) bucket.volumes.push(Number(h.volume24hUsd));
    }

    const ohlcv = Array.from(buckets.entries()).map(([timestamp, bucket]) => ({
      timestamp: new Date(timestamp).toISOString(),
      open: bucket.prices[0],
      high: Math.max(...bucket.prices),
      low: Math.min(...bucket.prices),
      close: bucket.prices[bucket.prices.length - 1],
      volume:
        bucket.volumes.length > 0
          ? bucket.volumes.reduce((a, b) => a + b, 0) / bucket.volumes.length
          : 0,
    }));

    res.json({
      address,
      interval,
      from: fromDate.toISOString(),
      to: toDate.toISOString(),
      dataPoints: ohlcv.length,
      data: ohlcv,
    });
  }),
);

tokenPricesRouter.get(
  '/:address/price/volume',
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;

    const pools = await prismaRead.dexPool.findMany({
      where: {
        OR: [{ tokenA: address }, { tokenB: address }],
        isActive: true,
      },
      select: {
        poolAddress: true,
        dexName: true,
        volume24hUsd: true,
        volume7dUsd: true,
        volume30dUsd: true,
        fees24hUsd: true,
      },
    });

    const volumeByDex: Record<
      string,
      {
        volume24hUsd: number;
        volume7dUsd: number;
        volume30dUsd: number;
        fees24hUsd: number;
        swaps24h: number;
      }
    > = {};

    for (const pool of pools) {
      const dex = pool.dexName;
      if (!volumeByDex[dex]) {
        volumeByDex[dex] = {
          volume24hUsd: 0,
          volume7dUsd: 0,
          volume30dUsd: 0,
          fees24hUsd: 0,
          swaps24h: 0,
        };
      }
      volumeByDex[dex].volume24hUsd += Number(pool.volume24hUsd ?? 0);
      volumeByDex[dex].volume7dUsd += Number(pool.volume7dUsd ?? 0);
      volumeByDex[dex].volume30dUsd += Number(pool.volume30dUsd ?? 0);
      volumeByDex[dex].fees24hUsd += Number(pool.fees24hUsd ?? 0);
    }

    const totalVolume24h = Object.values(volumeByDex).reduce((s, v) => s + v.volume24hUsd, 0);

    res.json({
      tokenAddress: address,
      totalVolume24hUsd: totalVolume24h,
      volumeByDex,
      pools: pools.map((p) => ({
        poolAddress: p.poolAddress,
        dexName: p.dexName,
        volume24hUsd: p.volume24hUsd,
        fees24hUsd: p.fees24hUsd,
      })),
    });
  }),
);

tokenPricesRouter.get(
  '/:address/price/liquidity',
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;

    const pools = await prismaRead.dexPool.findMany({
      where: {
        OR: [{ tokenA: address }, { tokenB: address }],
        isActive: true,
      },
      select: {
        poolAddress: true,
        dexName: true,
        tokenA: true,
        tokenB: true,
        tokenASymbol: true,
        tokenBSymbol: true,
        reserveA: true,
        reserveB: true,
        totalLiquidity: true,
        tvlUsd: true,
        feeBps: true,
        volume24hUsd: true,
      },
    });

    const totalLiquidityUsd = pools.reduce((s, p) => s + Number(p.tvlUsd ?? 0), 0);

    res.json({
      tokenAddress: address,
      totalLiquidityUsd,
      poolCount: pools.length,
      pools: pools.map((p) => {
        const isTokenA = p.tokenA === address;
        return {
          poolAddress: p.poolAddress,
          dexName: p.dexName,
          pairedToken: isTokenA ? p.tokenB : p.tokenA,
          pairedSymbol: isTokenA ? p.tokenBSymbol : p.tokenASymbol,
          reserveToken: isTokenA ? p.reserveA : p.reserveB,
          reservePaired: isTokenA ? p.reserveB : p.reserveA,
          liquidityUsd: p.tvlUsd,
          feeBps: p.feeBps,
          volume24hUsd: p.volume24hUsd,
        };
      }),
    });
  }),
);

tokenPricesRouter.post(
  '/prices',
  asyncHandler(async (req: Request, res: Response) => {
    const schema = z.object({
      tokens: z.array(z.string()).min(1).max(100),
    });

    const { tokens } = schema.parse(req.body);
    const prices = await computeBatchPrices(tokens);

    const result: Record<
      string,
      {
        usd: number;
        xlm: number;
        change24h: number | null;
        change1h: number | null;
        confidence: number;
        source: string;
      }
    > = {};

    for (const [addr, price] of Object.entries(prices)) {
      result[addr] = {
        usd: price.priceUsd,
        xlm: price.priceXlm,
        change24h: price.priceChange24h,
        change1h: price.priceChange1h,
        confidence: price.confidence,
        source: price.source,
      };
    }

    res.json({ tokens, prices: result });
  }),
);

tokenPricesRouter.get(
  '/:address/market',
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;

    const token = await prismaRead.contract.findFirst({
      where: { address, isToken: true },
      select: { tokenSymbol: true, tokenName: true, tokenDecimals: true, address: true },
    });

    if (!token) return res.status(404).json({ error: 'Token not found' });

    const [price, marketData, tokenPrice] = await Promise.all([
      computeCompositePrice(address, token.tokenSymbol),
      prismaRead.tokenMarketData.findUnique({ where: { tokenAddress: address } }),
      prismaRead.tokenPrice.findUnique({ where: { tokenAddress: address } }),
    ]);

    if (!price) return res.status(404).json({ error: 'Price data not found' });

    res.json({
      address: token.address,
      symbol: token.tokenSymbol,
      name: token.tokenName,
      decimals: token.tokenDecimals,
      price: {
        usd: price.priceUsd,
        xlm: price.priceXlm,
        source: price.source,
        confidence: price.confidence,
      },
      market: {
        marketCapUsd: price.marketCapUsd ?? tokenPrice?.marketCapUsd ?? null,
        volume24hUsd: price.volume24hUsd,
        liquidityUsd: price.liquidityUsd,
        circulatingSupply: tokenPrice?.circulatingSupply ?? null,
        totalSupply: tokenPrice?.totalSupply ?? null,
        fullyDilutedValuation: tokenPrice?.fullyDilutedValuation ?? null,
      },
      changes: {
        priceChange1h: price.priceChange1h,
        priceChange24h: price.priceChange24h,
        priceChange7d: price.priceChange7d,
      },
      indicators: marketData
        ? {
            holderCount: marketData.holderCount,
            transferCount24h: marketData.transferCount24h,
            uniqueSenders24h: marketData.uniqueSenders24h,
            uniqueReceivers24h: marketData.uniqueReceivers24h,
            averageTransferValueUsd: marketData.averageTransferValueUsd,
            isStablecoin: marketData.isStablecoin,
            tags: marketData.tags,
          }
        : null,
    });
  }),
);

tokenPricesRouter.get(
  '/:address/peg',
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;

    const marketData = await prismaRead.tokenMarketData.findUnique({
      where: { tokenAddress: address },
    });

    if (!marketData || !marketData.isStablecoin) {
      return res.status(404).json({ error: 'Token is not a stablecoin or peg data not available' });
    }

    const stableInfo = getStablecoinInfo(marketData.symbol);
    const targetPrice = stableInfo?.targetPrice ?? 1;

    const price = await prismaRead.tokenPrice.findUnique({
      where: { tokenAddress: address },
    });

    const currentPriceUsd = price ? Number(price.priceUsd) : 0;
    const currentDeviation = calculatePegDeviation(currentPriceUsd, targetPrice);

    const history24h = await prismaRead.tokenPriceHistory.findMany({
      where: {
        tokenAddress: address,
        timestamp: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
      orderBy: { timestamp: 'asc' },
      select: { priceUsd: true, timestamp: true },
    });

    const formattedHistory = history24h.map((h) => ({
      timestamp: h.timestamp.toISOString(),
      priceUsd: Number(h.priceUsd),
      deviation: calculatePegDeviation(Number(h.priceUsd), targetPrice),
    }));

    const maxDeviation24h =
      formattedHistory.length > 0
        ? Math.max(...formattedHistory.map((h) => h.deviation))
        : currentDeviation;

    const pegStabilityScore = computePegStabilityScore(
      history24h.map((h) => ({ priceUsd: Number(h.priceUsd), timestamp: h.timestamp })),
      targetPrice,
    );

    const flashCrash = detectFlashCrash(
      history24h.map((h) => ({ priceUsd: Number(h.priceUsd), timestamp: h.timestamp })),
      targetPrice,
    );

    res.json({
      tokenAddress: address,
      symbol: marketData.symbol,
      peg: stableInfo?.peg ?? 'USD',
      targetPrice,
      currentPrice: currentPriceUsd,
      currentDeviation,
      maxDeviation24h,
      pegStabilityScore,
      flashCrashDetected: flashCrash,
      history: formattedHistory,
    });
  }),
);

tokenPricesRouter.get(
  '/:address/indicators',
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;

    const history = await prismaRead.tokenPriceHistory.findMany({
      where: { tokenAddress: address },
      orderBy: { timestamp: 'asc' },
      select: { priceUsd: true },
      take: 500,
    });

    if (history.length < 20) {
      return res
        .status(400)
        .json({
          error: 'Insufficient price history for indicators (need at least 20 data points)',
        });
    }

    const prices = history.map((h) => Number(h.priceUsd));
    const indicators = computeAllIndicators(prices);

    res.json({
      tokenAddress: address,
      indicators: {
        sma: indicators.sma,
        ema: indicators.ema,
        rsi: indicators.rsi,
        macd: indicators.macd,
        bollingerBands: indicators.bollingerBands,
      },
      dataPoints: prices.length,
    });
  }),
);

tokenPricesRouter.get(
  '/:address/indicators/history',
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    const querySchema = z.object({
      period: z.coerce.number().default(50),
    });

    const { period } = querySchema.parse(req.query);

    const history = await prismaRead.tokenPriceHistory.findMany({
      where: { tokenAddress: address },
      orderBy: { timestamp: 'asc' },
      select: { priceUsd: true, timestamp: true },
      take: 500,
    });

    if (history.length < period) {
      return res.status(400).json({ error: 'Insufficient price history' });
    }

    const prices = history.map((h) => Number(h.priceUsd));
    const timestamps = history.map((h) => h.timestamp);

    const indicatorHistory = [];
    for (let i = period; i < prices.length; i++) {
      const windowPrices = prices.slice(0, i + 1);
      const indicators = computeAllIndicators(windowPrices);
      indicatorHistory.push({
        timestamp: timestamps[i].toISOString(),
        rsi: indicators.rsi,
        macdHistogram: indicators.macd.histogram,
        sma7: indicators.sma[7],
        sma25: indicators.sma[25],
        ema7: indicators.ema[7],
        ema25: indicators.ema[25],
        bollingerUpper: indicators.bollingerBands.upper,
        bollingerMiddle: indicators.bollingerBands.middle,
        bollingerLower: indicators.bollingerBands.lower,
      });
    }

    res.json({
      tokenAddress: address,
      indicatorHistory,
    });
  }),
);

tokenPricesRouter.get(
  '/:address/prediction',
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    const querySchema = z.object({
      horizon: z.enum(['1h', '24h']).default('1h'),
    });

    const { horizon } = querySchema.parse(req.query);

    const history = await prismaRead.tokenPriceHistory.findMany({
      where: { tokenAddress: address },
      orderBy: { timestamp: 'asc' },
      select: { priceUsd: true, timestamp: true },
      take: 500,
    });

    if (history.length < 50) {
      return res.status(400).json({ error: 'Insufficient price history for prediction' });
    }

    const prices = history.map((h) => Number(h.priceUsd));
    const recentPrices = prices.slice(-20);
    const avgRecentPrice = recentPrices.reduce((s, p) => s + p, 0) / recentPrices.length;
    const priceChange =
      recentPrices.length > 1
        ? (recentPrices[recentPrices.length - 1] - recentPrices[0]) / recentPrices[0]
        : 0;

    const volatility =
      prices.length > 1
        ? Math.sqrt(
            prices.slice(1).reduce((s, p, i) => s + Math.pow(p / prices[i] - 1, 2), 0) /
              (prices.length - 1),
          )
        : 0.01;

    const horizonHours = horizon === '1h' ? 1 : 24;
    const predictedChange = priceChange * Math.sqrt(horizonHours);
    const predictedPrice = avgRecentPrice * (1 + predictedChange);
    const confidenceInterval = volatility * Math.sqrt(horizonHours) * 1.96;

    res.json({
      tokenAddress: address,
      horizon,
      currentPrice: avgRecentPrice,
      predictedPrice: Math.max(0, predictedPrice),
      confidenceInterval: {
        upper: predictedPrice * (1 + confidenceInterval),
        lower: Math.max(0, predictedPrice * (1 - confidenceInterval)),
      },
      confidence: Math.max(0, Math.min(1, 1 - volatility * 10)),
      modelFeatures: {
        volatility,
        recentTrend: priceChange,
        dataPoints: prices.length,
      },
    });
  }),
);
