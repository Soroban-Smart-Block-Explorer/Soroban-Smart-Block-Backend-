import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  listBridgedAssets,
  getBridgeAssetDetail,
  listBridgeProtocols,
  getBridgeVolumeHistory,
} from '../../stellar/bridge-service';

export const bridgeRouter = Router();

// GET /api/v1/stellar/bridge/assets
bridgeRouter.get('/assets', async (_req: Request, res: Response) => {
  try {
    const data = await listBridgedAssets();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/v1/stellar/bridge/assets/:assetCode
bridgeRouter.get('/assets/:assetCode', async (req: Request, res: Response) => {
  try {
    const data = await getBridgeAssetDetail(req.params.assetCode);
    if (!data) return res.status(404).json({ error: 'Bridged asset not found' });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/v1/stellar/bridge/protocols
bridgeRouter.get('/protocols', async (_req: Request, res: Response) => {
  try {
    const data = await listBridgeProtocols();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/v1/stellar/bridge/volume-history
bridgeRouter.get('/volume-history', async (req: Request, res: Response) => {
  try {
    const days = z.coerce.number().min(1).max(365).default(30).parse(req.query.days);
    const data = await getBridgeVolumeHistory(days);
    res.json(data);
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});
