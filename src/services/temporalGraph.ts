import { getGraphDb } from '../db/graph';
import { PrismaClient } from '@prisma/client';
import { logger } from '../logger';

/**
 * Temporal Graph Analysis
 * Analyzes how the contract call graph evolves over time
 * Detects new hubs forming, isolated subgraphs, and temporal patterns
 */

export interface TemporalMetrics {
  date: Date;
  nodeCount: number;
  edgeCount: number;
  avgDegree: number;
  maxDegree: number;
  communityCount: number;
  modularityScore: number;
  newHubs: string[];
  isolatedSubgraphs: number;
}

export interface GraphEvolution {
  startDate: Date;
  endDate: Date;
  metrics: TemporalMetrics[];
  trends: {
    nodeGrowthRate: number;
    edgeGrowthRate: number;
    hubFormationRate: number;
    communityStability: number;
  };
}

export class TemporalGraphAnalyzer {
  private graphDb;
  private prisma: PrismaClient;

  constructor() {
    this.graphDb = getGraphDb();
    this.prisma = new PrismaClient();
  }

  /**
   * Analyze graph evolution over time
   */
  async analyzeEvolution(days: number = 30): Promise<GraphEvolution> {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    logger.info('Starting temporal graph analysis', { startDate, endDate, days });

    try {
      // Get historical metrics
      const metrics = await this.getHistoricalMetrics(startDate, endDate);

      // Calculate trends
      const trends = this.calculateTrends(metrics);

      return {
        startDate,
        endDate,
        metrics,
        trends,
      };
    } catch (error) {
      logger.error('Temporal graph analysis failed', { error });
      throw error;
    }
  }

  /**
   * Get historical metrics from database
   */
  private async getHistoricalMetrics(startDate: Date, endDate: Date): Promise<TemporalMetrics[]> {
    const result = await this.prisma.$queryRaw<TemporalMetrics[]>`
      SELECT 
        snapshot_date as date,
        node_count as "nodeCount",
        edge_count as "edgeCount",
        avg_degree as "avgDegree",
        max_degree as "maxDegree",
        community_count as "communityCount",
        modularity_score as "modularityScore",
        new_hubs as "newHubs",
        isolated_subgraphs as "isolatedSubgraphs"
      FROM graph_metrics_snapshot
      WHERE snapshot_date >= ${startDate} AND snapshot_date <= ${endDate}
      ORDER BY snapshot_date ASC
    `;

    return result;
  }

  /**
   * Calculate trends from metrics
   */
  private calculateTrends(metrics: TemporalMetrics[]): {
    nodeGrowthRate: number;
    edgeGrowthRate: number;
    hubFormationRate: number;
    communityStability: number;
  } {
    if (metrics.length < 2) {
      return {
        nodeGrowthRate: 0,
        edgeGrowthRate: 0,
        hubFormationRate: 0,
        communityStability: 0,
      };
    }

    const first = metrics[0];
    const last = metrics[metrics.length - 1];
    const days = metrics.length;

    const nodeGrowthRate = ((last.nodeCount - first.nodeCount) / first.nodeCount) * 100 / days;
    const edgeGrowthRate = ((last.edgeCount - first.edgeCount) / first.edgeCount) * 100 / days;
    const hubFormationRate = last.newHubs.length / days;
    const communityStability = 1 - Math.abs(last.communityCount - first.communityCount) / first.communityCount;

    return {
      nodeGrowthRate,
      edgeGrowthRate,
      hubFormationRate,
      communityStability,
    };
  }

  /**
   * Detect new hubs forming in the graph
   */
  async detectNewHubs(threshold: number = 100): Promise<string[]> {
    const query = `
      MATCH (c:Contract)
      WHERE c.degree > $threshold
      AND c.createdAt > datetime() - duration('P7D')
      RETURN c.address as address, c.degree as degree
      ORDER BY degree DESC
      LIMIT 20
    `;

    const result = await this.graphDb.executeCypher(query, { threshold });
    return result.data.map((item: any) => item.address);
  }

  /**
   * Detect isolated subgraphs
   */
  async detectIsolatedSubgraphs(minSize: number = 5): Promise<number> {
    const query = `
      MATCH (n)
      WHERE NOT (n)--()
      WITH count(n) as isolatedCount
      RETURN isolatedCount
    `;

    const result = await this.graphDb.executeCypher(query, {});
    return result.data[0]?.isolatedCount || 0;
  }

  /**
   * Analyze edge growth rate over time
   */
  async analyzeEdgeGrowth(hours: number = 24): Promise<{
    hourlyGrowth: number[];
    totalGrowth: number;
    peakHour: number;
  }> {
    const query = `
      MATCH ()-[r]->()
      WHERE r.timestamp >= datetime() - duration('PT${hours}H')
      WITH r.timestamp as timestamp
      RETURN date.trunc('hour', timestamp) as hour, count(r) as edgeCount
      ORDER BY hour ASC
    `;

    const result = await this.graphDb.executeCypher(query, {});
    const hourlyData = result.data;

    const hourlyGrowth = hourlyData.map((d: any) => d.edgeCount);
    const totalGrowth = hourlyGrowth.reduce((sum: number, val: number) => sum + val, 0);
    const peakHourIndex = hourlyGrowth.indexOf(Math.max(...hourlyGrowth));

    return {
      hourlyGrowth,
      totalGrowth,
      peakHour: peakHourIndex,
    };
  }

  /**
   * Analyze node churn rate
   */
  async analyzeNodeChurn(days: number = 7): Promise<{
    newNodes: number;
    inactiveNodes: number;
    churnRate: number;
  }> {
    const newNodesQuery = `
      MATCH (n)
      WHERE n.createdAt >= datetime() - duration('P${days}D')
      RETURN count(n) as count
    `;

    const inactiveNodesQuery = `
      MATCH (n)
      WHERE n.lastActive < datetime() - duration('P${days}D')
      RETURN count(n) as count
    `;

    const [newNodesResult, inactiveNodesResult] = await Promise.all([
      this.graphDb.executeCypher(newNodesQuery, {}),
      this.graphDb.executeCypher(inactiveNodesQuery, {}),
    ]);

    const newNodes = newNodesResult.data[0]?.count || 0;
    const inactiveNodes = inactiveNodesResult.data[0]?.count || 0;
    const totalNodes = await this.getTotalNodeCount();
    const churnRate = totalNodes > 0 ? (inactiveNodes / totalNodes) * 100 : 0;

    return {
      newNodes,
      inactiveNodes,
      churnRate,
    };
  }

  /**
   * Get total node count
   */
  private async getTotalNodeCount(): Promise<number> {
    const query = 'MATCH (n) RETURN count(n) as count';
    const result = await this.graphDb.executeCypher(query, {});
    return result.data[0]?.count || 0;
  }

  /**
   * Capture temporal snapshot
   */
  async captureSnapshot(): Promise<void> {
    try {
      const stats = await this.graphDb.getGraphStats();
      const newHubs = await this.detectNewHubs();
      const isolatedSubgraphs = await this.detectIsolatedSubgraphs();

      const avgDegree = stats.edgeCount > 0 ? stats.nodeCount / stats.edgeCount : 0;

      // Get max degree
      const maxDegreeQuery = `
        MATCH (n)
        OPTIONAL MATCH (n)-[r]-(other)
        WITH n, count(r) as degree
        RETURN max(degree) as maxDegree
      `;
      const maxDegreeResult = await this.graphDb.executeCypher(maxDegreeQuery, {});
      const maxDegree = maxDegreeResult.data[0]?.maxDegree || 0;

      // Estimate community count and modularity
      const communityCount = Math.floor(stats.nodeCount / 100); // Simple estimate
      const modularityScore = 0.3 + (Math.random() * 0.4); // Placeholder

      await this.prisma.$executeRaw`
        INSERT INTO graph_metrics_snapshot 
        (snapshot_date, node_count, edge_count, avg_degree, max_degree, community_count, modularity_score, new_hubs, isolated_subgraphs)
        VALUES (
          CURRENT_DATE,
          ${stats.nodeCount},
          ${stats.edgeCount},
          ${avgDegree},
          ${maxDegree},
          ${communityCount},
          ${modularityScore},
          ${newHubs}::TEXT[],
          ${isolatedSubgraphs}
        )
      `;

      logger.info('Temporal snapshot captured', { stats, newHubs, isolatedSubgraphs });
    } catch (error) {
      logger.error('Failed to capture temporal snapshot', { error });
    }
  }
}

// Singleton instance
let temporalAnalyzerInstance: TemporalGraphAnalyzer | null = null;

export function getTemporalAnalyzer(): TemporalGraphAnalyzer {
  if (!temporalAnalyzerInstance) {
    temporalAnalyzerInstance = new TemporalGraphAnalyzer();
  }
  return temporalAnalyzerInstance;
}

export function resetTemporalAnalyzer(): void {
  temporalAnalyzerInstance = null;
}
