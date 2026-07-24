/**
 * Query Router Middleware
 * Automatically routes graph-heavy queries to graph DB and row-heavy queries to PostgreSQL
 */

export type QueryTarget = 'graph' | 'relational';

export interface QueryContext {
  query: string;
  parameters?: Record<string, any>;
  isGraphQuery?: boolean;
}

export class QueryRouter {
  /**
   * Analyze query and determine target database
   */
  routeQuery(query: string, context: Partial<QueryContext> = {}): QueryTarget {
    // If explicitly set, use that
    if (context.isGraphQuery !== undefined) {
      return context.isGraphQuery ? 'graph' : 'relational';
    }

    const normalizedQuery = query.toUpperCase();

    // Check for graph-specific patterns
    if (this.isPathBasedQuery(normalizedQuery)) {
      return 'graph';
    }

    if (this.hasRecursiveCTE(normalizedQuery)) {
      return 'graph';
    }

    if (this.hasRelationshipJoins(normalizedQuery)) {
      return 'graph';
    }

    if (this.isRelationshipAggregation(normalizedQuery)) {
      return 'graph';
    }

    // Check for relational-specific patterns
    if (this.isSimpleRowLookup(normalizedQuery)) {
      return 'relational';
    }

    if (this.isAggregationQuery(normalizedQuery) && !this.hasRelationshipJoins(normalizedQuery)) {
      return 'relational';
    }

    // Default to relational for safety
    return 'relational';
  }

  /**
   * Check if query is path-based (shortest path, traversal)
   */
  private isPathBasedQuery(query: string): boolean {
    const pathPatterns = [
      /SHORTEST\s+PATH/i,
      /PATH\s*\(/i,
      /TRAVERSE/i,
      /WALK\s*\(/i,
      /HOPS?\s*\(/i,
    ];

    return pathPatterns.some(pattern => pattern.test(query));
  }

  /**
   * Check if query has recursive CTE
   */
  private hasRecursiveCTE(query: string): boolean {
    return /WITH\s+RECURSIVE/i.test(query);
  }

  /**
   * Check if query has relationship-heavy JOINs
   */
  private hasRelationshipJoins(query: string): boolean {
    const relationshipTables = [
      'TRANSACTION',
      'CONTRACT',
      'EVENT',
      'WALLET',
      'TOKEN',
    ];

    const joinCount = (query.match(/JOIN/gi) || []).length;
    
    // If multiple JOINs on relationship tables, route to graph
    if (joinCount >= 2) {
      const hasRelationshipJoin = relationshipTables.some(table => 
        query.includes(table)
      );
      return hasRelationshipJoin;
    }

    return false;
  }

  /**
   * Check if query is relationship aggregation
   */
  private isRelationshipAggregation(query: string): boolean {
    const aggregationPatterns = [
      /COUNT\s*\(\s*\w+\s*\.\s*\w+\s*\)/i,
      /SUM\s*\(\s*\w+\s*\.\s*\w+\s*\)/i,
      /AVG\s*\(\s*\w+\s*\.\s*\w+\s*\)/i,
      /GROUP\s+BY\s+\w+\s*\.\s*\w+/i,
    ];

    return aggregationPatterns.some(pattern => pattern.test(query)) && 
           this.hasRelationshipJoins(query);
  }

  /**
   * Check if query is simple row lookup
   */
  private isSimpleRowLookup(query: string): boolean {
    const simplePatterns = [
      /SELECT\s+\*\s+FROM\s+\w+\s+WHERE\s+\w+\s*=\s*['"]?\w+['"]?/i,
      /SELECT\s+\w+(?:,\s*\w+)*\s+FROM\s+\w+\s+WHERE\s+\w+\s*=\s*['"]?\w+['"]?/i,
    ];

    return simplePatterns.some(pattern => pattern.test(query)) && 
           !query.includes('JOIN');
  }

  /**
   * Check if query is aggregation (but not relationship-heavy)
   */
  private isAggregationQuery(query: string): boolean {
    return /COUNT|SUM|AVG|MAX|MIN|GROUP\s+BY/i.test(query);
  }

  /**
   * Estimate query complexity
   */
  estimateComplexity(query: string): number {
    let complexity = 0;

    // Base complexity
    complexity += 1;

    // JOINs increase complexity
    const joinCount = (query.match(/JOIN/gi) || []).length;
    complexity += joinCount * 2;

    // Subqueries increase complexity
    const subqueryCount = (query.match(/\(SELECT/gi) || []).length;
    complexity += subqueryCount * 3;

    // Recursive CTEs significantly increase complexity
    if (this.hasRecursiveCTE(query)) {
      complexity += 10;
    }

    // Aggregations increase complexity
    if (this.isAggregationQuery(query)) {
      complexity += 2;
    }

    return complexity;
  }

  /**
   * Get routing decision with explanation
   */
  getRoutingDecision(query: string, context: Partial<QueryContext> = {}): {
    target: QueryTarget;
    reason: string;
    complexity: number;
  } {
    const target = this.routeQuery(query, context);
    const complexity = this.estimateComplexity(query);
    
    let reason = '';
    
    switch (target) {
      case 'graph':
        if (this.isPathBasedQuery(query)) {
          reason = 'Query uses path-based operations (shortest path, traversal)';
        } else if (this.hasRecursiveCTE(query)) {
          reason = 'Query uses recursive CTEs';
        } else if (this.hasRelationshipJoins(query)) {
          reason = 'Query has multiple JOINs on relationship tables';
        } else if (this.isRelationshipAggregation(query)) {
          reason = 'Query performs relationship aggregations';
        } else {
          reason = 'Explicitly marked as graph query';
        }
        break;
      case 'relational':
        if (this.isSimpleRowLookup(query)) {
          reason = 'Query is a simple row lookup';
        } else if (this.isAggregationQuery(query)) {
          reason = 'Query is a standard aggregation';
        } else {
          reason = 'Default routing to relational database';
        }
        break;
    }

    return {
      target,
      reason,
      complexity,
    };
  }
}

// Singleton instance
let queryRouterInstance: QueryRouter | null = null;

export function getQueryRouter(): QueryRouter {
  if (!queryRouterInstance) {
    queryRouterInstance = new QueryRouter();
  }
  return queryRouterInstance;
}

export function resetQueryRouter(): void {
  queryRouterInstance = null;
}
