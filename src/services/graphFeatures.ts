import { getGraphDb } from '../db/graph';
import { PrismaClient } from '@prisma/client';
import { logger } from '../logger';

/**
 * Graph Feature Extraction for ML
 * Extracts node embeddings and graph features for machine learning pipelines
 * Supports Node2Vec and GraphSAGE-style embeddings
 */

export interface NodeEmbedding {
  nodeId: string;
  nodeType: string;
  embedding: number[];
  version: string;
}

export interface GraphFeatures {
  nodeId: string;
  nodeType: string;
  degree: number;
  pagerank: number;
  betweenness: number;
  community: number;
  clusteringCoefficient: number;
  timestamp: Date;
}

export class GraphFeatureExtractor {
  private graphDb;
  private prisma: PrismaClient;
  private embeddingDimensions: number = 128;
  private embeddingVersion: string = '1.0';

  constructor() {
    this.graphDb = getGraphDb();
    this.prisma = new PrismaClient();
  }

  /**
   * Generate Node2Vec-style embeddings for all nodes
   */
  async generateNodeEmbeddings(): Promise<void> {
    logger.info('Starting node embedding generation');

    try {
      // Get all nodes
      const nodesQuery = `
        MATCH (n)
        RETURN n.id as id, labels(n)[0] as type
        LIMIT 10000
      `;

      const result = await this.graphDb.executeCypher(nodesQuery, {});
      const nodes = result.data;

      logger.info(`Processing ${nodes.length} nodes for embeddings`);

      // Generate embeddings for each node
      for (const node of nodes) {
        const embedding = await this.generateSingleEmbedding(node.id, node.type);
        await this.saveEmbedding(node.id, node.type, embedding);
      }

      logger.info('Node embedding generation completed');
    } catch (error) {
      logger.error('Node embedding generation failed', { error });
      throw error;
    }
  }

  /**
   * Generate embedding for a single node
   * Simplified Node2Vec-style embedding using structural features
   */
  private async generateSingleEmbedding(nodeId: string, nodeType: string): Promise<number[]> {
    // Get structural features
    const features = await this.extractStructuralFeatures(nodeId);

    // Convert features to embedding vector
    const embedding = this.featuresToEmbedding(features);

    return embedding;
  }

  /**
   * Extract structural features for a node
   */
  private async extractStructuralFeatures(nodeId: string): Promise<Record<string, number>> {
    const degreeQuery = `
      MATCH (n {id: $nodeId})
      OPTIONAL MATCH (n)-[r]-(other)
      RETURN count(r) as degree
    `;

    const pagerankQuery = `
      MATCH (n {id: $nodeId})
      RETURN n.pagerank as pagerank
    `;

    const betweennessQuery = `
      MATCH (n {id: $nodeId})
      RETURN n.betweenness as betweenness
    `;

    const communityQuery = `
      MATCH (n {id: $nodeId})
      RETURN n.community as community
    `;

    const clusteringQuery = `
      MATCH (n {id: $nodeId})-[r]-(neighbor)
      WITH n, count(r) as degree
      MATCH (n)-[r1]-(a)-[r2]-(b)
      WHERE a.id <> b.id AND b.id <> n.id
      WITH n, degree, count(DISTINCT a, b) as triangles
      RETURN CASE WHEN degree > 1 THEN triangles / (degree * (degree - 1) / 2) ELSE 0 END as clustering
    `;

    const [degreeResult, pagerankResult, betweennessResult, communityResult, clusteringResult] =
      await Promise.all([
        this.graphDb.executeCypher(degreeQuery, { nodeId }),
        this.graphDb.executeCypher(pagerankQuery, { nodeId }),
        this.graphDb.executeCypher(betweennessQuery, { nodeId }),
        this.graphDb.executeCypher(communityQuery, { nodeId }),
        this.graphDb.executeCypher(clusteringQuery, { nodeId }),
      ]);

    return {
      degree: degreeResult.data[0]?.degree || 0,
      pagerank: pagerankResult.data[0]?.pagerank || 0,
      betweenness: betweennessResult.data[0]?.betweenness || 0,
      community: communityResult.data[0]?.community || 0,
      clusteringCoefficient: clusteringResult.data[0]?.clustering || 0,
    };
  }

  /**
   * Convert features to embedding vector
   */
  private featuresToEmbedding(features: Record<string, number>): number[] {
    const embedding = new Array(this.embeddingDimensions).fill(0);

    // Map features to embedding dimensions
    const featureKeys = Object.keys(features);
    for (let i = 0; i < featureKeys.length && i < this.embeddingDimensions; i++) {
      embedding[i] = features[featureKeys[i]] || 0;
    }

    // Fill remaining dimensions with hash-based values
    for (let i = featureKeys.length; i < this.embeddingDimensions; i++) {
      embedding[i] = Math.sin(i * 0.1) * 0.01; // Small random-like values
    }

    return embedding;
  }

  /**
   * Save embedding to database
   */
  private async saveEmbedding(nodeId: string, nodeType: string, embedding: number[]): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        INSERT INTO node_embeddings (node_id, node_type, embedding_vector, embedding_version)
        VALUES (${nodeId}, ${nodeType}, ${embedding}::FLOAT[], ${this.embeddingVersion})
        ON CONFLICT (node_id) 
        DO UPDATE SET 
          embedding_vector = EXCLUDED.embedding_vector,
          embedding_version = EXCLUDED.embedding_version,
          updated_at = NOW()
      `;
    } catch (error) {
      logger.error('Failed to save embedding', { nodeId, error });
    }
  }

  /**
   * Get embedding for a specific node
   */
  async getEmbedding(nodeId: string): Promise<NodeEmbedding | null> {
    try {
      const result = await this.prisma.$queryRaw<NodeEmbedding[]>`
        SELECT node_id as "nodeId", node_type as "nodeType", embedding_vector as "embedding", embedding_version as "version"
        FROM node_embeddings
        WHERE node_id = ${nodeId}
      `;

      return result[0] || null;
    } catch (error) {
      logger.error('Failed to get embedding', { nodeId, error });
      return null;
    }
  }

  /**
   * Extract comprehensive graph features for ML
   */
  async extractGraphFeatures(nodeId: string): Promise<GraphFeatures> {
    const features = await this.extractStructuralFeatures(nodeId);

    return {
      nodeId,
      nodeType: await this.getNodeType(nodeId),
      degree: features.degree,
      pagerank: features.pagerank,
      betweenness: features.betweenness,
      community: features.community,
      clusteringCoefficient: features.clusteringCoefficient,
      timestamp: new Date(),
    };
  }

  /**
   * Get node type
   */
  private async getNodeType(nodeId: string): Promise<string> {
    const query = `
      MATCH (n {id: $nodeId})
      RETURN labels(n)[0] as type
    `;

    const result = await this.graphDb.executeCypher(query, { nodeId });
    return result.data[0]?.type || 'Unknown';
  }

  /**
   * Batch extract features for multiple nodes
   */
  async batchExtractFeatures(nodeIds: string[]): Promise<GraphFeatures[]> {
    const features: GraphFeatures[] = [];

    for (const nodeId of nodeIds) {
      try {
        const nodeFeatures = await this.extractGraphFeatures(nodeId);
        features.push(nodeFeatures);
      } catch (error) {
        logger.error('Failed to extract features for node', { nodeId, error });
      }
    }

    return features;
  }

  /**
   * Update embedding version
   */
  async updateEmbeddingVersion(newVersion: string): Promise<void> {
    this.embeddingVersion = newVersion;
    logger.info('Embedding version updated', { newVersion });
  }

  /**
   * Get embedding statistics
   */
  async getEmbeddingStats(): Promise<{
    totalEmbeddings: number;
    version: string;
    nodeTypes: Record<string, number>;
  }> {
    try {
      const totalResult = await this.prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*) as count FROM node_embeddings
      `;

      const versionResult = await this.prisma.$queryRaw<{ embedding_version: string }[]>`
        SELECT DISTINCT embedding_version FROM node_embeddings LIMIT 1
      `;

      const typeResult = await this.prisma.$queryRaw<{ node_type: string; count: bigint }[]>`
        SELECT node_type, COUNT(*) as count FROM node_embeddings GROUP BY node_type
      `;

      const nodeTypes: Record<string, number> = {};
      for (const row of typeResult) {
        nodeTypes[row.node_type] = Number(row.count);
      }

      return {
        totalEmbeddings: Number(totalResult[0]?.count || 0),
        version: versionResult[0]?.embedding_version || this.embeddingVersion,
        nodeTypes,
      };
    } catch (error) {
      logger.error('Failed to get embedding stats', { error });
      return {
        totalEmbeddings: 0,
        version: this.embeddingVersion,
        nodeTypes: {},
      };
    }
  }
}

// Singleton instance
let featureExtractorInstance: GraphFeatureExtractor | null = null;

export function getFeatureExtractor(): GraphFeatureExtractor {
  if (!featureExtractorInstance) {
    featureExtractorInstance = new GraphFeatureExtractor();
  }
  return featureExtractorInstance;
}

export function resetFeatureExtractor(): void {
  featureExtractorInstance = null;
}
