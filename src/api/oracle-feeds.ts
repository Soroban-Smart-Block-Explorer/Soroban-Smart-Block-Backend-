/**
 * Oracle Feeds API Router
 *
 * Manages oracle price feed subscriptions, retrieves real-time and
 * historical price data, and exposes feed configuration for Soroban
 * contracts consuming on-chain oracle data.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';

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
oracleFeedsRouter.get('/assets/:assetPair/price', (req: Request, res: Response) => {
  const assetPair = req.params.assetPair.toUpperCase().replace('-', '/');
  const supported = ['XLM/USD', 'BTC/USD', 'ETH/USD', 'USDC/USD'];

  if (!supported.includes(assetPair)) {
    return res
      .status(404)
      .json({ error: `Asset pair ${assetPair} not supported. Supported: ${supported.join(', ')}` });
  }

  const mockPrices: Record<string, number> = {
    'XLM/USD': 0.12,
    'BTC/USD': 65000,
    'ETH/USD': 3500,
    'USDC/USD': 1.0,
  };

  res.json({
    pair: assetPair,
    price: mockPrices[assetPair],
    currency: 'USD',
    source: 'aggregated',
    confidence: 0.99,
    timestamp: new Date().toISOString(),
    note: 'Demo price. Connect oracle providers for live data.',
  });
});

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
