# ADR-002: In-Memory + Redis Cache Strategy

## Status
Accepted

## Context
Indexer and API responses are read-heavy and latency-sensitive. A pure in-memory cache does not survive restarts or scale across instances. A pure Redis cache adds network overhead for hot data.

## Decision
Use a layered cache:
- L1: in-memory LRU-style map for the hottest keys (sub-millisecond)
- L2: Redis for shared state across instances and persistence across restarts

Cache keys are namespaced by network (`testnet:`, `mainnet:`, `devnet:`) to avoid cross-network leakage.

## Consequences
- Hot paths stay fast even if Redis latency spikes
- Multiple API instances share consistent cache state
- Cache invalidation must purge both layers
