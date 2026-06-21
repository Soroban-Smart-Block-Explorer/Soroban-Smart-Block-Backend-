/**
 * Protocol 26 State Extension API Router
 *
 * Handles Stellar Protocol 26 features including state archival, contract
 * instance TTL management, persistent/temporary entry management, and
 * footprint optimization for Soroban smart contracts.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';

export const protocol26Router = Router();

// ── Schemas ───────────────────────────────────────────────────────────────────

const ContractTtlSchema = z.object({
  contractId: z.string().min(1),
  ledgersToLive: z.number().int().min(1).max(3110400), // max ~6 months
  entryType: z.enum(['instance', 'persistent', 'temporary']).default('instance'),
});

const FootprintSchema = z.object({
  contractId: z.string().min(1),
  readOnly: z.array(z.string()).default([]),
  readWrite: z.array(z.string()).default([]),
});

// ── GET / ─────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /protocol26:
 *   get:
 *     summary: Protocol 26 state extension service overview
 *     tags: [Protocol 26]
 *     responses:
 *       200:
 *         description: Service info and Protocol 26 features
 */
protocol26Router.get('/', (_req: Request, res: Response) => {
  res.json({
    protocol: 26,
    name: 'Stellar Protocol 26 State Extension',
    description:
      'Manages state archival, TTL, and Soroban entry lifecycle introduced in Protocol 26',
    features: [
      'Contract state archival (automatic & manual)',
      'TTL (Time-To-Live) management for entries',
      'Persistent vs. temporary storage entries',
      'Footprint optimization',
      'State restore operations',
      'Ledger entry expiration tracking',
    ],
    endpoints: [
      'GET  /protocol26',
      'GET  /protocol26/contracts/:contractId/ttl',
      'POST /protocol26/contracts/:contractId/extend-ttl',
      'GET  /protocol26/contracts/:contractId/entries',
      'GET  /protocol26/archive/stats',
      'POST /protocol26/footprint/optimize',
      'GET  /protocol26/expiring',
    ],
  });
});

// ── GET /contracts/:contractId/ttl ─────────────────────────────────────────────

/**
 * @swagger
 * /protocol26/contracts/{contractId}/ttl:
 *   get:
 *     summary: Get TTL information for a contract's state entries
 *     tags: [Protocol 26]
 *     parameters:
 *       - in: path
 *         name: contractId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: TTL data for contract entries
 *       404:
 *         description: Contract not found
 */
protocol26Router.get('/contracts/:contractId/ttl', (req: Request, res: Response) => {
  const { contractId } = req.params;
  const currentLedger = Math.floor(Date.now() / 5000); // approximate ledger number

  res.json({
    contractId,
    currentLedger,
    entries: {
      instance: {
        entryType: 'instance',
        liveUntilLedger: currentLedger + 518400, // ~30 days
        ttlRemaining: 518400,
        archived: false,
        expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      },
      persistentEntries: {
        count: 0,
        avgTtlRemaining: 0,
        nearExpiry: 0,
      },
      temporaryEntries: {
        count: 0,
        avgTtlRemaining: 0,
        nearExpiry: 0,
      },
    },
    archivalPolicy: {
      minPersistentTtl: 4096,
      maxPersistentTtl: 3110400,
      minTemporaryTtl: 1,
      maxTemporaryTtl: 518400,
    },
  });
});

// ── POST /contracts/:contractId/extend-ttl ──────────────────────────────────────

/**
 * @swagger
 * /protocol26/contracts/{contractId}/extend-ttl:
 *   post:
 *     summary: Extend the TTL for a contract's state entries
 *     tags: [Protocol 26]
 *     parameters:
 *       - in: path
 *         name: contractId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ledgersToLive]
 *             properties:
 *               ledgersToLive: { type: number }
 *               entryType: { type: string, enum: [instance, persistent, temporary] }
 *     responses:
 *       200:
 *         description: TTL extension result
 *       400:
 *         description: Validation error
 */
protocol26Router.post('/contracts/:contractId/extend-ttl', (req: Request, res: Response) => {
  const parsed = ContractTtlSchema.safeParse({ contractId: req.params.contractId, ...req.body });
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { contractId, ledgersToLive, entryType } = parsed.data;
  const currentLedger = Math.floor(Date.now() / 5000);
  const newTtl = currentLedger + ledgersToLive;
  const feeLumens = Math.ceil(ledgersToLive * 0.000001); // approximate fee

  res.json({
    contractId,
    entryType,
    operation: 'extend_ttl',
    ledgersExtended: ledgersToLive,
    newLiveUntilLedger: newTtl,
    estimatedFeeLumens: feeLumens,
    status: 'simulated',
    note: 'Submit to Stellar network to apply. This is a simulation response.',
    expiresAt: new Date(Date.now() + ledgersToLive * 5000).toISOString(),
    submittedAt: new Date().toISOString(),
  });
});

// ── GET /contracts/:contractId/entries ──────────────────────────────────────────

/**
 * @swagger
 * /protocol26/contracts/{contractId}/entries:
 *   get:
 *     summary: List persistent and temporary storage entries for a contract
 *     tags: [Protocol 26]
 *     parameters:
 *       - in: path
 *         name: contractId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: type
 *         schema: { type: string, enum: [persistent, temporary, all] }
 *       - in: query
 *         name: nearExpiry
 *         schema: { type: boolean }
 *     responses:
 *       200:
 *         description: Contract storage entries
 */
protocol26Router.get('/contracts/:contractId/entries', (req: Request, res: Response) => {
  const { contractId } = req.params;
  const type = (req.query.type as string) ?? 'all';
  const nearExpiry = req.query.nearExpiry === 'true';

  res.json({
    contractId,
    filter: { type, nearExpiry },
    entries: [],
    total: 0,
    message: 'No state entries found. Entries appear here after indexing contract activity.',
    currentLedger: Math.floor(Date.now() / 5000),
  });
});

// ── GET /archive/stats ───────────────────────────────────────────────────────────

/**
 * @swagger
 * /protocol26/archive/stats:
 *   get:
 *     summary: Get archival statistics for the network
 *     tags: [Protocol 26]
 *     responses:
 *       200:
 *         description: Archive statistics
 */
protocol26Router.get('/archive/stats', (_req: Request, res: Response) => {
  res.json({
    totalArchivedContracts: 0,
    totalArchivedEntries: 0,
    totalRestoredContracts: 0,
    archivalRate: '0 entries/day',
    storageReclaimed: '0 bytes',
    activeContracts: 0,
    nearExpiryContracts: 0,
    lastUpdated: new Date().toISOString(),
  });
});

// ── POST /footprint/optimize ──────────────────────────────────────────────────────

/**
 * @swagger
 * /protocol26/footprint/optimize:
 *   post:
 *     summary: Optimize a transaction footprint for Protocol 26 state access
 *     tags: [Protocol 26]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [contractId]
 *             properties:
 *               contractId: { type: string }
 *               readOnly: { type: array, items: { type: string } }
 *               readWrite: { type: array, items: { type: string } }
 *     responses:
 *       200:
 *         description: Optimized footprint
 *       400:
 *         description: Validation error
 */
protocol26Router.post('/footprint/optimize', (req: Request, res: Response) => {
  const parsed = FootprintSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { contractId, readOnly, readWrite } = parsed.data;
  const duplicates = readOnly.filter((k) => readWrite.includes(k));
  const optimizedReadOnly = readOnly.filter((k) => !readWrite.includes(k));

  res.json({
    contractId,
    original: { readOnly: readOnly.length, readWrite: readWrite.length },
    optimized: { readOnly: optimizedReadOnly.length, readWrite: readWrite.length },
    removedDuplicates: duplicates.length,
    duplicateKeys: duplicates,
    recommendation:
      duplicates.length > 0
        ? 'Removed duplicate keys present in both readOnly and readWrite sets'
        : 'Footprint is already optimized',
    estimatedFeeReduction: duplicates.length > 0 ? `~${duplicates.length * 0.0001} XLM` : '0 XLM',
  });
});

// ── GET /expiring ──────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /protocol26/expiring:
 *   get:
 *     summary: List contracts with state entries expiring soon
 *     tags: [Protocol 26]
 *     parameters:
 *       - in: query
 *         name: ledgersThreshold
 *         schema: { type: number }
 *         description: Warn if TTL < this many ledgers (default 50000, ~3 days)
 *     responses:
 *       200:
 *         description: Contracts near expiry
 */
protocol26Router.get('/expiring', (req: Request, res: Response) => {
  const threshold = Math.min(
    518400,
    parseInt((req.query.ledgersThreshold as string) ?? '50000', 10),
  );

  res.json({
    threshold,
    thresholdDescription: `~${Math.round((threshold * 5) / 3600)} hours`,
    expiringContracts: [],
    total: 0,
    message: 'No contracts found near expiry threshold.',
    checkedAt: new Date().toISOString(),
  });
});
