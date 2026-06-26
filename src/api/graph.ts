import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import {
  buildContractDependencyGraph,
  generateDependencyGraphSVG,
} from '../indexer/dependencyGraphCompiler';

/**
 * @swagger
 * tags:
 *   name: Graph
 *   description: Contract dependency visualization and analysis
 */

export const graphRouter = Router();

/**
 * @swagger
 * /api/v1/graph/dependencies:
 *   get:
 *     summary: Get contract dependency graph as JSON with hierarchy
 *     tags: [Graph]
 *     responses:
 *       200:
 *         description: Contract dependency graph with parent-child relationships
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 nodes:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       address: { type: string }
 *                       name: { type: string }
 *                       children: { type: array, items: { type: string } }
 *                       callCount: { type: integer }
 *                       depth: { type: integer }
 *                 edges:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       from: { type: string }
 *                       to: { type: string }
 *                       weight: { type: integer }
 *                 metadata:
 *                   type: object
 *                   properties:
 *                     totalNodes: { type: integer }
 *                     totalEdges: { type: integer }
 *                     maxDepth: { type: integer }
 *                     generatedAt: { type: string, format: date-time }
 */
graphRouter.get(
  '/dependencies',
  asyncHandler(async (_req: Request, res: Response) => {
    const graph = await buildContractDependencyGraph();
    res.json(graph);
  }),
);

/**
 * @swagger
 * /api/v1/graph/dependencies/svg:
 *   get:
 *     summary: Get contract dependency graph as SVG visualization
 *     tags: [Graph]
 *     description: Hierarchical layout with edge weights and depth-based coloring
 *     responses:
 *       200:
 *         description: SVG dependency graph
 *         content:
 *           image/svg+xml:
 *             schema:
 *               type: string
 */
graphRouter.get(
  '/dependencies/svg',
  asyncHandler(async (_req: Request, res: Response) => {
    const graph = await buildContractDependencyGraph();
    const svg = generateDependencyGraphSVG(graph);
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(svg);
  }),
);
