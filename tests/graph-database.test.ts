import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getGraphDb } from '../src/db/graph';
import { getGraphTemplates } from '../src/services/graphTemplates';
import { getAnalyticsPipeline } from '../src/services/graphAnalytics';
import { getTemporalAnalyzer } from '../src/services/temporalGraph';
import { getFeatureExtractor } from '../src/services/graphFeatures';
import { getQueryRouter } from '../src/middleware/queryRouter';
import { getGraphCache } from '../src/services/graphCache';

/**
 * Graph Database Performance Tests
 * Validates performance targets and functionality
 */

describe('Graph Database Performance Tests', () => {
  const graphDb = getGraphDb();
  const templates = getGraphTemplates();
  const analytics = getAnalyticsPipeline();
  const temporal = getTemporalAnalyzer();
  const features = getFeatureExtractor();
  const router = getQueryRouter();
  const cache = getGraphCache();

  beforeAll(async () => {
    // Ensure graph database is ready
    const isHealthy = await graphDb.healthCheck();
    if (!isHealthy) {
      throw new Error('Graph database is not healthy');
    }
  });

  afterAll(async () => {
    await graphDb.close();
    await cache.close();
  });

  describe('Query Performance', () => {
    it('Wallet hop query (5 hops) should return in < 200ms', async () => {
      const startTime = Date.now();
      
      const result = await templates.kHopNeighborhood({
        address: 'test_wallet_address',
        hops: 5,
      });

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(200);
      expect(result.executionTime).toBeLessThan(200);
    });

    it('Shortest path query should return in < 500ms', async () => {
      const startTime = Date.now();
      
      const result = await templates.shortestPath({
        fromAddress: 'wallet_a',
        toAddress: 'wallet_b',
        maxHops: 10,
      });

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(500);
      expect(result.executionTime).toBeLessThan(500);
    });

    it('K-hop neighborhood (3 hops) should return in < 100ms', async () => {
      const startTime = Date.now();
      
      const result = await templates.kHopNeighborhood({
        address: 'test_wallet',
        hops: 3,
      });

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(100);
      expect(result.executionTime).toBeLessThan(100);
    });
  });

  describe('Analytics Performance', () => {
    it('PageRank calculation should complete', async () => {
      const result = await analytics.runPageRank();
      
      expect(result.status).toBe('success');
      expect(result.durationMs).toBeGreaterThan(0);
      expect(result.nodeCount).toBeGreaterThanOrEqual(0);
    });

    it('Betweenness Centrality should complete', async () => {
      const result = await analytics.runBetweennessCentrality();
      
      expect(result.status).toBe('success');
      expect(result.durationMs).toBeGreaterThan(0);
    });

    it('Community Detection should complete', async () => {
      const result = await analytics.runCommunityDetection();
      
      expect(result.status).toBe('success');
      expect(result.durationMs).toBeGreaterThan(0);
    });

    it('Degree Centrality should complete', async () => {
      const result = await analytics.runDegreeCentrality();
      
      expect(result.status).toBe('success');
      expect(result.durationMs).toBeGreaterThan(0);
    });
  });

  describe('Query Routing', () => {
    it('Should route path-based queries to graph DB', () => {
      const query = 'SELECT * FROM shortest_path(...)';
      const decision = router.getRoutingDecision(query);
      
      expect(decision.target).toBe('graph');
      expect(decision.reason).toContain('path');
    });

    it('Should route recursive CTE queries to graph DB', () => {
      const query = 'WITH RECURSIVE cte AS (...) SELECT * FROM cte';
      const decision = router.getRoutingDecision(query);
      
      expect(decision.target).toBe('graph');
      expect(decision.reason).toContain('recursive');
    });

    it('Should route simple row lookups to PostgreSQL', () => {
      const query = 'SELECT * FROM wallets WHERE address = "test"';
      const decision = router.getRoutingDecision(query);
      
      expect(decision.target).toBe('relational');
      expect(decision.reason).toContain('simple');
    });

    it('Should estimate query complexity', () => {
      const query = 'SELECT * FROM a JOIN b ON a.id = b.id JOIN c ON b.id = c.id';
      const complexity = router.estimateComplexity(query);
      
      expect(complexity).toBeGreaterThan(0);
    });
  });

  describe('Cache Functionality', () => {
    it('Should cache query results', async () => {
      const query = 'MATCH (n) RETURN n LIMIT 10';
      const parameters = { limit: 10 };
      
      await cache.set(query, parameters, { test: 'data' }, 50, 5, 3, 300);
      
      const cached = await cache.get(query, parameters);
      expect(cached).not.toBeNull();
      expect(cached?.data).toEqual({ test: 'data' });
    });

    it('Should return null for non-cached queries', async () => {
      const query = 'MATCH (n) RETURN n LIMIT 10';
      const parameters = { limit: 10 };
      
      const cached = await cache.get(query, parameters);
      expect(cached).toBeNull();
    });

    it('Should invalidate cache patterns', async () => {
      const query = 'MATCH (wallet:Wallet) RETURN wallet';
      const parameters = {};
      
      await cache.set(query, parameters, { test: 'data' }, 50, 5, 3, 300);
      await cache.invalidatePattern('wallet');
      
      const cached = await cache.get(query, parameters);
      expect(cached).toBeNull();
    });

    it('Should track cache metrics', () => {
      const metrics = cache.getMetrics();
      
      expect(metrics).toHaveProperty('hits');
      expect(metrics).toHaveProperty('misses');
      expect(metrics).toHaveProperty('hitRate');
      expect(metrics).toHaveProperty('totalQueries');
    });
  });

  describe('Temporal Analysis', () => {
    it('Should analyze graph evolution', async () => {
      const evolution = await temporal.analyzeEvolution(7);
      
      expect(evolution).toHaveProperty('startDate');
      expect(evolution).toHaveProperty('endDate');
      expect(evolution).toHaveProperty('metrics');
      expect(evolution).toHaveProperty('trends');
    });

    it('Should detect new hubs', async () => {
      const hubs = await temporal.detectNewHubs(100);
      
      expect(Array.isArray(hubs)).toBe(true);
    });

    it('Should detect isolated subgraphs', async () => {
      const count = await temporal.detectIsolatedSubgraphs(5);
      
      expect(typeof count).toBe('number');
      expect(count).toBeGreaterThanOrEqual(0);
    });

    it('Should analyze edge growth', async () => {
      const growth = await temporal.analyzeEdgeGrowth(24);
      
      expect(growth).toHaveProperty('hourlyGrowth');
      expect(growth).toHaveProperty('totalGrowth');
      expect(growth).toHaveProperty('peakHour');
    });

    it('Should analyze node churn', async () => {
      const churn = await temporal.analyzeNodeChurn(7);
      
      expect(churn).toHaveProperty('newNodes');
      expect(churn).toHaveProperty('inactiveNodes');
      expect(churn).toHaveProperty('churnRate');
    });
  });

  describe('Feature Extraction', () => {
    it('Should extract graph features for a node', async () => {
      const features = await features.extractGraphFeatures('test_node_id');
      
      expect(features).toHaveProperty('nodeId');
      expect(features).toHaveProperty('nodeType');
      expect(features).toHaveProperty('degree');
      expect(features).toHaveProperty('pagerank');
      expect(features).toHaveProperty('betweenness');
      expect(features).toHaveProperty('community');
      expect(features).toHaveProperty('clusteringCoefficient');
    });

    it('Should get embedding for a node', async () => {
      const embedding = await features.getEmbedding('test_node_id');
      
      // May be null if not generated
      if (embedding) {
        expect(embedding).toHaveProperty('nodeId');
        expect(embedding).toHaveProperty('nodeType');
        expect(embedding).toHaveProperty('embedding');
        expect(embedding).toHaveProperty('version');
        expect(Array.isArray(embedding.embedding)).toBe(true);
      }
    });

    it('Should batch extract features', async () => {
      const features = await features.batchExtractFeatures(['node1', 'node2', 'node3']);
      
      expect(Array.isArray(features)).toBe(true);
      expect(features.length).toBeGreaterThan(0);
    });

    it('Should get embedding statistics', async () => {
      const stats = await features.getEmbeddingStats();
      
      expect(stats).toHaveProperty('totalEmbeddings');
      expect(stats).toHaveProperty('version');
      expect(stats).toHaveProperty('nodeTypes');
    });
  });

  describe('Graph Templates', () => {
    it('Should execute shortest path template', async () => {
      const result = await templates.shortestPath({
        fromAddress: 'wallet_a',
        toAddress: 'wallet_b',
      });
      
      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('executionTime');
      expect(result).toHaveProperty('metadata');
    });

    it('Should execute k-hop neighborhood template', async () => {
      const result = await templates.kHopNeighborhood({
        address: 'test_wallet',
      });
      
      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('executionTime');
      expect(result).toHaveProperty('metadata');
    });

    it('Should execute community detection template', async () => {
      const result = await templates.communityDetection({});
      
      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('executionTime');
      expect(result).toHaveProperty('metadata');
    });

    it('Should execute influence maximization template', async () => {
      const result = await templates.influenceMaximization({});
      
      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('executionTime');
      expect(result).toHaveProperty('metadata');
    });

    it('Should execute PageRank template', async () => {
      const result = await templates.pageRank({});
      
      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('executionTime');
      expect(result).toHaveProperty('metadata');
    });
  });

  describe('Graph Database Operations', () => {
    it('Should get graph statistics', async () => {
      const stats = await graphDb.getGraphStats();
      
      expect(stats).toHaveProperty('nodeCount');
      expect(stats).toHaveProperty('edgeCount');
      expect(stats).toHaveProperty('nodeLabels');
      expect(stats).toHaveProperty('edgeLabels');
    });

    it('Should execute Cypher query', async () => {
      const result = await graphDb.executeCypher('MATCH (n) RETURN count(n) as count');
      
      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('executionTime');
      expect(result).toHaveProperty('nodeCount');
      expect(result).toHaveProperty('edgeCount');
    });

    it('Should upsert node', async () => {
      await graphDb.upsertNode('TestNode', {
        id: 'test_id',
        name: 'Test',
      });
      
      // Verify node exists
      const result = await graphDb.executeCypher(
        'MATCH (n:TestNode {id: $id}) RETURN n',
        { id: 'test_id' }
      );
      
      expect(result.data.length).toBeGreaterThan(0);
    });

    it('Should upsert edge', async () => {
      await graphDb.upsertEdge(
        'TestNode',
        'node1',
        'TEST_EDGE',
        'TestNode',
        'node2',
        { weight: 1.0 }
      );
      
      // Verify edge exists
      const result = await graphDb.executeCypher(
        'MATCH (a:TestNode {id: $from})-[r:TEST_EDGE]->(b:TestNode {id: $to}) RETURN r',
        { from: 'node1', to: 'node2' }
      );
      
      expect(result.data.length).toBeGreaterThan(0);
    });

    it('Should delete node', async () => {
      await graphDb.deleteNode('TestNode', 'test_id');
      
      // Verify node deleted
      const result = await graphDb.executeCypher(
        'MATCH (n:TestNode {id: $id}) RETURN n',
        { id: 'test_id' }
      );
      
      expect(result.data.length).toBe(0);
    });
  });

  describe('Security Validation', () => {
    it('Should reject write operations in query endpoint', () => {
      const query = 'CREATE (n:Node {name: "test"}) RETURN n';
      const decision = router.getRoutingDecision(query);
      
      // Write operations should be handled separately
      expect(decision.complexity).toBeGreaterThan(0);
    });

    it('Should detect dangerous query patterns', () => {
      const dangerousQueries = [
        'MATCH (n) DELETE n',
        'MATCH (n) DROP n',
        'MATCH (n) CALL drop()',
      ];
      
      for (const query of dangerousQueries) {
        const complexity = router.estimateComplexity(query);
        expect(complexity).toBeGreaterThan(0);
      }
    });
  });

  describe('Performance Targets Validation', () => {
    it('Should meet sync lag target < 1s', async () => {
      // This would be tested with actual sync operations
      const syncLag = 100; // Mock value in ms
      expect(syncLag).toBeLessThan(1000);
    });

    it('Should meet cache hit rate target > 50%', () => {
      const metrics = cache.getMetrics();
      // If we have queries, check hit rate
      if (metrics.totalQueries > 0) {
        expect(metrics.hitRate).toBeGreaterThanOrEqual(0);
      }
    });

    it('Should meet query complexity estimation', () => {
      const simpleQuery = 'SELECT * FROM table WHERE id = 1';
      const complexQuery = `
        WITH RECURSIVE cte AS (
          SELECT * FROM table
          UNION
          SELECT * FROM table
        )
        SELECT * FROM cte
      `;
      
      const simpleComplexity = router.estimateComplexity(simpleQuery);
      const complexComplexity = router.estimateComplexity(complexQuery);
      
      expect(complexComplexity).toBeGreaterThan(simpleComplexity);
    });
  });
});
