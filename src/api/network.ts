// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck
import { Router, Request, Response } from 'express';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck
import { prismaWrite as prisma } from '../db';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck
import { logger } from '../logger';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck
import { z } from 'zod';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck
import {
  analyzeQuorumIntersection,
  detectNetworkPartitions,
  calculateCentralityScores,
  detectVersionDrift,
  generateTopologyVisualization,
  buildQuorumSliceMap,
} from '../indexer/topology-analyzer';

const router = Router();

const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(['name', 'uptime24h', 'latency', 'agreementRate24h']).default('name'),
  order: z.enum(['asc', 'desc']).default('asc'),
});

// GET /api/v1/network/nodes - List all nodes with filtering
router.get('/nodes', async (req: Request, res: Response) => {
  try {
    const query = paginationSchema.parse(req.query);
    const { page, limit, sort, order } = query;
    const skip = (page - 1) * limit;

    const filters: any = { activeInNetwork: true };
    if (req.query.isValidator === 'true') filters.isValidator = true;
    if (req.query.country) filters.country = req.query.country as string;

    const [nodes, total] = await Promise.all([
      prisma.networkNode.findMany({
        where: filters,
        skip,
        take: limit,
        orderBy: { [sort]: order } as any,
        select: {
          id: true,
          publicKey: true,
          name: true,
          organization: true,
          isValidator: true,
          uptime24h: true,
          avgLatency: true,
          agreementRate24h: true,
          lastSeen: true,
          nodeType: true,
        },
      }),
      prisma.networkNode.count({ where: filters }),
    ]);

    res.json({
      nodes,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    logger.error('Error fetching nodes:', err);
    res.status(400).json({ error: 'Invalid query parameters' });
  }
});

// GET /api/v1/network/nodes/:publicKey - Node detail
router.get('/nodes/:publicKey', async (req: Request, res: Response) => {
  try {
    const { publicKey } = req.params;
    const hoursParam = req.query.hours ? parseInt(req.query.hours as string) : 24;

    const node = await prisma.networkNode.findUnique({
      where: { publicKey },
      include: {
        nodeMetrics: {
          where: {
            timestamp: {
              gte: new Date(Date.now() - hoursParam * 3600 * 1000),
            },
          },
          orderBy: { timestamp: 'desc' },
          take: 100,
        },
        nodeEvents: {
          orderBy: { timestamp: 'desc' },
          take: 50,
        },
      },
    });

    if (!node) {
      return res.status(404).json({ error: 'Node not found' });
    }

    res.json(node as any);
  } catch (err) {
    logger.error('Error fetching node:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/v1/network/nodes/:publicKey/quorum - Transitive quorum set
router.get('/nodes/:publicKey/quorum', async (req: Request, res: Response) => {
  try {
    const { publicKey } = req.params;

    const node = await prisma.networkNode.findUnique({
      where: { publicKey },
      select: { publicKey: true, quorumSet: true, transitiveQuorum: true },
    });

    if (!node) {
      return res.status(404).json({ error: 'Node not found' });
    }

    res.json({
      publicKey: node.publicKey,
      quorumSet: node.quorumSet as any,
      transitiveQuorum: node.transitiveQuorum as any,
    });
  } catch (err) {
    logger.error('Error fetching quorum:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/v1/network/nodes/:publicKey/events - Event history
router.get('/nodes/:publicKey/events', async (req: Request, res: Response) => {
  try {
    const { publicKey } = req.params;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);

    const node = await prisma.networkNode.findUnique({
      where: { publicKey },
      select: { id: true },
    });

    if (!node) {
      return res.status(404).json({ error: 'Node not found' });
    }

    const events = await prisma.networkNodeEvent.findMany({
      where: { nodeId: node.id },
      orderBy: { timestamp: 'desc' },
      take: limit,
    });

    res.json({ events });
  } catch (err) {
    logger.error('Error fetching node events:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/v1/network/nodes/:publicKey/metrics - Time-series metrics
router.get('/nodes/:publicKey/metrics', async (req: Request, res: Response) => {
  try {
    const { publicKey } = req.params;
    const hoursParam = req.query.hours ? parseInt(req.query.hours as string) : 24;

    const node = await prisma.networkNode.findUnique({
      where: { publicKey },
      select: { id: true },
    });

    if (!node) {
      return res.status(404).json({ error: 'Node not found' });
    }

    const metrics = await prisma.networkNodeMetric.findMany({
      where: {
        nodeId: node.id,
        timestamp: {
          gte: new Date(Date.now() - hoursParam * 3600 * 1000),
        },
      },
      orderBy: { timestamp: 'asc' },
    });

    res.json({ metrics, hours: hoursParam });
  } catch (err) {
    logger.error('Error fetching metrics:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/v1/network/consensus - Consensus health dashboard
router.get('/consensus', async (req: Request, res: Response) => {
  try {
    const hoursParam = parseInt(req.query.hours as string) || 24;

    const rounds = await prisma.networkConsensusRound.findMany({
      where: {
        startTime: {
          gte: new Date(Date.now() - hoursParam * 3600 * 1000),
        },
      },
      orderBy: { startTime: 'desc' },
    });

    const stats = {
      totalRounds: rounds.length,
      successfulRounds: rounds.filter(r => r.successful).length,
      successRate: rounds.length > 0 
        ? (rounds.filter(r => r.successful).length / rounds.length) * 100 
        : 0,
      avgDurationMs: rounds.length > 0
        ? rounds.reduce((sum, r) => sum + r.durationMs, 0) / rounds.length
        : 0,
      avgAgreementRate: rounds.length > 0
        ? rounds.reduce((sum, r) => sum + (r.agreementRate || 0), 0) / rounds.length
        : 0,
    };

    res.json({ stats, rounds: rounds.slice(0, 100) });
  } catch (err) {
    logger.error('Error fetching consensus health:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/v1/network/consensus/rounds - Consensus round details
router.get('/consensus/rounds', async (req: Request, res: Response) => {
  try {
    const ledgerMin = parseInt(req.query.ledgerMin as string) || 0;
    const ledgerMax = parseInt(req.query.ledgerMax as string) || 999999999;

    const rounds = await prisma.networkConsensusRound.findMany({
      where: {
        ledgerSeq: {
          gte: ledgerMin,
          lte: ledgerMax,
        },
      },
      orderBy: { ledgerSeq: 'asc' },
      take: 100,
    });

    res.json({ rounds });
  } catch (err) {
    logger.error('Error fetching consensus rounds:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/v1/network/versions - Software version distribution
router.get('/versions', async (req: Request, res: Response) => {
  try {
    const nodes = await prisma.networkNode.findMany({
      where: { activeInNetwork: true },
      select: { stellarCoreVersion: true, isValidator: true },
    });

    const versionMap = new Map<string, { validators: number; full_nodes: number }>();
    
    nodes.forEach(node => {
      const ver = node.stellarCoreVersion || 'unknown';
      if (!versionMap.has(ver)) {
        versionMap.set(ver, { validators: 0, full_nodes: 0 });
      }
      const entry = versionMap.get(ver)!;
      if (node.isValidator) entry.validators++;
      else entry.full_nodes++;
    });

    const versions = Array.from(versionMap.entries()).map(([version, counts]) => ({
      version,
      ...counts,
      total: counts.validators + counts.full_nodes,
    }));

    res.json({ versions });
  } catch (err) {
    logger.error('Error fetching versions:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/v1/network/geography - Geographic distribution
router.get('/geography', async (req: Request, res: Response) => {
  try {
    const nodes = await prisma.networkNode.findMany({
      where: { activeInNetwork: true },
      select: { country: true, city: true, isValidator: true, avgLatency: true },
    });

    const geoMap = new Map<string, { count: number; validators: number; avgLatency: number }>();
    
    nodes.forEach(node => {
      const key = node.country || 'unknown';
      if (!geoMap.has(key)) {
        geoMap.set(key, { count: 0, validators: 0, avgLatency: 0 });
      }
      const entry = geoMap.get(key)!;
      entry.count++;
      if (node.isValidator) entry.validators++;
      if (node.avgLatency) entry.avgLatency += node.avgLatency;
    });

    const geography = Array.from(geoMap.entries())
      .map(([country, data]) => ({
        country,
        count: data.count,
        validators: data.validators,
        avgLatency: data.count > 0 ? Math.round(data.avgLatency / data.count) : 0,
      }))
      .sort((a, b) => b.count - a.count);

    res.json({ geography });
  } catch (err) {
    logger.error('Error fetching geography:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/v1/network/health - Overall network health
router.get('/health', async (req: Request, res: Response) => {
  try {
    const [activeNodes, validators, avgLatency, avgAgreement] = await Promise.all([
      prisma.networkNode.count({ where: { activeInNetwork: true } }),
      prisma.networkNode.count({ where: { isValidator: true, activeInNetwork: true } }),
      prisma.networkNode.aggregate({
        where: { activeInNetwork: true },
        _avg: { avgLatency: true },
      }),
      prisma.networkNode.aggregate({
        where: { activeInNetwork: true },
        _avg: { agreementRate24h: true },
      }),
    ]);

    const recentRounds = await prisma.networkConsensusRound.findMany({
      where: {
        startTime: { gte: new Date(Date.now() - 3600 * 1000) },
      },
      orderBy: { startTime: 'desc' },
      take: 60,
    });

    const consensusHealth = recentRounds.length > 0
      ? (recentRounds.filter(r => r.successful).length / recentRounds.length) * 100
      : 0;

    res.json({
      activeNodes,
      validators,
      averageLatency: Math.round(avgLatency._avg.avgLatency || 0),
      averageAgreementRate: Math.round((avgAgreement._avg.agreementRate24h || 0) * 100) / 100,
      consensusHealth: Math.round(consensusHealth * 100) / 100,
      timestamp: new Date(),
    });
  } catch (err) {
    logger.error('Error fetching network health:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/v1/network/nodes/import - Bulk import nodes
router.post('/nodes/import', async (req: Request, res: Response) => {
  try {
    const { nodes } = req.body;

    if (!Array.isArray(nodes) || nodes.length === 0) {
      return res.status(400).json({ error: 'Invalid nodes array' });
    }

    const results = [];

    for (const nodeData of nodes) {
      try {
        const existing = await prisma.networkNode.findUnique({
          where: { publicKey: nodeData.publicKey },
        });

        if (existing) {
          await prisma.networkNode.update({
            where: { publicKey: nodeData.publicKey },
            data: {
              version: nodeData.version,
              isValidator: nodeData.isValidator,
              lastSeen: new Date(),
              updatedAt: new Date(),
            },
          });
          results.push({ publicKey: nodeData.publicKey, status: 'updated' });
        } else {
          await prisma.networkNode.create({
            data: {
              publicKey: nodeData.publicKey,
              version: nodeData.version,
              isValidator: nodeData.isValidator,
              firstSeen: new Date(),
              lastSeen: new Date(),
              activeInNetwork: true,
            },
          });
          results.push({ publicKey: nodeData.publicKey, status: 'created' });
        }
      } catch (e) {
        results.push({ publicKey: nodeData.publicKey, status: 'error', error: String(e) });
      }
    }

    res.json({ imported: results.length, results });
  } catch (err) {
    logger.error('Error importing nodes:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/v1/network/topology - Full quorum set topology graph
router.get('/topology', async (req: Request, res: Response) => {
  try {
    const visualization = await generateTopologyVisualization();
    res.json(visualization);
  } catch (err) {
    logger.error('Error generating topology:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/v1/network/topology/quorum-slices/:publicKey
router.get('/topology/quorum-slices/:publicKey', async (req: Request, res: Response) => {
  try {
    const { publicKey } = req.params;
    const sliceMap = await buildQuorumSliceMap(publicKey);
    res.json(sliceMap);
  } catch (err) {
    logger.error('Error fetching quorum slices:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/v1/network/topology/intersection
router.get('/topology/intersection', async (req: Request, res: Response) => {
  try {
    const { publicKeys } = req.query;
    
    if (!publicKeys || !Array.isArray(publicKeys)) {
      return res.status(400).json({ error: 'publicKeys array required' });
    }

    const analysis = await analyzeQuorumIntersection(publicKeys as string[]);
    res.json(analysis);
  } catch (err) {
    logger.error('Error analyzing intersection:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/v1/network/topology/partitions
router.get('/topology/partitions', async (req: Request, res: Response) => {
  try {
    const partitions = await detectNetworkPartitions();
    res.json({ 
      partitionCount: partitions.length,
      isPartitioned: partitions.length > 1,
      partitions,
    });
  } catch (err) {
    logger.error('Error detecting partitions:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/v1/network/topology/centrality
router.get('/topology/centrality', async (req: Request, res: Response) => {
  try {
    const scores = await calculateCentralityScores();
    const sorted = Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 100);

    res.json({
      centrality: Object.fromEntries(sorted),
      topNodes: sorted.map(([key]) => key),
    });
  } catch (err) {
    logger.error('Error calculating centrality:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/v1/network/versions/outdated
router.get('/versions/outdated', async (req: Request, res: Response) => {
  try {
    const drift = await detectVersionDrift();
    
    if (!drift.driftDetected || drift.outdatedNodes.length === 0) {
      return res.json({ outdatedNodes: [], driftDetected: false });
    }

    const nodes = await prisma.networkNode.findMany({
      where: { publicKey: { in: drift.outdatedNodes } },
      select: {
        publicKey: true,
        name: true,
        organization: true,
        stellarCoreVersion: true,
      },
    });

    res.json({
      majorityVersion: drift.majorityVersion,
      minorityVersions: drift.minorityVersions,
      outdatedNodes: nodes,
      recommendation: 'Warning: version distribution is uneven',
    });
  } catch (err) {
    logger.error('Error fetching outdated nodes:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/v1/network/versions/history
router.get('/versions/history', async (req: Request, res: Response) => {
  try {
    const daysParam = parseInt(req.query.days as string) || 30;

    const events = await prisma.networkNodeEvent.findMany({
      where: {
        eventType: 'version_change',
        timestamp: {
          gte: new Date(Date.now() - daysParam * 24 * 3600 * 1000),
        },
      },
      orderBy: { timestamp: 'asc' },
      take: 1000,
    });

    const timeline = events.reduce((acc, evt) => {
      const date = evt.timestamp.toISOString().split('T')[0];
      if (!acc[date]) acc[date] = 0;
      acc[date]++;
      return acc;
    }, {} as Record<string, number>);

    res.json({ timeline, totalChanges: events.length });
  } catch (err) {
    logger.error('Error fetching version history:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as networkRouter };
