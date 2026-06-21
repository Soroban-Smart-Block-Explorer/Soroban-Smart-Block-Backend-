/**
 * Storage API Router
 *
 * Soroban contract persistent storage management. Provides read/write access
 * to contract storage entries, entry size analytics, and storage usage
 * reporting across the network.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';

export const storageRouter = Router();

// ── GET / ─────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /storage:
 *   get:
 *     summary: Storage service overview
 *     tags: [Storage]
 *     responses:
 *       200:
 *         description: Service info
 */
storageRouter.get('/', (_req: Request, res: Response) => {
  res.json({
    service: 'Storage API',
    description: 'Soroban contract persistent storage management and analysis',
    entryTypes: ['persistent', 'temporary', 'instance'],
    endpoints: [
      'GET  /storage',
      'GET  /storage/contracts/:contractId',
      'GET  /storage/contracts/:contractId/entries',
      'GET  /storage/contracts/:contractId/entries/:key',
      'GET  /storage/contracts/:contractId/size',
      'GET  /storage/network/stats',
      'GET  /storage/network/top-users',
    ],
  });
});

// ── GET /contracts/:contractId ─────────────────────────────────────────────────

/**
 * @swagger
 * /storage/contracts/{contractId}:
 *   get:
 *     summary: Get storage overview for a contract
 *     tags: [Storage]
 *     parameters:
 *       - in: path
 *         name: contractId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Contract storage overview
 */
storageRouter.get('/contracts/:contractId', (req: Request, res: Response) => {
  const { contractId } = req.params;

  res.json({
    contractId,
    storageEntries: {
      persistent: { count: 0, totalBytes: 0 },
      temporary: { count: 0, totalBytes: 0 },
      instance: { count: 0, totalBytes: 0 },
    },
    totalEntries: 0,
    totalBytes: 0,
    message: 'No storage data indexed for this contract.',
  });
});

// ── GET /contracts/:contractId/entries ─────────────────────────────────────────

/**
 * @swagger
 * /storage/contracts/{contractId}/entries:
 *   get:
 *     summary: List storage entries for a contract
 *     tags: [Storage]
 *     parameters:
 *       - in: path
 *         name: contractId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: type
 *         schema: { type: string, enum: [persistent, temporary, instance, all] }
 *       - in: query
 *         name: limit
 *         schema: { type: number }
 *     responses:
 *       200:
 *         description: Storage entries
 */
storageRouter.get('/contracts/:contractId/entries', (req: Request, res: Response) => {
  const { contractId } = req.params;
  const type = (req.query.type as string) ?? 'all';
  const limit = Math.min(200, parseInt((req.query.limit as string) ?? '50', 10));

  res.json({
    contractId,
    filter: { type },
    entries: [],
    total: 0,
    limit,
    message: 'No storage entries found.',
  });
});

// ── GET /contracts/:contractId/entries/:key ────────────────────────────────────

/**
 * @swagger
 * /storage/contracts/{contractId}/entries/{key}:
 *   get:
 *     summary: Get a specific storage entry by key
 *     tags: [Storage]
 *     parameters:
 *       - in: path
 *         name: contractId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: key
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Storage entry
 *       404:
 *         description: Entry not found
 */
storageRouter.get('/contracts/:contractId/entries/:key', (req: Request, res: Response) => {
  const { contractId, key } = req.params;

  res.status(404).json({
    contractId,
    key,
    error: 'Storage entry not found or not yet indexed.',
  });
});

// ── GET /contracts/:contractId/size ────────────────────────────────────────────

/**
 * @swagger
 * /storage/contracts/{contractId}/size:
 *   get:
 *     summary: Get total storage size for a contract
 *     tags: [Storage]
 *     parameters:
 *       - in: path
 *         name: contractId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Storage size
 */
storageRouter.get('/contracts/:contractId/size', (req: Request, res: Response) => {
  const { contractId } = req.params;

  res.json({
    contractId,
    totalBytes: 0,
    persistentBytes: 0,
    temporaryBytes: 0,
    instanceBytes: 0,
    estimatedRentFeeXLM: 0,
    message: 'No storage data available.',
  });
});

// ── GET /network/stats ─────────────────────────────────────────────────────────

/**
 * @swagger
 * /storage/network/stats:
 *   get:
 *     summary: Get network-wide storage statistics
 *     tags: [Storage]
 *     responses:
 *       200:
 *         description: Network storage stats
 */
storageRouter.get('/network/stats', (_req: Request, res: Response) => {
  res.json({
    totalContracts: 0,
    totalEntries: 0,
    totalBytes: 0,
    persistentBytes: 0,
    temporaryBytes: 0,
    avgBytesPerContract: 0,
    totalRentFeesXLM: 0,
    computedAt: new Date().toISOString(),
  });
});

// ── GET /network/top-users ─────────────────────────────────────────────────────

/**
 * @swagger
 * /storage/network/top-users:
 *   get:
 *     summary: Get contracts with highest storage usage
 *     tags: [Storage]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: number }
 *     responses:
 *       200:
 *         description: Top storage users
 */
storageRouter.get('/network/top-users', (req: Request, res: Response) => {
  const limit = Math.min(50, parseInt((req.query.limit as string) ?? '10', 10));

  res.json({
    topUsers: [],
    total: 0,
    limit,
    sortedBy: 'totalBytes',
    computedAt: new Date().toISOString(),
  });
});
