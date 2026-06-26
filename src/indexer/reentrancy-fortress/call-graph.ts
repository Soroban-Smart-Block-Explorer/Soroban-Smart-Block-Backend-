/**
 * Soroban Reentrancy Fortress — Dynamic Call Graph Engine
 *
 * Constructs multi-dimensional directed call graphs from transaction traces.
 * Issue #307
 */

import {
  type CallGraph,
  type CallGraphVertex,
  type CallGraphEdge,
} from './types';

// ── Call trace input types ───────────────────────────────────────────────────

export interface TraceCall {
  /** Contract that emitted this call event */
  contractId: string;
  /** Function name being called */
  functionName: string;
  /** Call depth (0 = root invocation) */
  depth: number;
  /** Chronological call index within the transaction */
  callIndex: number;
  /** Value transferred (stroops, as string) */
  value?: string;
  /** Storage keys read before this call */
  preStateReads?: string[];
  /** Storage keys written after this call */
  postStateWrites?: string[];
  /** Gas forwarded to this call */
  gasForwarded?: number;
  /** Gas remaining at this call point */
  gasRemaining?: number;
  /** Hash of the function arguments for deduplication */
  argsHash?: string;
}

/**
 * Build a complete call graph from a list of trace calls.
 *
 * Vertices: (contractAddress, functionName, callIndex)
 * Edges: caller → callee with payload (value, args hash, gas forwarded)
 */
export function buildCallGraph(
  txHash: string,
  calls: TraceCall[],
  timestamp: Date = new Date(),
): CallGraph {
  const vertices: CallGraphVertex[] = [];
  const edges: CallGraphEdge[] = [];
  let vertexCounter = 0;

  // Map: "contractAddress::functionName::callIndex" → vertex ID
  const vertexIdMap = new Map<string, string>();
  // Call depth stack to track parent → child relationships
  const depthStack: CallGraphVertex[] = [];

  for (const call of calls) {
    const vertexKey = `${call.contractId}::${call.functionName}::${call.callIndex}`;

    // Create vertex
    const vertexId = `vtx_${vertexCounter++}`;
    vertexIdMap.set(vertexKey, vertexId);

    const vertex: CallGraphVertex = {
      id: vertexId,
      txHash,
      contractAddress: call.contractId,
      functionName: call.functionName,
      depth: call.depth,
      callIndex: call.callIndex,
      value: call.value,
      preStateReads: call.preStateReads ?? [],
      postStateWrites: call.postStateWrites ?? [],
      timestamp,
    };
    vertices.push(vertex);

    // Pop depth stack: remove everything at or deeper than current depth
    while (depthStack.length > 0 && depthStack[depthStack.length - 1].depth >= call.depth) {
      depthStack.pop();
    }

    // Create edge from parent (top of stack) to current vertex
    if (depthStack.length > 0) {
      const parent = depthStack[depthStack.length - 1];
      const edge: CallGraphEdge = {
        id: `edge_${parent.id}_${vertexId}`,
        txHash,
        fromVertexId: parent.id,
        toVertexId: vertexId,
        functionName: call.functionName,
        value: call.value,
        gasForwarded: call.gasForwarded,
        argsHash: call.argsHash,
        callIndex: call.callIndex,
        timestamp,
      };
      edges.push(edge);
    }

    // Push current vertex onto depth stack
    depthStack.push(vertex);
  }

  return { vertices, edges };
}

// ── Graph Analysis Utilities ──────────────────────────────────────────────────

/**
 * Build a contract-level adjacency graph from vertex-level edges.
 * Maps contract address → set of child contract addresses.
 */
export function buildContractAdjacency(graph: CallGraph): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  for (const v of graph.vertices) {
    if (!adj.has(v.contractAddress)) {
      adj.set(v.contractAddress, new Set());
    }
  }
  for (const e of graph.edges) {
    const fromVtx = getVertex(graph, e.fromVertexId);
    const toVtx = getVertex(graph, e.toVertexId);
    if (fromVtx && toVtx && fromVtx.contractAddress !== toVtx.contractAddress) {
      const neighbors = adj.get(fromVtx.contractAddress) ?? new Set();
      neighbors.add(toVtx.contractAddress);
      adj.set(fromVtx.contractAddress, neighbors);
    }
  }
  return adj;
}

/**
 * Build a chronological contract call sequence from the call graph vertices.
 * This tracks the order contracts appear in the trace, including repeats.
 * Returns: [{ contractAddress, functionName, callIndex, vertexId }, ...]
 */
export function buildContractSequence(graph: CallGraph): Array<{
  contractAddress: string;
  functionName: string;
  callIndex: number;
  vertexId: string;
}> {
  return [...graph.vertices]
    .sort((a, b) => a.callIndex - b.callIndex)
    .map((v) => ({
      contractAddress: v.contractAddress,
      functionName: v.functionName,
      callIndex: v.callIndex,
      vertexId: v.id,
    }));
}

/**
 * Find all cycles in the call graph using DFS on the vertex-level edges.
 * Returns cycles as ordered lists of vertex IDs.
 */
export function findCycles(graph: CallGraph): string[][] {
  const adjacency = buildAdjacencyList(graph);
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const recStack = new Set<string>();
  const path: string[] = [];

  function dfs(v: string) {
    visited.add(v);
    recStack.add(v);
    path.push(v);

    for (const neighbor of adjacency.get(v) ?? []) {
      if (!visited.has(neighbor)) {
        dfs(neighbor);
      } else if (recStack.has(neighbor)) {
        // Back edge found — extract the cycle
        const cycleStart = path.indexOf(neighbor);
        cycles.push([...path.slice(cycleStart)]);
      }
    }

    path.pop();
    recStack.delete(v);
  }

  for (const v of adjacency.keys()) {
    if (!visited.has(v)) {
      dfs(v);
    }
  }

  return cycles;
}

/**
 * Find cycles at the contract level by building contract adjacency
 * and detecting back-edges using DFS.
 *
 * Returns cycles as lists of contract addresses in order.
 */
export function findContractCycles(graph: CallGraph): string[][] {
  const contractAdj = buildContractAdjacency(graph);
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const recStack = new Set<string>();
  const path: string[] = [];

  function dfs(contract: string) {
    visited.add(contract);
    recStack.add(contract);
    path.push(contract);

    for (const neighbor of contractAdj.get(contract) ?? []) {
      if (!visited.has(neighbor)) {
        dfs(neighbor);
      } else if (recStack.has(neighbor)) {
        // Back edge found — extract the cycle
        const cycleStart = path.indexOf(neighbor);
        cycles.push([...path.slice(cycleStart)]);
      }
    }

    path.pop();
    recStack.delete(contract);
  }

  for (const contract of contractAdj.keys()) {
    if (!visited.has(contract)) {
      dfs(contract);
    }
  }

  return cycles;
}

/**
 * Map a contract-level cycle back to vertex-level path entries,
 * using the chronological contract sequence to find the vertex details.
 */
export function mapContractCycleToVertexPath(
  contractCycle: string[],
  graph: CallGraph,
): Array<{ contractAddress: string; functionName: string; callIndex: number }> {
  const seq = buildContractSequence(graph);
  const result: Array<{ contractAddress: string; functionName: string; callIndex: number }> = [];

  // For each contract in the cycle, find all occurrences in sequence order
  const usedIndices = new Set<number>();

  for (const targetContract of contractCycle) {
    for (let i = 0; i < seq.length; i++) {
      if (usedIndices.has(i)) continue;
      if (seq[i].contractAddress === targetContract) {
        result.push({
          contractAddress: seq[i].contractAddress,
          functionName: seq[i].functionName,
          callIndex: seq[i].callIndex,
        });
        usedIndices.add(i);
        break;
      }
    }
  }

  // If we couldn't map all, fill in with whatever we have
  if (result.length < contractCycle.length) {
    for (let i = 0; i < seq.length && result.length < contractCycle.length; i++) {
      if (!usedIndices.has(i) && contractCycle.includes(seq[i].contractAddress)) {
        result.push({
          contractAddress: seq[i].contractAddress,
          functionName: seq[i].functionName,
          callIndex: seq[i].callIndex,
        });
        usedIndices.add(i);
      }
    }
  }

  return result;
}

/**
 * Build adjacency list from a call graph: vertexId → list of target vertex IDs.
 */
export function buildAdjacencyList(graph: CallGraph): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const v of graph.vertices) {
    adj.set(v.id, []);
  }
  for (const e of graph.edges) {
    const neighbors = adj.get(e.fromVertexId) ?? [];
    neighbors.push(e.toVertexId);
    adj.set(e.fromVertexId, neighbors);
  }
  return adj;
}

/**
 * Get vertex by ID.
 */
export function getVertex(graph: CallGraph, vertexId: string): CallGraphVertex | undefined {
  return graph.vertices.find((v) => v.id === vertexId);
}

/**
 * Build a map from vertex ID to the contract address for quick lookup.
 */
export function buildVertexContractMap(graph: CallGraph): Map<string, string> {
  const map = new Map<string, string>();
  for (const v of graph.vertices) {
    map.set(v.id, v.contractAddress);
  }
  return map;
}

/**
 * Compute the maximum depth in the call graph.
 */
export function computeMaxDepth(graph: CallGraph): number {
  return graph.vertices.reduce((max, v) => Math.max(max, v.depth), 0);
}

/**
 * Compute the average depth across all vertices.
 */
export function computeAvgDepth(graph: CallGraph): number {
  if (graph.vertices.length === 0) return 0;
  return graph.vertices.reduce((sum, v) => sum + v.depth, 0) / graph.vertices.length;
}

/**
 * Check if the graph contains any reentrancy loops.
 */
export function hasLoops(graph: CallGraph): boolean {
  return findContractCycles(graph).length > 0;
}

/**
 * Count unique contracts involved in the graph.
 */
export function uniqueContractCount(graph: CallGraph): number {
  return new Set(graph.vertices.map((v) => v.contractAddress)).size;
}
