/**
 * POST /api/v1/analytics/query
 *
 * Single query endpoint for the Blockchain Data Lake.  Accepts raw SQL or
 * a pre-built dashboard template ID, routes to Athena or Trino, and returns
 * results with cost/scan metadata.
 *
 * Authentication: API key required (compute-heavy endpoint).
 *
 * @swagger
 * tags:
 *   name: Analytics Data Lake
 *   description: Parquet/Iceberg analytics warehouse query interface
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';
import { executeQuery, estimateQueryCost } from '../analytics/query-engine/query-router';
import {
  DASHBOARD_TEMPLATES,
  getTemplate,
  interpolateTemplate,
} from '../analytics/dashboards/templates';
import {
  getTopContractsByDAU,
  getGasDistribution,
  getWalletCreationRate,
  getTokenTransferHeatmap,
  getProtocolMonthlySummary,
} from '../analytics/materialized-views/views';
import { listLineage } from '../analytics/data-quality/checks';

export const analyticsQueryRouter = Router();

// ── Validation schemas ────────────────────────────────────────────────────────

const QuerySchema = z.object({
  /** Raw SQL to execute against the data lake. */
  sql: z.string().min(1).max(16_000).optional(),
  /** Pre-built template ID (alternative to raw SQL). */
  templateId: z.string().optional(),
  /** Parameter overrides for template queries. */
  params: z.record(z.union([z.string(), z.number()])).optional(),
  /** Target query engine.  Auto-selected if omitted. */
  engine: z.enum(['athena', 'trino']).optional(),
  /** Hard limit on bytes scanned (0 = no limit). */
  maxScanBytes: z.number().int().min(0).optional(),
  /** Query timeout in milliseconds (default 30 000, max 300 000). */
  timeoutMs: z.number().int().min(1000).max(300_000).default(30_000),
  /** If true, return cost estimate only — do not execute the query. */
  dryRun: z.boolean().default(false),
});

// ── POST /analytics/query ─────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/analytics/query:
 *   post:
 *     summary: Execute a SQL query against the Iceberg data lake
 *     description: |
 *       Accepts raw SQL or a pre-built dashboard template ID and routes the query
 *       to Amazon Athena (ad-hoc) or Trino (complex/dashboard).
 *       Returns query results, cost estimate, and data-scan metadata.
 *     tags: [Analytics Data Lake]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               sql:
 *                 type: string
 *                 description: Raw SQL query (mutually exclusive with templateId)
 *               templateId:
 *                 type: string
 *                 description: Pre-built template ID
 *                 enum: [top_contracts_by_dau, gas_price_distribution, wallet_creation_rate, token_transfer_heatmap, contract_composability]
 *               params:
 *                 type: object
 *                 description: Template parameter overrides
 *               engine:
 *                 type: string
 *                 enum: [athena, trino]
 *                 description: Target query engine (auto-selected if omitted)
 *               maxScanBytes:
 *                 type: integer
 *                 description: Hard limit on bytes scanned
 *               timeoutMs:
 *                 type: integer
 *                 default: 30000
 *               dryRun:
 *                 type: boolean
 *                 default: false
 *                 description: Return cost estimate only, skip execution
 *     responses:
 *       200:
 *         description: Query result or cost estimate
 *       400:
 *         description: Invalid request or SQL too expensive
 */
analyticsQueryRouter.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const body = QuerySchema.parse(req.body);

    if (!body.sql && !body.templateId) {
      res.status(400).json({ error: 'Provide either "sql" or "templateId"' });
      return;
    }

    // Resolve SQL
    let sql: string;
    if (body.templateId) {
      const template = getTemplate(body.templateId);
      if (!template) {
        res.status(404).json({
          error: `Unknown templateId "${body.templateId}"`,
          availableTemplates: DASHBOARD_TEMPLATES.map((t) => ({ id: t.id, name: t.name })),
        });
        return;
      }
      sql = interpolateTemplate(template, body.params ?? {});
    } else {
      sql = body.sql!;
    }

    // Cost estimation
    const estimate = estimateQueryCost(sql);

    if (body.dryRun) {
      res.json({ dryRun: true, estimate, sql });
      return;
    }

    // Cost threshold warning (non-blocking — let the caller decide)
    const response: Record<string, unknown> = {};
    if (estimate.exceedsThreshold) {
      response.costWarning = {
        message: `Estimated cost $${estimate.estimatedCostUsd.toFixed(4)} exceeds threshold`,
        estimatedCostUsd: estimate.estimatedCostUsd,
        estimatedScanGb: (estimate.estimatedScanBytes / 1024 ** 3).toFixed(2),
      };
    }

    const { result } = await executeQuery({
      sql,
      engine: body.engine ?? estimate.recommendedEngine,
      maxScanBytes: body.maxScanBytes,
      timeoutMs: body.timeoutMs,
    });

    res.json({
      ...response,
      queryId: result.queryId,
      engine: result.engine,
      rowCount: result.rowCount,
      executionMs: result.executionMs,
      scanBytes: result.scanBytes,
      estimatedCostUsd: estimate.estimatedCostUsd,
      columns: result.columns,
      rows: result.rows,
    });
  }),
);

// ── GET /analytics/query/templates ───────────────────────────────────────────

/**
 * @swagger
 * /api/v1/analytics/query/templates:
 *   get:
 *     summary: List pre-built dashboard SQL templates
 *     tags: [Analytics Data Lake]
 */
analyticsQueryRouter.get(
  '/templates',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({
      templates: DASHBOARD_TEMPLATES.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        defaultParams: t.defaultParams,
        preferredEngine: t.preferredEngine,
        typicalLatencyMs: t.typicalLatencyMs,
      })),
    });
  }),
);

// ── GET /analytics/query/templates/:id ───────────────────────────────────────

analyticsQueryRouter.get(
  '/templates/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const template = getTemplate(req.params.id);
    if (!template) {
      res.status(404).json({ error: 'Template not found' });
      return;
    }
    res.json(template);
  }),
);

// ── GET /analytics/query/estimate ────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/analytics/query/estimate:
 *   post:
 *     summary: Estimate cost and engine recommendation for a SQL query
 *     tags: [Analytics Data Lake]
 */
analyticsQueryRouter.post(
  '/estimate',
  asyncHandler(async (req: Request, res: Response) => {
    const { sql } = z.object({ sql: z.string().min(1).max(16_000) }).parse(req.body);
    const estimate = estimateQueryCost(sql);
    res.json(estimate);
  }),
);

// ── GET /analytics/dashboard/:type — Materialized-view fast path ─────────────

/**
 * @swagger
 * /api/v1/analytics/dashboard/{type}:
 *   get:
 *     summary: Fast dashboard data from PostgreSQL materialized views (Redis-cached)
 *     description: Returns pre-computed aggregations without hitting the data lake. Cached for 5 min.
 *     tags: [Analytics Data Lake]
 *     parameters:
 *       - in: path
 *         name: type
 *         required: true
 *         schema:
 *           type: string
 *           enum: [top-contracts, gas-distribution, wallet-creation, token-heatmap, protocol-summary]
 */
analyticsQueryRouter.get(
  '/dashboard/:type',
  asyncHandler(async (req: Request, res: Response) => {
    const { type } = req.params;
    const limit = Math.min(parseInt(String(req.query.limit ?? '10'), 10), 100);
    const days = Math.min(parseInt(String(req.query.days ?? '30'), 10), 365);

    switch (type) {
      case 'top-contracts': {
        const data = await getTopContractsByDAU(limit);
        res.json({ type, data });
        break;
      }
      case 'gas-distribution': {
        const data = await getGasDistribution(days);
        res.json({ type, data });
        break;
      }
      case 'wallet-creation': {
        const data = await getWalletCreationRate(Math.ceil(days / 7));
        res.json({ type, data });
        break;
      }
      case 'token-heatmap': {
        const contract = req.query.contract as string | undefined;
        const data = await getTokenTransferHeatmap(contract);
        res.json({ type, data });
        break;
      }
      case 'protocol-summary': {
        const data = await getProtocolMonthlySummary(Math.ceil(days / 30));
        res.json({ type, data });
        break;
      }
      default:
        res.status(404).json({
          error: `Unknown dashboard type "${type}"`,
          available: ['top-contracts', 'gas-distribution', 'wallet-creation', 'token-heatmap', 'protocol-summary'],
        });
    }
  }),
);

// ── GET /analytics/lineage ────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/analytics/lineage:
 *   get:
 *     summary: List recent ETL job lineage records
 *     tags: [Analytics Data Lake]
 */
analyticsQueryRouter.get(
  '/lineage',
  asyncHandler(async (req: Request, res: Response) => {
    const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10), 100);
    const records = listLineage(limit);
    res.json({ lineage: records, count: records.length });
  }),
);
