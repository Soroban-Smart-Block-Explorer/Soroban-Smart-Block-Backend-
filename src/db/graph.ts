import { Pool } from 'pg';
import { config } from '../config';

/**
 * Apache AGE Graph Database Client
 * Provides interface for Cypher queries and graph operations
 */

export interface GraphQueryResult {
  data: any[];
  executionTime: number;
  nodeCount: number;
  edgeCount: number;
}

export interface GraphNode {
  id: string;
  label: string;
  properties: Record<string, any>;
}

export interface GraphEdge {
  id: string;
  label: string;
  startNode: string;
  endNode: string;
  properties: Record<string, any>;
}

export class GraphDatabase {
  private pool: Pool;
  private graphName: string;

  constructor(graphName: string = 'blockchain_graph') {
    this.graphName = graphName;
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });
  }

  /**
   * Execute a parameterized Cypher query
   */
  async executeCypher(
    query: string,
    parameters: Record<string, any> = {},
    timeout: number = 5000
  ): Promise<GraphQueryResult> {
    const startTime = Date.now();
    
    try {
      // Convert Cypher query to AGE format
      const ageQuery = this.convertToAgeQuery(query);
      
      const result = await this.pool.query(
        ageQuery,
        { ...parameters, timeout }
      );

      const executionTime = Date.now() - startTime;
      const processedData = this.processAgeResult(result.rows);

      return {
        data: processedData,
        executionTime,
        nodeCount: this.countNodes(processedData),
        edgeCount: this.countEdges(processedData),
      };
    } catch (error) {
      throw new Error(`Graph query execution failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Convert Cypher query to Apache AGE format
   */
  private convertToAgeQuery(cypherQuery: string): string {
    // AGE uses SELECT * FROM cypher($graph_name, $query) as ...
    return `SELECT * FROM cypher('${this.graphName}', $$${cypherQuery}$$) as (result agtype);`;
  }

  /**
   * Process AGE result format
   */
  private processAgeResult(rows: any[]): any[] {
    return rows.map(row => {
      const agtype = row.result;
      // Parse AGType to JSON
      return this.parseAgType(agtype);
    });
  }

  /**
   * Parse AGType to JavaScript object
   */
  private parseAgType(agtype: any): any {
    if (typeof agtype === 'string') {
      try {
        return JSON.parse(agtype);
      } catch {
        return agtype;
      }
    }
    return agtype;
  }

  /**
   * Count nodes in result
   */
  private countNodes(data: any[]): number {
    return data.reduce((count, item) => {
      if (item.nodes) return count + item.nodes.length;
      if (item.node) return count + 1;
      return count;
    }, 0);
  }

  /**
   * Count edges in result
   */
  private countEdges(data: any[]): number {
    return data.reduce((count, item) => {
      if (item.edges) return count + item.edges.length;
      if (item.edge) return count + 1;
      if (item.relationship) return count + 1;
      return count;
    }, 0);
  }

  /**
   * Create or update a node (upsert)
   */
  async upsertNode(
    label: string,
    properties: Record<string, any>
  ): Promise<void> {
    const { id, ...props } = properties;
    const query = `
      MERGE (n:${label} {id: $id})
      SET ${Object.keys(props).map(key => `n.${key} = $${key}`).join(', ')}
    `;
    
    await this.executeCypher(query, { id, ...props });
  }

  /**
   * Create or update an edge (upsert)
   */
  async upsertEdge(
    fromLabel: string,
    fromId: string,
    edgeLabel: string,
    toLabel: string,
    toId: string,
    properties: Record<string, any> = {}
  ): Promise<void> {
    const query = `
      MERGE (a:${fromLabel} {id: $fromId})
      MERGE (b:${toLabel} {id: $toId})
      MERGE (a)-[r:${edgeLabel} {id: $edgeId}]->(b)
      SET ${Object.keys(properties).map(key => `r.${key} = $${key}`).join(', ')}
    `;

    await this.executeCypher(query, {
      fromId,
      toId,
      edgeId: `${fromId}-${toId}-${edgeLabel}`,
      ...properties,
    });
  }

  /**
   * Delete a node
   */
  async deleteNode(label: string, id: string): Promise<void> {
    const query = `
      MATCH (n:${label} {id: $id})
      DETACH DELETE n
    `;
    
    await this.executeCypher(query, { id });
  }

  /**
   * Delete an edge
   */
  async deleteEdge(
    fromLabel: string,
    fromId: string,
    edgeLabel: string,
    toLabel: string,
    toId: string
  ): Promise<void> {
    const query = `
      MATCH (a:${fromLabel} {id: $fromId})-[r:${edgeLabel}]->(b:${toLabel} {id: $toId})
      DELETE r
    `;
    
    await this.executeCypher(query, { fromId, toId });
  }

  /**
   * Get graph statistics
   */
  async getGraphStats(): Promise<{
    nodeCount: number;
    edgeCount: number;
    nodeLabels: string[];
    edgeLabels: string[];
  }> {
    const nodeCountQuery = `
      MATCH (n)
      RETURN count(n) as count
    `;
    
    const edgeCountQuery = `
      MATCH ()-[r]->()
      RETURN count(r) as count
    `;
    
    const labelsQuery = `
      MATCH (n)
      RETURN DISTINCT labels(n) as labels
    `;
    
    const edgeTypesQuery = `
      MATCH ()-[r]->()
      RETURN DISTINCT type(r) as types
    `;

    const [nodeCount, edgeCount, labels, edgeTypes] = await Promise.all([
      this.executeCypher(nodeCountQuery),
      this.executeCypher(edgeCountQuery),
      this.executeCypher(labelsQuery),
      this.executeCypher(edgeTypesQuery),
    ]);

    return {
      nodeCount: nodeCount.data[0]?.count || 0,
      edgeCount: edgeCount.data[0]?.count || 0,
      nodeLabels: labels.data.flatMap(l => l.labels || []),
      edgeLabels: edgeTypes.data.flatMap(t => t.types || []),
    };
  }

  /**
   * Health check for graph database
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Close connection pool
   */
  async close(): Promise<void> {
    await this.pool.end();
  }
}

// Singleton instance
let graphDbInstance: GraphDatabase | null = null;

export function getGraphDb(): GraphDatabase {
  if (!graphDbInstance) {
    graphDbInstance = new GraphDatabase();
  }
  return graphDbInstance;
}

export function resetGraphDb(): void {
  graphDbInstance = null;
}
