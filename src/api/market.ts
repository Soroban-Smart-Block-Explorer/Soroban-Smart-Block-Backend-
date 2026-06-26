import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prismaRead } from '../db';
import { asyncHandler } from '../middleware/asyncHandler';
import { computeCompositePrice } from '../services/pricing/composite-price';
import { getStablecoinInfo } from '../services/pricing/stablecoin-peg';
import { getCrossChainPrices, findArbitrageOpportunities } from '../services/pricing/correlation';

export const marketRouter = Router();

const SORT_FIELDS = ['volume', 'market_cap', 'gainers', 'losers'] as const;

marketRouter.get(
  '/overview',
  asyncHandler(async (_req: Request, res: Response) => {
    const tokenPrices = await prismaRead.tokenPrice.findMany({
      orderBy: { volume24hUsd: 'desc' },
      where: { priceUsd: { gt: 0 } },
    });

    const tokenMarketData = await prismaRead.tokenMarketData.findMany({});
    const marketDataMap = new Map(tokenMarketData.map((d) => [d.tokenAddress, d]));

    let totalMarketCap = 0;
    let totalVolume24h = 0;
    let totalLiquidity = 0;

    for (const tp of tokenPrices) {
      const mc = Number(tp.marketCapUsd ?? 0);
      const vol = Number(tp.volume24hUsd ?? 0);
      const liq = Number(tp.liquidityUsd ?? 0);
      totalMarketCap += mc;
      totalVolume24h += vol;
      totalLiquidity += liq;
    }

    const sortedByCap = [...tokenPrices].sort(
      (a, b) => Number(b.marketCapUsd ?? 0) - Number(a.marketCapUsd ?? 0),
    );
    const totalCap = sortedByCap.reduce((s, t) => s + Number(t.marketCapUsd ?? 0), 0);

    const dominance = sortedByCap.slice(0, 10).map((t) => {
      const mData = marketDataMap.get(t.tokenAddress);
      return {
        token: t.tokenAddress,
        symbol: mData?.symbol ?? 'Unknown',
        dominance: totalCap > 0 ? (Number(t.marketCapUsd ?? 0) / totalCap) * 100 : 0,
      };
    });

    const withChanges = tokenPrices.filter((t) => t.priceChange24h != null);
    const topGainers = [...withChanges]
      .sort((a, b) => (b.priceChange24h ?? 0) - (a.priceChange24h ?? 0))
      .slice(0, 10);
    const topLosers = [...withChanges]
      .sort((a, b) => (a.priceChange24h ?? 0) - (b.priceChange24h ?? 0))
      .slice(0, 10);
    const mostActive = [...tokenPrices]
      .sort((a, b) => Number(b.volume24hUsd ?? 0) - Number(a.volume24hUsd ?? 0))
      .slice(0, 10);

    const stablecoins = tokenMarketData.filter((d) => d.isStablecoin);
    const depegged = stablecoins.filter((s) => (s.pegDeviation24h ?? 0) > 0.02);
    const stablecoinMcap = stablecoins.reduce((s, sc) => {
      const tp = tokenPrices.find((p) => p.tokenAddress === sc.tokenAddress);
      return s + Number(tp?.marketCapUsd ?? 0);
    }, 0);

    res.json({
      totalMarketCap: `${totalMarketCap.toLocaleString()} USD`,
      totalVolume24h: `${totalVolume24h.toLocaleString()} USD`,
      totalLiquidity: `${totalLiquidity.toLocaleString()} USD`,
      dominance,
      topGainers: topGainers.map((t) => ({
        token: t.tokenAddress,
        symbol: marketDataMap.get(t.tokenAddress)?.symbol ?? 'Unknown',
        change24h: t.priceChange24h,
      })),
      topLosers: topLosers.map((t) => ({
        token: t.tokenAddress,
        symbol: marketDataMap.get(t.tokenAddress)?.symbol ?? 'Unknown',
        change24h: t.priceChange24h,
      })),
      mostActive: mostActive.map((t) => ({
        token: t.tokenAddress,
        symbol: marketDataMap.get(t.tokenAddress)?.symbol ?? 'Unknown',
        volume24h: `${Number(t.volume24hUsd ?? 0).toLocaleString()} USD`,
      })),
      newListings: [],
      stablecoins: {
        totalMcap: `${stablecoinMcap.toLocaleString()}`,
        pegged: stablecoins.length - depegged.length,
        depegged: depegged.length,
      },
      updatedAt: new Date().toISOString(),
    });
  }),
);

marketRouter.get(
  '/tokens',
  asyncHandler(async (req: Request, res: Response) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;

    const tokenPrices = await prismaRead.tokenPrice.findMany({
      orderBy: { volume24hUsd: 'desc' },
      skip: offset,
      take: limit,
    });

    const addresses = tokenPrices.map((t) => t.tokenAddress);
    const contracts = await prismaRead.contract.findMany({
      where: { address: { in: addresses } },
      select: { address: true, tokenSymbol: true, tokenName: true, tokenDecimals: true },
    });
    const contractMap = new Map(contracts.map((c) => [c.address, c]));

    const marketData = await prismaRead.tokenMarketData.findMany({
      where: { tokenAddress: { in: addresses } },
    });
    const marketDataMap = new Map(marketData.map((m) => [m.tokenAddress, m]));

    res.json({
      tokens: tokenPrices.map((tp) => {
        const contract = contractMap.get(tp.tokenAddress);
        const md = marketDataMap.get(tp.tokenAddress);
        return {
          address: tp.tokenAddress,
          symbol: contract?.tokenSymbol ?? md?.symbol ?? null,
          name: contract?.tokenName ?? md?.name ?? null,
          priceUsd: Number(tp.priceUsd),
          priceXlm: Number(tp.priceXlm),
          volume24hUsd: Number(tp.volume24hUsd ?? 0),
          marketCapUsd: Number(tp.marketCapUsd ?? 0),
          liquidityUsd: Number(tp.liquidityUsd ?? 0),
          priceChange1h: tp.priceChange1h,
          priceChange24h: tp.priceChange24h,
          priceChange7d: tp.priceChange7d,
          confidence: tp.confidence,
          source: tp.source,
          holderCount: md?.holderCount ?? 0,
          transferCount24h: md?.transferCount24h ?? 0,
          isStablecoin: md?.isStablecoin ?? false,
          tags: md?.tags ?? [],
        };
      }),
      pagination: { limit, offset, hasMore: tokenPrices.length === limit },
    });
  }),
);

marketRouter.get(
  '/tokens/new',
  asyncHandler(async (req: Request, res: Response) => {
    const querySchema = z.object({
      days: z.coerce.number().min(1).max(30).default(1),
      limit: z.coerce.number().min(1).max(100).default(20),
    });

    const { days, limit } = querySchema.parse(req.query);

    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const newContracts = await prismaRead.contract.findMany({
      where: { isToken: true, createdAt: { gte: cutoff } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { address: true, tokenSymbol: true, tokenName: true, createdAt: true },
    });

    res.json({
      tokens: newContracts.map((c) => ({
        address: c.address,
        symbol: c.tokenSymbol,
        name: c.tokenName,
        listedAt: c.createdAt.toISOString(),
      })),
    });
  }),
);

marketRouter.get(
  '/tokens/trending',
  asyncHandler(async (req: Request, res: Response) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);

    const tokenPrices = await prismaRead.tokenPrice.findMany({
      where: { priceChange24h: { gt: 0 }, volume24hUsd: { gt: 0 } },
      orderBy: { volume24hUsd: 'desc' },
      take: 100,
    });

    const trending = tokenPrices
      .filter((t) => t.priceChange24h != null && t.volume24hUsd != null)
      .map((t) => ({
        address: t.tokenAddress,
        score: (Number(t.volume24hUsd ?? 0) / 1000) * (1 + (t.priceChange24h ?? 0) / 100),
        volume24hUsd: Number(t.volume24hUsd ?? 0),
        priceChange24h: t.priceChange24h,
        priceChange1h: t.priceChange1h,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    const addresses = trending.map((t) => t.address);
    const contracts = await prismaRead.contract.findMany({
      where: { address: { in: addresses } },
      select: { address: true, tokenSymbol: true },
    });
    const symbolMap = new Map(contracts.map((c) => [c.address, c.tokenSymbol]));

    res.json({
      tokens: trending.map((t) => ({
        address: t.address,
        symbol: symbolMap.get(t.address) ?? null,
        score: t.score,
        volume24hUsd: t.volume24hUsd,
        priceChange24h: t.priceChange24h,
        priceChange1h: t.priceChange1h,
      })),
    });
  }),
);

marketRouter.get(
  '/leaderboard',
  asyncHandler(async (req: Request, res: Response) => {
    const querySchema = z.object({
      sort: z.enum(SORT_FIELDS).default('volume'),
      limit: z.coerce.number().min(1).max(100).default(20),
    });

    const { sort, limit } = querySchema.parse(req.query);

    let orderBy: Record<string, 'asc' | 'desc'>;
    switch (sort) {
      case 'market_cap':
        orderBy = { marketCapUsd: 'desc' as const };
        break;
      case 'gainers':
        orderBy = { priceChange24h: 'desc' as const };
        break;
      case 'losers':
        orderBy = { priceChange24h: 'asc' as const };
        break;
      default:
        orderBy = { volume24hUsd: 'desc' as const };
    }

    const tokenPrices = await prismaRead.tokenPrice.findMany({
      orderBy,
      where:
        sort === 'gainers'
          ? { priceChange24h: { gt: 0 } }
          : sort === 'losers'
            ? { priceChange24h: { lt: 0 } }
            : { priceUsd: { gt: 0 } },
      take: limit,
    });

    const addresses = tokenPrices.map((t) => t.tokenAddress);
    const contracts = await prismaRead.contract.findMany({
      where: { address: { in: addresses } },
      select: { address: true, tokenSymbol: true },
    });
    const symbolMap = new Map(contracts.map((c) => [c.address, c.tokenSymbol]));

    res.json({
      sort,
      tokens: tokenPrices.map((tp, idx) => ({
        rank: idx + 1,
        address: tp.tokenAddress,
        symbol: symbolMap.get(tp.tokenAddress) ?? null,
        volume24hUsd: Number(tp.volume24hUsd ?? 0),
        marketCapUsd: Number(tp.marketCapUsd ?? 0),
        priceChange24h: tp.priceChange24h,
        priceUsd: Number(tp.priceUsd),
      })),
    });
  }),
);

marketRouter.get(
  '/tokens/:address/orderbook',
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;

    const pools = await prismaRead.dexPool.findMany({
      where: {
        OR: [{ tokenA: address }, { tokenB: address }],
        isActive: true,
      },
      select: {
        poolAddress: true,
        tokenA: true,
        tokenB: true,
        tokenADecimals: true,
        tokenBDecimals: true,
        reserveA: true,
        reserveB: true,
        feeBps: true,
      },
    });

    const bids: Array<{ price: number; amount: number; total: number }> = [];
    const asks: Array<{ price: number; amount: number; total: number }> = [];

    for (const pool of pools) {
      const isTokenA = pool.tokenA === address;
      const reserveToken = isTokenA
        ? BigInt(pool.reserveA?.toString() ?? '0')
        : BigInt(pool.reserveB?.toString() ?? '0');
      const reserveOther = isTokenA
        ? BigInt(pool.reserveB?.toString() ?? '0')
        : BigInt(pool.reserveA?.toString() ?? '0');
      const decToken = isTokenA ? (pool.tokenADecimals ?? 7) : (pool.tokenBDecimals ?? 7);
      const decOther = isTokenA ? (pool.tokenBDecimals ?? 7) : (pool.tokenADecimals ?? 7);

      if (reserveToken <= 0n || reserveOther <= 0n) continue;

      const amountToken = Number(reserveToken) / 10 ** decToken;
      const amountOther = Number(reserveOther) / 10 ** decOther;
      if (amountToken <= 0) continue;

      const feeFactor = 1 - (pool.feeBps ?? 30) / 10000;
      const price = (amountOther / amountToken) * feeFactor;

      const depthSteps = 10;
      for (let i = 1; i <= depthSteps; i++) {
        const depthPct = (i / depthSteps) * 100;
        const depthAmount = (amountToken * depthPct) / 100;
        const depthPrice = price * (1 + (isTokenA ? -1 : 1) * (depthPct / 100));

        if (isTokenA) {
          bids.push({ price: depthPrice, amount: depthAmount, total: depthAmount * depthPrice });
        } else {
          asks.push({ price: depthPrice, amount: depthAmount, total: depthAmount * depthPrice });
        }
      }
    }

    res.json({
      tokenAddress: address,
      bids: bids.sort((a, b) => b.price - a.price).slice(0, 20),
      asks: asks.sort((a, b) => a.price - b.price).slice(0, 20),
      poolCount: pools.length,
    });
  }),
);

marketRouter.get(
  '/stablecoins',
  asyncHandler(async (_req: Request, res: Response) => {
    const stablecoins = await prismaRead.tokenMarketData.findMany({
      where: { isStablecoin: true },
    });

    const addresses = stablecoins.map((s) => s.tokenAddress);
    const tokenPrices = await prismaRead.tokenPrice.findMany({
      where: { tokenAddress: { in: addresses } },
    });
    const priceMap = new Map(tokenPrices.map((p) => [p.tokenAddress, p]));

    res.json({
      stablecoins: stablecoins.map((s) => {
        const price = priceMap.get(s.tokenAddress);
        const stableInfo = getStablecoinInfo(s.symbol);
        return {
          address: s.tokenAddress,
          symbol: s.symbol,
          peg: s.stablecoinPeg ?? stableInfo?.peg ?? 'USD',
          targetPrice: stableInfo?.targetPrice ?? 1,
          currentPrice: price ? Number(price.priceUsd) : 0,
          deviation: s.pegDeviation24h,
          stabilityScore: s.pegStabilityScore,
          tags: s.tags,
        };
      }),
    });
  }),
);

marketRouter.get(
  '/stablecoins/:address',
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;

    const marketData = await prismaRead.tokenMarketData.findUnique({
      where: { tokenAddress: address },
    });

    if (!marketData || !marketData.isStablecoin) {
      return res.status(404).json({ error: 'Stablecoin not found' });
    }

    const price = await prismaRead.tokenPrice.findUnique({
      where: { tokenAddress: address },
    });

    const history24h = await prismaRead.tokenPriceHistory.findMany({
      where: {
        tokenAddress: address,
        timestamp: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
      },
      orderBy: { timestamp: 'asc' },
      select: { priceUsd: true, timestamp: true },
    });

    const stableInfo = getStablecoinInfo(marketData.symbol);

    res.json({
      address,
      symbol: marketData.symbol,
      peg: marketData.stablecoinPeg ?? stableInfo?.peg ?? 'USD',
      targetPrice: stableInfo?.targetPrice ?? 1,
      currentPrice: price ? Number(price.priceUsd) : 0,
      pegDeviation24h: marketData.pegDeviation24h,
      pegStabilityScore: marketData.pegStabilityScore,
      holderCount: marketData.holderCount,
      transferCount24h: marketData.transferCount24h,
      history: history24h.map((h) => ({
        timestamp: h.timestamp.toISOString(),
        priceUsd: Number(h.priceUsd),
      })),
    });
  }),
);

marketRouter.get(
  '/stablecoins/alerts',
  asyncHandler(async (_req: Request, res: Response) => {
    const stablecoins = await prismaRead.tokenMarketData.findMany({
      where: { isStablecoin: true, pegDeviation24h: { gt: 0.01 } },
      orderBy: { pegDeviation24h: 'desc' },
    });

    res.json({
      alerts: stablecoins.map((s) => ({
        tokenAddress: s.tokenAddress,
        symbol: s.symbol,
        deviation: s.pegDeviation24h,
        stabilityScore: s.pegStabilityScore,
        detectedAt: s.updatedAt.toISOString(),
        severity:
          (s.pegDeviation24h ?? 0) > 0.05
            ? 'critical'
            : (s.pegDeviation24h ?? 0) > 0.02
              ? 'warning'
              : 'info',
      })),
    });
  }),
);

marketRouter.get(
  '/dex/pools',
  asyncHandler(async (req: Request, res: Response) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;

    const pools = await prismaRead.dexPool.findMany({
      where: { isActive: true },
      orderBy: { tvlUsd: 'desc' },
      skip: offset,
      take: limit,
    });

    const total = await prismaRead.dexPool.count({ where: { isActive: true } });

    res.json({
      pools: pools.map((p) => ({
        poolAddress: p.poolAddress,
        contractAddress: p.contractAddress,
        dexName: p.dexName,
        tokenA: p.tokenA,
        tokenB: p.tokenB,
        tokenASymbol: p.tokenASymbol,
        tokenBSymbol: p.tokenBSymbol,
        reserveA: p.reserveA,
        reserveB: p.reserveB,
        tvlUsd: p.tvlUsd,
        volume24hUsd: p.volume24hUsd,
        fees24hUsd: p.fees24hUsd,
        feeBps: p.feeBps,
        aprPct: p.aprPct,
      })),
      total,
      limit,
      offset,
    });
  }),
);

marketRouter.get(
  '/dex/pools/:address',
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;

    const pool = await prismaRead.dexPool.findUnique({
      where: { poolAddress: address },
    });

    if (!pool) return res.status(404).json({ error: 'Pool not found' });

    const swaps = await prismaRead.poolSwap.findMany({
      where: { poolAddress: address },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    res.json({
      pool: {
        poolAddress: pool.poolAddress,
        dexName: pool.dexName,
        tokenA: pool.tokenA,
        tokenB: pool.tokenB,
        tokenASymbol: pool.tokenASymbol,
        tokenBSymbol: pool.tokenBSymbol,
        tokenADecimals: pool.tokenADecimals,
        tokenBDecimals: pool.tokenBDecimals,
        reserveA: pool.reserveA,
        reserveB: pool.reserveB,
        priceAUsd: pool.priceAUsd,
        priceBUsd: pool.priceBUsd,
        tvlUsd: pool.tvlUsd,
        volume24hUsd: pool.volume24hUsd,
        volume7dUsd: pool.volume7dUsd,
        volume30dUsd: pool.volume30dUsd,
        fees24hUsd: pool.fees24hUsd,
        feeBps: pool.feeBps,
        feeTier: pool.feeTier,
        aprPct: pool.aprPct,
        ilRiskScore: pool.ilRiskScore,
        lastSwapAt: pool.lastSyncedAt,
      },
      recentSwaps: swaps.map((s) => ({
        id: s.id,
        timestamp: s.createdAt.toISOString(),
        amountA: s.amountIn,
        amountB: s.amountIn,
      })),
    });
  }),
);

marketRouter.get(
  '/dex/overview',
  asyncHandler(async (_req: Request, res: Response) => {
    const pools = await prismaRead.dexPool.findMany({
      where: { isActive: true },
    });

    const dexMap = new Map<
      string,
      {
        poolCount: number;
        totalVolume24hUsd: number;
        totalLiquidityUsd: number;
        totalFees24hUsd: number;
      }
    >();

    for (const pool of pools) {
      const dex = pool.dexName;
      if (!dexMap.has(dex)) {
        dexMap.set(dex, {
          poolCount: 0,
          totalVolume24hUsd: 0,
          totalLiquidityUsd: 0,
          totalFees24hUsd: 0,
        });
      }
      const d = dexMap.get(dex)!;
      d.poolCount++;
      d.totalVolume24hUsd += Number(pool.volume24hUsd ?? 0);
      d.totalLiquidityUsd += Number(pool.tvlUsd ?? 0);
      d.totalFees24hUsd += Number(pool.fees24hUsd ?? 0);
    }

    const totalVolume = Array.from(dexMap.values()).reduce((s, d) => s + d.totalVolume24hUsd, 0);

    const dexShare = Array.from(dexMap.entries()).map(([name, data]) => ({
      name,
      poolCount: data.poolCount,
      volume24hUsd: data.totalVolume24hUsd,
      liquidityUsd: data.totalLiquidityUsd,
      fees24hUsd: data.totalFees24hUsd,
      marketShare: totalVolume > 0 ? (data.totalVolume24hUsd / totalVolume) * 100 : 0,
    }));

    res.json({
      totalPools: pools.length,
      totalVolume24hUsd: totalVolume,
      totalLiquidityUsd: Array.from(dexMap.values()).reduce((s, d) => s + d.totalLiquidityUsd, 0),
      totalFees24hUsd: Array.from(dexMap.values()).reduce((s, d) => s + d.totalFees24hUsd, 0),
      dexShare,
    });
  }),
);

marketRouter.get(
  '/correlation/:address',
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;

    const token = await prismaRead.contract.findFirst({
      where: { address },
      select: { tokenSymbol: true },
    });

    const crossChainPrices = await getCrossChainPrices(address, token?.tokenSymbol);

    const sorobanPrice = await computeCompositePrice(address, token?.tokenSymbol);

    res.json({
      tokenAddress: address,
      symbol: token?.tokenSymbol ?? null,
      sorobanPrice: {
        usd: sorobanPrice.priceUsd,
        source: sorobanPrice.source,
        confidence: sorobanPrice.confidence,
      },
      crossChain: crossChainPrices,
    });
  }),
);

marketRouter.get(
  '/arbitrage',
  asyncHandler(async (_req: Request, res: Response) => {
    const tokenPrices = await prismaRead.tokenPrice.findMany({
      where: { priceUsd: { gt: 0 } },
      select: { tokenAddress: true, priceUsd: true },
      take: 50,
    });

    const priceMap = new Map<string, { priceUsd: number; symbol?: string | null }>();
    for (const tp of tokenPrices) {
      priceMap.set(tp.tokenAddress, { priceUsd: Number(tp.priceUsd) });
    }

    const contracts = await prismaRead.contract.findMany({
      where: { address: { in: Array.from(priceMap.keys()) } },
      select: { address: true, tokenSymbol: true },
    });
    for (const c of contracts) {
      const p = priceMap.get(c.address);
      if (p) p.symbol = c.tokenSymbol;
    }

    const opportunities = await findArbitrageOpportunities(priceMap);

    res.json({
      opportunities,
      updatedAt: new Date().toISOString(),
    });
  }),
);
