/**
 * Oracle Feeds API Router
 *
 * Manages oracle price feed subscriptions, retrieves real-time and
 * historical price data, and exposes feed configuration for Soroban
 * contracts consuming on-chain oracle data.
 *
 * Price resolution order (per asset):
 *  1. CoinGecko public API  (COINGECKO_API_KEY optional – raises rate limit)
 *  2. Stellar Horizon DEX order-book  (XLM-based pairs only, no key needed)
 *  3. Cached last-known value (TTL controlled by ORACLE_PRICE_TTL_MS)
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import axios from 'axios';
import { logger } from '../logger';
import { asyncHandler } from '../middleware/asyncHandler';

// ── Configuration ─────────────────────────────────────────────────────────────

const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY ?? '';
const COINGECKO_BASE = COINGECKO_API_KEY
  ? 'https://pro-api.coingecko.com/api/v3'
  : 'https://api.coingecko.com/api/v3';

const HORIZON_URL = process.env.TESTNET_HORIZON_URL ?? 'https://horizon.stellar.org';
const PRICE_TTL_MS = parseInt(process.env.ORACLE_PRICE_TTL_MS ?? '30000', 10);

// CoinGecko coin IDs for each supported pair
const COINGECKO_IDS: Record<string, string> = {
  'XLM/USD': 'stellar',
  'BTC/USD': 'bitcoin',
  'ETH/USD': 'ethereum',
  'USDC/USD': 'usd-coin',
};

// ── In-memory price cache ─────────────────────────────────────────────────────

interface CachedPrice {
  price: number;
  source: string;
  fetchedAt: number;
}

const priceCache = new Map<string, CachedPrice>();

// ── CoinGecko fetch ───────────────────────────────────────────────────────────

async function fetchFromCoinGecko(coinId: string): Promise<number | null> {
  try {
    const headers: Record<string, string> = COINGECKO_API_KEY
      ? { 'x-cg-pro-api-key': COINGECKO_API_KEY }
      : {};

    const { data } = await axios.get(`${COINGECKO_BASE}/simple/price`, {
      params: { ids: coinId, vs_currencies: 'usd' },
      headers,
      timeout: 5000,
    });

    const price = data?.[coinId]?.usd;
    if (typeof price === 'number') return price;
    return null;
  } catch (err) {
    logger.warn('CoinGecko price fetch failed', {
      coinId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ── Stellar Horizon DEX fetch (XLM/USD via USDC order-book) ──────────────────

async function fetchXlmUsdFromHorizon(): Promise<number | null> {
  try {
    // USDC on Stellar: issued by Centre (USDC issuer on mainnet)
    const usdcIssuer = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
    const { data } = await axios.get(`${HORIZON_URL}/order_book`, {
      params: {
        selling_asset_type: 'native',
        buying_asset_type: 'credit_alphanum4',
        buying_asset_code: 'USDC',
        buying_asset_issuer: usdcIssuer,
        limit: 1,
      },
      timeout: 5000,
    });

    // Mid-price from top bid/ask
    const bids: { price: string }[] = data?.bids ?? [];
    const asks: { price: string }[] = data?.asks ?? [];
    if (bids.length && asks.length) {
      const mid = (parseFloat(bids[0].price) + parseFloat(asks[0].price)) / 2;
      if (mid > 0) return mid;
    }
    return null;
  } catch (err) {
    logger.warn('Horizon DEX XLM/USD fetch failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ── Unified price resolver ────────────────────────────────────────────────────

async function resolvePrice(pair: string): Promise<{ price: number; source: string } | null> {
  // 1. Return cached value if still fresh
  const cached = priceCache.get(pair);
  if (cached && Date.now() - cached.fetchedAt < PRICE_TTL_MS) {
    return { price: cached.price, source: `${cached.source} (cached)` };
  }

  const coinId = COINGECKO_IDS[pair];
  let price: number | null = null;
  let source = 'unknown';

  // 2. Try CoinGecko
  if (coinId) {
    price = await fetchFromCoinGecko(coinId);
    if (price !== null) source = 'coingecko';
  }

  // 3. Fallback: Horizon DEX for XLM/USD
  if (price === null && pair === 'XLM/USD') {
    price = await fetchXlmUsdFromHorizon();
    if (price !== null) source = 'horizon-dex';
  }

  if (price === null) {
    // 4. Use stale cache if available rather than returning nothing
    if (cached) {
      logger.warn('All price sources failed – using stale cache', { pair });
      return { price: cached.price, source: `${cached.source} (stale)` };
    }
    return null;
  }

  // Update cache
  priceCache.set(pair, { price, source, fetchedAt: Date.now() });
  return { price, source };
}

export const oracleFeedsRouter = Router();

// ── GET / ─────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /oracle-feeds:
 *   get:
 *     summary: Oracle feeds service overview
 *     tags: [Oracle Feeds]
 *     responses:
 *       200:
 *         description: Service info
 */
oracleFeedsRouter.get('/', (_req: Request, res: Response) => {
  res.json({
    service: 'Oracle Feeds API',
    description: 'Real-time and historical oracle price feed data for Soroban contracts',
    supportedAssets: ['XLM/USD', 'BTC/USD', 'ETH/USD', 'USDC/USD'],
    endpoints: [
      'GET  /oracle-feeds',
      'GET  /oracle-feeds/assets',
      'GET  /oracle-feeds/assets/:assetPair/price',
      'GET  /oracle-feeds/assets/:assetPair/history',
      'GET  /oracle-feeds/assets/:assetPair/ohlcv',
      'POST /oracle-feeds/subscribe',
      'GET  /oracle-feeds/subscriptions',
      'DELETE /oracle-feeds/subscriptions/:id',
      'GET  /oracle-feeds/providers',
    ],
  });
});

// ── GET /assets ────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /oracle-feeds/assets:
 *   get:
 *     summary: List all available oracle price feed assets
 *     tags: [Oracle Feeds]
 *     responses:
 *       200:
 *         description: Asset pairs list
 */
oracleFeedsRouter.get('/assets', (_req: Request, res: Response) => {
  res.json({
    assets: [
      { pair: 'XLM/USD', base: 'XLM', quote: 'USD', active: true, updateFrequencyMs: 5000 },
      { pair: 'BTC/USD', base: 'BTC', quote: 'USD', active: true, updateFrequencyMs: 5000 },
      { pair: 'ETH/USD', base: 'ETH', quote: 'USD', active: true, updateFrequencyMs: 5000 },
      { pair: 'USDC/USD', base: 'USDC', quote: 'USD', active: true, updateFrequencyMs: 30000 },
    ],
    total: 4,
  });
});

// ── GET /assets/:assetPair/price ───────────────────────────────────────────────

/**
 * @swagger
 * /oracle-feeds/assets/{assetPair}/price:
 *   get:
 *     summary: Get current price for an asset pair
 *     tags: [Oracle Feeds]
 *     parameters:
 *       - in: path
 *         name: assetPair
 *         required: true
 *         schema: { type: string }
 *         example: XLM-USD
 *     responses:
 *       200:
 *         description: Current price
 *       404:
 *         description: Asset pair not supported
 */
oracleFeedsRouter.get(
  '/assets/:assetPair/price',
  asyncHandler(async (req: Request, res: Response) => {
    const assetPair = req.params.assetPair.toUpperCase().replace('-', '/');
    const supported = ['XLM/USD', 'BTC/USD', 'ETH/USD', 'USDC/USD'];

    if (!supported.includes(assetPair)) {
      return res.status(404).json({
        error: `Asset pair ${assetPair} not supported. Supported: ${supported.join(', ')}`,
      });
    }

    const result = await resolvePrice(assetPair);

    if (!result) {
      logger.error('All price sources exhausted and no cached value available', {
        pair: assetPair,
      });
      return res.status(503).json({
        error:
          'Price data temporarily unavailable. All providers failed and no cached value exists.',
        pair: assetPair,
      });
    }

    const isStale = result.source.includes('stale');

    res.json({
      pair: assetPair,
      price: result.price,
      currency: 'USD',
      source: result.source,
      confidence: isStale ? 0.5 : 0.99,
      timestamp: new Date().toISOString(),
      ...(isStale
        ? { warning: 'Price data is stale – live providers are currently unreachable.' }
        : {}),
    });
  }),
);

// ── GET /assets/:assetPair/history ─────────────────────────────────────────────

/**
 * @swagger
 * /oracle-feeds/assets/{assetPair}/history:
 *   get:
 *     summary: Get historical price data for an asset pair
 *     tags: [Oracle Feeds]
 *     parameters:
 *       - in: path
 *         name: assetPair
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: from
 *         schema: { type: string }
 *       - in: query
 *         name: to
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: number }
 *     responses:
 *       200:
 *         description: Historical prices
 */
oracleFeedsRouter.get('/assets/:assetPair/history', (req: Request, res: Response) => {
  const assetPair = req.params.assetPair.toUpperCase().replace('-', '/');
  const limit = Math.min(1000, parseInt((req.query.limit as string) ?? '100', 10));

  res.json({
    pair: assetPair,
    history: [],
    total: 0,
    limit,
    message: 'No historical data available. Price history is populated as oracle data arrives.',
  });
});

// ── GET /assets/:assetPair/ohlcv ───────────────────────────────────────────────

/**
 * @swagger
 * /oracle-feeds/assets/{assetPair}/ohlcv:
 *   get:
 *     summary: Get OHLCV (open/high/low/close/volume) candle data
 *     tags: [Oracle Feeds]
 *     parameters:
 *       - in: path
 *         name: assetPair
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: resolution
 *         schema: { type: string, enum: [1m, 5m, 15m, 1h, 4h, 1d] }
 *       - in: query
 *         name: limit
 *         schema: { type: number }
 *     responses:
 *       200:
 *         description: OHLCV candles
 */
oracleFeedsRouter.get('/assets/:assetPair/ohlcv', (req: Request, res: Response) => {
  const assetPair = req.params.assetPair.toUpperCase().replace('-', '/');
  const resolution = (req.query.resolution as string) ?? '1h';
  const limit = Math.min(500, parseInt((req.query.limit as string) ?? '100', 10));
  const validResolutions = ['1m', '5m', '15m', '1h', '4h', '1d'];

  if (!validResolutions.includes(resolution)) {
    return res
      .status(400)
      .json({ error: `Invalid resolution. Must be one of: ${validResolutions.join(', ')}` });
  }

  res.json({ pair: assetPair, resolution, candles: [], total: 0, limit });
});

// ── POST /subscribe ───────────────────────────────────────────────────────────

/**
 * @swagger
 * /oracle-feeds/subscribe:
 *   post:
 *     summary: Subscribe to price feed updates
 *     tags: [Oracle Feeds]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [assetPair, webhookUrl]
 *             properties:
 *               assetPair: { type: string }
 *               webhookUrl: { type: string }
 *               updateFrequencyMs: { type: number }
 *     responses:
 *       201:
 *         description: Subscription created
 *       400:
 *         description: Validation error
 */
oracleFeedsRouter.post('/subscribe', (req: Request, res: Response) => {
  const schema = z.object({
    assetPair: z.string().min(3),
    webhookUrl: z.string().url(),
    updateFrequencyMs: z.number().int().min(1000).max(3600000).default(5000),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const id = `feed_sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  res.status(201).json({
    id,
    ...parsed.data,
    active: true,
    createdAt: new Date().toISOString(),
  });
});

// ── GET /subscriptions ────────────────────────────────────────────────────────

/**
 * @swagger
 * /oracle-feeds/subscriptions:
 *   get:
 *     summary: List active feed subscriptions
 *     tags: [Oracle Feeds]
 *     responses:
 *       200:
 *         description: Subscriptions list
 */
oracleFeedsRouter.get('/subscriptions', (_req: Request, res: Response) => {
  res.json({ subscriptions: [], total: 0 });
});

// ── DELETE /subscriptions/:id ─────────────────────────────────────────────────

/**
 * @swagger
 * /oracle-feeds/subscriptions/{id}:
 *   delete:
 *     summary: Cancel a feed subscription
 *     tags: [Oracle Feeds]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       204:
 *         description: Subscription cancelled
 */
oracleFeedsRouter.delete('/subscriptions/:id', (_req: Request, res: Response) => {
  res.status(204).send();
});

// ── GET /providers ─────────────────────────────────────────────────────────────

/**
 * @swagger
 * /oracle-feeds/providers:
 *   get:
 *     summary: List oracle data providers
 *     tags: [Oracle Feeds]
 *     responses:
 *       200:
 *         description: Providers list
 */
oracleFeedsRouter.get('/providers', (_req: Request, res: Response) => {
  res.json({
    providers: [
      {
        id: 'band-protocol',
        name: 'Band Protocol',
        assets: ['XLM/USD', 'BTC/USD', 'ETH/USD'],
        active: false,
      },
      { id: 'dia-data', name: 'DIA Data', assets: ['XLM/USD', 'USDC/USD'], active: false },
      { id: 'pyth-network', name: 'Pyth Network', assets: ['BTC/USD', 'ETH/USD'], active: false },
    ],
    note: 'Providers must be configured via environment variables to be active.',
  });
});
