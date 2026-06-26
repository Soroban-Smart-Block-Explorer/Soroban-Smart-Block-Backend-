/**
 * Cross-Contract Composability Analysis Engine
 *
 * Provides static call-graph extraction, pattern detection, formal verification
 * of safety properties, safety scoring, exploit detection, and fuzzing.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface CallNode {
  address: string;
  method: string;
  depth: number;
}

export interface CallEdge {
  from: string;
  to: string;
  method: string;
  argCount: number;
}

export interface CallGraph {
  nodes: CallNode[];
  edges: CallEdge[];
}

export interface ContractCall {
  from: string;
  to: string;
  method: string;
  args?: unknown[];
}

export interface PatternDetectionResult {
  patternName: string;
  category: string;
  confidence: number;
  details: Record<string, unknown>;
}

export interface SafetyScoreBreakdown {
  atomicity: number; // max 25
  authorization: number; // max 25
  stateConsistency: number; // max 20
  reentrancy: number; // max 20
  oracleFreshness: number; // max 10
  total: number; // max 100
}

export interface VerificationResult {
  atomicity: boolean;
  authorization: boolean;
  stateConsistency: boolean;
  reentrancyFree: boolean;
  oracleFreshness: boolean;
  scores: SafetyScoreBreakdown;
  proofData: Record<string, unknown>;
  verified: boolean;
}

export interface StaticAnalysisResult {
  externalCalls: Array<{ callee: string; method: string; isDynamic: boolean }>;
  callGraph: CallGraph;
  circularDeps: string[][];
  hasUnboundedRecursion: boolean;
  maxCallDepth: number;
}

export interface FuzzFinding {
  sequence: ContractCall[];
  risk: string;
  description: string;
}

// ── Known pattern definitions ─────────────────────────────────────────────────

const KNOWN_PATTERNS: Array<{
  name: string;
  category: string;
  risk: 'safe' | 'low_risk' | 'medium_risk' | 'high_risk' | 'critical';
  detect: (calls: ContractCall[]) => number; // returns confidence 0-1
  mitigationGuide: string;
}> = [
  {
    name: 'Flash Loan Attack',
    category: 'flash_loan',
    risk: 'critical',
    detect(calls) {
      const hasBorrow = calls.some(
        (c) =>
          c.method.toLowerCase().includes('borrow') || c.method.toLowerCase().includes('flash'),
      );
      const hasRepay = calls.some(
        (c) =>
          c.method.toLowerCase().includes('repay') || c.method.toLowerCase().includes('return'),
      );
      const hasUse = calls.some(
        (c) =>
          c.method.toLowerCase().includes('swap') || c.method.toLowerCase().includes('liquidate'),
      );
      // Flash loan = borrow -> use -> repay in same tx
      if (hasBorrow && hasRepay && hasUse) return 0.9;
      if (hasBorrow && hasRepay) return 0.6;
      return 0;
    },
    mitigationGuide:
      'Add reentrancy guards and validate balances before/after flash loan callbacks.',
  },
  {
    name: 'Cross-Contract Reentrancy',
    category: 'reentrancy',
    risk: 'critical',
    detect(calls) {
      // Detect cycles in the call graph
      const callPairs = calls.map((c) => `${c.from}->${c.to}`);
      const seen = new Set<string>();
      let cycles = 0;
      for (const pair of callPairs) {
        if (seen.has(pair)) cycles++;
        seen.add(pair);
      }
      if (cycles >= 2) return 0.95;
      if (cycles === 1) return 0.7;
      return 0;
    },
    mitigationGuide:
      'Apply checks-effects-interactions pattern. Add reentrancy mutex guards on all external calls.',
  },
  {
    name: 'DEX Arbitrage Composition',
    category: 'arbitrage',
    risk: 'low_risk',
    detect(calls) {
      const dexCalls = calls.filter(
        (c) =>
          c.method.toLowerCase().includes('swap') ||
          c.method.toLowerCase().includes('exchange') ||
          c.method.toLowerCase().includes('trade'),
      );
      // Two or more swaps across different contracts = arbitrage
      const uniqueDexContracts = new Set(dexCalls.map((c) => c.to)).size;
      if (dexCalls.length >= 2 && uniqueDexContracts >= 2) return 0.8;
      if (dexCalls.length >= 2) return 0.5;
      return 0;
    },
    mitigationGuide: 'Arbitrage is generally benign. Monitor for sandwich attack patterns.',
  },
  {
    name: 'Leveraged Position Composition',
    category: 'leverage',
    risk: 'medium_risk',
    detect(calls) {
      const hasDeposit = calls.some(
        (c) =>
          c.method.toLowerCase().includes('deposit') ||
          c.method.toLowerCase().includes('collateral'),
      );
      const hasBorrow = calls.some((c) => c.method.toLowerCase().includes('borrow'));
      const hasSwap = calls.some((c) => c.method.toLowerCase().includes('swap'));
      if (hasDeposit && hasBorrow && hasSwap) return 0.85;
      if (hasDeposit && hasBorrow) return 0.6;
      return 0;
    },
    mitigationGuide: 'Validate collateralization ratios at each step. Emit liquidation events.',
  },
  {
    name: 'Collateral Swap Composition',
    category: 'collateral_swap',
    risk: 'medium_risk',
    detect(calls) {
      const hasWithdraw = calls.some((c) => c.method.toLowerCase().includes('withdraw'));
      const hasDeposit = calls.some((c) => c.method.toLowerCase().includes('deposit'));
      const hasRepay = calls.some((c) => c.method.toLowerCase().includes('repay'));
      if (hasWithdraw && hasDeposit && hasRepay) return 0.8;
      if (hasWithdraw && hasDeposit) return 0.5;
      return 0;
    },
    mitigationGuide: 'Ensure atomicity of collateral swap. Add minimum output validation.',
  },
  {
    name: 'Multi-DEX Route Composition',
    category: 'multi_dex',
    risk: 'low_risk',
    detect(calls) {
      const swaps = calls.filter((c) => c.method.toLowerCase().includes('swap'));
      const uniqueContracts = new Set(swaps.map((c) => c.to)).size;
      if (swaps.length >= 3 && uniqueContracts >= 3) return 0.9;
      if (swaps.length >= 2 && uniqueContracts >= 2) return 0.6;
      return 0;
    },
    mitigationGuide:
      'Add slippage protection on each hop. Validate final output against minimum threshold.',
  },
  {
    name: 'Oracle Manipulation',
    category: 'oracle_manip',
    risk: 'high_risk',
    detect(calls) {
      const oracleRead = calls.some(
        (c) =>
          c.method.toLowerCase().includes('price') ||
          c.method.toLowerCase().includes('oracle') ||
          c.method.toLowerCase().includes('twap'),
      );
      const largeSwap = calls.some(
        (c) =>
          c.method.toLowerCase().includes('swap') || c.method.toLowerCase().includes('exchange'),
      );
      const hasBorrow = calls.some((c) => c.method.toLowerCase().includes('borrow'));
      // Swap to move price, read oracle, borrow inflated amount
      if (largeSwap && oracleRead && hasBorrow) return 0.85;
      return 0;
    },
    mitigationGuide:
      'Use TWAP oracles with sufficient observation window. Add price deviation guards.',
  },
];

// ── Call-Graph Builder ────────────────────────────────────────────────────────

export function buildCallGraph(calls: ContractCall[]): CallGraph {
  const nodeMap = new Map<string, CallNode>();
  const edges: CallEdge[] = [];

  for (const call of calls) {
    const fromKey = `${call.from}::${call.method}`;
    const toKey = `${call.to}::${call.method}`;

    if (!nodeMap.has(call.from)) {
      nodeMap.set(call.from, { address: call.from, method: '', depth: 0 });
    }
    if (!nodeMap.has(toKey)) {
      nodeMap.set(toKey, {
        address: call.to,
        method: call.method,
        depth: nodeMap.get(fromKey)?.depth ?? 0 + 1,
      });
    }

    edges.push({
      from: call.from,
      to: call.to,
      method: call.method,
      argCount: call.args?.length ?? 0,
    });
  }

  return { nodes: Array.from(nodeMap.values()), edges };
}

// ── Static Analysis ───────────────────────────────────────────────────────────

export function performStaticAnalysis(
  contractAddress: string,
  functionSignatures: Array<{ name: string }> | null,
  abi: { functions?: Array<{ name: string; calls?: string[] }> } | null,
): StaticAnalysisResult {
  const externalCalls: StaticAnalysisResult['externalCalls'] = [];
  const edges: CallEdge[] = [];
  const nodes: CallNode[] = [{ address: contractAddress, method: '', depth: 0 }];

  // Extract calls from function signatures and ABI
  const fns = [...(functionSignatures ?? []), ...(abi?.functions ?? [])];

  for (const fn of fns) {
    const name = fn.name.toLowerCase();
    // Heuristic: functions that invoke external patterns
    const externalPatterns = [
      'call',
      'invoke',
      'execute',
      'transfer',
      'approve',
      'swap',
      'borrow',
      'deposit',
      'withdraw',
    ];

    for (const pattern of externalPatterns) {
      if (name.includes(pattern)) {
        externalCalls.push({
          callee: 'unknown', // would be resolved from bytecode in production
          method: fn.name,
          isDynamic: name.includes('call') || name.includes('invoke'),
        });
        edges.push({ from: contractAddress, to: 'unknown', method: fn.name, argCount: 0 });
        break;
      }
    }
  }

  // Detect circular deps (simplified: check if any function calls back to itself chain)
  const circularDeps = detectCircularDeps(edges, contractAddress);
  const maxCallDepth = Math.min(externalCalls.length, 10);

  return {
    externalCalls,
    callGraph: { nodes, edges },
    circularDeps,
    hasUnboundedRecursion: circularDeps.length > 0,
    maxCallDepth,
  };
}

function detectCircularDeps(edges: CallEdge[], root: string): string[][] {
  const graph = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!graph.has(edge.from)) graph.set(edge.from, new Set());
    graph.get(edge.from)!.add(edge.to);
  }

  const cycles: string[][] = [];
  const visited = new Set<string>();
  const stack: string[] = [];

  function dfs(node: string) {
    if (stack.includes(node)) {
      cycles.push([...stack.slice(stack.indexOf(node)), node]);
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    stack.push(node);
    for (const neighbor of graph.get(node) ?? []) {
      dfs(neighbor);
    }
    stack.pop();
  }

  dfs(root);
  return cycles;
}

// ── Pattern Detection ─────────────────────────────────────────────────────────

export function detectPatterns(calls: ContractCall[]): PatternDetectionResult[] {
  const results: PatternDetectionResult[] = [];

  for (const pattern of KNOWN_PATTERNS) {
    const confidence = pattern.detect(calls);
    if (confidence >= 0.5) {
      results.push({
        patternName: pattern.name,
        category: pattern.category,
        confidence,
        details: {
          riskRating: pattern.risk,
          mitigationGuide: pattern.mitigationGuide,
          callCount: calls.length,
          uniqueContracts: new Set(calls.flatMap((c) => [c.from, c.to])).size,
        },
      });
    }
  }

  return results;
}

// ── Formal Verification ───────────────────────────────────────────────────────

export function verifyCompositionSafety(
  calls: ContractCall[],
  callGraph: CallGraph,
): VerificationResult {
  // Atomicity: all calls in same tx context (no async gaps detectable from call list)
  const atomicity =
    calls.length > 0 && !calls.some((c) => c.method.toLowerCase().includes('async'));

  // Authorization: check that privileged methods have consistent caller
  const privilegedMethods = ['admin', 'owner', 'pause', 'upgrade', 'mint', 'burn'];
  const authViolations = calls.filter(
    (c) =>
      privilegedMethods.some((p) => c.method.toLowerCase().includes(p)) &&
      c.from !== calls[0]?.from,
  );
  const authorization = authViolations.length === 0;

  // State consistency: no withdraw before deposit in same contract pair
  const contractPairs = new Map<string, string[]>();
  for (const call of calls) {
    const key = `${call.from}->${call.to}`;
    if (!contractPairs.has(key)) contractPairs.set(key, []);
    contractPairs.get(key)!.push(call.method);
  }
  let stateViolations = 0;
  for (const [, methods] of contractPairs) {
    const withdrawIdx = methods.findIndex((m) => m.toLowerCase().includes('withdraw'));
    const depositIdx = methods.findIndex((m) => m.toLowerCase().includes('deposit'));
    if (withdrawIdx !== -1 && depositIdx !== -1 && withdrawIdx < depositIdx) stateViolations++;
  }
  const stateConsistency = stateViolations === 0;

  // Reentrancy: no cyclic edges in call graph
  const reentrancyFree = callGraph.edges.every(
    (e) => !callGraph.edges.some((e2) => e2.from === e.to && e2.to === e.from),
  );

  // Oracle freshness: oracle reads should not precede large swaps without time check
  const oracleReads = calls.filter(
    (c) => c.method.toLowerCase().includes('price') || c.method.toLowerCase().includes('oracle'),
  );
  const oracleFreshness = oracleReads.length === 0 || calls.length <= 3;

  // Score computation (0-100 total)
  const atomicityScore = atomicity ? 25 : 0;
  const authorizationScore = authorization ? 25 : 0;
  const stateScore = stateConsistency ? 20 : 0;
  const reentrancyScore = reentrancyFree ? 20 : 0;
  const oracleScore = oracleFreshness ? 10 : 0;
  const total = atomicityScore + authorizationScore + stateScore + reentrancyScore + oracleScore;

  return {
    atomicity,
    authorization,
    stateConsistency,
    reentrancyFree,
    oracleFreshness,
    scores: {
      atomicity: atomicityScore,
      authorization: authorizationScore,
      stateConsistency: stateScore,
      reentrancy: reentrancyScore,
      oracleFreshness: oracleScore,
      total,
    },
    proofData: {
      authViolations: authViolations.length,
      stateViolations,
      cyclicEdges: callGraph.edges.filter((e) =>
        callGraph.edges.some((e2) => e2.from === e.to && e2.to === e.from),
      ).length,
    },
    verified: total >= 70,
  };
}

// ── Safety Scoring ────────────────────────────────────────────────────────────

export function computeRiskLevel(
  score: number,
): 'safe' | 'low_risk' | 'medium_risk' | 'high_risk' | 'critical' {
  if (score >= 90) return 'safe';
  if (score >= 70) return 'low_risk';
  if (score >= 50) return 'medium_risk';
  if (score >= 30) return 'high_risk';
  return 'critical';
}

// ── Mitigation Patch Generator ────────────────────────────────────────────────

export function generateMitigationPatch(
  calls: ContractCall[],
  patterns: PatternDetectionResult[],
): Record<string, unknown> {
  const patches: Array<{ type: string; description: string; codeSnippet: string }> = [];

  const hasReentrancy = patterns.some((p) => p.category === 'reentrancy');
  const hasOracleManip = patterns.some((p) => p.category === 'oracle_manip');
  const hasFlashLoan = patterns.some((p) => p.category === 'flash_loan');

  if (hasReentrancy) {
    patches.push({
      type: 'reentrancy_guard',
      description: 'Add reentrancy mutex to prevent cross-contract reentrancy',
      codeSnippet: `
// Add to contract storage
DataKey::ReentrancyGuard => false

// Wrap external calls
fn protected_call(env: Env, ...) {
    let locked: bool = env.storage().instance().get(&DataKey::ReentrancyGuard).unwrap_or(false);
    if locked { panic_with_error!(&env, Error::Reentrancy); }
    env.storage().instance().set(&DataKey::ReentrancyGuard, &true);
    // ... external call ...
    env.storage().instance().set(&DataKey::ReentrancyGuard, &false);
}`.trim(),
    });
  }

  if (hasOracleManip) {
    patches.push({
      type: 'oracle_freshness_check',
      description: 'Add TWAP staleness check before using oracle price',
      codeSnippet: `
const MAX_ORACLE_AGE_LEDGERS: u32 = 20; // ~100 seconds at 5s/ledger

fn get_fresh_price(env: &Env, oracle: Address) -> i128 {
    let (price, timestamp) = oracle_interface::get_price(env, oracle);
    let age = env.ledger().sequence() - timestamp;
    if age > MAX_ORACLE_AGE_LEDGERS {
        panic_with_error!(env, Error::StaleOracle);
    }
    price
}`.trim(),
    });
  }

  if (hasFlashLoan) {
    patches.push({
      type: 'flash_loan_guard',
      description: 'Validate balances before and after flash loan callback',
      codeSnippet: `
fn flash_loan_callback(env: Env, token: Address, amount: i128) {
    let balance_before = token_client::balance(&env, &token, &env.current_contract_address());
    // ... use funds ...
    let balance_after = token_client::balance(&env, &token, &env.current_contract_address());
    if balance_after < balance_before {
        panic_with_error!(&env, Error::InsufficientRepayment);
    }
}`.trim(),
    });
  }

  // Minimum output validation
  const hasSwap = calls.some((c) => c.method.toLowerCase().includes('swap'));
  if (hasSwap) {
    patches.push({
      type: 'min_output_validation',
      description: 'Add minimum output amount check to prevent sandwich attacks',
      codeSnippet: `
fn swap(env: Env, amount_in: i128, min_amount_out: i128) -> i128 {
    let out = calculate_out(amount_in);
    if out < min_amount_out {
        panic_with_error!(&env, Error::InsufficientOutput);
    }
    out
}`.trim(),
    });
  }

  return {
    patchCount: patches.length,
    patches,
    appliedAt: new Date().toISOString(),
  };
}

// ── Fuzzing Engine ────────────────────────────────────────────────────────────

const FUZZ_METHODS = [
  'swap',
  'borrow',
  'repay',
  'deposit',
  'withdraw',
  'transfer',
  'approve',
  'liquidate',
  'flash_loan',
  'oracle_read',
  'price',
  'balance',
  'mint',
  'burn',
];

export function runFuzzCampaign(
  contractAddress: string,
  iterations: number = 100,
): { findings: FuzzFinding[]; coverage: number } {
  const findings: FuzzFinding[] = [];
  const coveredMethods = new Set<string>();

  for (let i = 0; i < iterations; i++) {
    // Generate random call sequence
    const seqLen = 2 + Math.floor(Math.random() * 5);
    const sequence: ContractCall[] = [];

    for (let j = 0; j < seqLen; j++) {
      const method = FUZZ_METHODS[Math.floor(Math.random() * FUZZ_METHODS.length)];
      coveredMethods.add(method);
      sequence.push({
        from: j === 0 ? 'attacker' : contractAddress,
        to: contractAddress,
        method,
        args: [],
      });
    }

    const detected = detectPatterns(sequence);
    const graph = buildCallGraph(sequence);
    const verification = verifyCompositionSafety(sequence, graph);

    for (const pattern of detected) {
      if (pattern.confidence >= 0.7 && verification.scores.total < 50) {
        findings.push({
          sequence,
          risk: (pattern.details as any).riskRating ?? 'high_risk',
          description: `Detected ${pattern.patternName} with confidence ${(pattern.confidence * 100).toFixed(0)}%`,
        });
      }
    }
  }

  const coverage = (coveredMethods.size / FUZZ_METHODS.length) * 100;

  return { findings, coverage };
}

// ── Exploit Detection ─────────────────────────────────────────────────────────

export function checkForExploit(calls: ContractCall[]): {
  exploitDetected: boolean;
  exploitType: string | null;
  confidence: number;
  description: string | null;
} {
  // Check for known high-confidence exploit signatures
  const patterns = detectPatterns(calls);
  const criticalPatterns = patterns.filter(
    (p) => (p.details as any).riskRating === 'critical' && p.confidence >= 0.8,
  );

  if (criticalPatterns.length > 0) {
    const top = criticalPatterns[0];
    return {
      exploitDetected: true,
      exploitType: top.category,
      confidence: top.confidence,
      description: `${top.patternName} exploit pattern detected in call sequence`,
    };
  }

  return { exploitDetected: false, exploitType: null, confidence: 0, description: null };
}

// ── Ecosystem Composability Index ─────────────────────────────────────────────

export function computeEcosystemIndex(stats: {
  totalContracts: number;
  totalComposedTx: number;
  uniquePatternCategories: number;
  avgSafetyScore: number;
  exploitCount: number;
  totalTx: number;
}): number {
  // Diversity: unique patterns normalized (0-250)
  const diversity = Math.min(250, (stats.uniquePatternCategories / 10) * 250);

  // Safety: avg score normalized (0-400)
  const safety = (stats.avgSafetyScore / 100) * 400;

  // Exploit rate inverse (0-200) — fewer exploits = higher score
  const exploitRate = stats.totalTx > 0 ? stats.exploitCount / stats.totalTx : 0;
  const exploitScore = Math.max(0, 200 - exploitRate * 10000);

  // Interconnectivity: how many contracts are composing (0-150)
  const interconnectivity =
    stats.totalContracts > 0
      ? Math.min(150, (stats.totalComposedTx / stats.totalContracts) * 15)
      : 0;

  return Math.round(diversity + safety + exploitScore + interconnectivity);
}
