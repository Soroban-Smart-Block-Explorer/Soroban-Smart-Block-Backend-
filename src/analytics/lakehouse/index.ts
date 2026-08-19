/**
 * Multi-Layer Data Lakehouse (Issue #551)
 *
 * Barrel export for the four-layer lakehouse:
 *
 *   Layer 1 — Stream Processing : schema-registry, stream-bus, stream-processors
 *   Layer 2 — OLAP Analytics    : olap-store (ClickHouse + in-memory)
 *   Layer 3 — Cold Storage       : tiering, federated-query (+ existing iceberg-writer)
 *   Layer 4 — Query Gateway      : query-gateway
 *
 * See DATA_LAKEHOUSE_ARCHITECTURE.md for the full design.
 */

export * from './schema-registry';
export * from './stream-bus';
export * from './stream-processors';
export * from './olap-store';
export * from './tiering';
export * from './federated-query';
export * from './query-gateway';
