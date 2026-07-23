export type FlashLoanType =
  | 'vanilla'
  | 'multi_hop'
  | 'cross_contract'
  | 'flash_swap'
  | 'donation'
  | 'reentrancy'
  | 'self_hosted'
  | 'nft'
  | 'unknown';

export type AttackArchetype =
  | 'oracle_manipulation'
  | 'price_manipulation_liquidation'
  | 'collateral_inflation'
  | 'fee_rebate_exploit'
  | 'staking_reward_manipulation'
  | 'governance_vote'
  | 'cross_protocol_sandwich'
  | 'arbitrage'
  | 'unknown';

export interface FundFlowEdge {
  from: string;
  to: string;
  token: string;
  amount: string;
  stepIndex: number;
  purpose?: string;
  slippage?: number;
}

export interface AttackStep {
  index: number;
  type: string;
  from: string;
  to: string;
  token: string;
  amount: string;
  description: string;
  isFlashLoan?: boolean;
  isRepayment?: boolean;
}

export interface FlashLoanEvent {
  txHash: string;
  attacker: string;
  ledgerSequence: number;
  detectedAt: Date;
  flashLoanTypes: FlashLoanType[];
  archetype: AttackArchetype;
  attackSubtype?: string;
  borrowedTotal: string;
  borrowedTokens: string[];
  repaidTotal: string;
  profitAmount: string;
  profitUsd?: number;
  protocolCount: number;
  stepCount: number;
  fundFlowGraph: { edges: FundFlowEdge[]; nodes: string[] };
  reconstruction: AttackStep[];
  originalTvls: Record<string, string>;
  riskScore: number;
  attackerToxicity?: number;
  detectionLatencyMs: number;
  brokenInvariants?: string[];
  cweMappings?: string[];
  isArbitrage: boolean;
  mevExtracted?: string;
}

export interface RawTransaction {
  hash: string;
  sourceAccount: string;
  ledgerSequence: number;
  ledgerCloseTime: Date;
  functionName?: string;
  contractAddress?: string;
  functionArgs?: unknown;
  status: string;
  rawXdr?: string;
}

export interface RawEvent {
  transactionHash: string;
  contractAddress: string;
  eventType: string;
  topicSymbol?: string;
  topics: unknown[];
  data: unknown;
  ledgerSequence: number;
}

// Known flash loan function signatures
const FLASH_LOAN_FUNCTION_NAMES = new Set([
  'flash_loan',
  'flashLoan',
  'flash',
  'borrow',
  'flash_borrow',
  'execute_flash_loan',
  'request_flash_loan',
  'flash_mint',
]);

const FLASH_SWAP_FUNCTION_NAMES = new Set([
  'swap',
  'swap_exact_in',
  'swap_exact_out',
  'flash_swap',
  'flashswap',
]);

const REPAY_FUNCTION_NAMES = new Set([
  'repay',
  'repay_flash_loan',
  'flash_repay',
  'return_flash',
  'settle',
]);

const ORACLE_FUNCTION_NAMES = new Set([
  'get_price',
  'price',
  'last_price',
  'get_rate',
  'consult',
  'spot_price',
]);

const GOVERNANCE_FUNCTION_NAMES = new Set(['vote', 'cast_vote', 'execute', 'queue', 'propose']);

const LIQUIDATION_FUNCTION_NAMES = new Set(['liquidate', 'liquidation_call', 'flash_liquidate']);

function isBigAmount(amount: string, threshold = '1000000'): boolean {
  try {
    return BigInt(amount) >= BigInt(threshold);
  } catch {
    return false;
  }
}

function scoredArchetype(
  functions: string[],
  protocols: string[],
): { archetype: AttackArchetype; confidence: number } {
  const fnSet = new Set(functions.map((f) => f.toLowerCase()));

  const hasOracle = [...fnSet].some(
    (f) => ORACLE_FUNCTION_NAMES.has(f) || f.includes('oracle') || f.includes('price'),
  );
  const hasLiquidation = [...fnSet].some((f) => LIQUIDATION_FUNCTION_NAMES.has(f));
  const hasGovernance = [...fnSet].some((f) => GOVERNANCE_FUNCTION_NAMES.has(f));
  const hasSwap = [...fnSet].some((f) => FLASH_SWAP_FUNCTION_NAMES.has(f));
  const hasDeposit = [...fnSet].some((f) => f.includes('deposit') || f.includes('collateral'));
  const hasBorrow = [...fnSet].some((f) => f.includes('borrow'));

  if (hasOracle && hasSwap) return { archetype: 'oracle_manipulation', confidence: 0.9 };
  if (hasLiquidation && hasBorrow)
    return { archetype: 'price_manipulation_liquidation', confidence: 0.85 };
  if (hasDeposit && hasBorrow && protocols.length >= 2)
    return { archetype: 'collateral_inflation', confidence: 0.8 };
  if (hasGovernance) return { archetype: 'governance_vote', confidence: 0.88 };
  if (hasSwap && protocols.length >= 3)
    return { archetype: 'cross_protocol_sandwich', confidence: 0.75 };
  return { archetype: 'unknown', confidence: 0.3 };
}

function detectFlashLoanType(
  events: RawEvent[],
  txEvents: RawEvent[],
): { types: FlashLoanType[]; isFlashLoan: boolean } {
  const types: FlashLoanType[] = [];

  const hasBorrow = txEvents.some(
    (e) =>
      FLASH_LOAN_FUNCTION_NAMES.has(e.topicSymbol ?? '') ||
      FLASH_LOAN_FUNCTION_NAMES.has(e.eventType) ||
      (typeof e.data === 'string' && e.data.includes('flash')),
  );
  const hasRepay = txEvents.some(
    (e) => REPAY_FUNCTION_NAMES.has(e.topicSymbol ?? '') || REPAY_FUNCTION_NAMES.has(e.eventType),
  );

  if (hasBorrow && hasRepay) types.push('vanilla');

  const contractsInvolved = new Set(txEvents.map((e) => e.contractAddress));
  if (contractsInvolved.size >= 5) types.push('multi_hop');
  if (contractsInvolved.size >= 10) types.push('cross_contract');

  const hasSwapWithoutBorrow =
    txEvents.some((e) => FLASH_SWAP_FUNCTION_NAMES.has(e.topicSymbol ?? '')) && !hasBorrow;
  if (hasSwapWithoutBorrow) types.push('flash_swap');

  const hasDonation = txEvents.some(
    (e) => e.topicSymbol === 'transfer' && e.eventType === 'transfer',
  );
  if (hasDonation && !hasBorrow) types.push('donation');

  // NFT flash loan: look for NFT transfer events
  const hasNftTransfer = txEvents.some(
    (e) => e.topicSymbol === 'transfer_nft' || e.eventType === 'nft_transfer',
  );
  if (hasNftTransfer) types.push('nft');

  if (types.length === 0 && (hasBorrow || hasRepay)) types.push('unknown');

  return { types, isFlashLoan: types.length > 0 };
}

function reconstructAttackFlow(txEvents: RawEvent[], attacker: string): AttackStep[] {
  const steps: AttackStep[] = [];

  for (const [i, evt] of txEvents.entries()) {
    const data = evt.data as Record<string, unknown> | null;
    const from = (data?.from as string) ?? attacker;
    const to = (data?.to as string) ?? evt.contractAddress;
    const token =
      (data?.token as string) ?? (Array.isArray(evt.topics) ? String(evt.topics[0] ?? '') : '');
    const amount = String(data?.amount ?? '0');

    const isFlashLoan =
      FLASH_LOAN_FUNCTION_NAMES.has(evt.topicSymbol ?? '') ||
      FLASH_LOAN_FUNCTION_NAMES.has(evt.eventType);
    const isRepayment =
      REPAY_FUNCTION_NAMES.has(evt.topicSymbol ?? '') || REPAY_FUNCTION_NAMES.has(evt.eventType);

    steps.push({
      index: i,
      type: evt.topicSymbol ?? evt.eventType,
      from,
      to,
      token,
      amount,
      description: `${evt.topicSymbol ?? evt.eventType}: ${from} → ${to} (${amount} ${token})`,
      isFlashLoan,
      isRepayment,
    });
  }

  return steps;
}

function buildFundFlowGraph(steps: AttackStep[]): { edges: FundFlowEdge[]; nodes: string[] } {
  const nodes = new Set<string>();
  const edges: FundFlowEdge[] = [];

  for (const step of steps) {
    nodes.add(step.from);
    nodes.add(step.to);
    edges.push({
      from: step.from,
      to: step.to,
      token: step.token,
      amount: step.amount,
      stepIndex: step.index,
      purpose: step.isFlashLoan ? 'flash_loan' : step.isRepayment ? 'repayment' : 'transfer',
    });
  }

  return { edges, nodes: [...nodes] };
}

function computeRiskScore(params: {
  profitUsd: number;
  protocolCount: number;
  attackerToxicity: number;
  archetype: AttackArchetype;
  isArbitrage: boolean;
}): number {
  if (params.isArbitrage) return Math.min(20 + params.profitUsd / 10000, 40);

  let score = 0;

  // Profit contribution (0-40)
  if (params.profitUsd > 1_000_000) score += 40;
  else if (params.profitUsd > 100_000) score += 30;
  else if (params.profitUsd > 10_000) score += 20;
  else score += 10;

  // Protocol complexity (0-20)
  score += Math.min(params.protocolCount * 4, 20);

  // Attacker history (0-20)
  score += params.attackerToxicity * 20;

  // Archetype severity (0-20)
  const archetypeScore: Record<AttackArchetype, number> = {
    oracle_manipulation: 20,
    price_manipulation_liquidation: 18,
    collateral_inflation: 16,
    governance_vote: 15,
    cross_protocol_sandwich: 12,
    fee_rebate_exploit: 10,
    staking_reward_manipulation: 10,
    arbitrage: 5,
    unknown: 8,
  };
  score += archetypeScore[params.archetype] ?? 8;

  return Math.min(score, 100);
}

function extractBrokenInvariants(archetype: AttackArchetype): string[] {
  const invariantMap: Record<AttackArchetype, string[]> = {
    oracle_manipulation: [
      'price[t] == TWAP(price, window) // spot price must not deviate >X% from TWAP',
      'oracle.latestAnswer() must be updated within staleness threshold',
    ],
    price_manipulation_liquidation: [
      'collateralRatio >= minCollateralRatio // must hold post-flash-loan',
      'totalBorrowed <= totalCollateral * maxLTV',
    ],
    collateral_inflation: [
      'totalSupply == sum(balances) // token accounting invariant',
      'collateralValue == sum(deposits) // collateral register invariant',
    ],
    governance_vote: [
      'votingPower[user] == token.balanceOf(user, block - 1) // snapshot invariant',
      'quorum reached via persistent stake, not flash-borrowed voting power',
    ],
    cross_protocol_sandwich: [
      'price impact per swap <= maxImpact',
      'AMM reserves satisfy x*y=k after each trade',
    ],
    fee_rebate_exploit: ['netFee >= 0 // protocol cannot pay out more than it collects'],
    staking_reward_manipulation: [
      'rewardPerToken is monotonically non-decreasing',
      'claimable[user] == integral(rewardPerToken * stake)',
    ],
    arbitrage: [],
    unknown: ['atomic balance invariant: balance(start) == balance(end) for all tokens'],
  };
  return invariantMap[archetype] ?? [];
}

export function detectFlashLoan(
  tx: RawTransaction,
  allEvents: RawEvent[],
  knownAttackerToxicity = 0,
): FlashLoanEvent | null {
  const startMs = Date.now();

  const txEvents = allEvents.filter((e) => e.transactionHash === tx.hash);
  if (txEvents.length === 0) return null;

  const { types, isFlashLoan } = detectFlashLoanType(allEvents, txEvents);
  if (!isFlashLoan) return null;

  const contracts = [...new Set(txEvents.map((e) => e.contractAddress))];
  const functions = txEvents.map((e) => e.topicSymbol ?? e.eventType).filter(Boolean);

  const { archetype } = scoredArchetype(functions, contracts);
  const steps = reconstructAttackFlow(txEvents, tx.sourceAccount);
  const graph = buildFundFlowGraph(steps);

  const borrowEvents = txEvents.filter(
    (e) =>
      FLASH_LOAN_FUNCTION_NAMES.has(e.topicSymbol ?? '') ||
      FLASH_LOAN_FUNCTION_NAMES.has(e.eventType),
  );
  const borrowedTotal = borrowEvents.reduce((sum, e) => {
    try {
      return (
        BigInt(sum) + BigInt(String((e.data as Record<string, unknown>)?.amount ?? '0'))
      ).toString();
    } catch {
      return sum;
    }
  }, '0');

  const borrowedTokens = [
    ...new Set(
      borrowEvents
        .map((e) => String((e.data as Record<string, unknown>)?.token ?? ''))
        .filter(Boolean),
    ),
  ];

  const repayEvents = txEvents.filter(
    (e) => REPAY_FUNCTION_NAMES.has(e.topicSymbol ?? '') || REPAY_FUNCTION_NAMES.has(e.eventType),
  );
  const repaidTotal = repayEvents.reduce((sum, e) => {
    try {
      return (
        BigInt(sum) + BigInt(String((e.data as Record<string, unknown>)?.amount ?? '0'))
      ).toString();
    } catch {
      return sum;
    }
  }, '0');

  let profit = '0';
  try {
    const p = BigInt(repaidTotal) - BigInt(borrowedTotal);
    profit = p < 0n ? p.toString() : p.toString();
  } catch {
    profit = '0';
  }

  const isArbitrage =
    archetype === 'arbitrage' || (types.includes('flash_swap') && contracts.length <= 2);

  const riskScore = computeRiskScore({
    profitUsd: 0,
    protocolCount: contracts.length,
    attackerToxicity: knownAttackerToxicity,
    archetype,
    isArbitrage,
  });

  const brokenInvariants = extractBrokenInvariants(archetype);

  const cweMappings: string[] = [];
  if (archetype === 'reentrancy') cweMappings.push('CWE-841', 'SWC-107');
  if (archetype === 'oracle_manipulation') cweMappings.push('CWE-345');
  if (archetype === 'governance_vote') cweMappings.push('CWE-284');

  return {
    txHash: tx.hash,
    attacker: tx.sourceAccount,
    ledgerSequence: tx.ledgerSequence,
    detectedAt: new Date(),
    flashLoanTypes: types,
    archetype,
    borrowedTotal,
    borrowedTokens,
    repaidTotal,
    profitAmount: profit,
    protocolCount: contracts.length,
    stepCount: steps.length,
    fundFlowGraph: graph,
    reconstruction: steps,
    originalTvls: {},
    riskScore,
    attackerToxicity: knownAttackerToxicity,
    detectionLatencyMs: Date.now() - startMs,
    brokenInvariants,
    cweMappings,
    isArbitrage,
  };
}

export function computePreFlightScore(tx: RawTransaction): {
  score: number;
  factors: Record<string, number>;
} {
  const factors: Record<string, number> = {};
  let score = 0;

  const fnName = tx.functionName?.toLowerCase() ?? '';

  if (FLASH_LOAN_FUNCTION_NAMES.has(fnName) || fnName.includes('flash')) {
    factors.flashLoanPresent = 40;
    score += 40;
  }

  // Multiple protocol interactions inferred from args size
  const argsSize = JSON.stringify(tx.functionArgs ?? {}).length;
  if (argsSize > 500) {
    factors.multipleProtocols = 20;
    score += 20;
  }

  if (ORACLE_FUNCTION_NAMES.has(fnName) || fnName.includes('price') || fnName.includes('oracle')) {
    factors.oracleDependent = 15;
    score += 15;
  }

  return { score: Math.min(score, 100), factors };
}

export function generateSecurityAdvisory(attack: FlashLoanEvent): {
  advisoryId: string;
  title: string;
  severity: string;
  attackVector: string;
  affectedProtocols: string[];
  mitigation: string;
  variantCount: number;
} {
  const severityMap: Record<number, string> = { 80: 'CRITICAL', 60: 'HIGH', 40: 'MEDIUM' };
  let severity = 'LOW';
  for (const [threshold, label] of Object.entries(severityMap)) {
    if (attack.riskScore >= Number(threshold)) {
      severity = label;
      break;
    }
  }

  const archetypeDescriptions: Record<AttackArchetype, string> = {
    oracle_manipulation: 'Oracle manipulation via flash loan',
    price_manipulation_liquidation: 'Price manipulation and forced liquidation via flash loan',
    collateral_inflation: 'Collateral inflation exploit via flash loan',
    governance_vote: 'Governance takeover via flash-borrowed voting power',
    cross_protocol_sandwich: 'Cross-protocol sandwich attack via flash loan',
    fee_rebate_exploit: 'Fee/rebate exploit via flash loan',
    staking_reward_manipulation: 'Staking reward manipulation via flash loan',
    arbitrage: 'Flash loan arbitrage (non-malicious)',
    unknown: 'Unknown flash loan attack pattern',
  };

  const mitigationMap: Record<AttackArchetype, string> = {
    oracle_manipulation:
      'Use TWAP oracle with minimum 30-minute window; add circuit breakers for price deviations >5%',
    price_manipulation_liquidation: 'Use time-delayed price feeds; add liquidation delay blocks',
    collateral_inflation: 'Validate token accounting invariants in post-flash-loan hooks',
    governance_vote: 'Use voting power snapshots from previous block; add flash-loan lock period',
    cross_protocol_sandwich: 'Add slippage guards; use commit-reveal for large swaps',
    fee_rebate_exploit: 'Cap rebates to actual fees received; add reentrancy guard',
    staking_reward_manipulation: 'Use reward per token accumulators with block-level snapshots',
    arbitrage: 'No mitigation needed for legitimate arbitrage',
    unknown: 'Audit protocol for flash-loan-accessible state changes',
  };

  const ledger = attack.ledgerSequence;
  const year = new Date().getFullYear();
  const advisoryId = `SOROBAN-${year}-${String(ledger).slice(-4)}`;

  return {
    advisoryId,
    title: archetypeDescriptions[attack.archetype],
    severity,
    attackVector: attack.archetype,
    affectedProtocols: attack.fundFlowGraph.nodes.filter((n) => n !== attack.attacker),
    mitigation: mitigationMap[attack.archetype],
    variantCount: attack.reconstruction.length,
  };
}
