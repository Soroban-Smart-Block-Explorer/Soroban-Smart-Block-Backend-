import { Router } from 'express';
import { prisma } from '../db';

const router = Router();

// GET /api/v1/market/tokens - All tracked tokens with current price
router.get('/tokens', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;
    const sortBy = (req.query.sortBy as string) || 'volume24h';
    const order = (req.query.order as string) === 'asc' ? 'asc' : 'desc';

    // Get latest snapshots for each token
    const tokens = await prisma.marketDataSnapshot.findMany({
      distinct: ['tokenAddress'],
      orderBy: { timestamp: 'desc' },
      skip: offset,
      take: limit,
    });

    // Sort by requested field
    tokens.sort((a, b) => {
      const aVal = a[sortBy as keyof typeof a] || 0;
      const bVal = b[sortBy as keyof typeof b] || 0;
      return order === 'asc' ? (aVal > bVal ? 1 : -1) : aVal < bVal ? 1 : -1;
    });

    res.json({
      tokens: tokens.map((token) => ({
        address: token.tokenAddress,
        symbol: token.tokenSymbol,
        priceUsd: token.priceUsd,
        volume24h: token.volume24h?.toString(),
        tvl: token.tvl?.toString(),
        liquidity: token.liquidity?.toString(),
        priceChange1h: token.priceChange1h,
        priceChange24h: token.priceChange24h,
        trades24h: token.trades24h,
        uniqueTraders24h: token.uniqueTraders24h,
        lastUpdated: token.timestamp,
      })),
      pagination: {
        limit,
        offset,
        hasMore: tokens.length === limit,
      },
    });
  } catch (error) {
    console.error('Failed to fetch tokens:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/v1/market/tokens/:address - Token market data with history
router.get('/tokens/:address', async (req, res) => {
  try {
    const { address } = req.params;
    const days = Math.min(parseInt(req.query.days as string) || 7, 365);

    // Get latest snapshot
    const latestSnapshot = await prisma.marketDataSnapshot.findFirst({
      where: { tokenAddress: address },
      orderBy: { timestamp: 'desc' },
    });

    if (!latestSnapshot) {
      return res.status(404).json({ error: 'Token not found' });
    }

    // Get historical data
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const history = await prisma.marketDataSnapshot.findMany({
      where: {
        tokenAddress: address,
        timestamp: { gte: startDate },
      },
      orderBy: { timestamp: 'asc' },
    });

    // Calculate statistics
    const prices = history.map((h) => h.priceUsd).filter((p) => p !== null) as number[];
    const volumes = history.map((h) => parseFloat(h.volume24h?.toString() || '0'));

    const stats = {
      minPrice: Math.min(...prices),
      maxPrice: Math.max(...prices),
      avgPrice: prices.reduce((a, b) => a + b, 0) / prices.length,
      totalVolume: volumes.reduce((a, b) => a + b, 0),
      volatility: calculateVolatility(prices),
    };

    res.json({
      token: {
        address: latestSnapshot.tokenAddress,
        symbol: latestSnapshot.tokenSymbol,
        currentPrice: latestSnapshot.priceUsd,
        volume24h: latestSnapshot.volume24h?.toString(),
        tvl: latestSnapshot.tvl?.toString(),
        liquidity: latestSnapshot.liquidity?.toString(),
        priceChange1h: latestSnapshot.priceChange1h,
        priceChange24h: latestSnapshot.priceChange24h,
        trades24h: latestSnapshot.trades24h,
        uniqueTraders24h: latestSnapshot.uniqueTraders24h,
      },
      statistics: stats,
      history: history.map((h) => ({
        timestamp: h.timestamp,
        priceUsd: h.priceUsd,
        volume24h: h.volume24h?.toString(),
        trades24h: h.trades24h,
      })),
    });
  } catch (error) {
    console.error('Failed to fetch token data:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/v1/market/tokens/:address/price-history - Price history with granularity
router.get('/tokens/:address/price-history', async (req, res) => {
  try {
    const { address } = req.params;
    const granularity = (req.query.granularity as string) || '1h';
    const from = req.query.from
      ? new Date(req.query.from as string)
      : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const to = req.query.to ? new Date(req.query.to as string) : new Date();

    // Get price data in the specified range
    const priceData = await prisma.marketDataSnapshot.findMany({
      where: {
        tokenAddress: address,
        timestamp: {
          gte: from,
          lte: to,
        },
      },
      orderBy: { timestamp: 'asc' },
      select: {
        timestamp: true,
        priceUsd: true,
        volume24h: true,
      },
    });

    // Group by granularity (simplified - real implementation would use proper time buckets)
    const bucketSize = getGranularityMs(granularity);
    const buckets = new Map<number, { prices: number[]; volumes: number[]; count: number }>();

    for (const data of priceData) {
      if (data.priceUsd === null) continue;

      const bucketKey = Math.floor(data.timestamp.getTime() / bucketSize) * bucketSize;

      if (!buckets.has(bucketKey)) {
        buckets.set(bucketKey, { prices: [], volumes: [], count: 0 });
      }

      const bucket = buckets.get(bucketKey)!;
      bucket.prices.push(data.priceUsd);
      bucket.volumes.push(parseFloat(data.volume24h?.toString() || '0'));
      bucket.count++;
    }

    const result = Array.from(buckets.entries()).map(([timestamp, bucket]) => ({
      timestamp: new Date(timestamp),
      open: bucket.prices[0],
      high: Math.max(...bucket.prices),
      low: Math.min(...bucket.prices),
      close: bucket.prices[bucket.prices.length - 1],
      volume: bucket.volumes.reduce((a, b) => a + b, 0) / bucket.count,
    }));

    res.json({
      address,
      granularity,
      from,
      to,
      dataPoints: result.length,
      data: result,
    });
  } catch (error) {
    console.error('Failed to fetch price history:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/v1/market/tokens/:address/ohlc - OHLC candlestick data
router.get('/tokens/:address/ohlc', async (req, res) => {
  try {
    // This would be similar to price-history but formatted as proper OHLC
    const { address } = req.params;
    const granularity = (req.query.granularity as string) || '1h';
    const from = req.query.from
      ? new Date(req.query.from as string)
      : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const to = req.query.to ? new Date(req.query.to as string) : new Date();

    // Mock OHLC data (real implementation would compute from actual trade data)
    const mockOHLC = generateMockOHLC(from, to, granularity);

    res.json({
      address,
      granularity,
      from,
      to,
      candlesticks: mockOHLC,
    });
  } catch (error) {
    console.error('Failed to fetch OHLC data:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/v1/market/overview - Market overview dashboard data
router.get('/overview', async (req, res) => {
  try {
    // Get current metrics
    const totalTokens = await prisma.marketDataSnapshot.groupBy({
      by: ['tokenAddress'],
      _count: true,
    });

    // Get recent derived metrics
    const recentMetrics = await prisma.derivedMetric.findMany({
      where: {
        name: {
          in: ['total_value_locked', 'daily_volume', 'active_accounts', 'total_transactions'],
        },
        timestamp: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
      orderBy: { timestamp: 'desc' },
      take: 4,
    });

    const metricsMap = recentMetrics.reduce(
      (acc, metric) => {
        acc[metric.name] = metric.value;
        return acc;
      },
      {} as Record<string, number>,
    );

    // Get top tokens by volume
    const topTokens = await prisma.marketDataSnapshot.findMany({
      distinct: ['tokenAddress'],
      orderBy: { volume24h: 'desc' },
      take: 10,
      select: {
        tokenAddress: true,
        tokenSymbol: true,
        priceUsd: true,
        volume24h: true,
        priceChange24h: true,
      },
    });

    res.json({
      overview: {
        totalTokens: totalTokens.length,
        totalValueLocked: metricsMap.total_value_locked || 0,
        dailyVolume: metricsMap.daily_volume || 0,
        activeAccounts: metricsMap.active_accounts || 0,
        totalTransactions: metricsMap.total_transactions || 0,
      },
      topTokensByVolume: topTokens.map((token) => ({
        address: token.tokenAddress,
        symbol: token.tokenSymbol,
        priceUsd: token.priceUsd,
        volume24h: token.volume24h?.toString(),
        priceChange24h: token.priceChange24h,
      })),
      lastUpdated: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Failed to fetch market overview:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

function calculateVolatility(prices: number[]): number {
  if (prices.length < 2) return 0;

  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
  }

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;

  return Math.sqrt(variance);
}

function getGranularityMs(granularity: string): number {
  const granularityMap: Record<string, number> = {
    '1m': 60 * 1000,
    '5m': 5 * 60 * 1000,
    '15m': 15 * 60 * 1000,
    '1h': 60 * 60 * 1000,
    '4h': 4 * 60 * 60 * 1000,
    '1d': 24 * 60 * 60 * 1000,
  };
  return granularityMap[granularity] || granularityMap['1h'];
}

function generateMockOHLC(from: Date, to: Date, granularity: string) {
  const bucketSize = getGranularityMs(granularity);
  const buckets = [];
  let basePrice = 100 + Math.random() * 50; // Start around $100-150

  for (let time = from.getTime(); time < to.getTime(); time += bucketSize) {
    const volatility = 0.02; // 2% volatility
    const change = (Math.random() - 0.5) * volatility;

    const open = basePrice;
    const close = basePrice * (1 + change);
    const high = Math.max(open, close) * (1 + Math.random() * 0.01);
    const low = Math.min(open, close) * (1 - Math.random() * 0.01);
    const volume = 1000000 + Math.random() * 5000000;

    buckets.push({
      timestamp: new Date(time),
      open: Math.round(open * 10000) / 10000,
      high: Math.round(high * 10000) / 10000,
      low: Math.round(low * 10000) / 10000,
      close: Math.round(close * 10000) / 10000,
      volume: Math.round(volume),
    });

    basePrice = close;
  }

  return buckets;
}

export default router;
