import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';
import type { Chain } from '../bridge-tracker/types';
import {
  detectBridgeTransactions,
  pollAndResolvePending,
  checkFinality,
  getVolumeByProtocol,
  getVolumeByChain,
  getVolumeByAsset,
  getActivityTrends,
  getFeeComparison,
  getAlerts,
  acknowledgeAlert,
  addMonitoredAddress,
  removeMonitoredAddress,
  listMonitoredAddresses,
  startBridgeWorker,
  stopBridgeWorker,
  isBridgeWorkerRunning,
} from '../bridge-tracker';
import { BRIDGE_CONTRACTS } from '../bridge-tracker/config';
import { prismaRead } from '../db';

export const bridgeTrackerRouter = Router();

// ── Bridge Transactions ─────────────────────────────────────────────────────

const VALID_CHAINS: [Chain, ...Chain[]] = [
  'ethereum',
  'solana',
  'cosmos',
  'bsc',
  'polygon',
  'avalanche',
  'arbitrum',
  'optimism',
];

// GET /api/v1/bridge-tracker/transactions
bridgeTrackerRouter.get('/transactions', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      protocol: z.string().optional(),
      sourceChain: z.enum(VALID_CHAINS).optional(),
      destinationChain: z.enum(VALID_CHAINS).optional(),
      status: z.string().optional(),
      sender: z.string().min(1).optional(),
      recipient: z.string().min(1).optional(),
      limit: z.coerce.number().min(1).max(100).default(20),
      offset: z.coerce.number().min(0).default(0),
    });
    const params = schema.parse(req.query);

    const where: Record<string, unknown> = {};
    if (params.protocol) where.protocol = params.protocol;
    if (params.sourceChain) where.sourceChain = params.sourceChain;
    if (params.destinationChain) where.destinationChain = params.destinationChain;
    if (params.status) where.status = params.status;
    if (params.sender) where.sender = params.sender;
    if (params.recipient) where.recipient = params.recipient;

    const [transactions, total] = await Promise.all([
      prismaRead.bridgeTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: params.limit,
        skip: params.offset,
      }),
      prismaRead.bridgeTransaction.count({ where }),
    ]);

    res.json({ transactions, total, limit: params.limit, offset: params.offset });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// GET /api/v1/bridge-tracker/transactions/:hash
bridgeTrackerRouter.get('/transactions/:hash', async (req: Request, res: Response) => {
  try {
    const tx = await prismaRead.bridgeTransaction.findUnique({
      where: { transactionHash: req.params.hash },
    });
    if (!tx) return res.status(404).json({ error: 'Bridge transaction not found' });
    res.json(tx);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/v1/bridge-tracker/transactions/:hash/finality
bridgeTrackerRouter.get('/transactions/:hash/finality', async (req: Request, res: Response) => {
  try {
    const tx = await prismaRead.bridgeTransaction.findUnique({
      where: { transactionHash: req.params.hash },
    });
    if (!tx) return res.status(404).json({ error: 'Bridge transaction not found' });

    const finality = await checkFinality(
      tx.transactionHash,
      tx.sourceChain as any,
      tx.destinationChain as any,
    );
    res.json(finality);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// POST /api/v1/bridge-tracker/detect
bridgeTrackerRouter.post('/detect', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      events: z.array(
        z.object({
          transactionHash: z.string(),
          blockNumber: z.number(),
          contractAddress: z.string(),
          topic0: z.string().optional(),
          topics: z.array(z.string()).default([]),
          data: z.string().default('0x'),
        }),
      ),
    });
    const { events } = schema.parse(req.body);
    const result = await detectBridgeTransactions(events);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// POST /api/v1/bridge-tracker/resolve
bridgeTrackerRouter.post('/resolve', async (req: Request, res: Response) => {
  try {
    const count = await pollAndResolvePending(100);
    res.json({ resolved: count });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── Stats / Analytics ───────────────────────────────────────────────────────

// GET /api/v1/bridge-tracker/stats/volume
bridgeTrackerRouter.get('/stats/volume', async (req: Request, res: Response) => {
  try {
    const groupBy = (req.query.groupBy as string) || 'protocol';
    let stats;
    if (groupBy === 'protocol') {
      stats = await getVolumeByProtocol();
    } else if (groupBy === 'chain') {
      stats = await getVolumeByChain();
    } else if (groupBy === 'asset') {
      stats = await getVolumeByAsset();
    } else {
      return res.status(400).json({ error: 'Invalid groupBy. Use: protocol, chain, or asset' });
    }
    res.json({ groupBy, stats });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/v1/bridge-tracker/stats/trends
bridgeTrackerRouter.get('/stats/trends', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      period: z.enum(['daily', 'weekly', 'monthly']).default('daily'),
      days: z.coerce.number().min(1).max(365).default(30),
    });
    const params = schema.parse(req.query);
    const trends = await getActivityTrends(params.period, params.days);
    res.json({ period: params.period, days: params.days, trends });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// GET /api/v1/bridge-tracker/stats/fees
bridgeTrackerRouter.get('/stats/fees', async (_req: Request, res: Response) => {
  try {
    const fees = await getFeeComparison();
    res.json({ fees });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── Alerts ─────────────────────────────────────────────────────────────────

// GET /api/v1/bridge-tracker/alerts
bridgeTrackerRouter.get('/alerts', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      type: z.string().optional(),
      severity: z.string().optional(),
      acknowledged: z.coerce.boolean().optional(),
      limit: z.coerce.number().min(1).max(100).default(50),
      offset: z.coerce.number().min(0).default(0),
    });
    const params = schema.parse(req.query);
    const result = await getAlerts({
      type: params.type as any,
      severity: params.severity as any,
      acknowledged: params.acknowledged,
      limit: params.limit,
      offset: params.offset,
    });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// POST /api/v1/bridge-tracker/alerts/:id/acknowledge
bridgeTrackerRouter.post('/alerts/:id/acknowledge', async (req: Request, res: Response) => {
  try {
    await acknowledgeAlert(req.params.id);
    res.json({ acknowledged: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── Monitored Addresses ────────────────────────────────────────────────────

// GET /api/v1/bridge-tracker/monitor
bridgeTrackerRouter.get('/monitor', async (_req: Request, res: Response) => {
  try {
    const addresses = await listMonitoredAddresses(true);
    res.json({ addresses });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// POST /api/v1/bridge-tracker/monitor
bridgeTrackerRouter.post('/monitor', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      address: z.string().min(1),
      chain: z.string().min(1),
      label: z.string().optional(),
      minAlertUsd: z.number().positive().optional(),
      alertOnTx: z.boolean().default(true),
      alertOnBridging: z.boolean().default(true),
    });
    const params = schema.parse(req.body);
    const entry = await addMonitoredAddress(params.address, params.chain as any, {
      label: params.label,
      minAlertUsd: params.minAlertUsd,
      alertOnTx: params.alertOnTx,
      alertOnBridging: params.alertOnBridging,
    });
    res.status(201).json(entry);
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// DELETE /api/v1/bridge-tracker/monitor/:id
bridgeTrackerRouter.delete('/monitor/:id', async (req: Request, res: Response) => {
  try {
    await removeMonitoredAddress(req.params.id);
    res.json({ deleted: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── Protocols ──────────────────────────────────────────────────────────────

// GET /api/v1/bridge-tracker/protocols
bridgeTrackerRouter.get('/protocols', async (_req: Request, res: Response) => {
  try {
    const contracts = BRIDGE_CONTRACTS.reduce(
      (acc, c) => {
        if (!acc[c.protocol]) acc[c.protocol] = { chains: [], contracts: 0 };
        if (!acc[c.protocol].chains.includes(c.chain)) acc[c.protocol].chains.push(c.chain);
        acc[c.protocol].contracts++;
        return acc;
      },
      {} as Record<string, { chains: string[]; contracts: number }>,
    );

    res.json({ protocols: Object.entries(contracts).map(([name, info]) => ({ name, ...info })) });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── Worker Control ─────────────────────────────────────────────────────────

// POST /api/v1/bridge-tracker/worker/start
bridgeTrackerRouter.post('/worker/start', async (_req: Request, res: Response) => {
  try {
    startBridgeWorker();
    res.json({ running: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// POST /api/v1/bridge-tracker/worker/stop
bridgeTrackerRouter.post('/worker/stop', async (_req: Request, res: Response) => {
  try {
    stopBridgeWorker();
    res.json({ running: false });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/v1/bridge-tracker/worker/status
bridgeTrackerRouter.get(
  '/worker/status',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ running: isBridgeWorkerRunning() });
  }),
);
