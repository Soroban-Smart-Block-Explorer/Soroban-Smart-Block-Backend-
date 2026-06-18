import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  listAssets,
  getAssetDetail,
  getAssetHolders,
  getAssetOrderbook,
  getAssetPriceHistory,
  getTopAssets,
} from '../../stellar/asset-service';

export const classicAssetsRouter = Router();

function parseAssetParam(param: string): { code: string; issuer: string } | null {
  const parts = param.split('-');
  if (parts.length < 2) return null;
  return { code: parts[0], issuer: parts.slice(1).join('-') };
}

// GET /api/v1/stellar/assets
classicAssetsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const data = await listAssets({
      code: req.query.code as string | undefined,
      issuer: req.query.issuer as string | undefined,
      anchored: req.query.anchored === 'true',
      bridged: req.query.bridged === 'true',
      sort: (req.query.sort as 'volume' | 'holders' | 'marketCap') ?? 'volume',
      limit: z.coerce.number().min(1).max(200).default(50).parse(req.query.limit),
    });
    res.json(data);
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// GET /api/v1/stellar/assets/top
classicAssetsRouter.get('/top', async (req: Request, res: Response) => {
  try {
    const by = (req.query.by as 'volume' | 'holders' | 'marketCap') ?? 'volume';
    const limit = z.coerce.number().min(1).max(50).default(10).parse(req.query.limit);
    const data = await getTopAssets(by, limit);
    res.json(data);
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// GET /api/v1/stellar/assets/:code-:issuer
classicAssetsRouter.get('/:assetId', async (req: Request, res: Response) => {
  try {
    const parsed = parseAssetParam(req.params.assetId);
    if (!parsed) return res.status(400).json({ error: 'Invalid asset format. Use :code-:issuer' });

    const detail = await getAssetDetail(parsed.code, parsed.issuer);
    if (!detail) return res.status(404).json({ error: 'Asset not found' });
    res.json(detail);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/v1/stellar/assets/:code-:issuer/holders
classicAssetsRouter.get('/:assetId/holders', async (req: Request, res: Response) => {
  try {
    const parsed = parseAssetParam(req.params.assetId);
    if (!parsed) return res.status(400).json({ error: 'Invalid asset format' });
    const limit = z.coerce.number().min(1).max(100).default(20).parse(req.query.limit);
    const data = await getAssetHolders(parsed.code, parsed.issuer, limit);
    res.json(data);
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// GET /api/v1/stellar/assets/:code-:issuer/orderbook
classicAssetsRouter.get('/:assetId/orderbook', async (req: Request, res: Response) => {
  try {
    const parsed = parseAssetParam(req.params.assetId);
    if (!parsed) return res.status(400).json({ error: 'Invalid asset format' });
    const data = await getAssetOrderbook(parsed.code, parsed.issuer);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/v1/stellar/assets/:code-:issuer/price-history
classicAssetsRouter.get('/:assetId/price-history', async (req: Request, res: Response) => {
  try {
    const parsed = parseAssetParam(req.params.assetId);
    if (!parsed) return res.status(400).json({ error: 'Invalid asset format' });
    const days = z.coerce.number().min(1).max(365).default(30).parse(req.query.days);
    const data = await getAssetPriceHistory(parsed.code, parsed.issuer, days);
    res.json({ history: data });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});
