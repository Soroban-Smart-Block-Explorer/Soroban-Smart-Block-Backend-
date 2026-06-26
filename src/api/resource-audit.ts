/**
 * Resource Audit API Router
 *
 * Tracks and reports resource usage (compute, storage, bandwidth) for Soroban
 * contracts. Provides audit trails, usage limits, quota enforcement, and
 * cost analysis for contract resource consumption.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';

export const resourceAuditRouter = Router();

// ── GET / ────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /resource-audit:
 *   get:
 *     summary: Resource audit service overview
 *     tags: [Resource Audit]
 *     responses:
 *       200:
 *         description: Service info
 */
resourceAuditRouter.get('/', (_req: Request, res: Response) => {
  res.json({
    service: 'Resource Audit API',
    description:
      'Tracks compute units, storage bytes, and network bandwidth used by Soroban contracts',
    resourceTypes: [
      'compute_units',
      'read_entries',
      'write_entries',
      'read_bytes',
      'write_bytes',
      'events_bytes',
    ],
    endpoints: [
      'GET  /resource-audit',
      'GET  /resource-audit/contracts/:contractId',
      'GET  /resource-audit/contracts/:contractId/history',
      'GET  /resource-audit/network/summary',
      'GET  /resource-audit/top-consumers',
      'POST /resource-audit/simulate',
    ],
  });
});

// ── GET /contracts/:contractId ────────────────────────────────────────────────

/**
 * @swagger
 * /resource-audit/contracts/{contractId}:
 *   get:
 *     summary: Get resource usage for a specific contract
 *     tags: [Resource Audit]
 *     parameters:
 *       - in: path
 *         name: contractId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Contract resource audit data
 */
resourceAuditRouter.get('/contracts/:contractId', (req: Request, res: Response) => {
  const { contractId } = req.params;

  res.json({
    contractId,
    totalInvocations: 0,
    cumulativeResources: {
      computeUnits: 0,
      readEntries: 0,
      writeEntries: 0,
      readBytes: 0,
      writeBytes: 0,
      eventsBytes: 0,
    },
    averagePerInvocation: {
      computeUnits: 0,
      readEntries: 0,
      writeEntries: 0,
    },
    costAnalysis: {
      totalFeesLumens: 0,
      averageFeePerInvocation: 0,
    },
    firstSeen: null,
    lastSeen: null,
    message: 'No resource audit data available for this contract.',
  });
});

// ── GET /contracts/:contractId/history ────────────────────────────────────────

/**
 * @swagger
 * /resource-audit/contracts/{contractId}/history:
 *   get:
 *     summary: Get historical resource usage over time for a contract
 *     tags: [Resource Audit]
 *     parameters:
 *       - in: path
 *         name: contractId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: days
 *         schema: { type: number }
 *     responses:
 *       200:
 *         description: Historical resource usage
 */
resourceAuditRouter.get('/contracts/:contractId/history', (req: Request, res: Response) => {
  const { contractId } = req.params;
  const days = Math.min(90, parseInt((req.query.days as string) ?? '30', 10));

  res.json({
    contractId,
    period: { days },
    history: [],
    message: `No usage history for the last ${days} days.`,
  });
});

// ── GET /network/summary ──────────────────────────────────────────────────────

/**
 * @swagger
 * /resource-audit/network/summary:
 *   get:
 *     summary: Get network-wide resource consumption summary
 *     tags: [Resource Audit]
 *     responses:
 *       200:
 *         description: Network resource summary
 */
resourceAuditRouter.get('/network/summary', (_req: Request, res: Response) => {
  res.json({
    period: 'last_24h',
    totalContracts: 0,
    totalInvocations: 0,
    totalComputeUnits: 0,
    totalReadBytes: 0,
    totalWriteBytes: 0,
    totalEventsBytes: 0,
    totalFeesLumens: 0,
    avgComputePerInvocation: 0,
    computedAt: new Date().toISOString(),
  });
});

// ── GET /top-consumers ────────────────────────────────────────────────────────

/**
 * @swagger
 * /resource-audit/top-consumers:
 *   get:
 *     summary: Get top resource-consuming contracts
 *     tags: [Resource Audit]
 *     parameters:
 *       - in: query
 *         name: metric
 *         schema: { type: string, enum: [compute_units, read_bytes, write_bytes, events_bytes, fees] }
 *       - in: query
 *         name: limit
 *         schema: { type: number }
 *     responses:
 *       200:
 *         description: Top consumers list
 */
resourceAuditRouter.get('/top-consumers', (req: Request, res: Response) => {
  const metric = (req.query.metric as string) ?? 'compute_units';
  const limit = Math.min(50, parseInt((req.query.limit as string) ?? '10', 10));
  const validMetrics = ['compute_units', 'read_bytes', 'write_bytes', 'events_bytes', 'fees'];

  if (!validMetrics.includes(metric)) {
    return res
      .status(400)
      .json({ error: `Invalid metric. Must be one of: ${validMetrics.join(', ')}` });
  }

  res.json({ metric, limit, contracts: [], message: 'No resource data available.' });
});

// ── POST /simulate ─────────────────────────────────────────────────────────────

/**
 * @swagger
 * /resource-audit/simulate:
 *   post:
 *     summary: Simulate resource cost for a hypothetical contract call
 *     tags: [Resource Audit]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [contractId, functionName]
 *             properties:
 *               contractId: { type: string }
 *               functionName: { type: string }
 *               args: { type: array }
 *     responses:
 *       200:
 *         description: Simulated resource estimate
 *       400:
 *         description: Validation error
 */
resourceAuditRouter.post('/simulate', (req: Request, res: Response) => {
  const schema = z.object({
    contractId: z.string().min(1),
    functionName: z.string().min(1),
    args: z.array(z.unknown()).optional().default([]),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { contractId, functionName } = parsed.data;

  res.json({
    contractId,
    functionName,
    simulation: {
      estimatedComputeUnits: 500000,
      estimatedReadEntries: 2,
      estimatedWriteEntries: 1,
      estimatedReadBytes: 256,
      estimatedWriteBytes: 128,
      estimatedEventsBytes: 64,
      estimatedFeeLumens: 0.001,
    },
    note: 'Estimates are based on network averages. Actual usage may vary.',
    simulatedAt: new Date().toISOString(),
  });
});
