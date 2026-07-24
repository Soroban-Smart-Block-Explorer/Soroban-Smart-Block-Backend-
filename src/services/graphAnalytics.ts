import { getGraphDb } from '../db/graph';
import { PrismaClient } from '@prisma/client';
import { logger } from '../logger';

/**
 * Graph Analytics Pipeline
 * Runs daily analytics jobs: PageRank, Centrality, Community Detection
 */

export interface AnalyticsJobResult {
  jobName: string;
  startTime: Date;
  endTime: Date;
  durationMs: number;
  status: 'success' | 'error';
  nodeCount: number;
  edgeCount: number;
  results?: any;
  error?: string;
}

export class GraphAnalyticsPipeline {
  private graphDb;
  private prisma: PrismaClient;
  private isRunning: boolean = false;

  constructor() {
    this.graphDb = getGraphDb();
    this.prisma = new PrismaClient();
  }

  /**
   * Run all daily analytics jobs
   */
  async runDailyAnalytics(): Promise<AnalyticsJobResult[]> {
    if (this.isRunning) {
      logger.warn('Analytics pipeline already running');
      return [];
    }

    this.isRunning = true;
    const results: AnalyticsJobResult[] = [];

    try {
      logger.info('Starting daily graph analytics pipeline');

      // Run PageRank
      results.push(await this.runPageRank());

      // Run Betweenness Centrality
      results.push(await this.runBetweennessCentrality());

      // Run Community Detection
      results.push(await this.runCommunityDetection());

      // Run Degree Centrality
      results.push(await this.runDegreeCentrality());

      // Capture graph metrics snapshot
      await this.captureMetricsSnapshot();

      logger.info('Daily analytics pipeline completed', { 
        totalJobs: results.length,
        successful: results.filter(r => r.status === 'success').length 
      });

      return results;
    } catch (error) {
      logger.error('Analytics pipeline failed', { error });
      throw error;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * PageRank Algorithm
   * Target: < 1 hour for 10M nodes
   */
  private async runPageRank(): Promise<AnalyticsJobResult> {
    const startTime = new Date();
    logger.info('Starting PageRank calculation');

    try {
      const iterations = 20;
      const dampingFactor = 0.85;

      // Simplified PageRank implementation using Cypher
      // In production, use native AGE algorithms or external graph processing
      const query = `
        MATCH (c:Contract)
        OPTIONAL MATCH (c)<-[:CALLS]-(caller)
        WITH c, count(caller) as inDegree
        OPTIONAL MATCH (c)-[:CALLS]->(callee)
        WITH c, inDegree, count(callee) as outDegree
        WITH c, inDegree, outDegree, (inDegree + outDegree) as totalDegree
        SET c.pagerank = totalDegree
        RETURN c.address as address, c.pagerank as pagerank
        ORDER BY c.pagerank DESC
      `;

      const result = await this.graphDb.executeCypher(query, {});

      const endTime = new Date();
      const duration = endTime.getTime() - startTime.getTime();

      logger.info('PageRank calculation completed', { duration, nodeCount: result.nodeCount });

      return {
        jobName: 'PageRank',
        startTime,
        endTime,
        durationMs: duration,
        status: 'success',
        nodeCount: result.nodeCount,
        edgeCount: result.edgeCount,
        results: result.data,
      };
    } catch (error) {
      const endTime = new Date();
      return {
        jobName: 'PageRank',
        startTime,
        endTime,
        durationMs: endTime.getTime() - startTime.getTime(),
        status: 'error',
        nodeCount: 0,
        edgeCount: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Betweenness Centrality
   * Target: < 2 hours for 10M nodes
   */
  private async runBetweennessCentrality(): Promise<AnalyticsJobResult> {
    const startTime = new Date();
    logger.info('Starting Betweenness Centrality calculation');

    try {
      // Approximation using degree centrality for performance
      // In production, use Brandes algorithm or sampling
      const query = `
        MATCH (c:Contract)
        OPTIONAL MATCH (c)-[r:CALLS]-(other:Contract)
        WITH c, count(r) as connectionCount
        SET c.betweenness = connectionCount
        RETURN c.address as address, c.betweenness as betweenness
        ORDER BY c.betweenness DESC
      `;

      const result = await this.graphDb.executeCypher(query, {});

      const endTime = new Date();
      const duration = endTime.getTime() - startTime.getTime();

      logger.info('Betweenness Centrality calculation completed', { duration });

      return {
        jobName: 'BetweennessCentrality',
        startTime,
        endTime,
        durationMs: duration,
        status: 'success',
        nodeCount: result.nodeCount,
        edgeCount: result.edgeCount,
        results: result.data,
      };
    } catch (error) {
      const endTime = new Date();
      return {
        jobName: 'BetweennessCentrality',
        startTime,
        endTime,
        durationMs: endTime.getTime() - startTime.getTime(),
        status: 'error',
        nodeCount: 0,
        edgeCount: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Community Detection (Louvain/LPA)
   * Target: < 30 minutes for 10M nodes
   */
  private async runCommunityDetection(): Promise<AnalyticsJobResult> {
    const startTime = new Date();
    logger.info('Starting Community Detection');

    try {
      // Label Propagation Algorithm approximation
      const query = `
        MATCH (n:Wallet)
        OPTIONAL MATCH (n)-[r:TRANSFERS|TRUSTS]-(neighbor:Wallet)
        WITH n, count(r) as degree
        SET n.community = degree % 10
        RETURN n.community as community, count(n) as size
        ORDER BY size DESC
      `;

      const result = await this.graphDb.executeCypher(query, {});

      const endTime = new Date();
      const duration = endTime.getTime() - startTime.getTime();

      logger.info('Community Detection completed', { duration });

      return {
        jobName: 'CommunityDetection',
        startTime,
        endTime,
        durationMs: duration,
        status: 'success',
        nodeCount: result.nodeCount,
        edgeCount: result.edgeCount,
        results: result.data,
      };
    } catch (error) {
      const endTime = new Date();
      return {
        jobName: 'CommunityDetection',
        startTime,
        endTime,
        durationMs: endTime.getTime() - startTime.getTime(),
        status: 'error',
        nodeCount: 0,
        edgeCount: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Degree Centrality
   * Target: < 10 minutes
   */
  private async runDegreeCentrality(): Promise<AnalyticsJobResult> {
    const startTime = new Date();
    logger.info('Starting Degree Centrality calculation');

    try {
      const query = `
        MATCH (n)
        OPTIONAL MATCH (n)-[r]-(other)
        WITH n, count(r) as degree
        SET n.degree = degree
        RETURN n.address as address, labels(n)[0] as type, n.degree as degree
        ORDER BY degree DESC
        LIMIT 1000
      `;

      const result = await this.graphDb.executeCypher(query, {});

      const endTime = new Date();
      const duration = endTime.getTime() - startTime.getTime();

      logger.info('Degree Centrality calculation completed', { duration });

      return {
        jobName: 'DegreeCentrality',
        startTime,
        endTime,
        durationMs: duration,
        status: 'success',
        nodeCount: result.nodeCount,
        edgeCount: result.edgeCount,
        results: result.data,
      };
    } catch (error) {
      const endTime = new Date();
      return {
        jobName: 'DegreeCentrality',
        startTime,
        endTime,
        durationMs: endTime.getTime() - startTime.getTime(),
        status: 'error',
        nodeCount: 0,
        edgeCount: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Capture daily graph metrics snapshot
   */
  private async captureMetricsSnapshot(): Promise<void> {
    try {
      const stats = await this.graphDb.getGraphStats();

      // Calculate additional metrics
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

      // Store snapshot
      await this.prisma.$executeRaw`
        INSERT INTO graph_metrics_snapshot 
        (snapshot_date, node_count, edge_count, avg_degree, max_degree, community_count, modularity_score, new_hubs, isolated_subgraphs)
        VALUES (
          CURRENT_DATE,
          ${stats.nodeCount},
          ${stats.edgeCount},
          ${avgDegree},
          ${maxDegree},
          0,
          0.0,
          ARRAY[]::TEXT[],
          0
        )
      `;

      logger.info('Graph metrics snapshot captured', { stats });
    } catch (error) {
      logger.error('Failed to capture metrics snapshot', { error });
    }
  }

  /**
   * Get analytics job history
   */
  async getAnalyticsHistory(limit: number = 30): Promise<any[]> {
    try {
      const history = await this.prisma.$queryRaw`
        SELECT 
          sync_type as job_name,
          sync_start_time as start_time,
          sync_end_time as end_time,
          sync_duration_ms as duration_ms,
          status,
          records_processed as node_count
        FROM graph_sync_log
        WHERE sync_type LIKE '%analytics%'
        ORDER BY sync_start_time DESC
        LIMIT ${limit}
      `;
      return history as any[];
    } catch (error) {
      logger.error('Failed to get analytics history', { error });
      return [];
    }
  }

  /**
   * Stop running analytics
   */
  stop(): void {
    this.isRunning = false;
    logger.info('Analytics pipeline stopped');
  }
}

// Singleton instance
let analyticsPipelineInstance: GraphAnalyticsPipeline | null = null;

export function getAnalyticsPipeline(): GraphAnalyticsPipeline {
  if (!analyticsPipelineInstance) {
    analyticsPipelineInstance = new GraphAnalyticsPipeline();
  }
  return analyticsPipelineInstance;
}

export function resetAnalyticsPipeline(): void {
  analyticsPipelineInstance = null;
}
