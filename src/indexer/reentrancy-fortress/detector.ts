/**
 * Soroban Reentrancy Fortress — Detection Algorithm Suite
 *
 * Implements all 6 reentrancy detection types with documented methodology.
 * Uses contract-level cycle detection for accurate cross-contract analysis.
 * Issue #307
 */

import {
  type CallGraph,
  type ReentrancyFinding,
  type DetectionPattern,
  ReentrancyTypes,
  ReentrancySeverities,
} from './types';
import {
  findCycles,
  findContractCycles,
  mapContractCycleToVertexPath,
  buildVertexContractMap,
  getVertex,
} from './call-graph';

// ── Utility helpers ───────────────────────────────────────────────────────────

/** Extract loop path from a contract-level cycle by mapping back to vertices */
function extractLoopPathFromContractCycle(
  contractCycle: string[],
  graph: CallGraph,
): ReentrancyFinding['loopPath'] {
  return mapContractCycleToVertexPath(contractCycle, graph);
}

/** Extract loop path from vertex-level cycle IDs */
function extractLoopPath(cycle: string[], graph: CallGraph): ReentrancyFinding['loopPath'] {
  const contractMap = buildVertexContractMap(graph);
  return cycle.map((vtxId) => {
    const v = getVertex(graph, vtxId);
    return {
      contractAddress: contractMap.get(vtxId) ?? 'unknown',
      functionName: v?.functionName ?? 'unknown',
      callIndex: v?.callIndex ?? 0,
    };
  });
}

// ── Detection Patterns ───────────────────────────────────────────────────────

/**
 * TYPE 1: Simple Reentrancy (A → A)
 *
 * Pattern: Same contract calls itself within a single transaction.
 * Detected when a contract appears multiple times and calls itself
 * (has an edge from one vertex to another with the same contract address).
 * Severity: HIGH
 */
function detectSimpleReentrancy(graph: CallGraph): ReturnType<DetectionPattern['detect']> {
  // Check if any vertex calls another vertex with the same contract address
  const selfCalls: Array<{
    from: string;
    to: string;
    fromFn: string;
    toFn: string;
    fromIdx: number;
    toIdx: number;
  }> = [];

  for (const edge of graph.edges) {
    const fromVtx = getVertex(graph, edge.fromVertexId);
    const toVtx = getVertex(graph, edge.toVertexId);
    if (
      fromVtx &&
      toVtx &&
      fromVtx.contractAddress === toVtx.contractAddress &&
      fromVtx.callIndex < toVtx.callIndex
    ) {
      selfCalls.push({
        from: fromVtx.contractAddress,
        to: toVtx.contractAddress,
        fromFn: fromVtx.functionName,
        toFn: toVtx.functionName,
        fromIdx: fromVtx.callIndex,
        toIdx: toVtx.callIndex,
      });
    }
  }

  // Also check for same contract appearing at different call indices
  // (even without a direct edge, this indicates re-entry)
  const contractCounts = new Map<string, number>();
  for (const v of graph.vertices) {
    contractCounts.set(v.contractAddress, (contractCounts.get(v.contractAddress) ?? 0) + 1);
  }

  const repeated = [...contractCounts.entries()].filter(([, count]) => count > 1);

  if (selfCalls.length === 0 && repeated.length === 0) return null;

  // Build loop path from self-calls or repeated contract occurrences
  const loopPath: ReentrancyFinding['loopPath'] = [];
  const seen = new Map<string, number>();

  for (const v of graph.vertices) {
    const prev = seen.get(v.contractAddress);
    if (prev !== undefined && prev < v.callIndex) {
      loopPath.push({
        contractAddress: v.contractAddress,
        functionName: v.functionName,
        callIndex: prev,
      });
      loopPath.push({
        contractAddress: v.contractAddress,
        functionName: v.functionName,
        callIndex: v.callIndex,
      });
    }
    seen.set(v.contractAddress, v.callIndex);
  }

  const confidence = Math.min(1, (selfCalls.length + repeated.length) * 0.35);

  return {
    confidence,
    loopPath:
      loopPath.length > 0
        ? loopPath
        : repeated.map(([addr]) => ({
            contractAddress: addr,
            functionName: 'unknown',
            callIndex: 0,
          })),
  };
}

/**
 * TYPE 2: Cross-Contract Reentrancy (A → B → A)
 *
 * Pattern: Two different contracts calling each other. Detected via
 * contract-level cycle detection of length 3 (A calls B, B calls back A).
 * Severity: CRITICAL
 */
function detectCrossContractReentrancy(graph: CallGraph): ReturnType<DetectionPattern['detect']> {
  const contractCycles = findContractCycles(graph);

  // Contract-level cycles: A→B→A becomes [A, B] (length 2), closing edge implicit
  const crossContractCycles = contractCycles.filter((cycle) => {
    return cycle.length === 2 && cycle[0] !== cycle[1];
  });

  if (crossContractCycles.length === 0) {
    // Also try vertex-level cycles as fallback
    const vertexCycles = findCycles(graph);
    const contractMap = buildVertexContractMap(graph);
    const vertexCrossCycles = vertexCycles.filter((cycle) => {
      if (cycle.length !== 3) return false;
      const contracts = cycle.map((v) => contractMap.get(v));
      return contracts[0] === contracts[2] && contracts[0] !== contracts[1];
    });

    if (vertexCrossCycles.length === 0) return null;

    const loopPath = extractLoopPath(vertexCrossCycles[0], graph);
    return {
      confidence: Math.min(1, 0.5 + vertexCrossCycles.length * 0.15),
      loopPath,
    };
  }

  const loopPath = extractLoopPathFromContractCycle(crossContractCycles[0], graph);
  return {
    confidence: Math.min(1, 0.5 + crossContractCycles.length * 0.15),
    loopPath,
  };
}

/**
 * TYPE 3: Multi-Step Reentrancy (A → B → C → A)
 *
 * Pattern: Reentrancy loop spanning ≥4 contract calls. Detected via
 * contract-level cycle detection of length ≥4.
 * Severity: CRITICAL
 */
function detectMultiStepReentrancy(graph: CallGraph): ReturnType<DetectionPattern['detect']> {
  const contractCycles = findContractCycles(graph);

  // Contract-level cycles: A→B→C→A becomes [A, B, C] (length ≥3), closing edge implicit
  const multiStepCycles = contractCycles.filter((cycle) => {
    if (cycle.length < 3) return false;
    // All contracts should be distinct
    return new Set(cycle).size === cycle.length;
  });

  if (multiStepCycles.length === 0) {
    // Fallback: vertex-level cycles
    const vertexCycles = findCycles(graph);
    const contractMap = buildVertexContractMap(graph);
    const vMultiStep = vertexCycles.filter((cycle) => {
      if (cycle.length < 4) return false;
      const contracts = cycle.map((v) => contractMap.get(v));
      if (contracts[0] !== contracts[contracts.length - 1]) return false;
      const uniqueContracts = new Set(contracts);
      return uniqueContracts.size === contracts.length - 1;
    });

    if (vMultiStep.length === 0) return null;

    const loopPath = extractLoopPath(vMultiStep[0], graph);
    return {
      confidence: Math.min(1, 0.4 + vMultiStep.length * 0.1),
      loopPath,
    };
  }

  const loopPath = extractLoopPathFromContractCycle(multiStepCycles[0], graph);
  return {
    confidence: Math.min(1, 0.4 + multiStepCycles.length * 0.1),
    loopPath,
  };
}

/**
 * TYPE 4: Read-Only Reentrancy (A reads state, calls B, B calls A which reads stale state)
 *
 * Pattern: Contract A reads state at step 1, calls B, B calls back A,
 * and A reads the same state again — but it's stale because B may have
 * changed something. Detected via state read analysis across calls.
 * Severity: HIGH
 */
function detectReadOnlyReentrancy(graph: CallGraph): ReturnType<DetectionPattern['detect']> {
  const contractCycles = findContractCycles(graph);

  for (const cycle of contractCycles) {
    if (cycle.length < 2) continue;

    // Find a vertex of the first contract that has preStateReads
    const firstContract = cycle[0];
    const firstVtx = graph.vertices.find(
      (v) => v.contractAddress === firstContract && (v.preStateReads?.length ?? 0) > 0,
    );
    if (!firstVtx?.preStateReads?.length) continue;

    // Check if any intermediate contract's vertices have overlapping writes
    for (let i = 1; i < cycle.length; i++) {
      const intermediateContract = cycle[i];
      const intermediateVertices = graph.vertices.filter(
        (v) => v.contractAddress === intermediateContract,
      );

      for (const iv of intermediateVertices) {
        const intermediateWrites = iv.postStateWrites ?? [];
        const firstReads = firstVtx.preStateReads ?? [];

        const staleKeys = firstReads.filter((key) => intermediateWrites.includes(key));

        if (staleKeys.length > 0) {
          const loopPath = extractLoopPathFromContractCycle(cycle, graph);
          return {
            confidence: Math.min(1, 0.3 + staleKeys.length * 0.15),
            loopPath,
          };
        }
      }
    }
  }

  return null;
}

/**
 * TYPE 5: Cross-Function Reentrancy (A.func1 → B → A.func2)
 *
 * Pattern: Same contract called back but through a different function.
 * Detected when a cycle exists in the call graph with the same contract
 * appearing at the start and end but with different function names.
 * Severity: HIGH
 */
function detectCrossFunctionReentrancy(graph: CallGraph): ReturnType<DetectionPattern['detect']> {
  const contractCycles = findContractCycles(graph);

  // For each contract cycle, check if first contract has different function names
  for (const cycle of contractCycles) {
    if (cycle.length < 2) continue;

    // Find the function names for the first and last occurrences of this contract
    const contract = cycle[0];
    const vertices = graph.vertices
      .filter((v) => v.contractAddress === contract)
      .sort((a, b) => a.callIndex - b.callIndex);

    if (vertices.length < 2) continue;

    const firstFn = vertices[0].functionName;
    const lastFn = vertices[vertices.length - 1].functionName;

    if (firstFn !== lastFn) {
      const loopPath = extractLoopPathFromContractCycle(cycle, graph);
      return {
        confidence: 0.85,
        loopPath,
      };
    }
  }

  // Fallback: vertex-level detection
  const vertexCycles = findCycles(graph);
  const crossFunctionCycles = vertexCycles.filter((cycle) => {
    if (cycle.length < 3) return false;
    const first = getVertex(graph, cycle[0]);
    const last = getVertex(graph, cycle[cycle.length - 1]);
    if (!first || !last) return false;
    return (
      first.contractAddress === last.contractAddress && first.functionName !== last.functionName
    );
  });

  if (crossFunctionCycles.length === 0) return null;

  const loopPath = extractLoopPath(crossFunctionCycles[0], graph);
  return {
    confidence: Math.min(1, 0.45 + crossFunctionCycles.length * 0.12),
    loopPath,
  };
}

/**
 * TYPE 6: Destructive Reentrancy (selfdestruct-style pattern)
 *
 * Pattern: A calls B, B deploys new code (stores code), then B calls back A.
 * This is a deploy-and-call pattern where one contract in the cycle
 * was freshly deployed or had its code modified.
 * Severity: CRITICAL
 *
 * Detection: Look for cycles where an intermediate vertex has
 * postStateWrites that include code/deployment keys (keys containing
 * 'wasm', 'code', 'deploy', 'bytecode').
 */
function detectDestructiveReentrancy(graph: CallGraph): ReturnType<DetectionPattern['detect']> {
  const contractCycles = findContractCycles(graph);
  const CODE_KEY_PATTERNS = ['wasm', 'code', 'bytecode', 'deploy', 'init', 'constructor'];

  for (const cycle of contractCycles) {
    if (cycle.length < 2) continue;

    // Check intermediate contracts for code-storing vertices
    for (let i = 1; i < cycle.length; i++) {
      const intermediateContract = cycle[i];
      const intermediateVertices = graph.vertices.filter(
        (v) => v.contractAddress === intermediateContract,
      );

      for (const vtx of intermediateVertices) {
        if (!vtx.postStateWrites?.length) continue;

        const storesCode = vtx.postStateWrites.some((key) =>
          CODE_KEY_PATTERNS.some((pattern) => key.toLowerCase().includes(pattern)),
        );

        if (storesCode) {
          const loopPath = extractLoopPathFromContractCycle(cycle, graph);
          return {
            confidence: 0.7,
            loopPath,
          };
        }
      }
    }
  }

  // Fallback: vertex-level detection
  const vertexCycles = findCycles(graph);
  for (const cycle of vertexCycles) {
    if (cycle.length < 3) continue;

    for (let i = 1; i < cycle.length - 1; i++) {
      const vtx = getVertex(graph, cycle[i]);
      if (!vtx?.postStateWrites?.length) continue;

      const storesCode = vtx.postStateWrites.some((key) =>
        CODE_KEY_PATTERNS.some((pattern) => key.toLowerCase().includes(pattern)),
      );

      if (storesCode) {
        const loopPath = extractLoopPath(cycle, graph);
        return {
          confidence: 0.7,
          loopPath,
        };
      }
    }
  }

  return null;
}

// ── Detection Pattern Registry ────────────────────────────────────────────────

export const DETECTION_PATTERNS: DetectionPattern[] = [
  {
    type: ReentrancyTypes.SIMPLE,
    name: 'Simple Reentrancy',
    description: 'Same contract calls itself within a single transaction. Pattern: A → A.',
    severity: ReentrancySeverities.HIGH,
    detect: detectSimpleReentrancy,
  },
  {
    type: ReentrancyTypes.CROSS_CONTRACT,
    name: 'Cross-Contract Reentrancy',
    description: 'Two different contracts calling each other in a loop. Pattern: A → B → A.',
    severity: ReentrancySeverities.CRITICAL,
    detect: detectCrossContractReentrancy,
  },
  {
    type: ReentrancyTypes.MULTI_STEP,
    name: 'Multi-Step Reentrancy',
    description: 'Reentrancy loop spanning 4+ contract calls. Pattern: A → B → C → A.',
    severity: ReentrancySeverities.CRITICAL,
    detect: detectMultiStepReentrancy,
  },
  {
    type: ReentrancyTypes.READ_ONLY,
    name: 'Read-Only Reentrancy',
    description:
      'Contract reads state, external call modifies it, callback reads stale state. Pattern: A reads → B → A reads stale.',
    severity: ReentrancySeverities.HIGH,
    detect: detectReadOnlyReentrancy,
  },
  {
    type: ReentrancyTypes.CROSS_FUNCTION,
    name: 'Cross-Function Reentrancy',
    description:
      'Same contract re-entered through a different function. Pattern: A.func1 → B → A.func2.',
    severity: ReentrancySeverities.HIGH,
    detect: detectCrossFunctionReentrancy,
  },
  {
    type: ReentrancyTypes.DESTRUCTIVE,
    name: 'Destructive Reentrancy',
    description:
      'Contract deploys new code mid-transaction and calls back. Pattern: A → B stores code → B → A.',
    severity: ReentrancySeverities.CRITICAL,
    detect: detectDestructiveReentrancy,
  },
];

// ── Main Analysis Function ────────────────────────────────────────────────────

/**
 * Run all detection patterns against a call graph and return findings.
 */
export function detectReentrancy(
  txHash: string,
  graph: CallGraph,
  valueAtRisk?: string,
  usdValueAtRisk?: number,
): ReentrancyFinding[] {
  const findings: ReentrancyFinding[] = [];

  // Get the entry point (first vertex in the call chain)
  const entryVertex = graph.vertices.length > 0 ? graph.vertices[0] : null;
  const entryPoint = entryVertex?.contractAddress ?? 'unknown';

  for (const pattern of DETECTION_PATTERNS) {
    const result = pattern.detect(graph);
    if (result && result.confidence >= 0.4) {
      // Determine likelihood
      const likelihood = result.confidence >= 0.8 ? 'confirmed' : 'theoretical';

      // Compute profit potential based on confidence and value at risk
      const profitPotential =
        usdValueAtRisk != null ? usdValueAtRisk * result.confidence : undefined;

      const finding: ReentrancyFinding = {
        id: `finding_${txHash.slice(0, 12)}_${pattern.type}`,
        txHash,
        contractAddress: entryPoint,
        reentrancyType: pattern.type,
        severity: pattern.severity,
        likelihood,
        loopPath: result.loopPath,
        entryPoint,
        valueAtRisk,
        usdValueAtRisk,
        profitPotential,
        description: `${pattern.name}: ${pattern.description}`,
        detectedAt: new Date(),
      };

      findings.push(finding);
    }
  }

  return findings;
}

/**
 * Get all detection pattern definitions (used by the patterns API endpoint).
 */
export function getPatternDefinitions(): Array<{
  type: string;
  name: string;
  description: string;
  severity: string;
  detectionMethod: string;
  example: string;
}> {
  const detectionMethods: Record<string, string> = {
    SIMPLE: 'Same vertex repeated in call graph',
    CROSS_CONTRACT: 'Contract-level cycle detection (length 3)',
    MULTI_STEP: 'Contract-level cycle detection (length ≥4)',
    READ_ONLY: 'State read analysis across calls',
    CROSS_FUNCTION: 'Same contract, different function',
    DESTRUCTIVE: 'Deploy-and-call pattern detection',
  };

  const examples: Record<string, string> = {
    SIMPLE: 'Contract A calls withdraw() → withdraw()',
    CROSS_CONTRACT: 'A.withdraw() → B.token() → A.callback()',
    MULTI_STEP: 'A.withdraw() → B.lend() → C.swap() → A.borrow()',
    READ_ONLY: 'A.getPrice() → B.oracle() → A.getPrice() [stale]',
    CROSS_FUNCTION: 'A.withdraw() → B.token() → A.deposit()',
    DESTRUCTIVE: 'A.upgrade() → B.deployCode() → B → A.callback()',
  };

  return DETECTION_PATTERNS.map((p) => ({
    type: p.type,
    name: p.name,
    description: p.description,
    severity: p.severity,
    detectionMethod: detectionMethods[p.type] ?? 'Custom detection',
    example: examples[p.type] ?? 'N/A',
  }));
}
