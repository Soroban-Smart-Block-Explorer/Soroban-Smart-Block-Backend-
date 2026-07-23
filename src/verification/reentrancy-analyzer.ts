import { SmtSolver } from './smt-solver';
import {
  SymbolicExecutor,
  type WasmFunction,
  type Vulnerability,
} from './symbolic-executor';

export interface CallGraphEdge {
  caller: string;
  callee: string;
  functionName: string;
  isReentrant: boolean;
  depth: number;
}

export interface ReentrancyAnalysisResult {
  contractAddress: string;
  callGraph: CallGraphEdge[];
  vulnerabilities: Vulnerability[];
  maxCallDepth: number;
  cyclicPaths: Array<{ path: string[]; severity: 'low' | 'medium' | 'high' | 'critical' }>;
  safetyScore: number;
  verified: boolean;
  witnessTrace: Array<{
    steps: Array<{ contract: string; function: string; action: string }>;
  }>;
}

export class ReentrancyAnalyzer {
  private symExec: SymbolicExecutor;
  private solver: SmtSolver;

  constructor(solver: SmtSolver) {
    this.solver = solver;
    this.symExec = new SymbolicExecutor(solver, {
      maxPaths: 500,
      maxDepth: 20,
      loopUnrollBound: 3,
    });
  }

  async analyze(
    contractAddress: string,
    functions: WasmFunction[],
    knownContracts: Map<string, WasmFunction[]> = new Map(),
  ): Promise<ReentrancyAnalysisResult> {
    this.symExec.loadContract(functions);

    const callGraph: CallGraphEdge[] = [];
    const allVulnerabilities: Vulnerability[] = [];

    let maxCallDepth = 0;

    for (const func of functions) {
      const result = await this.symExec.executeSymbolic(
        func.name,
        func.params.map((p, i) => ({
          name: p.name,
          type: p.type as 'i32' | 'i64',
          symbolic: true,
        })),
      );

      allVulnerabilities.push(...result.vulnerabilities);

      for (const path of result.pathConstraints) {
        const depth = path.split('call_depth').length - 1;
        maxCallDepth = Math.max(maxCallDepth, depth);

        callGraph.push({
          caller: contractAddress,
          callee: contractAddress,
          functionName: func.name,
          isReentrant: depth > 0,
          depth,
        });
      }
    }

    for (const [addr, calleeFuncs] of knownContracts) {
      for (const cf of calleeFuncs) {
        callGraph.push({
          caller: contractAddress,
          callee: addr,
          functionName: cf.name,
          isReentrant: true,
          depth: 1,
        });
      }
    }

    const cyclicPaths = this.detectCyclicPaths(callGraph);

    for (const cycle of cyclicPaths) {
      allVulnerabilities.push({
        type: 'reentrancy',
        severity: cycle.severity,
        description: `Cyclic call path detected: ${cycle.path.join(' → ')}`,
        functionName: cycle.path[0] ?? 'unknown',
        pathId: 0,
        witness: cycle.path.map((p) => ({ function: p, constraints: 'reentrant_cycle' })),
      });
    }

    const safetyScore = this.computeSafetyScore(callGraph, cyclicPaths);

    const witnessTrace = this.generateWitnessTrace(callGraph, cyclicPaths);

    return {
      contractAddress,
      callGraph,
      vulnerabilities: allVulnerabilities,
      maxCallDepth,
      cyclicPaths,
      safetyScore,
      verified: safetyScore >= 80,
      witnessTrace,
    };
  }

  private detectCyclicPaths(
    edges: CallGraphEdge[],
  ): Array<{ path: string[]; severity: 'low' | 'medium' | 'high' | 'critical' }> {
    const adjList = new Map<string, string[]>();
    for (const edge of edges) {
      if (!adjList.has(edge.caller)) adjList.set(edge.caller, []);
      adjList.get(edge.caller)!.push(edge.callee);
    }

    const cycles: Array<{ path: string[]; severity: 'low' | 'medium' | 'high' | 'critical' }> = [];
    const visited = new Set<string>();
    const recStack = new Set<string>();
    const pathStack: string[] = [];

    function dfs(node: string) {
      if (recStack.has(node)) {
        const cycleStart = pathStack.indexOf(node);
        if (cycleStart !== -1) {
          const cycle = pathStack.slice(cycleStart);
          cycle.push(node);
          const depth = cycle.length;
          const severity: 'low' | 'medium' | 'high' | 'critical' =
            depth <= 2 ? 'low' : depth <= 3 ? 'medium' : depth <= 4 ? 'high' : 'critical';
          cycles.push({ path: cycle, severity });
        }
        return;
      }
      if (visited.has(node)) return;

      visited.add(node);
      recStack.add(node);
      pathStack.push(node);

      for (const neighbor of adjList.get(node) ?? []) {
        dfs(neighbor);
      }

      pathStack.pop();
      recStack.delete(node);
    }

    for (const node of adjList.keys()) {
      dfs(node);
    }

    return cycles;
  }

  private computeSafetyScore(
    edges: CallGraphEdge[],
    cycles: Array<{ path: string[]; severity: string }>,
  ): number {
    let score = 100;

    const reentrant = edges.filter((e) => e.isReentrant).length;
    const hasCycles = cycles.length > 0;
    const maxDepth = Math.max(...edges.map((e) => e.depth), 0);

    score -= reentrant * 10;
    if (hasCycles) score -= 30;
    score -= maxDepth * 5;

    if (cycles.some((c) => c.severity === 'critical')) score -= 20;
    if (cycles.some((c) => c.severity === 'high')) score -= 10;

    return Math.max(0, Math.min(100, score));
  }

  private generateWitnessTrace(
    edges: CallGraphEdge[],
    cycles: Array<{ path: string[]; severity: string }>,
  ): ReentrancyAnalysisResult['witnessTrace'] {
    const traces: ReentrancyAnalysisResult['witnessTrace'] = [];

    for (const cycle of cycles) {
      const steps = cycle.path.map((node, i) => ({
        contract: node,
        function: `fn_${i}`,
        action: i === 0 ? 'entry' : i < cycle.path.length - 1 ? 'cross_call' : 'reentry',
      }));
      traces.push({ steps });
    }

    if (traces.length === 0 && edges.some((e) => e.isReentrant)) {
      const reentrantEdge = edges.find((e) => e.isReentrant);
      if (reentrantEdge) {
        traces.push({
          steps: [
            {
              contract: reentrantEdge.caller,
              function: reentrantEdge.functionName,
              action: 'entry',
            },
            { contract: reentrantEdge.callee, function: 'external_call', action: 'cross_call' },
            {
              contract: reentrantEdge.caller,
              function: reentrantEdge.functionName,
              action: 'reentry',
            },
          ],
        });
      }
    }

    return traces;
  }

  async analyzeCrossContract(
    contractAddresses: string[],
    functionMap: Map<string, WasmFunction[]>,
  ): Promise<{
    results: Map<string, ReentrancyAnalysisResult>;
    globalCallGraph: CallGraphEdge[];
    totalVulnerabilities: number;
  }> {
    const results = new Map<string, ReentrancyAnalysisResult>();
    const globalCallGraph: CallGraphEdge[] = [];
    let totalVulnerabilities = 0;

    for (const addr of contractAddresses) {
      const funcs = functionMap.get(addr) ?? [];
      const knownContracts = new Map(functionMap);
      knownContracts.delete(addr);

      const result = await this.analyze(addr, funcs, knownContracts);
      results.set(addr, result);
      globalCallGraph.push(...result.callGraph);
      totalVulnerabilities += result.vulnerabilities.length;
    }

    return { results, globalCallGraph, totalVulnerabilities };
  }
}
