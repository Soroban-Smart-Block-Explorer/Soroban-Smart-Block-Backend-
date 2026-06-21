/**
 * GET /api/v1/sync-state
 *
 * Returns the DB's max synced ledger vs the live network tip so the frontend
 * can display a "Syncing… (99.9%)" banner when the indexer lags behind.
 */

import { Router, Request, Response } from 'express';
import { prismaRead as prisma } from '../db';
import { getLatestLedger } from '../indexer/rpc';

export const syncStateRouter = Router();

export async function getSyncState(): Promise<{
  dbLedger: number;
  networkLedger: number;
  syncPercent: number;
  isSynced: boolean;
}> {
  const [agg, networkLedger] = await Promise.all([
    prisma.ledger.aggregate({ _max: { sequence: true } }),
    getLatestLedger(),
  ]);

  const dbLedger = agg._max.sequence ?? 0;
  const syncPercent = networkLedger > 0 ? Math.min(100, (dbLedger / networkLedger) * 100) : 100;

  return {
    dbLedger,
    networkLedger,
    syncPercent: Math.round(syncPercent * 10) / 10,
    isSynced: dbLedger >= networkLedger,
  };
}

syncStateRouter.get('/', async (_req: Request, res: Response) => {
  try {
    res.json(await getSyncState());
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});
