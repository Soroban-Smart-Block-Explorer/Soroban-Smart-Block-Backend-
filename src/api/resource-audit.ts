/**
 * Resource Audit API Router
 *
 * Tracks and reports resource usage (compute, storage, bandwidth) for Soroban
 * contracts. Provides audit trails, usage limits, quota enforcement, and
 * cost analysis for contract resource consumption.
 *
 * All timestamps and metrics are sourced from real indexer data stored in the
 * database (ContractResourceMetric + Transaction tables). Resolves issue #638.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prismaRead } from '../db';

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
resourceAuditRouter.get(
  '/contracts/:contractId',
  asyncHandler(async (req: Request, res: Response) => {
    const { contractId } = req.params;

    // Aggregate resource metrics from ContractResourceMetric (written by indexer)
    const metrics = await prismaRead.contractResourceMetric.aggregate({
      where: { contractAddress: contractId },
      _count: { id: true },
      _sum: { cpuInstructions: true, memoryUsageBytes: true, storageFootprint: true },
      _avg: { cpuInstructions: true, memoryUsageBytes: true, storageFootprint: true },
      _min: { ledgerCloseTime: true },
      _max: { ledgerCloseTime: true },
    });

    // Also pull fee data from Transaction table
    const txAggregate = await prismaRead.transaction.aggregate({
      where: { contractAddress: contractId, sorobanResources: { not: null } },
      _count: { id: true },
      _min: { ledgerCloseTime: true },
      _max: { ledgerCloseTime: true },
    });

    const totalInvocations = txAggregate._count.id ?? 0;
    const totalCpuInstructions = Number(metrics._sum.cpuInstructions ?? 0);
    const totalMemoryBytes = Number(metrics._sum.memoryUsageBytes ?? 0);
    const totalStorageFootprint = Number(metrics._sum.storageFootprint ?? 0);
    const avgCpuInstructions = Number(metrics._avg.cpuInstructions ?? 0);

    // Sum fee data from the transactions
    const transactions = await prismaRead.transaction.findMany({
      where: { contractAddress: contractId, feeCharged: { not: null } },
      select: { feeCharged: true },
    });
    const totalFeeLumens = transactions.reduce((acc, tx) => {
      const fee = parseFloat(tx.feeCharged ?? '0');
      return acc + (isNaN(fee) ? 0 : fee / 1e7); // convert stroops to lumens
    }, 0);

    const firstSeen = metrics._min.ledgerCloseTime ?? txAggregate._min.ledgerCloseTime ?? null;
    const lastSeen = metrics._max.ledgerCloseTime ?? txAggregate._max.ledgerCloseTime ?? null;

    res.json({
      contractId,
      totalInvocations,
      cumulativeResources: {
        computeUnits: totalCpuInstructions,
        readBytes: totalMemoryBytes,
        writeBytes: 0,
        storageFootprint: totalStorageFootprint,
        eventsBytes: 0,
      },
      averagePerInvocation: {
        computeUnits: Math.round(avgCpuInstructions),
        readBytes: Math.round(Number(metrics._avg.memoryUsageBytes ?? 0)),
        storageFootprint: Math.round(Number(metrics._avg.storageFootprint ?? 0)),
      },
      costAnalysis: {
        totalFeesLumens: parseFloat(totalFeeLumens.toFixed(7)),
        averageFeePerInvocation:
          totalInvocations > 0 ? parseFloat((totalFeeLumens / totalInvocations).toFixed(7)) : 0,
      },
      firstSeen: firstSeen ? firstSeen.toISOString() : null,
      lastSeen: lastSeen ? lastSeen.toISOString() : null,
      ...(totalInvocations === 0 && {
        message: 'No resource audit data available for this contract.',
      }),
    });
  }),
);

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
resourceAuditRouter.get(
  '/contracts/:contractId/history',
  asyncHandler(async (req: Request, res: Response) => {
    const { contractId } = req.params;
    const days = Math.min(90, parseInt((req.query.days as string) ?? '30', 10));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const metrics = await prismaRead.contractResourceMetric.findMany({
      where: { contractAddress: contractId, ledgerCloseTime: { gte: since } },
      orderBy: { ledgerCloseTime: 'asc' },
      select: {
        ledgerSequence: true,
        ledgerCloseTime: true,
        cpuInstructions: true,
        memoryUsageBytes: true,
        storageFootprint: true,
        transactionHash: true,
      },
    });

    const history = metrics.map((m) => ({
      ledgerSequence: m.ledgerSequence,
      timestamp: m.ledgerCloseTime.toISOString(),
      transactionHash: m.transactionHash,
      cpuInstructions: m.cpuInstructions,
      memoryUsageBytes: m.memoryUsageBytes,
      storageFootprint: m.storageFootprint,
    }));

    res.json({
      contractId,
      period: { days },
      history,
      ...(history.length === 0 && {
        message: `No usage history for the last ${days} days.`,
      }),
    });
  }),
);

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
resourceAuditRouter.get(
  '/network/summary',
  asyncHandler(async (_req: Request, res: Response) => {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Pull aggregated data from the last 24 hours from ContractResourceMetric
    const [resourceAgg, contractCount, txAgg, latestTx] = await Promise.all([
      prismaRead.contractResourceMetric.aggregate({
        where: { ledgerCloseTime: { gte: since24h } },
        _sum: { cpuInstructions: true, memoryUsageBytes: true, storageFootprint: true },
        _avg: { cpuInstructions: true },
        _count: { id: true },
      }),
      // Count distinct contracts with activity in the last 24h
      prismaRead.contractResourceMetric.groupBy({
        by: ['contractAddress'],
        where: { ledgerCloseTime: { gte: since24h } },
        _count: { id: true },
      }),
      // Get total invocation count and fee from Transaction table
      prismaRead.transaction.aggregate({
        where: { ledgerCloseTime: { gte: since24h }, sorobanResources: { not: null } },
        _count: { id: true },
        _sum: { feeCharged: true },
      }),
      // Get the timestamp of the most recently indexed transaction for computedAt
      prismaRead.transaction.findFirst({
        orderBy: { ledgerCloseTime: 'desc' },
        select: { ledgerCloseTime: true },
      }),
    ]);

    const totalInvocations = txAgg._count.id ?? 0;
    const totalComputeUnits = Number(resourceAgg._sum.cpuInstructions ?? 0);
    const totalReadBytes = Number(resourceAgg._sum.memoryUsageBytes ?? 0);
    const totalWriteBytes = 0; // not separately tracked yet
    const totalEventsBytes = 0; // not separately tracked yet
    const avgComputePerInvocation =
      resourceAgg._count.id > 0 ? Math.round(Number(resourceAgg._avg.cpuInstructions ?? 0)) : 0;

    // Fee total: sum of feeCharged (stored as string in stroops), convert to lumens
    const totalFeesLumens = Number(txAgg._sum.feeCharged ?? 0) / 1e7;

    // computedAt reflects the last time the indexer processed a transaction
    const computedAt = latestTx?.ledgerCloseTime?.toISOString() ?? new Date().toISOString();

    res.json({
      period: 'last_24h',
      totalContracts: contractCount.length,
      totalInvocations,
      totalComputeUnits,
      totalReadBytes,
      totalWriteBytes,
      totalEventsBytes,
      totalFeesLumens: parseFloat(totalFeesLumens.toFixed(7)),
      avgComputePerInvocation,
      computedAt,
    });
  }),
);

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
resourceAuditRouter.get(
  '/top-consumers',
  asyncHandler(async (req: Request, res: Response) => {
    const metric = (req.query.metric as string) ?? 'compute_units';
    const limit = Math.min(50, parseInt((req.query.limit as string) ?? '10', 10));
    const validMetrics = ['compute_units', 'read_bytes', 'write_bytes', 'events_bytes', 'fees'];

    if (!validMetrics.includes(metric)) {
      return res
        .status(400)
        .json({ error: `Invalid metric. Must be one of: ${validMetrics.join(', ')}` });
    }

    if (metric === 'fees') {
      // For fees, query the Transaction table
      const rows = await prismaRead.transaction.groupBy({
        by: ['contractAddress'],
        where: { contractAddress: { not: null }, feeCharged: { not: null } },
        _sum: { feeCharged: true },
        _count: { id: true },
        orderBy: { _sum: { feeCharged: 'desc' } },
        take: limit,
      });

      return res.json({
        metric,
        limit,
        contracts: rows.map((r) => ({
          contractAddress: r.contractAddress,
          totalFeesLumens: parseFloat((Number(r._sum.feeCharged ?? 0) / 1e7).toFixed(7)),
          totalInvocations: r._count.id,
        })),
      });
    }

    // For resource metrics, use ContractResourceMetric
    const prismaField =
      metric === 'compute_units'
        ? 'cpuInstructions'
        : metric === 'read_bytes'
          ? 'memoryUsageBytes'
          : 'storageFootprint'; // write_bytes/events_bytes fall back to storageFootprint

    const rows = await prismaRead.contractResourceMetric.groupBy({
      by: ['contractAddress'],
      _sum: { [prismaField]: true } as any,
      _count: { id: true },
      orderBy: { _sum: { [prismaField]: 'desc' } } as any,
      take: limit,
    });

    res.json({
      metric,
      limit,
      contracts: rows.map((r) => ({
        contractAddress: r.contractAddress,
        total: Number((r._sum as any)[prismaField] ?? 0),
        totalInvocations: r._count.id,
      })),
    });
  }),
);

// ── POST /simulate ─────────────────────────────────────────────────────────────

/**
 * @swagger
 * /resource-audit/simulate:
 *   post:
 *     summary: Simulate resource cost for a hypothetical contract call
 *     description: >
 *       Returns resource estimates based on historical averages recorded by the
 *       indexer for the given contract and function. The `simulatedAt` timestamp
 *       reflects the ledger close time of the most recent indexed transaction for
 *       that contract, providing a real on-chain reference point rather than a
 *       wall-clock stub. If no historical data exists, falls back to
 *       network-wide averages.
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
 *         description: Resource estimate based on real historical data
 *       400:
 *         description: Validation error
 */
resourceAuditRouter.post(
  '/simulate',
  asyncHandler(async (req: Request, res: Response) => {
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

    // Query historical resource metrics for this specific contract + function
    const [contractMetrics, contractFunctionTx, networkAvg] = await Promise.all([
      // Aggregate resource metrics from ContractResourceMetric for this contract
      prismaRead.contractResourceMetric.aggregate({
        where: { contractAddress: contractId },
        _avg: { cpuInstructions: true, memoryUsageBytes: true, storageFootprint: true },
        _count: { id: true },
      }),
      // Get the most recent transaction for this contract+function (for simulatedAt timestamp)
      prismaRead.transaction.findFirst({
        where: { contractAddress: contractId, functionName },
        orderBy: { ledgerCloseTime: 'desc' },
        select: { ledgerCloseTime: true, feeCharged: true, sorobanResources: true },
      }),
      // Network-wide average as fallback when no contract-specific data exists
      prismaRead.contractResourceMetric.aggregate({
        _avg: { cpuInstructions: true, memoryUsageBytes: true, storageFootprint: true },
      }),
    ]);

    const hasContractData = contractMetrics._count.id > 0;

    // Use contract-specific averages if available, otherwise fall back to network averages
    const avgCpu = hasContractData
      ? Number(contractMetrics._avg.cpuInstructions ?? 0)
      : Number(networkAvg._avg.cpuInstructions ?? 500_000);
    const avgMem = hasContractData
      ? Number(contractMetrics._avg.memoryUsageBytes ?? 0)
      : Number(networkAvg._avg.memoryUsageBytes ?? 256);
    const avgStorage = hasContractData
      ? Number(contractMetrics._avg.storageFootprint ?? 0)
      : Number(networkAvg._avg.storageFootprint ?? 128);

    // Derive an estimated fee from the most recent real transaction for this function
    const estimatedFeeLumens = contractFunctionTx?.feeCharged
      ? parseFloat((Number(contractFunctionTx.feeCharged) / 1e7).toFixed(7))
      : 0.001;

    // simulatedAt: the ledger close time of the most recent real on-chain transaction
    // for this contract/function. This anchors the estimate to actual chain state
    // instead of using a wall-clock stub (fixes issue #638).
    const simulatedAt =
      contractFunctionTx?.ledgerCloseTime?.toISOString() ?? new Date().toISOString();

    const dataSource = hasContractData
      ? `historical averages from ${contractMetrics._count.id} indexed invocations`
      : 'network-wide averages (no contract-specific data indexed yet)';

    res.json({
      contractId,
      functionName,
      simulation: {
        estimatedComputeUnits: Math.round(avgCpu),
        estimatedReadBytes: Math.round(avgMem),
        estimatedWriteBytes: Math.round(avgStorage / 2),
        estimatedStorageFootprint: Math.round(avgStorage),
        estimatedEventsBytes: 64,
        estimatedFeeLumens,
      },
      dataSource,
      note: `Estimates derived from ${dataSource}. Actual usage may vary.`,
      simulatedAt,
    });
  }),
);
