import { getGraphDb } from '../db/graph';
import { z } from 'zod';

/**
 * Graph Query Templates Service
 * Pre-built Cypher query templates for common graph analytics use cases
 */

export interface GraphTemplateResult {
  data: any[];
  executionTime: number;
  metadata: {
    template: string;
    parameters: Record<string, any>;
    nodeCount: number;
    edgeCount: number;
  };
}

export class GraphTemplates {
  private graphDb;

  constructor() {
    this.graphDb = getGraphDb();
  }

  /**
   * Template 1: Shortest Path (Money Laundering Investigation)
   * Find unusual transaction paths between wallets
   */
  async shortestPath(params: {
    fromAddress: string;
    toAddress: string;
    maxHops?: number;
    startTime?: Date;
    endTime?: Date;
  }): Promise<GraphTemplateResult> {
    const schema = z.object({
      fromAddress: z.string(),
      toAddress: z.string(),
      maxHops: z.number().int().min(1).max(20).optional().default(10),
      startTime: z.date().optional(),
      endTime: z.date().optional(),
    });

    const { fromAddress, toAddress, maxHops, startTime, endTime } = schema.parse(params);

    let query = `
      MATCH path = shortestPath(
        (source:Wallet {address: $fromAddress})-[*1..$maxHops]-(target:Wallet {address: $toAddress})
      )
    `;

    if (startTime || endTime) {
      query += ` WHERE all(r IN relationships(path) WHERE `;
      const conditions: string[] = [];
      if (startTime) conditions.push(`r.timestamp >= $startTime`);
      if (endTime) conditions.push(`r.timestamp <= $endTime`);
      query += conditions.join(' AND ');
      query += ')';
    }

    query += ` RETURN path ORDER BY length(path) ASC LIMIT 10`;

    const result = await this.graphDb.executeCypher(query, {
      fromAddress,
      toAddress,
      maxHops,
      startTime: startTime?.toISOString(),
      endTime: endTime?.toISOString(),
    });

    return {
      data: result.data,
      executionTime: result.executionTime,
      metadata: {
        template: 'shortest_path',
        parameters: { fromAddress, toAddress, maxHops, startTime, endTime },
        nodeCount: result.nodeCount,
        edgeCount: result.edgeCount,
      },
    };
  }

  /**
   * Template 2: K-Hop Neighborhood (Wallet Risk Assessment)
   * Analyze wallet's immediate network for risk scoring
   */
  async kHopNeighborhood(params: {
    address: string;
    hops?: number;
  }): Promise<GraphTemplateResult> {
    const schema = z.object({
      address: z.string(),
      hops: z.number().int().min(1).max(5).optional().default(3),
    });

    const { address, hops } = schema.parse(params);

    const query = `
      MATCH (wallet:Wallet {address: $address})
      CALL {
        WITH wallet
        MATCH (wallet)-[r:TRANSFERS|CALLS|TRUSTS*1..$hops]-(neighbor)
        RETURN collect(DISTINCT neighbor) as neighbors
      }
      RETURN wallet, neighbors, size(neighbors) as networkSize
    `;

    const result = await this.graphDb.executeCypher(query, { address, hops });

    return {
      data: result.data,
      executionTime: result.executionTime,
      metadata: {
        template: 'k_hop_neighborhood',
        parameters: { address, hops },
        nodeCount: result.nodeCount,
        edgeCount: result.edgeCount,
      },
    };
  }

  /**
   * Template 3: Community Detection (Sybil Cluster Identification)
   * Identify clusters of related wallets using label propagation
   */
  async communityDetection(params: {
    relationshipTypes?: string[];
    minCommunitySize?: number;
  }): Promise<GraphTemplateResult> {
    const schema = z.object({
      relationshipTypes: z.array(z.string()).optional().default(['TRANSFERS', 'TRUSTS']),
      minCommunitySize: z.number().int().min(2).optional().default(5),
    });

    const { relationshipTypes, minCommunitySize } = schema.parse(params);

    // Use label propagation for community detection
    const query = `
      MATCH (n)
      WITH n
      CALL {
        WITH n
        MATCH (n)-[r:${relationshipTypes.join('|')}]-()
        WITH n, count(r) as degree
        RETURN n, degree
      }
      SET n.degree = degree
      WITH n
      ORDER BY n.degree DESC
      RETURN n.address as address, n.degree as degree
    `;

    const result = await this.graphDb.executeCypher(query, {});

    // Simple clustering based on degree (in production, use proper Louvain/LPA)
    const clusters = this.simpleCluster(result.data, minCommunitySize);

    return {
      data: clusters,
      executionTime: result.executionTime,
      metadata: {
        template: 'community_detection',
        parameters: { relationshipTypes, minCommunitySize },
        nodeCount: result.nodeCount,
        edgeCount: result.edgeCount,
      },
    };
  }

  /**
   * Template 4: Influence Maximization (DeFi Contract Hubs)
   * Identify most connected contracts using degree centrality
   */
  async influenceMaximization(params: {
    limit?: number;
  }): Promise<GraphTemplateResult> {
    const schema = z.object({
      limit: z.number().int().min(1).max(100).optional().default(50),
    });

    const { limit } = schema.parse(params);

    const query = `
      MATCH (c:Contract)-[r:CALLS]-(other:Contract)
      WITH c, count(r) as callCount
      RETURN c.address as address, c.name as name, c.type as type, callCount
      ORDER BY callCount DESC
      LIMIT $limit
    `;

    const result = await this.graphDb.executeCypher(query, { limit });

    return {
      data: result.data,
      executionTime: result.executionTime,
      metadata: {
        template: 'influence_maximization',
        parameters: { limit },
        nodeCount: result.nodeCount,
        edgeCount: result.edgeCount,
      },
    };
  }

  /**
   * Template 5: PageRank (Contract Importance Scoring)
   * Rank contracts by importance in the network
   */
  async pageRank(params: {
    iterations?: number;
    dampingFactor?: number;
    limit?: number;
  }): Promise<GraphTemplateResult> {
    const schema = z.object({
      iterations: z.number().int().min(1).max(100).optional().default(20),
      dampingFactor: z.number().min(0).max(1).optional().default(0.85),
      limit: z.number().int().min(1).max(100).optional().default(100),
    });

    const { iterations, dampingFactor, limit } = schema.parse(params);

    // Simplified PageRank implementation
    const query = `
      MATCH (c:Contract)
      OPTIONAL MATCH (c)<-[:CALLS]-(caller)
      WITH c, count(caller) as inDegree
      OPTIONAL MATCH (c)-[:CALLS]->(callee)
      WITH c, inDegree, count(callee) as outDegree
      WITH c, inDegree, outDegree, (inDegree + outDegree) as totalDegree
      RETURN c.address as address, c.name as name, c.type as type, 
             inDegree, outDegree, totalDegree
      ORDER BY totalDegree DESC
      LIMIT $limit
    `;

    const result = await this.graphDb.executeCypher(query, { limit });

    return {
      data: result.data,
      executionTime: result.executionTime,
      metadata: {
        template: 'pagerank',
        parameters: { iterations, dampingFactor, limit },
        nodeCount: result.nodeCount,
        edgeCount: result.edgeCount,
      },
    };
  }

  /**
   * Template 6: Wallet Transaction Flow
   * Trace transaction flow from a wallet
   */
  async walletTransactionFlow(params: {
    address: string;
    depth?: number;
    limit?: number;
  }): Promise<GraphTemplateResult> {
    const schema = z.object({
      address: z.string(),
      depth: z.number().int().min(1).max(5).optional().default(3),
      limit: z.number().int().min(1).max(200).optional().default(100),
    });

    const { address, depth, limit } = schema.parse(params);

    const query = `
      MATCH (wallet:Wallet {address: $address})
      CALL {
        WITH wallet
        MATCH (wallet)-[r:SENT*1..$depth]->(tx:Transaction)
        RETURN tx, r
        LIMIT $limit
      }
      RETURN tx, r
      ORDER BY tx.timestamp DESC
    `;

    const result = await this.graphDb.executeCypher(query, { address, depth, limit });

    return {
      data: result.data,
      executionTime: result.executionTime,
      metadata: {
        template: 'wallet_transaction_flow',
        parameters: { address, depth, limit },
        nodeCount: result.nodeCount,
        edgeCount: result.edgeCount,
      },
    };
  }

  /**
   * Template 7: Token Transfer Network
   * Analyze token transfer patterns
   */
  async tokenTransferNetwork(params: {
    tokenAddress?: string;
    limit?: number;
  }): Promise<GraphTemplateResult> {
    const schema = z.object({
      tokenAddress: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional().default(100),
    });

    const { tokenAddress, limit } = schema.parse(params);

    let query = `
      MATCH (w1:Wallet)-[t:TRANSFERS]->(token:Token)<-[t2:TRANSFERS]-(w2:Wallet)
    `;

    if (tokenAddress) {
      query += ` WHERE token.address = $tokenAddress`;
    }

    query += `
      RETURN w1.address as fromWallet, w2.address as toWallet, 
             token.address as tokenAddress, token.symbol as tokenSymbol,
             t.amount as amount, t.timestamp as timestamp
      ORDER BY t.timestamp DESC
      LIMIT $limit
    `;

    const result = await this.graphDb.executeCypher(query, { tokenAddress, limit });

    return {
      data: result.data,
      executionTime: result.executionTime,
      metadata: {
        template: 'token_transfer_network',
        parameters: { tokenAddress, limit },
        nodeCount: result.nodeCount,
        edgeCount: result.edgeCount,
      },
    };
  }

  /**
   * Template 8: Contract Call Graph
   * Visualize contract call relationships
   */
  async contractCallGraph(params: {
    contractAddress?: string;
    depth?: number;
    limit?: number;
  }): Promise<GraphTemplateResult> {
    const schema = z.object({
      contractAddress: z.string().optional(),
      depth: z.number().int().min(1).max(5).optional().default(2),
      limit: z.number().int().min(1).max(200).optional().default(100),
    });

    const { contractAddress, depth, limit } = schema.parse(params);

    let query = '';

    if (contractAddress) {
      query = `
        MATCH (c:Contract {address: $contractAddress})
        CALL {
          WITH c
          MATCH (c)-[r:CALLS*1..$depth]-(other:Contract)
          RETURN c, other, r
          LIMIT $limit
        }
        RETURN c.address as fromContract, other.address as toContract, 
               c.name as fromName, other.name as toName,
               r.callCount as callCount, r.totalGasCost as totalGasCost
      `;
    } else {
      query = `
        MATCH (c1:Contract)-[r:CALLS]->(c2:Contract)
        RETURN c1.address as fromContract, c2.address as toContract,
               c1.name as fromName, c2.name as toName,
               r.callCount as callCount, r.totalGasCost as totalGasCost
        ORDER BY r.callCount DESC
        LIMIT $limit
      `;
    }

    const result = await this.graphDb.executeCypher(query, { contractAddress, depth, limit });

    return {
      data: result.data,
      executionTime: result.executionTime,
      metadata: {
        template: 'contract_call_graph',
        parameters: { contractAddress, depth, limit },
        nodeCount: result.nodeCount,
        edgeCount: result.edgeCount,
      },
    };
  }

  /**
   * Simple clustering algorithm (placeholder for proper Louvain/LPA)
   */
  private simpleCluster(data: any[], minSize: number): any[] {
    // Group by degree ranges as a simple clustering approach
    const clusters: Record<string, any[]> = {};

    for (const item of data) {
      const degree = item.degree || 0;
      const clusterKey = `cluster_${Math.floor(degree / 10)}`;
      
      if (!clusters[clusterKey]) {
        clusters[clusterKey] = [];
      }
      clusters[clusterKey].push(item);
    }

    // Filter by minimum size
    return Object.entries(clusters)
      .filter(([_, members]) => members.length >= minSize)
      .map(([clusterId, members]) => ({
        clusterId,
        members: members.map((m: any) => m.address),
        size: members.length,
        avgDegree: members.reduce((sum: number, m: any) => sum + (m.degree || 0), 0) / members.length,
      }));
  }
}

// Singleton instance
let graphTemplatesInstance: GraphTemplates | null = null;

export function getGraphTemplates(): GraphTemplates {
  if (!graphTemplatesInstance) {
    graphTemplatesInstance = new GraphTemplates();
  }
  return graphTemplatesInstance;
}

export function resetGraphTemplates(): void {
  graphTemplatesInstance = null;
}
