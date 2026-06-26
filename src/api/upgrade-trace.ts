/**
 * Upgrade Trace API Router
 *
 * Tracks Soroban contract upgrade history — wasm hash changes, admin key
 * rotations, version lineage, and upgrade authorization events.
 */
import { Router, Request, Response } from 'express';

export const upgradeTraceRouter = Router();

// ── GET / ─────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /upgrade-trace:
 *   get:
 *     summary: Upgrade trace service overview
 *     tags: [Upgrade Trace]
 *     responses:
 *       200:
 *         description: Service info
 */
upgradeTraceRouter.get('/', (_req: Request, res: Response) => {
  res.json({
    service: 'Upgrade Trace API',
    description: 'Tracks wasm upgrades, admin rotations, and version lineage for Soroban contracts',
    endpoints: [
      'GET  /upgrade-trace',
      'GET  /upgrade-trace/contracts/:contractId',
      'GET  /upgrade-trace/contracts/:contractId/history',
      'GET  /upgrade-trace/contracts/:contractId/diff',
      'GET  /upgrade-trace/recent',
      'GET  /upgrade-trace/stats',
    ],
  });
});

// ── GET /contracts/:contractId ─────────────────────────────────────────────────

/**
 * @swagger
 * /upgrade-trace/contracts/{contractId}:
 *   get:
 *     summary: Get upgrade state for a contract
 *     tags: [Upgrade Trace]
 *     parameters:
 *       - in: path
 *         name: contractId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Contract upgrade info
 */
upgradeTraceRouter.get('/contracts/:contractId', (req: Request, res: Response) => {
  const { contractId } = req.params;

  res.json({
    contractId,
    currentWasmHash: null,
    totalUpgrades: 0,
    firstDeployedAt: null,
    lastUpgradedAt: null,
    adminKey: null,
    upgradeAuthority: null,
    isUpgradeable: null,
    message: 'No upgrade data indexed for this contract.',
  });
});

// ── GET /contracts/:contractId/history ────────────────────────────────────────

/**
 * @swagger
 * /upgrade-trace/contracts/{contractId}/history:
 *   get:
 *     summary: Get full upgrade history for a contract
 *     tags: [Upgrade Trace]
 *     parameters:
 *       - in: path
 *         name: contractId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Contract upgrade history
 */
upgradeTraceRouter.get('/contracts/:contractId/history', (req: Request, res: Response) => {
  const { contractId } = req.params;
  const limit = Math.min(100, parseInt((req.query.limit as string) ?? '20', 10));

  res.json({
    contractId,
    upgrades: [],
    total: 0,
    limit,
    message: 'No upgrade history found.',
  });
});

// ── GET /contracts/:contractId/diff ───────────────────────────────────────────

/**
 * @swagger
 * /upgrade-trace/contracts/{contractId}/diff:
 *   get:
 *     summary: Compare two wasm versions for a contract
 *     tags: [Upgrade Trace]
 *     parameters:
 *       - in: path
 *         name: contractId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: from
 *         schema: { type: string }
 *         description: Previous wasm hash
 *       - in: query
 *         name: to
 *         schema: { type: string }
 *         description: Current wasm hash (defaults to latest)
 *     responses:
 *       200:
 *         description: Wasm diff result
 *       400:
 *         description: Missing from parameter
 */
upgradeTraceRouter.get('/contracts/:contractId/diff', (req: Request, res: Response) => {
  const { contractId } = req.params;
  const from = req.query.from as string | undefined;
  const to = (req.query.to as string | undefined) ?? 'latest';

  if (!from) {
    return res.status(400).json({ error: '"from" wasm hash is required' });
  }

  res.json({
    contractId,
    from,
    to,
    diff: null,
    message: 'Wasm diff unavailable. Both versions must be indexed.',
  });
});

// ── GET /recent ────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /upgrade-trace/recent:
 *   get:
 *     summary: Get recently upgraded contracts
 *     tags: [Upgrade Trace]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: number }
 *     responses:
 *       200:
 *         description: Recent upgrades
 */
upgradeTraceRouter.get('/recent', (req: Request, res: Response) => {
  const limit = Math.min(50, parseInt((req.query.limit as string) ?? '10', 10));

  res.json({
    recentUpgrades: [],
    total: 0,
    limit,
    message: 'No recent upgrades found.',
    fetchedAt: new Date().toISOString(),
  });
});

// ── GET /stats ─────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /upgrade-trace/stats:
 *   get:
 *     summary: Get aggregate upgrade statistics
 *     tags: [Upgrade Trace]
 *     responses:
 *       200:
 *         description: Upgrade statistics
 */
upgradeTraceRouter.get('/stats', (_req: Request, res: Response) => {
  res.json({
    totalContractsTracked: 0,
    totalUpgradesIndexed: 0,
    upgradesLast24h: 0,
    upgradesLast7d: 0,
    mostUpgraded: null,
    avgDaysBetweenUpgrades: null,
    computedAt: new Date().toISOString(),
  });
});
