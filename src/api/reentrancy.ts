/**
 * Soroban Reentrancy Fortress — Security API Endpoints
 *
 * 12 core security API endpoints for cross-contract reentrancy analysis.
 * Issue #307
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prismaRead, prismaWrite } from '../db';
import {
  buildCallGraph,
  detectReentrancy,
  getPatternDefinitions,
  getRiskLevel,
  hasLoops,
  computeMaxDepth,
  computeAvgDepth,
  uniqueContractCount,
} from '../indexer/reentrancy-fortress';
import { asyncHandler } from '../middleware/asyncHandler';
import { validateAddressParam } from '../middleware/sanitize';

export const reentrancyRouter = Router();

// ── Helper: format contract address for display ──────────────────────────────

function shortAddr(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-6)}` : addr;
}

// ── Validation schemas ───────────────────────────────────────────────────────

const scanSchema = z.object({
  txHash: z.string().optional(),
  contractAddress: z.string().optional(),
  calls: z
    .array(
      z.object({
        contractId: z.string(),
        functionName: z.string(),
        depth: z.number().int().min(0).default(0),
        callIndex: z.number().int().min(0).default(0),
        value: z.string().optional(),
        preStateReads: z.array(z.string()).optional(),
        postStateWrites: z.array(z.string()).optional(),
        gasForwarded: z.number().int().optional(),
        argsHash: z.string().optional(),
      }),
    )
    .optional(),
});

// ═══════════════════════════════════════════════════════════════════════════════
// 1. GET /contracts/:address — Full risk report with findings
// ═══════════════════════════════════════════════════════════════════════════════

reentrancyRouter.get(
  '/contracts/:address',
  validateAddressParam,
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;

    const [riskScore, findings, vertices, alerts] = await Promise.all([
      prismaRead.contractRiskScore.findUnique({
        where: { contractAddress: address },
      }),
      prismaRead.reentrancyFinding.findMany({
        where: { contractAddress: address },
        orderBy: { detectedAt: 'desc' },
        take: 50,
      }),
      prismaRead.callGraphVertex.findMany({
        where: { contractAddress: address },
        orderBy: { timestamp: 'desc' },
        take: 100,
      }),
      prismaRead.reentrancyAlertExtended.findMany({
        where: { contractAddress: address },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    ]);

    const riskLevel = riskScore ? getRiskLevel(riskScore.riskScore) : 'safe';

    res.json({
      contract: address,
      displayName: shortAddr(address),
      riskScore: riskScore
        ? {
            score: riskScore.riskScore,
            previousScore: riskScore.previousScore,
            level: riskLevel,
            findings: {
              total: riskScore.totalFindings,
              critical: riskScore.criticalFindings,
              high: riskScore.highFindings,
              medium: riskScore.mediumFindings,
            },
            riskFactors: riskScore.riskFactors,
            lastAnalyzed: riskScore.lastAnalyzed,
            trend: riskScore.previousScore
              ? riskScore.riskScore > riskScore.previousScore
                ? 'increasing'
                : riskScore.riskScore < riskScore.previousScore
                  ? 'decreasing'
                  : 'stable'
              : 'new',
          }
        : null,
      findings: findings.map((f) => ({
        id: f.id,
        txHash: f.txHash,
        type: f.reentrancyType,
        severity: f.severity,
        likelihood: f.likelihood,
        loopPath: f.loopPath,
        entryPoint: f.entryPoint,
        valueAtRisk: f.valueAtRisk,
        usdValueAtRisk: f.usdValueAtRisk,
        description: f.description,
        detectedAt: f.detectedAt,
      })),
      callGraphActivity: {
        totalVertices: vertices.length,
        uniqueTxs: new Set(vertices.map((v) => v.txHash)).size,
        lastActivity: vertices[0]?.timestamp ?? null,
      },
      recentAlerts: alerts
        .filter((a) => !a.acknowledged)
        .map((a) => ({
          id: a.id,
          alertType: a.alertType,
          severity: a.severity,
          message: a.message,
          createdAt: a.createdAt,
          acknowledged: a.acknowledged,
        })),
    });
  }),
);

// ═══════════════════════════════════════════════════════════════════════════════
// 2. GET /transactions/:txHash — Analyze specific tx with call graph
// ═══════════════════════════════════════════════════════════════════════════════

reentrancyRouter.get(
  '/transactions/:txHash',
  asyncHandler(async (req: Request, res: Response) => {
    const { txHash } = req.params;

    const [vertices, edges, findings] = await Promise.all([
      prismaRead.callGraphVertex.findMany({
        where: { txHash },
        orderBy: { callIndex: 'asc' },
      }),
      prismaRead.callGraphEdge.findMany({
        where: { txHash },
        orderBy: { callIndex: 'asc' },
      }),
      prismaRead.reentrancyFinding.findMany({
        where: { txHash },
      }),
    ]);

    if (vertices.length === 0) {
      return res.status(404).json({
        error: 'Not found',
        message: 'No call graph data for this transaction. Use POST /scan to analyze.',
      });
    }

    const graph = { vertices: vertices as any, edges: edges as any };

    res.json({
      txHash,
      callGraph: {
        vertices: vertices.map((v) => ({
          id: v.id,
          contractAddress: v.contractAddress,
          functionName: v.functionName,
          depth: v.depth,
          callIndex: v.callIndex,
          value: v.value,
        })),
        edges: edges.map((e) => ({
          fromVertexId: e.fromVertexId,
          toVertexId: e.toVertexId,
          functionName: e.functionName,
          value: e.value,
          gasForwarded: e.gasForwarded,
        })),
      },
      analysis: {
        maxDepth: computeMaxDepth(graph),
        avgDepth: computeAvgDepth(graph),
        uniqueContracts: uniqueContractCount(graph),
        hasLoops: hasLoops(graph),
      },
      findings: findings.map((f) => ({
        type: f.reentrancyType,
        severity: f.severity,
        likelihood: f.likelihood,
        loopPath: f.loopPath,
        description: f.description,
      })),
    });
  }),
);

// ═══════════════════════════════════════════════════════════════════════════════
// 3. GET /transactions/:txHash/graph — SVG/JSON call graph visualization
// ═══════════════════════════════════════════════════════════════════════════════

reentrancyRouter.get(
  '/transactions/:txHash/graph',
  asyncHandler(async (req: Request, res: Response) => {
    const { txHash } = req.params;
    const format = (req.query.format as string) ?? 'json';

    const [vertices, edges] = await Promise.all([
      prismaRead.callGraphVertex.findMany({
        where: { txHash },
        orderBy: { callIndex: 'asc' },
      }),
      prismaRead.callGraphEdge.findMany({
        where: { txHash },
      }),
    ]);

    if (vertices.length === 0) {
      return res.status(404).json({ error: 'No call graph found for this transaction' });
    }

    // Build D3.js-compatible graph nodes and links
    const nodes = vertices.map((v) => ({
      id: v.id,
      contractAddress: v.contractAddress,
      functionName: v.functionName,
      depth: v.depth,
      // Color-coded by risk: green → yellow → red based on depth
      color: v.depth >= 4 ? '#ef4444' : v.depth >= 2 ? '#f59e0b' : '#22c55e',
      // Node size proportional to position in call chain
      size: 8 + v.depth * 2,
    }));

    const links = edges.map((e) => ({
      source: e.fromVertexId,
      target: e.toVertexId,
      label: e.functionName,
      value: e.value,
    }));

    if (format === 'html') {
      // Generate an HTML page with embedded D3.js/vis-network visualization
      const graphData = JSON.stringify({ nodes, links });
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reentrancy Call Graph — ${txHash.slice(0, 12)}…</title>
  <script src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', system-ui, sans-serif; background: #0f172a; color: #e2e8f0; overflow: hidden; }
    #header { padding: 1rem 1.5rem; background: #1e293b; border-bottom: 1px solid #334155; display: flex; justify-content: space-between; align-items: center; }
    #header h1 { font-size: 1.25rem; font-weight: 600; }
    .legend { display: flex; gap: 1rem; }
    .legend-item { display: flex; align-items: center; gap: 0.4rem; font-size: 0.825rem; }
    .legend-dot { width: 12px; height: 12px; border-radius: 50%; }
    #graph { width: 100vw; height: calc(100vh - 60px); }
    .tooltip { position: absolute; background: #1e293b; border: 1px solid #475569; padding: 0.75rem; border-radius: 8px; font-size: 0.8rem; pointer-events: none; opacity: 0; transition: opacity 0.2s; max-width: 300px; z-index: 10; }
    .reentrant { animation: pulse 2s infinite; }
    @keyframes pulse { 0%, 100% { stroke-width: 2; } 50% { stroke-width: 5; stroke: #ef4444; } }
  </style>
</head>
<body>
  <div id="header">
    <h1>🔍 Call Graph — ${txHash.slice(0, 12)}…</h1>
    <div class="legend">
      <div class="legend-item"><span class="legend-dot" style="background:#22c55e" title="Depth 0-1"></span>Shallow</div>
      <div class="legend-item"><span class="legend-dot" style="background:#f59e0b" title="Depth 2-3"></span>Medium</div>
      <div class="legend-item"><span class="legend-dot" style="background:#ef4444" title="Depth 4+"></span>Deep</div>
    </div>
  </div>
  <div id="graph"></div>
  <script>
    const data = ${graphData};
    const container = document.getElementById('graph');
    const nodes = new vis.DataSet(data.nodes.map(n => ({
      id: n.id,
      label: n.functionName + '\\n' + n.contractAddress.slice(0,8) + '…',
      title: 'Contract: ' + n.contractAddress + '\\nFunction: ' + n.functionName + '\\nDepth: ' + n.depth,
      color: { background: n.color, border: '#475569', highlight: { background: n.color, border: '#94a3b8' } },
      shape: 'box',
      font: { color: '#e2e8f0', size: 11 },
      margin: 10,
      widthConstraint: 140,
    })));
    const edges = new vis.DataSet(data.links.map(l => ({
      from: l.source,
      to: l.target,
      label: l.label,
      arrows: 'to',
      color: { color: '#64748b', highlight: '#94a3b8' },
      font: { color: '#94a3b8', size: 9, align: 'middle' },
    })));
    const network = new vis.Network(container, { nodes, edges }, {
      physics: { solver: 'forceAtlas2Based', forceAtlas2Based: { gravitationalConstant: -50 } },
      interaction: { dragNodes: true, dragView: true, zoomView: true },
      layout: { hierarchical: { enabled: true, direction: 'LR', sortMethod: 'directed' } },
      edges: { smooth: { type: 'curvedCW', roundness: 0.2 } },
    });
  </script>
</body>
</html>`;
      res.setHeader('Content-Type', 'text/html');
      return res.send(html);
    }

    // Default JSON format
    res.json({
      txHash,
      nodes,
      links,
      summary: {
        totalVertices: nodes.length,
        totalEdges: links.length,
        maxDepth: Math.max(...nodes.map((n) => n.depth)),
        uniqueContracts: new Set(nodes.map((n) => n.contractAddress)).size,
      },
    });
  }),
);

// ═══════════════════════════════════════════════════════════════════════════════
// 4. GET /leaderboard — Most at-risk contracts
// ═══════════════════════════════════════════════════════════════════════════════

reentrancyRouter.get(
  '/leaderboard',
  asyncHandler(async (req: Request, res: Response) => {
    const sort = (req.query.sort as string) ?? 'risk_score';
    const limit = Math.min(200, parseInt((req.query.limit as string) ?? '50', 10));

    let orderBy: any = { riskScore: 'desc' };
    if (sort === 'findings') orderBy = { totalFindings: 'desc' };
    else if (sort === 'critical') orderBy = { criticalFindings: 'desc' };
    else if (sort === 'recent') orderBy = { lastAnalyzed: 'desc' };

    const scores = await prismaRead.contractRiskScore.findMany({
      take: limit,
      orderBy,
    });

    const contractAddresses = scores.map((s) => s.contractAddress);
    const contracts = await prismaRead.contract.findMany({
      where: { address: { in: contractAddresses } },
      select: { address: true, name: true },
    });
    const nameMap = Object.fromEntries(contracts.map((c) => [c.address, c.name]));

    res.json({
      leaderboard: scores.map((s, i) => ({
        rank: i + 1,
        contract: s.contractAddress,
        name: nameMap[s.contractAddress] ?? null,
        riskScore: s.riskScore,
        riskLevel: getRiskLevel(s.riskScore),
        totalFindings: s.totalFindings,
        criticalFindings: s.criticalFindings,
        highFindings: s.highFindings,
        previousScore: s.previousScore,
        trend:
          s.previousScore != null
            ? s.riskScore > s.previousScore
              ? '↑ increasing'
              : s.riskScore < s.previousScore
                ? '↓ decreasing'
                : '→ stable'
            : 'new',
        lastAnalyzed: s.lastAnalyzed,
      })),
    });
  }),
);

// ═══════════════════════════════════════════════════════════════════════════════
// 5. GET /recent — Recent dangerous transactions
// ═══════════════════════════════════════════════════════════════════════════════

reentrancyRouter.get(
  '/recent',
  asyncHandler(async (req: Request, res: Response) => {
    const hours = parseInt((req.query.hours as string) ?? '24', 10);
    const severity = (req.query.severity as string) ?? 'CRITICAL';
    const limit = Math.min(100, parseInt((req.query.limit as string) ?? '50', 10));

    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const findings = await prismaRead.reentrancyFinding.findMany({
      where: {
        severity: severity as any,
        detectedAt: { gte: since },
      },
      orderBy: { detectedAt: 'desc' },
      take: limit,
    });

    res.json({
      period: `last_${hours}h`,
      severity,
      total: findings.length,
      transactions: findings.map((f) => ({
        txHash: f.txHash,
        contractAddress: f.contractAddress,
        type: f.reentrancyType,
        severity: f.severity,
        likelihood: f.likelihood,
        loopLength: (f.loopPath as any[]).length,
        valueAtRisk: f.valueAtRisk,
        usdValueAtRisk: f.usdValueAtRisk,
        description: f.description,
        detectedAt: f.detectedAt,
      })),
    });
  }),
);

// ═══════════════════════════════════════════════════════════════════════════════
// 6. GET /loops — Discovered call loops
// ═══════════════════════════════════════════════════════════════════════════════

reentrancyRouter.get(
  '/loops',
  asyncHandler(async (req: Request, res: Response) => {
    const minLength = parseInt((req.query.min_length as string) ?? '3', 10);
    const limit = Math.min(100, parseInt((req.query.limit as string) ?? '50', 10));

    const findings = await prismaRead.reentrancyFinding.findMany({
      orderBy: { detectedAt: 'desc' },
      take: 500, // Fetch more to filter by loop length
    });

    const loopFindings = findings
      .filter((f) => (f.loopPath as any[]).length >= minLength)
      .slice(0, limit);

    res.json({
      minLoopLength: minLength,
      totalLoopsFound: loopFindings.length,
      loops: loopFindings.map((f) => ({
        txHash: f.txHash,
        contractAddress: f.contractAddress,
        type: f.reentrancyType,
        severity: f.severity,
        likelihood: f.likelihood,
        loopLength: (f.loopPath as any[]).length,
        loopPath: f.loopPath,
        description: f.description,
        detectedAt: f.detectedAt,
      })),
    });
  }),
);

// ═══════════════════════════════════════════════════════════════════════════════
// 7. GET /stats — Overall platform statistics
// ═══════════════════════════════════════════════════════════════════════════════

reentrancyRouter.get(
  '/stats',
  asyncHandler(async (_req: Request, res: Response) => {
    const latestStats = await prismaRead.reentrancyStats.findFirst({
      orderBy: { timestamp: 'desc' },
    });

    const [totalVertices, totalEdges, totalAlerts, unacknowledgedAlerts] = await Promise.all([
      prismaRead.callGraphVertex.count(),
      prismaRead.callGraphEdge.count(),
      prismaRead.reentrancyAlertExtended.count(),
      prismaRead.reentrancyAlertExtended.count({
        where: { acknowledged: false },
      }),
    ]);

    res.json({
      latestSnapshot: latestStats,
      runningTotals: {
        totalCallGraphVertices: totalVertices,
        totalCallGraphEdges: totalEdges,
        totalAlerts,
        unacknowledgedAlerts,
      },
      generatedAt: new Date().toISOString(),
    });
  }),
);

// ═══════════════════════════════════════════════════════════════════════════════
// 8. GET /patterns — All known reentrancy patterns with examples
// ═══════════════════════════════════════════════════════════════════════════════

reentrancyRouter.get(
  '/patterns',
  asyncHandler(async (_req: Request, res: Response) => {
    const patterns = getPatternDefinitions();

    res.json({
      patternCount: patterns.length,
      patterns,
    });
  }),
);

// ═══════════════════════════════════════════════════════════════════════════════
// 9. GET /alerts — Alert history
// ═══════════════════════════════════════════════════════════════════════════════

reentrancyRouter.get(
  '/alerts',
  asyncHandler(async (req: Request, res: Response) => {
    const contract = req.query.contract as string | undefined;
    const severity = req.query.severity as string | undefined;
    const acknowledged = req.query.acknowledged as string | undefined;
    const limit = Math.min(100, parseInt((req.query.limit as string) ?? '50', 10));

    const where: any = {};
    if (contract) where.contractAddress = contract;
    if (severity) where.severity = severity;
    if (acknowledged === 'true') where.acknowledged = true;
    else if (acknowledged === 'false') where.acknowledged = false;

    const alerts = await prismaRead.reentrancyAlertExtended.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    res.json({
      total: alerts.length,
      alerts: alerts.map((a) => ({
        id: a.id,
        contractAddress: a.contractAddress,
        alertType: a.alertType,
        severity: a.severity,
        message: a.message,
        metadata: a.metadata,
        acknowledged: a.acknowledged,
        acknowledgedAt: a.acknowledgedAt,
        createdAt: a.createdAt,
      })),
    });
  }),
);

// ═══════════════════════════════════════════════════════════════════════════════
// 10. POST /alerts/:id/acknowledge — Acknowledge alert
// ═══════════════════════════════════════════════════════════════════════════════

reentrancyRouter.post(
  '/alerts/:id/acknowledge',
  asyncHandler(async (req: Request, res: Response) => {
    const alert = await prismaWrite.reentrancyAlertExtended.update({
      where: { id: req.params.id },
      data: {
        acknowledged: true,
        acknowledgedAt: new Date(),
      },
    });

    if (!alert) {
      return res.status(404).json({ error: 'Alert not found' });
    }

    res.json({
      id: alert.id,
      acknowledged: alert.acknowledged,
      acknowledgedAt: alert.acknowledgedAt,
    });
  }),
);

// ═══════════════════════════════════════════════════════════════════════════════
// 11. GET /graph/contracts/:address — Contract's call graph (all time)
// ═══════════════════════════════════════════════════════════════════════════════

reentrancyRouter.get(
  '/graph/contracts/:address',
  validateAddressParam,
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    const limit = Math.min(200, parseInt((req.query.limit as string) ?? '100', 10));

    const vertices = await prismaRead.callGraphVertex.findMany({
      where: { contractAddress: address },
      orderBy: { timestamp: 'desc' },
      take: limit,
    });

    const txHashes = [...new Set(vertices.map((v) => v.txHash))];
    const edges = await prismaRead.callGraphEdge.findMany({
      where: { txHash: { in: txHashes } },
    });

    const allVertexIds = new Set(vertices.map((v) => v.id));

    const nodes = vertices.map((v) => ({
      id: v.id,
      contractAddress: v.contractAddress,
      functionName: v.functionName,
      depth: v.depth,
    }));

    const links = edges
      .filter((e) => allVertexIds.has(e.fromVertexId) || allVertexIds.has(e.toVertexId))
      .map((e) => ({
        source: e.fromVertexId,
        target: e.toVertexId,
        functionName: e.functionName,
      }));

    res.json({
      contract: address,
      displayName: shortAddr(address),
      graph: { nodes, links },
      summary: {
        totalVertices: nodes.length,
        totalEdges: links.length,
        uniqueTransactions: txHashes.length,
      },
    });
  }),
);

// ═══════════════════════════════════════════════════════════════════════════════
// 12. POST /scan — Manual scan of specific contract/tx
// ═══════════════════════════════════════════════════════════════════════════════

reentrancyRouter.post(
  '/scan',
  asyncHandler(async (req: Request, res: Response) => {
    const body = scanSchema.parse(req.body);

    // If a txHash is provided, try to fetch existing data
    if (body.txHash && !body.calls) {
      const existingVertices = await prismaRead.callGraphVertex.findMany({
        where: { txHash: body.txHash },
        orderBy: { callIndex: 'asc' },
      });

      if (existingVertices.length > 0) {
        const existingEdges = await prismaRead.callGraphEdge.findMany({
          where: { txHash: body.txHash },
        });

        const graph = {
          vertices: existingVertices as any,
          edges: existingEdges as any,
        };
        const findings = detectReentrancy(body.txHash, graph);

        return res.json({
          txHash: body.txHash,
          source: 'existing',
          callGraph: {
            vertexCount: existingVertices.length,
            edgeCount: existingEdges.length,
            maxDepth: computeMaxDepth(graph),
            uniqueContracts: uniqueContractCount(graph),
          },
          findings: findings.map((f) => ({
            type: f.reentrancyType,
            severity: f.severity,
            likelihood: f.likelihood,
            loopPath: f.loopPath,
            description: f.description,
          })),
          totalFindings: findings.length,
          criticalFindings: findings.filter((f) => f.severity === 'CRITICAL').length,
        });
      }

      return res.status(404).json({
        error: 'No call graph data available',
        message: 'Supply "calls" array in request body to analyze directly.',
      });
    }

    // Analyze from provided calls
    if (!body.calls || body.calls.length === 0) {
      return res.status(400).json({
        error: 'No calls provided',
        message: 'Supply either txHash or calls array.',
      });
    }

    const txHash = body.txHash ?? `scan_${Date.now()}`;
    const graph = buildCallGraph(txHash, body.calls);
    const findings = detectReentrancy(txHash, graph);

    res.json({
      txHash,
      source: 'provided_calls',
      callGraph: {
        vertexCount: graph.vertices.length,
        edgeCount: graph.edges.length,
        maxDepth: computeMaxDepth(graph),
        uniqueContracts: uniqueContractCount(graph),
        hasLoops: hasLoops(graph),
      },
      findings: findings.map((f) => ({
        type: f.reentrancyType,
        severity: f.severity,
        likelihood: f.likelihood,
        loopPath: f.loopPath,
        description: f.description,
      })),
      totalFindings: findings.length,
      criticalFindings: findings.filter((f) => f.severity === 'CRITICAL').length,
    });
  }),
);

// ── Bonus: Additional endpoints for Should-Have features ─────────────────────
// These go beyond the 12 core endpoints

// GET /contracts/:address/state-deps — State dependency analysis
reentrancyRouter.get(
  '/contracts/:address/state-deps',
  validateAddressParam,
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    const vertices = await prismaRead.callGraphVertex.findMany({
      where: { contractAddress: address },
      select: {
        preStateReads: true,
        postStateWrites: true,
        txHash: true,
        functionName: true,
      },
      take: 200,
    });

    // Aggregate state read/write patterns
    const allReads = new Map<string, number>();
    const allWrites = new Map<string, number>();
    const conflicts: Array<{
      txHash: string;
      functionName: string;
      readKeys: string[];
      writeKeys: string[];
      overlappingKeys: string[];
    }> = [];

    for (const v of vertices) {
      const reads = (v.preStateReads as string[]) ?? [];
      const writes = (v.postStateWrites as string[]) ?? [];

      for (const key of reads) {
        allReads.set(key, (allReads.get(key) ?? 0) + 1);
      }
      for (const key of writes) {
        allWrites.set(key, (allWrites.get(key) ?? 0) + 1);
      }

      const overlapping = reads.filter((k) => writes.includes(k));
      if (overlapping.length > 0) {
        conflicts.push({
          txHash: v.txHash,
          functionName: v.functionName,
          readKeys: reads,
          writeKeys: writes,
          overlappingKeys: overlapping,
        });
      }
    }

    res.json({
      contract: address,
      stateReads: {
        mostRead: [...allReads.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 20)
          .map(([key, count]) => ({ key, count })),
        uniqueReadKeys: allReads.size,
      },
      stateWrites: {
        mostWritten: [...allWrites.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 20)
          .map(([key, count]) => ({ key, count })),
        uniqueWriteKeys: allWrites.size,
      },
      writeThenReadConflicts: conflicts,
      conflictCount: conflicts.length,
    });
  }),
);
