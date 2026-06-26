/**
 * Soroban Reentrancy Fortress — Shared Types
 *
 * Core type definitions for the cross-contract reentrancy analysis platform.
 * Issue #307
 */

// ── Call Graph Types ─────────────────────────────────────────────────────────

export interface CallGraphVertex {
  id: string;
  txHash: string;
  contractAddress: string;
  functionName: string;
  depth: number;
  callIndex: number;
  value?: string;
  preStateReads?: string[];
  postStateWrites?: string[];
  timestamp: Date;
}

export interface CallGraphEdge {
  id: string;
  txHash: string;
  fromVertexId: string;
  toVertexId: string;
  functionName: string;
  value?: string;
  gasForwarded?: number;
  argsHash?: string;
  callIndex: number;
  timestamp: Date;
}

export interface CallGraph {
  vertices: CallGraphVertex[];
  edges: CallGraphEdge[];
}

// ── Reentrancy Detection Types ───────────────────────────────────────────────

export type ReentrancyType = 'SIMPLE' | 'CROSS_CONTRACT' | 'MULTI_STEP' | 'READ_ONLY' | 'CROSS_FUNCTION' | 'DESTRUCTIVE';

export const ReentrancyTypes = {
  SIMPLE: 'SIMPLE' as const,
  CROSS_CONTRACT: 'CROSS_CONTRACT' as const,
  MULTI_STEP: 'MULTI_STEP' as const,
  READ_ONLY: 'READ_ONLY' as const,
  CROSS_FUNCTION: 'CROSS_FUNCTION' as const,
  DESTRUCTIVE: 'DESTRUCTIVE' as const,
};

export type ReentrancySeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export const ReentrancySeverities = {
  LOW: 'LOW' as const,
  MEDIUM: 'MEDIUM' as const,
  HIGH: 'HIGH' as const,
  CRITICAL: 'CRITICAL' as const,
};

export interface ReentrancyFinding {
  id: string;
  txHash: string;
  contractAddress: string;
  reentrancyType: ReentrancyType;
  severity: ReentrancySeverity;
  likelihood: string; // 'theoretical' | 'confirmed'
  loopPath: Array<{ contractAddress: string; functionName: string; callIndex: number }>;
  entryPoint: string;
  valueAtRisk?: string;
  usdValueAtRisk?: number;
  profitPotential?: number;
  description: string;
  detectedAt: Date;
}

// ── Detection Pattern Types ──────────────────────────────────────────────────

export interface DetectionPattern {
  type: ReentrancyType;
  name: string;
  description: string;
  severity: ReentrancySeverity;
  /** Returns confidence 0-1 and the detected loop path if found */
  detect: (graph: CallGraph) => { confidence: number; loopPath: ReentrancyFinding['loopPath'] } | null;
}

// ── Risk Scoring Types ──────────────────────────────────────────────────────

export interface ContractRiskFactors {
  totalFindings: number;
  criticalFindings: number;
  highFindings: number;
  mediumFindings: number;
  simpleReentrancyCount: number;
  crossContractCount: number;
  multiStepCount: number;
  readOnlyCount: number;
  crossFunctionCount: number;
  destructiveCount: number;
  avgCycleLength: number;
  maxCallDepth: number;
  totalValueAtRiskUsd: number;
  findingsInLast30Days: number;
  confirmedAttackCount: number;
}

export interface RiskScore {
  contractAddress: string;
  riskScore: number; // 0-100
  previousScore?: number;
  totalFindings: number;
  criticalFindings: number;
  highFindings: number;
  mediumFindings: number;
  riskFactors: ContractRiskFactors;
  lastAnalyzed: Date;
  severity: ReentrancySeverity;
}

// ── Stats Types ──────────────────────────────────────────────────────────────

export interface ReentrancyStatsSnapshot {
  timestamp: Date;
  totalCallGraphs: number;
  contractsAnalyzed: number;
  contractsWithLoops: number;
  highRiskContracts: number;
  criticalFindings: number;
  totalFindings: number;
  mostCommonPatterns: Array<{ type: string; count: number }>;
  avgDepth?: number;
  maxDepth?: number;
  valueAtRiskTotal?: string;
}

// ── Background Engine Types ─────────────────────────────────────────────────

export interface AnalysisResult {
  graph: CallGraph;
  findings: ReentrancyFinding[];
  riskScore: RiskScore;
}

export interface AnalysisConfig {
  /** Maximum transactions to process per batch */
  batchSize: number;
  /** Interval between batch runs in milliseconds */
  batchIntervalMs: number;
  /** Whether real-time analysis is enabled */
  realtimeEnabled: boolean;
  /** Minimum transaction value to analyze (in stroops, as string) */
  minValueThreshold?: string;
}
