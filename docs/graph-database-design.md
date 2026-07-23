# Hybrid Relational-Graph Storage Design Document

## Overview

This document describes the implementation of a hybrid relational-graph storage system for the Soroban Smart Block Backend platform. The system addresses performance issues with relationship-heavy queries by adding Apache AGE (Apache Graph Extension) as a companion graph database to PostgreSQL.

## Problem Statement

The platform faces performance challenges with relationship-heavy queries:
- Contract call graphs
- Token transfer chains  
- Wallet interaction networks
- Governance vote delegation chains

These require recursive CTEs, N+1 joins, and application-level walking, leading to O(n²) query times on the relational database.

## Solution Architecture

### Technology Choice: Apache AGE

**Rationale for Apache AGE over Neo4j:**
- Native PostgreSQL extension - no additional infrastructure
- Direct SQL integration with Cypher queries
- Leverages existing PostgreSQL infrastructure and expertise
- Lower operational overhead
- Seamless CDC integration via PostgreSQL replication
- ACID compliance with PostgreSQL transactions

### System Components

```
┌─────────────────┐         ┌─────────────────┐
│   PostgreSQL    │◄────────┤  Apache AGE    │
│  (Relational)   │  CDC    │   (Graph)       │
└────────┬────────┘         └────────┬────────┘
         │                           │
         │                           │
┌────────▼────────┐         ┌────────▼────────┐
│  Prisma ORM     │         │  Graph Service │
└────────┬────────┘         └────────┬────────┘
         │                           │
         └──────────┬────────────────┘
                    │
         ┌──────────▼────────┐
         │  Express API      │
         │  Query Router     │
         └───────────────────┘
```

## Property Graph Model

### 1. Transaction Flow Graph

**Nodes:**
- `Wallet` (address, type, firstSeen, lastActive)
- `Transaction` (hash, ledgerSequence, timestamp, status, fee)
- `Contract` (address, name, type, verified)
- `Event` (id, type, topics, data)

**Edges:**
- `SENT` (Wallet → Transaction): timestamp, fee
- `CALLS` (Transaction → Contract): functionName, gasUsed, success
- `EMITS` (Contract → Event): eventType, topicCount

**Cypher Schema:**
```cypher
CREATE CONSTRAINT wallet_address_unique IF NOT EXISTS FOR (w:Wallet) REQUIRE w.address IS UNIQUE;
CREATE CONSTRAINT tx_hash_unique IF NOT EXISTS FOR (t:Transaction) REQUIRE t.hash IS UNIQUE;
CREATE CONSTRAINT contract_address_unique IF NOT EXISTS FOR (c:Contract) REQUIRE c.address IS UNIQUE;
CREATE CONSTRAINT event_id_unique IF NOT EXISTS FOR (e:Event) REQUIRE e.id IS UNIQUE;

CREATE INDEX wallet_type IF NOT EXISTS FOR (w:Wallet) ON (w.type);
CREATE INDEX tx_timestamp IF NOT EXISTS FOR (t:Transaction) ON (t.timestamp);
CREATE INDEX contract_type IF NOT EXISTS FOR (c:Contract) ON (c.type);
```

### 2. Token Transfer Graph

**Nodes:**
- `Wallet` (address, balance, tokenCount)
- `Token` (address, symbol, decimals, totalSupply)

**Edges:**
- `TRANSFERS` (Wallet → Token): amount, timestamp, transactionHash
- `HELD_BY` (Token → Wallet): balance, firstHeld, lastTransfer

**Cypher Schema:**
```cypher
CREATE CONSTRAINT token_address_unique IF NOT EXISTS FOR (t:Token) REQUIRE t.address IS UNIQUE;

CREATE INDEX token_symbol IF NOT EXISTS FOR (t:Token) ON (t.symbol);
CREATE INDEX transfers_timestamp IF NOT EXISTS FOR ()-[r:TRANSFERS]-() ON (r.timestamp);
```

### 3. Contract Composability Graph

**Nodes:**
- `Contract` (address, type, complexityScore, deploymentDate)

**Edges:**
- `CALLS` (Contract → Contract): callCount, totalGasCost, avgGasCost, reentrancyDepth, lastCallTimestamp

**Cypher Schema:**
```cypher
CREATE INDEX contract_calls_count IF NOT EXISTS FOR ()-[r:CALLS]-() ON (r.callCount);
CREATE INDEX contract_reentrancy IF NOT EXISTS FOR ()-[r:CALLS]-() ON (r.reentrancyDepth);
```

### 4. Reputation Trust Graph

**Nodes:**
- `Wallet` (address, trustScore, reputationLevel, verificationStatus)

**Edges:**
- `TRUSTS` (Wallet → Wallet): score, timestamp, context, expiration
- `ATTESTS` (Wallet → Wallet): score, timestamp, type, expiration
- `ENDORSES` (Wallet → Wallet): score, timestamp, endorsementType, expiration

**Cypher Schema:**
```cypher
CREATE INDEX trusts_score IF NOT EXISTS FOR ()-[r:TRUSTS]-() ON (r.score);
CREATE INDEX trusts_timestamp IF NOT EXISTS FOR ()-[r:TRUSTS]-() ON (r.timestamp);
CREATE INDEX trusts_expiration IF NOT EXISTS FOR ()-[r:TRUSTS]-() ON (r.expiration);
```

## Data Synchronization

### Change Data Capture (CDC) Strategy

**Implementation Approach:**
1. PostgreSQL logical replication to capture row-level changes
2. Debezium connector for change stream processing
3. Apache AGE upsert operations for graph synchronization
4. Eventual consistency with < 1s lag target

**Sync Pipeline:**
```
PostgreSQL WAL → Logical Replication → Debezium → Kafka → Graph Sync Service → Apache AGE
```

**Idempotent Edge Operations:**
```cypher
// Upsert pattern for idempotent edge creation
MERGE (a:Wallet {address: $fromAddress})
MERGE (b:Wallet {address: $toAddress})
MERGE (a)-[r:TRANSFERS {transactionHash: $txHash}]->(b)
SET r.amount = $amount, r.timestamp = $timestamp
```

**Sync Latency Monitoring:**
- Track PostgreSQL commit time to graph write completion
- Alert if p99 latency exceeds 1s
- Implement backpressure for high-volume periods

## Graph Query API

### Endpoint: POST /api/v1/graph/query

**Request Schema:**
```typescript
{
  query: string,        // Parameterized Cypher query
  parameters: object,   // Query parameters (prevents injection)
  timeout?: number      // Query timeout in ms (default: 5000)
}
```

**Response Schema:**
```typescript
{
  data: any[],          // Query results
  executionTime: number, // Execution time in ms
  nodeCount: number,    // Number of nodes returned
  edgeCount: number     // Number of edges returned
}
```

**Security Measures:**
- Parameterized queries only (no string interpolation)
- Query complexity limits (max 1000 nodes returned)
- Query timeout enforcement
- Whitelisted Cypher functions
- Read-only role for graph queries

### Visual Graph Explorer Endpoint

**Endpoint: GET /api/v1/graph/explorer**

**Query Parameters:**
- `nodeId`: Starting node ID
- `depth`: Hop depth (1-5, default: 2)
- `nodeTypes`: Filter by node types (comma-separated)
- `edgeTypes`: Filter by edge types (comma-separated)
- `limit`: Max nodes per depth (default: 50)

**Response Format (D3.js/Cytoscape compatible):**
```typescript
{
  nodes: Array<{
    id: string,
    label: string,
    type: string,
    properties: object,
    data: object  // Cytoscape data format
  }>,
  edges: Array<{
    id: string,
    source: string,
    target: string,
    label: string,
    type: string,
    properties: object,
    data: object  // Cytoscape data format
  }>,
  metadata: {
    totalNodes: number,
    totalEdges: number,
    queryTime: number,
    depth: number
  }
}
```

## Pre-built Graph Query Templates

### 1. Shortest Path (Money Laundering Investigation)

**Use Case:** Find unusual transaction paths between wallets

**Template:**
```cypher
MATCH path = shortestPath(
  (source:Wallet {address: $fromAddress})-[*1..$maxHops]-(target:Wallet {address: $toAddress})
)
WHERE all(r IN relationships(path) WHERE r.timestamp >= $startTime AND r.timestamp <= $endTime)
RETURN path
ORDER BY length(path) ASC
LIMIT 10
```

**Parameters:**
- `fromAddress`: Source wallet address
- `toAddress`: Target wallet address
- `maxHops`: Maximum path length (default: 10)
- `startTime`: Start timestamp
- `endTime`: End timestamp

### 2. K-Hop Neighborhood (Wallet Risk Assessment)

**Use Case:** Analyze wallet's immediate network for risk scoring

**Template:**
```cypher
MATCH (wallet:Wallet {address: $address})
CALL {
  WITH wallet
  MATCH (wallet)-[r:TRANSFERS|CALLS|TRUSTS*1..$hops]-(neighbor)
  RETURN collect(DISTINCT neighbor) as neighbors
}
RETURN wallet, neighbors, size(neighbors) as networkSize
```

**Parameters:**
- `address`: Wallet address
- `hops`: Number of hops (1-5)

### 3. Community Detection (Sybil Cluster Identification)

**Use Case:** Identify clusters of related wallets

**Algorithm:** Louvain Community Detection

**Template:**
```cypher
CALL louvain.algo($graphName, {writeProperty: 'community', relationshipTypes: ['TRANSFERS', 'TRUSTS']})
YIELD communityCount, modularity
RETURN communityCount, modularity
```

**Cluster Query:**
```cypher
MATCH (n)
WHERE n.community IS NOT NULL
RETURN n.community as community, collect(n.address) as members, count(n) as size
ORDER BY size DESC
LIMIT 100
```

### 4. Influence Maximization (DeFi Contract Hubs)

**Use Case:** Identify most connected contracts

**Algorithm:** Betweenness Centrality

**Template:**
```cypher
CALL betweenness.centrality($graphName, {writeProperty: 'betweenness'})
YIELD nodes, centrality
RETURN nodes.address, nodes.name, centrality
ORDER BY centrality DESC
LIMIT 50
```

### 5. PageRank (Contract Importance Scoring)

**Use Case:** Rank contracts by importance in the network

**Template:**
```cypher
CALL pagerank.algo($graphName, {writeProperty: 'pagerank', iterations: 20, dampingFactor: 0.85})
YIELD nodes, pagerank
RETURN nodes.address, nodes.name, nodes.type, pagerank
ORDER BY pagerank DESC
LIMIT 100
```

## Graph Analytics Pipeline

### Daily Analytics Jobs

**Schedule:** Daily at 00:00 UTC

**Jobs:**
1. **PageRank Calculation**
   - Input: Full transaction graph
   - Algorithm: PageRank with 20 iterations, damping factor 0.85
   - Output: Node property `pagerank`
   - Target: < 1 hour for 10M nodes

2. **Betweenness Centrality**
   - Input: Contract call graph
   - Algorithm: Brandes algorithm (approximation for large graphs)
   - Output: Node property `betweenness`
   - Target: < 2 hours for 10M nodes

3. **Community Detection**
   - Input: Wallet interaction graph
   - Algorithm: Louvain method
   - Output: Node property `community`
   - Target: < 30 minutes for 10M nodes

4. **Degree Centrality**
   - Input: All graphs
   - Algorithm: Simple degree calculation
   - Output: Node properties `inDegree`, `outDegree`
   - Target: < 10 minutes

### Temporal Graph Analysis

**Time Window Analysis:**
- Daily snapshots of graph metrics
- Trend analysis for:
  - New hub formation
  - Isolated subgraph detection
  - Edge growth rate
  - Node churn rate

**Implementation:**
```sql
-- PostgreSQL table for temporal metrics
CREATE TABLE graph_metrics_snapshot (
  id SERIAL PRIMARY KEY,
  snapshot_date DATE NOT NULL,
  node_count INT NOT NULL,
  edge_count INT NOT NULL,
  avg_degree FLOAT NOT NULL,
  max_degree INT NOT NULL,
  community_count INT NOT NULL,
  modularity_score FLOAT NOT NULL,
  new_hubs TEXT[],
  isolated_subgraphs INT,
  created_at TIMESTAMP DEFAULT NOW()
);
```

### Graph Feature Extraction for ML

**Node Embeddings:**
- Algorithm: Node2Vec or GraphSAGE
- Dimensions: 128
- Window size: 10
- Walks per node: 10
- Walk length: 80

**Feature Storage:**
```sql
CREATE TABLE node_embeddings (
  node_id VARCHAR(255) PRIMARY KEY,
  node_type VARCHAR(50) NOT NULL,
  embedding_vector FLOAT(128) NOT NULL,
  embedding_version VARCHAR(20) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

## Query Routing Logic

**Routing Decision Tree:**
```
Query Analysis
├── Contains JOINs on relationship tables?
│   ├── Yes → Route to Graph DB
│   └── No → Continue analysis
├── Contains recursive CTEs?
│   ├── Yes → Route to Graph DB
│   └── No → Continue analysis
├── Path-based query (shortest path, traversal)?
│   ├── Yes → Route to Graph DB
│   └── No → Continue analysis
├── Aggregation on relationships?
│   ├── Yes → Route to Graph DB
│   └── No → Route to PostgreSQL
└── Simple row lookup?
    └── Yes → Route to PostgreSQL
```

**Implementation:**
```typescript
function routeQuery(query: string, context: QueryContext): 'graph' | 'relational' {
  if (query.includes('JOIN') && hasRelationshipJoins(query)) {
    return 'graph';
  }
  if (query.includes('WITH RECURSIVE')) {
    return 'graph';
  }
  if (isPathBasedQuery(query)) {
    return 'graph';
  }
  if (isRelationshipAggregation(query)) {
    return 'graph';
  }
  return 'relational';
}
```

## Graph Query Caching

**Cache Strategy:**
- Redis-based caching layer
- Cache key: Hash of query + parameters
- TTL: 5 minutes for analytical queries, 1 hour for reference data
- Invalidation: Event-driven on new edge creation

**Invalidation Triggers:**
```typescript
// On new transaction
invalidateCachePattern('wallet:*', 'transaction:*');

// On new contract call
invalidateCachePattern('contract:*', 'call:*');

// On token transfer
invalidateCachePattern('token:*', 'transfer:*');
```

**Cache Metrics:**
- Hit rate tracking
- Eviction rate monitoring
- Memory usage alerts

## Performance Targets

### Query Performance
- Wallet hop query (5 hops, 10M nodes): < 200ms
- Shortest path query (10 hops): < 500ms
- K-hop neighborhood (3 hops, 1000 nodes): < 100ms
- Community detection (10M nodes): < 30 minutes

### Analytics Performance
- PageRank (10M nodes): < 1 hour
- Betweenness Centrality (10M nodes): < 2 hours
- Louvain Community Detection (10M nodes): < 30 minutes

### Sync Performance
- PostgreSQL to Graph DB sync lag: < 1s p99
- Batch write throughput: > 10,000 edges/second

## Consistency Guarantees

### Eventual Consistency
- Target: < 1s lag between PostgreSQL and Graph DB
- Monitoring: p99 latency measurement
- Alerting: > 2s lag triggers alert

### Idempotent Operations
- All edge writes use MERGE (upsert) pattern
- Transaction hash as unique identifier for edges
- Retry-safe operations

### Transaction Safety
- Graph writes wrapped in PostgreSQL transactions where possible
- Fallback to compensation transactions for cross-system operations

## Security Considerations

### Cypher Injection Prevention
- Parameterized queries only
- Query template whitelisting
- No dynamic query construction
- Read-only graph user for API queries

### Access Control
- Role-based access to graph operations
- Audit logging for all graph queries
- Rate limiting on graph endpoints

### Data Privacy
- Sensitive wallet data masking
- Graph-level access controls
- Query result size limits

## Monitoring & Observability

### Metrics to Track
- Graph query latency (p50, p95, p99)
- Sync lag between PostgreSQL and Graph DB
- Cache hit/miss rates
- Graph size (node count, edge count)
- Analytics job duration
- Query routing decisions

### Alerts
- Sync lag > 2s
- Graph query latency > 1s
- Cache hit rate < 50%
- Analytics job failure
- Graph DB connection issues

## Deployment Strategy

### Infrastructure Changes
1. Add Apache AGE extension to PostgreSQL
2. Configure logical replication
3. Deploy Debezium connector
4. Deploy graph sync service
5. Update docker-compose.yml

### Migration Steps
1. Install Apache AGE extension
2. Create graph schema and constraints
3. Backfill historical data
4. Enable CDC sync
5. Deploy graph API endpoints
6. Enable query routing
7. Monitor and tune performance

### Rollback Plan
- Disable query routing (route all to PostgreSQL)
- Stop graph sync service
- Graph DB remains available for manual queries
- No data loss (PostgreSQL remains source of truth)

## Testing Strategy

### Unit Tests
- Graph query template validation
- Query routing logic
- CDC sync operations
- Cache invalidation

### Integration Tests
- End-to-end sync pipeline
- Graph query API
- Visual explorer endpoint
- Analytics jobs

### Performance Tests
- Query latency benchmarks
- Sync throughput tests
- Analytics job duration tests
- Cache effectiveness tests

### Load Tests
- Concurrent query handling
- High-volume sync scenarios
- Graph DB under load

## Future Enhancements

### Phase 2 Features
- Real-time graph updates via WebSocket
- Graph-based anomaly detection
- Advanced ML features (Graph Neural Networks)
- Multi-chain graph support
- Graph visualization UI

### Phase 3 Features
- Temporal graph queries (time travel)
- Graph-based recommendation engine
- Predictive analytics on graph evolution
- Cross-chain bridge graph analysis

## Conclusion

This hybrid relational-graph storage architecture addresses the performance challenges of relationship-heavy queries while maintaining the robustness of the existing PostgreSQL-based system. The use of Apache AGE provides seamless integration with existing infrastructure while delivering the performance benefits of a native graph database.
