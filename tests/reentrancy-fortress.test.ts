/**
 * Soroban Reentrancy Fortress — Comprehensive Test Suite
 *
 * Tests for: call graph construction, all 6 reentrancy detection types,
 * risk scoring, and the full analysis pipeline.
 * Issue #307
 */

import { describe, it, expect } from 'vitest';
import {
  buildCallGraph,
  findContractCycles,
  hasLoops,
  computeMaxDepth,
  computeAvgDepth,
  uniqueContractCount,
} from '../src/indexer/reentrancy-fortress/call-graph';
import type { TraceCall } from '../src/indexer/reentrancy-fortress/call-graph';
import {
  detectReentrancy,
  getPatternDefinitions,
  DETECTION_PATTERNS,
} from '../src/indexer/reentrancy-fortress/detector';
import {
  computeRiskScore,
  scoreFinding,
  getRiskLevel,
  computeRiskFactors,
} from '../src/indexer/reentrancy-fortress/scoring';
import type { ReentrancyFinding, ReentrancyType } from '../src/indexer/reentrancy-fortress/types';

// ── Test Helpers ──────────────────────────────────────────────────────────────

const TX = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
const CONTRACT_A = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const CONTRACT_B = 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const CONTRACT_C = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const CONTRACT_D = 'CDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';

function makeCall(
  contractId: string,
  functionName: string,
  opts: Partial<TraceCall> = {},
): TraceCall {
  return {
    contractId,
    functionName,
    depth: opts.depth ?? 0,
    callIndex: opts.callIndex ?? 0,
    value: opts.value,
    preStateReads: opts.preStateReads,
    postStateWrites: opts.postStateWrites,
    gasForwarded: opts.gasForwarded,
    argsHash: opts.argsHash,
  };
}

function hasFindingsOfType(findings: ReentrancyFinding[], type: ReentrancyType): boolean {
  return findings.some((f) => f.reentrancyType === type);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Call Graph Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('CallGraph Builder', () => {
  it('builds a simple call graph with one vertex and no edges', () => {
    const calls: TraceCall[] = [makeCall(CONTRACT_A, 'transfer', { depth: 0, callIndex: 0 })];
    const graph = buildCallGraph(TX, calls);
    expect(graph.vertices).toHaveLength(1);
    expect(graph.edges).toHaveLength(0);
    expect(graph.vertices[0].contractAddress).toBe(CONTRACT_A);
    expect(graph.vertices[0].functionName).toBe('transfer');
  });

  it('builds a graph with parent-child relationships', () => {
    const calls: TraceCall[] = [
      makeCall(CONTRACT_A, 'withdraw', { depth: 0, callIndex: 0 }),
      makeCall(CONTRACT_B, 'transfer', { depth: 1, callIndex: 1 }),
      makeCall(CONTRACT_B, 'transfer_inner', { depth: 2, callIndex: 2 }),
    ];
    const graph = buildCallGraph(TX, calls);
    expect(graph.vertices).toHaveLength(3);
    expect(graph.edges).toHaveLength(2);
    expect(graph.edges[0].fromVertexId).toBe(graph.vertices[0].id);
    expect(graph.edges[0].toVertexId).toBe(graph.vertices[1].id);
    expect(graph.edges[1].fromVertexId).toBe(graph.vertices[1].id);
    expect(graph.edges[1].toVertexId).toBe(graph.vertices[2].id);
  });

  it('correctly tracks depth in vertices', () => {
    const calls: TraceCall[] = [
      makeCall(CONTRACT_A, 'fn1', { depth: 0, callIndex: 0 }),
      makeCall(CONTRACT_B, 'fn2', { depth: 1, callIndex: 1 }),
      makeCall(CONTRACT_C, 'fn3', { depth: 2, callIndex: 2 }),
      makeCall(CONTRACT_D, 'fn4', { depth: 3, callIndex: 3 }),
    ];
    const graph = buildCallGraph(TX, calls);
    expect(graph.vertices[0].depth).toBe(0);
    expect(graph.vertices[1].depth).toBe(1);
    expect(graph.vertices[2].depth).toBe(2);
    expect(graph.vertices[3].depth).toBe(3);
  });

  it('preserves metadata on edges', () => {
    const calls: TraceCall[] = [
      makeCall(CONTRACT_A, 'withdraw', {
        depth: 0,
        callIndex: 0,
        value: '1000',
        gasForwarded: 50000,
        argsHash: 'abc123',
      }),
      makeCall(CONTRACT_B, 'callback', {
        depth: 1,
        callIndex: 1,
        value: '500',
        gasForwarded: 30000,
      }),
    ];
    const graph = buildCallGraph(TX, calls);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].value).toBe('500');
    expect(graph.edges[0].gasForwarded).toBe(30000);
  });

  it('siblings at same depth link to correct parent', () => {
    const calls: TraceCall[] = [
      makeCall(CONTRACT_A, 'root', { depth: 0, callIndex: 0 }),
      makeCall(CONTRACT_B, 'child1', { depth: 1, callIndex: 1 }),
      makeCall(CONTRACT_C, 'child2', { depth: 1, callIndex: 2 }),
      makeCall(CONTRACT_D, 'child3', { depth: 1, callIndex: 3 }),
    ];
    const graph = buildCallGraph(TX, calls);
    expect(graph.vertices).toHaveLength(4);
    expect(graph.edges).toHaveLength(3);
    for (const edge of graph.edges) {
      expect(edge.fromVertexId).toBe(graph.vertices[0].id);
    }
  });
});

describe('Contract-Level Cycle Detection', () => {
  it('detects contract-level cycle A→B→A', () => {
    const calls: TraceCall[] = [
      makeCall(CONTRACT_A, 'withdraw', { depth: 0, callIndex: 0 }),
      makeCall(CONTRACT_B, 'transfer', { depth: 1, callIndex: 1 }),
      makeCall(CONTRACT_A, 'callback', { depth: 2, callIndex: 2 }),
    ];
    const graph = buildCallGraph(TX, calls);
    const contractCycles = findContractCycles(graph);
    expect(contractCycles.length).toBeGreaterThan(0);
  });

  it('detects contract-level cycle A→B→C→A', () => {
    const calls: TraceCall[] = [
      makeCall(CONTRACT_A, 'withdraw', { depth: 0, callIndex: 0 }),
      makeCall(CONTRACT_B, 'lend', { depth: 1, callIndex: 1 }),
      makeCall(CONTRACT_C, 'swap', { depth: 2, callIndex: 2 }),
      makeCall(CONTRACT_A, 'borrow', { depth: 3, callIndex: 3 }),
    ];
    const graph = buildCallGraph(TX, calls);
    const contractCycles = findContractCycles(graph);
    expect(contractCycles.length).toBeGreaterThan(0);
  });

  it('finds no contract cycles in a linear chain', () => {
    const calls: TraceCall[] = [
      makeCall(CONTRACT_A, 'fn1', { depth: 0, callIndex: 0 }),
      makeCall(CONTRACT_B, 'fn2', { depth: 1, callIndex: 1 }),
      makeCall(CONTRACT_C, 'fn3', { depth: 2, callIndex: 2 }),
    ];
    const graph = buildCallGraph(TX, calls);
    const contractCycles = findContractCycles(graph);
    expect(contractCycles).toHaveLength(0);
  });
});

describe('Graph Utilities', () => {
  it('computes max depth correctly', () => {
    const calls: TraceCall[] = [
      makeCall(CONTRACT_A, 'fn1', { depth: 0, callIndex: 0 }),
      makeCall(CONTRACT_B, 'fn2', { depth: 1, callIndex: 1 }),
      makeCall(CONTRACT_C, 'fn3', { depth: 4, callIndex: 2 }),
    ];
    const graph = buildCallGraph(TX, calls);
    expect(computeMaxDepth(graph)).toBe(4);
  });

  it('computes average depth correctly', () => {
    const calls: TraceCall[] = [
      makeCall(CONTRACT_A, 'fn1', { depth: 0, callIndex: 0 }),
      makeCall(CONTRACT_B, 'fn2', { depth: 1, callIndex: 1 }),
      makeCall(CONTRACT_C, 'fn3', { depth: 2, callIndex: 2 }),
    ];
    const graph = buildCallGraph(TX, calls);
    expect(computeAvgDepth(graph)).toBeCloseTo(1, 0);
  });

  it('counts unique contracts', () => {
    const calls: TraceCall[] = [
      makeCall(CONTRACT_A, 'fn1', { depth: 0, callIndex: 0 }),
      makeCall(CONTRACT_A, 'fn2', { depth: 1, callIndex: 1 }),
      makeCall(CONTRACT_B, 'fn3', { depth: 2, callIndex: 2 }),
      makeCall(CONTRACT_B, 'fn4', { depth: 3, callIndex: 3 }),
    ];
    const graph = buildCallGraph(TX, calls);
    expect(uniqueContractCount(graph)).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Detection Algorithm Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('Detection: Simple Reentrancy (A→A)', () => {
  it('detects same contract calling itself', () => {
    const calls: TraceCall[] = [
      makeCall(CONTRACT_A, 'withdraw', { depth: 0, callIndex: 0 }),
      makeCall(CONTRACT_A, 'withdraw', { depth: 1, callIndex: 1 }),
      makeCall(CONTRACT_A, 'withdraw', { depth: 2, callIndex: 2 }),
    ];
    const graph = buildCallGraph(TX, calls);
    const findings = detectReentrancy(TX, graph);
    expect(hasFindingsOfType(findings, 'SIMPLE')).toBe(true);
  });

  it('no false positive for single contract call', () => {
    const calls: TraceCall[] = [
      makeCall(CONTRACT_A, 'transfer', { depth: 0, callIndex: 0 }),
      makeCall(CONTRACT_B, 'callback', { depth: 1, callIndex: 1 }),
    ];
    const graph = buildCallGraph(TX, calls);
    const findings = detectReentrancy(TX, graph);
    expect(hasFindingsOfType(findings, 'SIMPLE')).toBe(false);
  });
});

describe('Detection: Cross-Contract Reentrancy (A→B→A)', () => {
  it('detects cross-contract reentrancy', () => {
    const calls: TraceCall[] = [
      makeCall(CONTRACT_A, 'withdraw', { depth: 0, callIndex: 0 }),
      makeCall(CONTRACT_B, 'transfer', { depth: 1, callIndex: 1 }),
      makeCall(CONTRACT_A, 'callback', { depth: 2, callIndex: 2 }),
    ];
    const graph = buildCallGraph(TX, calls);
    const findings = detectReentrancy(TX, graph);
    expect(hasFindingsOfType(findings, 'CROSS_CONTRACT')).toBe(true);
    const finding = findings.find((f) => f.reentrancyType === 'CROSS_CONTRACT')!;
    expect(finding.severity).toBe('CRITICAL');
  });

  it('detects A→B→A confirmed pattern with value at risk', () => {
    const calls: TraceCall[] = [
      makeCall(CONTRACT_A, 'withdraw', { depth: 0, callIndex: 0 }),
      makeCall(CONTRACT_B, 'transfer', { depth: 1, callIndex: 1 }),
      makeCall(CONTRACT_A, 'callback', { depth: 2, callIndex: 2 }),
    ];
    const graph = buildCallGraph(TX, calls);
    const findings = detectReentrancy(TX, graph, '1000000', 50000);
    const crossFinding = findings.find((f) => f.reentrancyType === 'CROSS_CONTRACT');
    expect(crossFinding).toBeDefined();
    expect(crossFinding!.valueAtRisk).toBe('1000000');
    expect(crossFinding!.usdValueAtRisk).toBe(50000);
  });

  it('no false positive for linear chain', () => {
    const calls: TraceCall[] = [
      makeCall(CONTRACT_A, 'fn1', { depth: 0, callIndex: 0 }),
      makeCall(CONTRACT_B, 'fn2', { depth: 1, callIndex: 1 }),
      makeCall(CONTRACT_C, 'fn3', { depth: 2, callIndex: 2 }),
    ];
    const graph = buildCallGraph(TX, calls);
    const findings = detectReentrancy(TX, graph);
    expect(hasFindingsOfType(findings, 'CROSS_CONTRACT')).toBe(false);
  });
});

describe('Detection: Multi-Step Reentrancy (A→B→C→A)', () => {
  it('detects multi-step reentrancy', () => {
    const calls: TraceCall[] = [
      makeCall(CONTRACT_A, 'withdraw', { depth: 0, callIndex: 0 }),
      makeCall(CONTRACT_B, 'lend', { depth: 1, callIndex: 1 }),
      makeCall(CONTRACT_C, 'swap', { depth: 2, callIndex: 2 }),
      makeCall(CONTRACT_A, 'borrow', { depth: 3, callIndex: 3 }),
    ];
    const graph = buildCallGraph(TX, calls);
    const findings = detectReentrancy(TX, graph);
    expect(hasFindingsOfType(findings, 'MULTI_STEP')).toBe(true);
    const finding = findings.find((f) => f.reentrancyType === 'MULTI_STEP')!;
    expect(finding.severity).toBe('CRITICAL');
  });

  it('loopPath has expected length', () => {
    const calls: TraceCall[] = [
      makeCall(CONTRACT_A, 'withdraw', { depth: 0, callIndex: 0 }),
      makeCall(CONTRACT_B, 'lend', { depth: 1, callIndex: 1 }),
      makeCall(CONTRACT_C, 'swap', { depth: 2, callIndex: 2 }),
      makeCall(CONTRACT_A, 'borrow', { depth: 3, callIndex: 3 }),
    ];
    const graph = buildCallGraph(TX, calls);
    const findings = detectReentrancy(TX, graph);
    const finding = findings.find((f) => f.reentrancyType === 'MULTI_STEP');
    expect(finding).toBeDefined();
    expect(finding!.loopPath.length).toBeGreaterThanOrEqual(3);
  });
});

describe('Detection: Read-Only Reentrancy', () => {
  it('detects read-only reentrancy when state reads overlap with writes', () => {
    const calls: TraceCall[] = [
      makeCall(CONTRACT_A, 'getPrice', {
        depth: 0,
        callIndex: 0,
        preStateReads: ['priceKey', 'timestampKey'],
      }),
      makeCall(CONTRACT_B, 'oracle', {
        depth: 1,
        callIndex: 1,
        postStateWrites: ['priceKey', 'timestampKey'],
      }),
      makeCall(CONTRACT_A, 'getPrice', {
        depth: 2,
        callIndex: 2,
        preStateReads: ['priceKey'],
      }),
    ];
    const graph = buildCallGraph(TX, calls);
    const findings = detectReentrancy(TX, graph);

    const readOnlyFinding = findings.find((f) => f.reentrancyType === 'READ_ONLY');
    expect(readOnlyFinding).toBeDefined();
  });

  it('no false positive without state access data', () => {
    const calls: TraceCall[] = [
      makeCall(CONTRACT_A, 'fn1', { depth: 0, callIndex: 0 }),
      makeCall(CONTRACT_B, 'fn2', { depth: 1, callIndex: 1 }),
      makeCall(CONTRACT_A, 'fn3', { depth: 2, callIndex: 2 }),
    ];
    const graph = buildCallGraph(TX, calls);
    const findings = detectReentrancy(TX, graph);
    const readOnly = findings.find((f) => f.reentrancyType === 'READ_ONLY');
    expect(readOnly).toBeUndefined();
  });
});

describe('Detection: Cross-Function Reentrancy (A.func1→B→A.func2)', () => {
  it('detects cross-function reentrancy', () => {
    const calls: TraceCall[] = [
      makeCall(CONTRACT_A, 'withdraw', { depth: 0, callIndex: 0 }),
      makeCall(CONTRACT_B, 'tokenTransfer', { depth: 1, callIndex: 1 }),
      makeCall(CONTRACT_A, 'deposit', { depth: 2, callIndex: 2 }),
    ];
    const graph = buildCallGraph(TX, calls);
    const findings = detectReentrancy(TX, graph);
    expect(hasFindingsOfType(findings, 'CROSS_FUNCTION')).toBe(true);
    const finding = findings.find((f) => f.reentrancyType === 'CROSS_FUNCTION')!;
    expect(finding.severity).toBe('HIGH');
  });

  it('no false positive for same function reentry', () => {
    const calls: TraceCall[] = [
      makeCall(CONTRACT_A, 'withdraw', { depth: 0, callIndex: 0 }),
      makeCall(CONTRACT_B, 'tokenTransfer', { depth: 1, callIndex: 1 }),
      makeCall(CONTRACT_A, 'withdraw', { depth: 2, callIndex: 2 }),
    ];
    const graph = buildCallGraph(TX, calls);
    const findings = detectReentrancy(TX, graph);
    const crossFunc = findings.filter((f) => f.reentrancyType === 'CROSS_FUNCTION');
    expect(crossFunc.length).toBe(0);
  });
});

describe('Detection: Destructive Reentrancy', () => {
  it('detects destructive reentrancy when code is deployed mid-tx', () => {
    const calls: TraceCall[] = [
      makeCall(CONTRACT_A, 'upgrade', { depth: 0, callIndex: 0 }),
      makeCall(CONTRACT_B, 'deployCode', {
        depth: 1,
        callIndex: 1,
        postStateWrites: ['wasm_hash_prod', 'bytecode_v2'],
      }),
      makeCall(CONTRACT_A, 'callback', { depth: 2, callIndex: 2 }),
    ];
    const graph = buildCallGraph(TX, calls);
    const findings = detectReentrancy(TX, graph);
    expect(hasFindingsOfType(findings, 'DESTRUCTIVE')).toBe(true);
    const finding = findings.find((f) => f.reentrancyType === 'DESTRUCTIVE')!;
    expect(finding.severity).toBe('CRITICAL');
  });

  it('no false positive without code deployment', () => {
    const calls: TraceCall[] = [
      makeCall(CONTRACT_A, 'withdraw', { depth: 0, callIndex: 0 }),
      makeCall(CONTRACT_B, 'transfer', {
        depth: 1,
        callIndex: 1,
        postStateWrites: ['balance'],
      }),
      makeCall(CONTRACT_A, 'callback', { depth: 2, callIndex: 2 }),
    ];
    const graph = buildCallGraph(TX, calls);
    const findings = detectReentrancy(TX, graph);
    const destructive = findings.find((f) => f.reentrancyType === 'DESTRUCTIVE');
    expect(destructive).toBeUndefined();
  });
});

describe('Detection: Clean Transaction', () => {
  it('returns empty findings for a clean linear transaction', () => {
    const calls: TraceCall[] = [
      makeCall(CONTRACT_A, 'init', { depth: 0, callIndex: 0 }),
      makeCall(CONTRACT_B, 'getBalance', { depth: 1, callIndex: 1 }),
    ];
    const graph = buildCallGraph(TX, calls);
    const findings = detectReentrancy(TX, graph);
    expect(findings).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Risk Scoring Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('Risk Scoring', () => {
  it('scores a critical cross-contract finding', () => {
    const finding: ReentrancyFinding = {
      id: 'test-1',
      txHash: TX,
      contractAddress: CONTRACT_A,
      reentrancyType: 'CROSS_CONTRACT',
      severity: 'CRITICAL',
      likelihood: 'confirmed',
      loopPath: [{ contractAddress: CONTRACT_A, functionName: 'withdraw', callIndex: 0 }],
      entryPoint: CONTRACT_A,
      usdValueAtRisk: 500000,
      description: 'Cross-contract reentrancy detected',
      detectedAt: new Date(),
    };
    const score = scoreFinding(finding);
    // Critical (75) * 2x (>$100K) * 1.0 (confirmed) = 150
    expect(score).toBe(150);
  });

  it('theoretical finding gets half score', () => {
    const confirmed: ReentrancyFinding = {
      id: 'test-2',
      txHash: TX,
      contractAddress: CONTRACT_A,
      reentrancyType: 'SIMPLE',
      severity: 'HIGH',
      likelihood: 'confirmed',
      loopPath: [],
      entryPoint: CONTRACT_A,
      description: 'Simple reentrancy',
      detectedAt: new Date(),
    };
    const theoretical: ReentrancyFinding = {
      ...confirmed,
      id: 'test-3',
      likelihood: 'theoretical',
    };
    expect(scoreFinding(confirmed)).toBe(50); // HIGH(50) * 1 * 1
    expect(scoreFinding(theoretical)).toBe(25); // HIGH(50) * 1 * 0.5
  });

  it('value multiplier works correctly', () => {
    const baseFinding: ReentrancyFinding = {
      id: 'test-4',
      txHash: TX,
      contractAddress: CONTRACT_A,
      reentrancyType: 'SIMPLE',
      severity: 'HIGH',
      likelihood: 'confirmed',
      loopPath: [],
      entryPoint: CONTRACT_A,
      description: 'Test',
      detectedAt: new Date(),
    };

    const noValue = scoreFinding(baseFinding);
    const smallValue = scoreFinding({ ...baseFinding, usdValueAtRisk: 50000 });
    const largeValue = scoreFinding({ ...baseFinding, usdValueAtRisk: 200000 });
    const hugeValue = scoreFinding({ ...baseFinding, usdValueAtRisk: 2000000 });

    expect(noValue).toBe(50); // 50 * 1.0 * 1.0
    expect(smallValue).toBe(50); // 50 * 1.0 * 1.0
    expect(largeValue).toBe(100); // 50 * 2.0 * 1.0
    expect(hugeValue).toBe(150); // 50 * 3.0 * 1.0
  });

  it('computes aggregate risk score from multiple findings', () => {
    const findings: ReentrancyFinding[] = [
      {
        id: 'f1',
        txHash: TX,
        contractAddress: CONTRACT_A,
        reentrancyType: 'CROSS_CONTRACT',
        severity: 'CRITICAL',
        likelihood: 'confirmed',
        loopPath: [],
        entryPoint: CONTRACT_A,
        description: 'Critical finding',
        detectedAt: new Date(),
      },
      {
        id: 'f2',
        txHash: TX + '2',
        contractAddress: CONTRACT_A,
        reentrancyType: 'SIMPLE',
        severity: 'HIGH',
        likelihood: 'theoretical',
        loopPath: [],
        entryPoint: CONTRACT_A,
        description: 'High finding',
        detectedAt: new Date(),
      },
    ];
    const score = computeRiskScore(CONTRACT_A, findings);
    expect(score.riskScore).toBeGreaterThan(25);
    expect(score.totalFindings).toBe(2);
    expect(score.criticalFindings).toBe(1);
    expect(score.highFindings).toBe(1);
  });

  it('risk level classification works', () => {
    expect(getRiskLevel(0)).toBe('safe');
    expect(getRiskLevel(10)).toBe('low_risk');
    expect(getRiskLevel(30)).toBe('medium_risk');
    expect(getRiskLevel(55)).toBe('high_risk');
    expect(getRiskLevel(80)).toBe('critical');
    expect(getRiskLevel(100)).toBe('critical');
  });

  it('risk factors are computed correctly', () => {
    const findings: ReentrancyFinding[] = [
      {
        id: 'f1',
        txHash: TX,
        contractAddress: CONTRACT_A,
        reentrancyType: 'CROSS_CONTRACT',
        severity: 'CRITICAL',
        likelihood: 'confirmed',
        loopPath: [],
        entryPoint: CONTRACT_A,
        description: 'Critical',
        detectedAt: new Date(),
      },
      {
        id: 'f2',
        txHash: TX + '2',
        contractAddress: CONTRACT_A,
        reentrancyType: 'SIMPLE',
        severity: 'HIGH',
        likelihood: 'confirmed',
        loopPath: [],
        entryPoint: CONTRACT_A,
        description: 'Simple',
        detectedAt: new Date(),
      },
    ];
    const factors = computeRiskFactors(findings, 5);
    expect(factors.totalFindings).toBe(2);
    expect(factors.criticalFindings).toBe(1);
    expect(factors.highFindings).toBe(1);
    expect(factors.crossContractCount).toBe(1);
    expect(factors.simpleReentrancyCount).toBe(1);
    expect(factors.maxCallDepth).toBe(5);
    expect(factors.confirmedAttackCount).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Pattern Definitions Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('Pattern Definitions', () => {
  it('has all 6 reentrancy types defined', () => {
    const patterns = getPatternDefinitions();
    expect(patterns).toHaveLength(6);
    const typeNames = patterns.map((p) => p.type);
    expect(typeNames).toContain('SIMPLE');
    expect(typeNames).toContain('CROSS_CONTRACT');
    expect(typeNames).toContain('MULTI_STEP');
    expect(typeNames).toContain('READ_ONLY');
    expect(typeNames).toContain('CROSS_FUNCTION');
    expect(typeNames).toContain('DESTRUCTIVE');
  });

  it('each pattern has required fields', () => {
    const patterns = getPatternDefinitions();
    for (const p of patterns) {
      expect(p.name).toBeTruthy();
      expect(p.description).toBeTruthy();
      expect(p.severity).toBeTruthy();
      expect(p.detectionMethod).toBeTruthy();
      expect(p.example).toBeTruthy();
    }
  });

  it('DETECTION_PATTERNS has 6 entries', () => {
    expect(DETECTION_PATTERNS).toHaveLength(6);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Integration Tests: Full Analysis Pipeline
// ═══════════════════════════════════════════════════════════════════════════════

describe('Full Analysis Pipeline', () => {
  it('analyzes a cross-contract attack transaction end to end', () => {
    const calls: TraceCall[] = [
      makeCall(CONTRACT_A, 'withdraw', {
        depth: 0,
        callIndex: 0,
        value: '10000000',
        preStateReads: ['balance_A', 'auth_A'],
      }),
      makeCall(CONTRACT_B, 'transfer', {
        depth: 1,
        callIndex: 1,
        value: '10000000',
        postStateWrites: ['balance_A', 'balance_B'],
      }),
      makeCall(CONTRACT_A, 'callback', {
        depth: 2,
        callIndex: 2,
        value: '5000000',
        preStateReads: ['balance_A'],
      }),
    ];
    const graph = buildCallGraph(TX, calls);
    const findings = detectReentrancy(TX, graph, '10000000', 1000000);

    expect(findings.length).toBeGreaterThan(0);

    const crossContract = findings.find((f) => f.reentrancyType === 'CROSS_CONTRACT');
    expect(crossContract).toBeDefined();
    expect(crossContract!.severity).toBe('CRITICAL');

    const score = computeRiskScore(CONTRACT_A, findings, undefined, 3);
    expect(score.riskScore).toBeGreaterThan(0);
    expect(score.contractAddress).toBe(CONTRACT_A);
  });

  it('detects known DAO-hack style attack (cross-contract + read-only)', () => {
    const calls: TraceCall[] = [
      makeCall(CONTRACT_A, 'withdraw', {
        depth: 0,
        callIndex: 0,
        preStateReads: ['balance'],
        value: '50000000',
      }),
      makeCall(CONTRACT_B, 'transfer', {
        depth: 1,
        callIndex: 1,
        postStateWrites: ['balance'],
      }),
      makeCall(CONTRACT_A, 'getBalance', {
        depth: 2,
        callIndex: 2,
        preStateReads: ['balance'],
      }),
    ];
    const graph = buildCallGraph(TX, calls);
    const findings = detectReentrancy(TX, graph, '50000000', 5000000);
    expect(findings.length).toBeGreaterThan(0);
  });

  it('handles empty calls gracefully', () => {
    const graph = buildCallGraph(TX, []);
    expect(graph.vertices).toHaveLength(0);
    expect(graph.edges).toHaveLength(0);
    const findings = detectReentrancy(TX, graph);
    expect(findings).toHaveLength(0);
    expect(hasLoops(graph)).toBe(false);
  });

  it('handles single-contract call with no reentrancy', () => {
    const calls: TraceCall[] = [makeCall(CONTRACT_A, 'getScore', { depth: 0, callIndex: 0 })];
    const graph = buildCallGraph(TX, calls);
    const findings = detectReentrancy(TX, graph);
    expect(findings).toHaveLength(0);
    expect(computeMaxDepth(graph)).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Performance Benchmarks
// ═══════════════════════════════════════════════════════════════════════════════

describe('Performance: Call Graph Construction', () => {
  it('processes 100 calls under acceptable time', () => {
    const calls: TraceCall[] = [];
    for (let i = 0; i < 100; i++) {
      const depth = i % 5;
      const contracts = [CONTRACT_A, CONTRACT_B, CONTRACT_C, CONTRACT_D];
      calls.push(
        makeCall(contracts[i % 4], `fn_${i}`, {
          depth,
          callIndex: i,
        }),
      );
    }
    const start = Date.now();
    const graph = buildCallGraph(TX, calls);
    const elapsed = Date.now() - start;
    expect(graph.vertices).toHaveLength(100);
    expect(elapsed).toBeLessThan(200);
  });
});
