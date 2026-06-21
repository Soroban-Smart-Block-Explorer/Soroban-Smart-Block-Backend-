/**
 * Cross-Protocol Liquidity Aggregation Engine (Issue #334)
 *
 * Entry point for all aggregator sub-modules.
 * Each module exports pure/stateless core functions and a
 * DB-backed convenience layer that wraps the DB calls.
 */

export * from './pool-indexer';
export * from './order-router';
export * from './split-router';
export * from './price-engine';
export * from './quote-cache';
export * from './orders';
export * from './dca';
export * from './mev-protection';
export * from './cl-math';
export * from './cl-manager';
export * from './bridge-aggregator';
export * from './gas-optimizer';
export * from './risk-manager';
export * from './aggregator-ws';
export * from './social-trading';
export * from './twap-oracle';
