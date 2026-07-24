/**
 * Multi-Layer Data Lakehouse API (Issue #551)
 *
 * Unified query gateway (Layer 4) plus introspection endpoints for the stream
 * schema registry (Layer 1), OLAP dashboards (Layer 2) and tiered lifecycle
 * (Layer 3). A single POST /lakehouse/query routes to the correct layer based
 * on time range, aggregation level and freshness requirements.
 *
 * @swagger
 * tags:
 *   name: Data Lakehouse
 *   description: Multi-layer stream + OLAP + cold-storage query gateway (#551)
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';
import { buildDemoLakehouse, type Lakehouse } from '../analytics/lakehouse/bootstrap';
import { MATERIALIZED_VIEWS } from '../analytics/lakehouse/olap-store';
import type { GatewayRequest } from '../analytics/lakehouse/query-gateway';

export const lakehouseRouter = Router();

// ── Lazy single-instance demo lakehouse ────────────────────────────────────────
// Built on first request, seeded relative to the current time. Production wiring
// injects real Kafka/ClickHouse/Trino via LAKEHOUSE_*_DRIVER env vars.

let instance: Promise<Lakehouse> | null = null;
function lakehouse(): Promise<Lakehouse> {
  if (!instance) instance = buildDemoLakehouse(Date.now());
  return instance;
}

// ── Validation ─────────────────────────────────────────────────────────────────

const MeasureSchema = z.object({
  as: z.string().min(1),
  fn: z.enum(['sum', 'count', 'avg', 'min', 'max']),
  column: z.string().optional(),
});

const QuerySchema = z.object({
  dataset: z.string().default('txn_events'),
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
  groupBy: z.array(z.string()).default([]),
  measures: z.array(MeasureSchema).min(1),
  freshness: z.enum(['realtime', 'near-realtime', 'batch']).optional(),
  aggregation: z.enum(['raw', 'pre-aggregated']).optional(),
  timeoutMs: z.number().int().min(100).max(60_000).optional(),
});

function toGatewayRequest(body: z.infer<typeof QuerySchema>): GatewayRequest {
  return {
    dataset: body.dataset,
    from: body.from,
    to: body.to,
    groupBy: body.groupBy,
    measures: body.measures,
    freshness: body.freshness,
    aggregation: body.aggregation,
    timeoutMs: body.timeoutMs,
  };
}

// ── POST /lakehouse/query ──────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/lakehouse/query:
 *   post:
 *     summary: Route a time-ranged analytics query to the correct layer
 *     description: |
 *       Routes to Layer 1 (stream view), Layer 2 (ClickHouse materialized view)
 *       or Layer 3 (federated hot+warm+cold) based on time range, aggregation
 *       level and freshness. Returns rows plus routing, cost and cache metadata.
 *     tags: [Data Lakehouse]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200: { description: Query result with routing/cost metadata }
 *       400: { description: Invalid request }
 */
lakehouseRouter.post(
  '/query',
  asyncHandler(async (req: Request, res: Response) => {
    const body = QuerySchema.parse(req.body);
    if (body.to < body.from) {
      res.status(400).json({ error: '`to` must be >= `from`' });
      return;
    }
    const lh = await lakehouse();
    const now = Date.now();
    const result = await lh.gateway.execute(toGatewayRequest(body), now);
    res.json({
      target: result.target,
      cacheHit: result.cacheHit,
      cost: result.cost,
      executionMs: result.executionMs,
      rowCount: result.rows.length,
      rows: result.rows,
    });
  }),
);

// ── POST /lakehouse/query/plan — dry run ───────────────────────────────────────

/**
 * @swagger
 * /api/v1/lakehouse/query/plan:
 *   post:
 *     summary: Explain routing + federated plan for a query without executing it
 *     tags: [Data Lakehouse]
 */
lakehouseRouter.post(
  '/query/plan',
  asyncHandler(async (req: Request, res: Response) => {
    const body = QuerySchema.parse(req.body);
    const lh = await lakehouse();
    const now = Date.now();
    const gwReq = toGatewayRequest(body);
    const decision = lh.gateway.plan(gwReq, now);
    const federated = decision.target === 'federated' ? lh.gateway.federatedPlan(gwReq) : null;
    res.json({ decision, federated });
  }),
);

// ── GET /lakehouse/schemas — Layer 1 schema registry ───────────────────────────

/**
 * @swagger
 * /api/v1/lakehouse/schemas:
 *   get:
 *     summary: List registered event schemas (subjects, versions, compatibility)
 *     tags: [Data Lakehouse]
 */
lakehouseRouter.get(
  '/schemas',
  asyncHandler(async (_req: Request, res: Response) => {
    const lh = await lakehouse();
    const subjects = lh.registry.subjects().map((subject) => {
      const latest = lh.registry.latest(subject)!;
      return {
        subject,
        id: latest.id,
        version: latest.version,
        format: latest.format,
        compatibility: lh.registry.getCompatibility(subject),
        fields: latest.fields,
      };
    });
    res.json({ count: subjects.length, subjects });
  }),
);

// ── GET /lakehouse/tiers — Layer 3 lifecycle state ─────────────────────────────

/**
 * @swagger
 * /api/v1/lakehouse/tiers:
 *   get:
 *     summary: List data partitions and their current storage tier
 *     tags: [Data Lakehouse]
 */
lakehouseRouter.get(
  '/tiers',
  asyncHandler(async (_req: Request, res: Response) => {
    const lh = await lakehouse();
    res.json({
      partitions: lh.tiers.all().map((p) => ({
        id: p.id,
        tier: p.currentTier,
        rowCount: p.rowCount,
        sizeBytes: p.sizeBytes,
        recentAccesses: p.recentAccesses.length,
      })),
    });
  }),
);

// ── POST /lakehouse/tiers/evaluate — run the lifecycle policy ──────────────────

/**
 * @swagger
 * /api/v1/lakehouse/tiers/evaluate:
 *   post:
 *     summary: Evaluate tier promotion/demotion decisions (optionally apply them)
 *     tags: [Data Lakehouse]
 */
lakehouseRouter.post(
  '/tiers/evaluate',
  asyncHandler(async (req: Request, res: Response) => {
    const { apply } = z.object({ apply: z.boolean().default(false) }).parse(req.body ?? {});
    const lh = await lakehouse();
    const now = Date.now();
    const decisions = apply ? lh.tiers.reconcile(now) : lh.tiers.evaluate(now);
    res.json({ applied: apply, count: decisions.length, decisions });
  }),
);

// ── GET /lakehouse/dashboards — Layer 2 materialized-view catalog ──────────────

/**
 * @swagger
 * /api/v1/lakehouse/dashboards:
 *   get:
 *     summary: List OLAP materialized views (MEV, compliance, protocol economics)
 *     tags: [Data Lakehouse]
 */
lakehouseRouter.get(
  '/dashboards',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({
      dashboards: MATERIALIZED_VIEWS.map((v) => ({
        name: v.name,
        dashboard: v.dashboard,
        groupBy: v.query.groupBy,
        measures: v.query.measures,
      })),
    });
  }),
);

// ── GET /lakehouse/health — layer readiness summary ────────────────────────────

/**
 * @swagger
 * /api/v1/lakehouse/health:
 *   get:
 *     summary: Report which layer drivers are active and instance readiness
 *     tags: [Data Lakehouse]
 */
lakehouseRouter.get(
  '/health',
  asyncHandler(async (_req: Request, res: Response) => {
    const lh = await lakehouse();
    res.json({
      status: 'ok',
      drivers: {
        bus: process.env.LAKEHOUSE_BUS_DRIVER ?? 'memory',
        olap: process.env.LAKEHOUSE_OLAP_DRIVER ?? 'memory',
      },
      layers: {
        streamSchemas: lh.registry.subjects().length,
        olapTables: await lh.olap.count('txn_events'),
        tierPartitions: lh.tiers.all().length,
        cacheEntries: lh.gateway.cacheSize,
      },
    });
  }),
);
