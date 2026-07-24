import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import {
  buildContractDependencyGraph,
  generateDependencyGraphSVG,
} from '../indexer/dependencyGraphCompiler';
import { getGraphDb } from '../db/graph';
import { getGraphTemplates } from '../services/graphTemplates';
import { logger } from '../logger';
import { z } from 'zod';
import {
  traverseUpstream,
  traverseDownstream,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_NODES,
  DEFAULT_TIMEOUT_MS,
} from '../indexer/graph-traversal-db';

/**
 * @swagger
 * tags:
 *   name: Graph
 *   description: Graph database queries and visualization
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

// Schema for Cypher query request
const cypherQuerySchema = z.object({
  query: z.string().min(1).max(10000),
  parameters: z.record(z.any()).optional().default({}),
  timeout: z.number().int().min(100).max(30000).optional().default(5000),
});

/**
 * @swagger
 * /api/v1/graph/query:
 *   post:
 *     summary: Execute parameterized Cypher query
 *     tags: [Graph]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               query:
 *                 type: string
 *                 description: Parameterized Cypher query
 *               parameters:
 *                 type: object
 *                 description: Query parameters
 *               timeout:
 *                 type: integer
 *                 description: Query timeout in ms (default: 5000)
 *     responses:
 *       200:
 *         description: Query results
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                 executionTime:
 *                   type: integer
 *                 nodeCount:
 *                   type: integer
 *                 edgeCount:
 *                   type: integer
 *       400:
 *         description: Invalid request
 *       500:
 *         description: Query execution failed
 */
graphRouter.post(
  '/query',
  asyncHandler(async (req: Request, res: Response) => {
    // Validate request
    const { query, parameters, timeout } = cypherQuerySchema.parse(req.body);

    // Security checks
    if (
      query.includes('CREATE') ||
      query.includes('DELETE') ||
      query.includes('SET') ||
      query.includes('REMOVE')
    ) {
      return res.status(403).json({
        error: 'Write operations are not allowed through this endpoint',
      });
    }

    // Check for injection patterns
    const dangerousPatterns = [
      /;\s*DROP/i,
      /;\s*DELETE/i,
      /;\s*ALTER/i,
      /;\s*GRANT/i,
      /;\s*REVOKE/i,
      /;\s*EXEC/i,
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(query)) {
        logger.warn('Potential Cypher injection attempt detected', { query });
        return res.status(403).json({
          error: 'Query contains potentially dangerous patterns',
        });
      }
    }

    try {
      const graphDb = getGraphDb();
      const result = await graphDb.executeCypher(query, parameters, timeout);

      res.json(result);
    } catch (error) {
      logger.error('Cypher query execution failed', { error, query });
      res.status(500).json({
        error: 'Query execution failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }),
);

// Schema for graph explorer request
const explorerSchema = z.object({
  nodeId: z.string().optional(),
  depth: z.number().int().min(1).max(5).optional().default(2),
  nodeTypes: z.string().optional(),
  edgeTypes: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional().default(50),
});

/**
 * @swagger
 * /api/v1/graph/explorer:
 *   get:
 *     summary: Get graph data for visual exploration (D3.js/Cytoscape compatible)
 *     tags: [Graph]
 *     parameters:
 *       - in: query
 *         name: nodeId
 *         schema:
 *           type: string
 *         description: Starting node ID
 *       - in: query
 *         name: depth
 *         schema:
 *           type: integer
 *           default: 2
 *           minimum: 1
 *           maximum: 5
 *         description: Hop depth
 *       - in: query
 *         name: nodeTypes
 *         schema:
 *           type: string
 *         description: Filter by node types (comma-separated)
 *       - in: query
 *         name: edgeTypes
 *         schema:
 *           type: string
 *         description: Filter by edge types (comma-separated)
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *           minimum: 1
 *           maximum: 200
 *         description: Max nodes per depth
 *     responses:
 *       200:
 *         description: Graph data for visualization
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 nodes:
 *                   type: array
 *                   items:
 *                     type: object
 *                 edges:
 *                   type: array
 *                   items:
 *                     type: object
 *                 metadata:
 *                   type: object
 */
graphRouter.get(
  '/explorer',
  asyncHandler(async (req: Request, res: Response) => {
    const { nodeId, depth, nodeTypes, edgeTypes, limit } = explorerSchema.parse(req.query);

    const graphDb = getGraphDb();

    // Build Cypher query based on parameters
    let cypherQuery: string;
    const parameters: Record<string, any> = { depth, limit };

    if (nodeId) {
      // Start from specific node
      cypherQuery = `
        MATCH (start {id: $nodeId})
        CALL {
          WITH start
          MATCH (start)-[r*1..$depth]-(neighbor)
          RETURN DISTINCT neighbor, r
          LIMIT $limit
        }
        RETURN collect(DISTINCT neighbor) as nodes, collect(DISTINCT r) as edges
      `;
      parameters.nodeId = nodeId;
    } else {
      // Get sample graph
      cypherQuery = `
        MATCH (n)-[r]-(m)
        WITH n, r, m
        LIMIT $limit
        RETURN collect(DISTINCT n) + collect(DISTINCT m) as nodes, collect(DISTINCT r) as edges
      `;
    }

    // Add type filters if provided
    if (nodeTypes) {
      const types = nodeTypes.split(',').map((t: string) => t.trim());
      cypherQuery = cypherQuery.replace('MATCH (n)', `MATCH (n:${types.join('|')})`);
    }

    if (edgeTypes) {
      const types = edgeTypes.split(',').map((t: string) => t.trim());
      cypherQuery = cypherQuery.replace('[r]', `[r:${types.join('|')}]`);
    }

    const result = await graphDb.executeCypher(cypherQuery, parameters);

    // Transform to D3.js/Cytoscape format
    const nodes: any[] = [];
    const edges: any[] = [];
    const nodeSet = new Set<string>();

    if (result.data.length > 0) {
      const rawData = result.data[0];

      if (rawData.nodes) {
        for (const node of rawData.nodes) {
          const nodeId = node.id || node.identity;
          if (!nodeSet.has(nodeId)) {
            nodeSet.add(nodeId);
            nodes.push({
              id: nodeId,
              label: node.label || node.id,
              type: node.labels?.[0] || 'Unknown',
              properties: node.properties || {},
              data: {
                id: nodeId,
                label: node.label || node.id,
                type: node.labels?.[0] || 'Unknown',
                ...node.properties,
              },
            });
          }
        }
      }

      if (rawData.edges) {
        for (const edge of rawData.edges) {
          if (Array.isArray(edge)) {
            for (const e of edge) {
              edges.push({
                id: e.id || `${e.start}-${e.end}`,
                source: e.start,
                target: e.end,
                label: e.label || e.type,
                type: e.type || 'UNKNOWN',
                properties: e.properties || {},
                data: {
                  id: e.id || `${e.start}-${e.end}`,
                  source: e.start,
                  target: e.end,
                  label: e.label || e.type,
                  type: e.type || 'UNKNOWN',
                  ...e.properties,
                },
              });
            }
          } else {
            edges.push({
              id: edge.id || `${edge.start}-${edge.end}`,
              source: edge.start,
              target: edge.end,
              label: edge.label || edge.type,
              type: edge.type || 'UNKNOWN',
              properties: edge.properties || {},
              data: {
                id: edge.id || `${edge.start}-${edge.end}`,
                source: edge.start,
                target: edge.end,
                label: edge.label || edge.type,
                type: edge.type || 'UNKNOWN',
                ...edge.properties,
              },
            });
          }
        }
      }
    }

    res.json({
      nodes,
      edges,
      metadata: {
        totalNodes: nodes.length,
        totalEdges: edges.length,
        queryTime: result.executionTime,
        depth,
      },
    });
  }),
);

// Template endpoints
/**
 * @swagger
 * /api/v1/graph/templates/shortest-path:
 *   post:
 *     summary: Find shortest path between wallets (money laundering investigation)
 *     tags: [Graph Templates]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               fromAddress:
 *                 type: string
 *               toAddress:
 *                 type: string
 *               maxHops:
 *                 type: integer
 *                 default: 10
 *               startTime:
 *                 type: string
 *                 format: date-time
 *               endTime:
 *                 type: string
 *                 format: date-time
 *     responses:
 *       200:
 *         description: Shortest path results
 */
graphRouter.post(
  '/templates/shortest-path',
  asyncHandler(async (req: Request, res: Response) => {
    const templates = getGraphTemplates();
    const result = await templates.shortestPath(req.body);
    res.json(result);
  }),
);

/**
 * @swagger
 * /api/v1/graph/templates/k-hop:
 *   post:
 *     summary: Get k-hop neighborhood for wallet risk assessment
 *     tags: [Graph Templates]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               address:
 *                 type: string
 *               hops:
 *                 type: integer
 *                 default: 3
 *     responses:
 *       200:
 *         description: K-hop neighborhood results
 */
graphRouter.post(
  '/templates/k-hop',
  asyncHandler(async (req: Request, res: Response) => {
    const templates = getGraphTemplates();
    const result = await templates.kHopNeighborhood(req.body);
    res.json(result);
  }),
);

/**
 * @swagger
 * /api/v1/graph/templates/community-detection:
 *   post:
 *     summary: Detect communities (Sybil cluster identification)
 *     tags: [Graph Templates]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               relationshipTypes:
 *                 type: array
 *                 items:
 *                   type: string
 *               minCommunitySize:
 *                 type: integer
 *                 default: 5
 *     responses:
 *       200:
 *         description: Community detection results
 */
graphRouter.post(
  '/templates/community-detection',
  asyncHandler(async (req: Request, res: Response) => {
    const templates = getGraphTemplates();
    const result = await templates.communityDetection(req.body);
    res.json(result);
  }),
);

/**
 * @swagger
 * /api/v1/graph/templates/influence:
 *   post:
 *     summary: Identify most influential contracts (DeFi hubs)
 *     tags: [Graph Templates]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               limit:
 *                 type: integer
 *                 default: 50
 *     responses:
 *       200:
 *         description: Influence maximization results
 */
graphRouter.post(
  '/templates/influence',
  asyncHandler(async (req: Request, res: Response) => {
    const templates = getGraphTemplates();
    const result = await templates.influenceMaximization(req.body);
    res.json(result);
  }),
);

/**
 * @swagger
 * /api/v1/graph/templates/pagerank:
 *   post:
 *     summary: Calculate PageRank for contract importance scoring
 *     tags: [Graph Templates]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               iterations:
 *                 type: integer
 *                 default: 20
 *               dampingFactor:
 *                 type: number
 *                 default: 0.85
 *               limit:
 *                 type: integer
 *                 default: 100
 *     responses:
 *       200:
 *         description: PageRank results
 */
graphRouter.post(
  '/templates/pagerank',
  asyncHandler(async (req: Request, res: Response) => {
    const templates = getGraphTemplates();
    const result = await templates.pageRank(req.body);
    res.json(result);
  }),
);

/**
 * @swagger
 * /api/v1/graph/templates/transaction-flow:
 *   post:
 *     summary: Trace wallet transaction flow
 *     tags: [Graph Templates]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               address:
 *                 type: string
 *               depth:
 *                 type: integer
 *                 default: 3
 *               limit:
 *                 type: integer
 *                 default: 100
 *     responses:
 *       200:
 *         description: Transaction flow results
 */
graphRouter.post(
  '/templates/transaction-flow',
  asyncHandler(async (req: Request, res: Response) => {
    const templates = getGraphTemplates();
    const result = await templates.walletTransactionFlow(req.body);
    res.json(result);
  }),
);

/**
 * @swagger
 * /api/v1/graph/templates/token-network:
 *   post:
 *     summary: Analyze token transfer network
 *     tags: [Graph Templates]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               tokenAddress:
 *                 type: string
 *               limit:
 *                 type: integer
 *                 default: 100
 *     responses:
 *       200:
 *         description: Token network results
 */
graphRouter.post(
  '/templates/token-network',
  asyncHandler(async (req: Request, res: Response) => {
    const templates = getGraphTemplates();
    const result = await templates.tokenTransferNetwork(req.body);
    res.json(result);
  }),
);

/**
 * @swagger
 * /api/v1/graph/templates/contract-calls:
 *   post:
 *     summary: Visualize contract call graph
 *     tags: [Graph Templates]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               contractAddress:
 *                 type: string
 *               depth:
 *                 type: integer
 *                 default: 2
 *               limit:
 *                 type: integer
 *                 default: 100
 *     responses:
 *       200:
 *         description: Contract call graph results
 */
graphRouter.post(
  '/templates/contract-calls',
  asyncHandler(async (req: Request, res: Response) => {
    const templates = getGraphTemplates();
    const result = await templates.contractCallGraph(req.body);
    res.json(result);
  }),
);

// Schema for upstream graph query
const upstreamQuerySchema = z.object({
  maxDepth: z.coerce.number().int().min(1).max(10).optional().default(DEFAULT_MAX_DEPTH),
  maxNodes: z.coerce.number().int().min(1).max(100000).optional().default(DEFAULT_MAX_NODES),
  timeoutMs: z.coerce.number().int().min(100).max(30000).optional().default(DEFAULT_TIMEOUT_MS),
});

/**
 * @swagger
 * /api/v1/graph/contracts/:address/upstream:
 *   get:
 *     summary: Get upstream contract dependencies using frontier-paginated BFS
 *     tags: [Graph]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema:
 *           type: string
 *         description: Contract address to traverse upstream from
 *       - in: query
 *         name: maxDepth
 *         schema:
 *           type: integer
 *           default: 5
 *         description: Maximum traversal depth
 *       - in: query
 *         name: maxNodes
 *         schema:
 *           type: integer
 *           default: 10000
 *         description: Maximum nodes to visit
 *       - in: query
 *         name: timeoutMs
 *         schema:
 *           type: integer
 *           default: 5000
 *         description: Query timeout in milliseconds
 *     responses:
 *       200:
 *         description: Upstream dependency graph
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 startAddress: { type: string }
 *                 nodes: { type: array, items: { type: string } }
 *                 edges: { type: array, items: { type: object, properties: { source: { type: string }, target: { type: string } } } }
 *                 depthReached: { type: integer }
 *                 totalNodes: { type: integer }
 *                 totalEdges: { type: integer }
 *                 truncated: { type: boolean }
 *                 timedOut: { type: boolean }
 */
graphRouter.get(
  '/contracts/:address/upstream',
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    const opts = upstreamQuerySchema.parse(req.query);

    const result = await traverseUpstream(address, opts);

    res.json({
      startAddress: address,
      ...result,
    });
  }),
);

// Schema for downstream graph query (mirrors upstream — same knobs, different direction)
const downstreamQuerySchema = z.object({
  maxDepth: z.coerce.number().int().min(1).max(10).optional().default(DEFAULT_MAX_DEPTH),
  maxNodes: z.coerce.number().int().min(1).max(100000).optional().default(DEFAULT_MAX_NODES),
  timeoutMs: z.coerce.number().int().min(100).max(30000).optional().default(DEFAULT_TIMEOUT_MS),
});

/**
 * @swagger
 * /api/v1/graph/contracts/:address/downstream:
 *   get:
 *     summary: Get downstream contract dependencies using frontier-paginated BFS
 *     tags: [Graph]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema:
 *           type: string
 *         description: Contract address to traverse downstream from
 *       - in: query
 *         name: maxDepth
 *         schema:
 *           type: integer
 *           default: 5
 *         description: Maximum traversal depth
 *       - in: query
 *         name: maxNodes
 *         schema:
 *           type: integer
 *           default: 10000
 *         description: Maximum nodes to visit
 *       - in: query
 *         name: timeoutMs
 *         schema:
 *           type: integer
 *           default: 5000
 *         description: Query timeout in milliseconds
 *     responses:
 *       200:
 *         description: Downstream dependency graph
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 startAddress: { type: string }
 *                 nodes: { type: array, items: { type: string } }
 *                 edges: { type: array, items: { type: object, properties: { source: { type: string }, target: { type: string } } } }
 *                 depthReached: { type: integer }
 *                 totalNodes: { type: integer }
 *                 totalEdges: { type: integer }
 *                 truncated: { type: boolean }
 *                 timedOut: { type: boolean }
 */
graphRouter.get(
  '/contracts/:address/downstream',
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    const opts = downstreamQuerySchema.parse(req.query);

    const result = await traverseDownstream(address, opts);

    res.json({
      startAddress: address,
      ...result,
    });
  }),
);
