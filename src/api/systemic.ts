import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  getSystemicOverview,
  getProtocolRiskProfile,
  getCriticalNodes,
  simulateCascade,
  computeConcentrationMetrics,
  buildSystemDependencyGraph,
} from '../indexer/systemicRisk';
import { getCurrentRiskIndex, getAlerts, getRiskIndexHistory } from '../indexer/systemicMonitor';

export const systemicRouter = Router();

/**
 * @swagger
 * tags:
 *   name: Systemic
 *   description: Cross-Protocol Comorbidity and Systemic Risk Analysis
 */

/**
 * @swagger
 * /api/v1/systemic/overview:
 *   get:
 *     summary: Systemic risk dashboard overview
 *     tags: [Systemic]
 *     responses:
 *       200:
 *         description: Systemic risk dashboard with index, critical nodes, and concentration
 */
systemicRouter.get('/overview', async (_req: Request, res: Response) => {
  try {
    const overview = await getSystemicOverview();
    res.json(overview);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * @swagger
 * /api/v1/systemic/protocols/{address}:
 *   get:
 *     summary: Protocol risk profile
 *     tags: [Systemic]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Protocol-level systemic risk profile
 */
systemicRouter.get('/protocols/:address', async (req: Request, res: Response) => {
  try {
    const profile = await getProtocolRiskProfile(req.params.address);
    if (!profile) {
      return res.status(404).json({ error: 'Protocol not found' });
    }
    res.json(profile);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * @swagger
 * /api/v1/systemic/critical-nodes:
 *   get:
 *     summary: Top 10 most systemically critical protocols
 *     tags: [Systemic]
 *     responses:
 *       200:
 *         description: List of critical protocol nodes
 */
systemicRouter.get('/critical-nodes', async (_req: Request, res: Response) => {
  try {
    const nodes = await getCriticalNodes();
    res.json({ criticalNodes: nodes, count: nodes.length });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * @swagger
 * /api/v1/systemic/concentration:
 *   get:
 *     summary: Ecosystem concentration metrics
 *     tags: [Systemic]
 *     responses:
 *       200:
 *         description: TVL, dependency, and diversity concentration metrics
 */
systemicRouter.get('/concentration', async (_req: Request, res: Response) => {
  try {
    const graph = await buildSystemDependencyGraph();
    const metrics = computeConcentrationMetrics(graph);
    res.json(metrics);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

const simulateSchema = z.object({
  failedProtocol: z.string(),
  failureType: z.enum(['hack', 'oracle_failure', 'governance_attack', 'bank_run']),
});

/**
 * @swagger
 * /api/v1/systemic/simulate-cascade:
 *   post:
 *     summary: Simulate cascade failure from a protocol collapse
 *     tags: [Systemic]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               failedProtocol:
 *                 type: string
 *               failureType:
 *                 type: string
 *                 enum: [hack, oracle_failure, governance_attack, bank_run]
 *     responses:
 *       200:
 *         description: Cascade simulation results
 */
systemicRouter.post('/simulate-cascade', async (req: Request, res: Response) => {
  try {
    const { failedProtocol, failureType } = simulateSchema.parse(req.body);
    const result = await simulateCascade(failedProtocol, failureType);
    if (!result) {
      return res.status(404).json({ error: 'Protocol not found in dependency graph' });
    }
    res.json(result);
  } catch (e) {
    if (e instanceof z.ZodError) {
      return res.status(400).json({ error: e.errors });
    }
    res.status(500).json({ error: String(e) });
  }
});

/**
 * @swagger
 * /api/v1/systemic/dependency-graph:
 *   get:
 *     summary: Full cross-protocol dependency graph
 *     tags: [Systemic]
 *     responses:
 *       200:
 *         description: Complete dependency graph with typed edges
 */
systemicRouter.get('/dependency-graph', async (_req: Request, res: Response) => {
  try {
    const graph = await buildSystemDependencyGraph();
    res.json({
      protocols: Array.from(graph.protocols.values()),
      edges: graph.edges,
      metadata: graph.metadata,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * @swagger
 * /api/v1/systemic/monitor/risk-index:
 *   get:
 *     summary: Current systemic risk index
 *     tags: [Systemic]
 *     responses:
 *       200:
 *         description: Current systemic risk index value
 */
systemicRouter.get('/monitor/risk-index', async (_req: Request, res: Response) => {
  try {
    res.json({
      currentRiskIndex: getCurrentRiskIndex(),
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * @swagger
 * /api/v1/systemic/monitor/alerts:
 *   get:
 *     summary: Recent systemic risk alerts
 *     tags: [Systemic]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *     responses:
 *       200:
 *         description: Recent alerts
 */
systemicRouter.get('/monitor/alerts', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 100);
    res.json({ alerts: getAlerts(limit), count: limit });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * @swagger
 * /api/v1/systemic/monitor/history:
 *   get:
 *     summary: Systemic risk index history
 *     tags: [Systemic]
 *     parameters:
 *       - in: query
 *         name: since
 *         schema:
 *           type: string
 *           format: date-time
 *     responses:
 *       200:
 *         description: Historical risk index data points
 */
systemicRouter.get('/monitor/history', async (req: Request, res: Response) => {
  try {
    const since = req.query.since ? new Date(req.query.since as string) : undefined;
    const history = getRiskIndexHistory(since);
    res.json({ data: history, count: history.length });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});
