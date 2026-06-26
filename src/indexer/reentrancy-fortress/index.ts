/**
 * Soroban Reentrancy Fortress — Module Index
 *
 * Re-exports all fortress functionality.
 * Issue #307
 */

export * from './types';
export {
  buildCallGraph,
  findCycles,
  findContractCycles,
  mapContractCycleToVertexPath,
  hasLoops,
  uniqueContractCount,
  computeMaxDepth,
  computeAvgDepth,
  buildContractAdjacency,
  buildContractSequence,
} from './call-graph';
export type { TraceCall } from './call-graph';
export { detectReentrancy, getPatternDefinitions, DETECTION_PATTERNS } from './detector';
export { computeRiskScore, scoreFinding, computeRiskFactors, getRiskLevel } from './scoring';
export {
  analyzeTransaction,
  analyzeAndPersist,
  persistAnalysis,
  runBatchAnalysis,
  runHistoricalBackfill,
  processRealtimeTransaction,
  computeAndPersistStats,
  createAlert,
} from './background';
