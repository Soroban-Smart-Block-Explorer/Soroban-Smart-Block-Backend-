/**
 * Advanced MEV Sandwich Attack Detection Engine (#290)
 *
 * Detects sandwich attacks, multi-hop variants, cross-pool patterns,
 * frontrunning/backrunning pairs, and computes confidence scores (0–100)
 * with profit/victim-loss calculations.
 */

export interface LedgerTx {
  hash: string;
  position: number; // ordinal position in the ledger
  sourceAccount: string;
  contractAddress: string | null;
  functionName: string | null;
  humanReadable: string | null;
  ledgerSequence: number;
  ledgerCloseTime: Date;
  amountIn?: string;
  amountOut?: string;
  tokenIn?: string;
  tokenOut?: string;
  feeCharged?: string;
  flashLoanAlert?: boolean;
  events?: Array<{ type: string; data: any }>;
}

export interface SandwichPattern {
  type:
    | 'simple_sandwich'
    | 'multi_hop_sandwich'
    | 'cross_pool_sandwich'
    | 'frontrun_backrun'
    | 'displacement'
    | 'jit_liquidity';
  frontrunTx: string;
  victimTx: string;
  backrunTx: string;
  attacker: string;
  victim: string;
  protocol: string;
  confidence: number; // 0–100
  profitEstimateUsd: number;
  victimLossUsd: number;
  victimLossPct: number;
  tokensInvolved: string[];
  poolsInvolved: string[];
  ledgerSeq: number;
  timestamp: Date;
  hops?: number; // for multi-hop
  details: Record<string, unknown>;
}

export interface MevLandscape {
  totalExtractedUsd: number;
  byType: Record<string, { count: number; totalUsd: number }>;
  topAttackers: { address: string; totalProfitUsd: number; attackCount: number }[];
  mostVictimizedProtocols: { protocol: string; totalLossUsd: number; attackCount: number }[];
  mevConcentration: number; // Herfindahl-Hirschman Index (0–1)
}

export interface FairnessScore {
  protocol: string;
  fairnessScore: number; // 0–100 (100 = perfectly fair)
  sandwichRate: number; // attacks per 1000 txs
  unfairOrderingRate: number; // ratio of out-of-order txs
  mevExtractedPct: number; // % of protocol value extracted as MEV
  crossDexComparison: { dex: string; fairnessScore: number }[];
}

// ── Detection helpers ──────────────────────────────────────────────────────────

const SWAP_KEYWORDS = ['swap', 'exchange', 'trade', 'buy', 'sell', 'convert'];

function isSwapTx(tx: LedgerTx): boolean {
  const fn = (tx.functionName ?? '').toLowerCase();
  const hr = (tx.humanReadable ?? '').toLowerCase();
  return SWAP_KEYWORDS.some((k) => fn.includes(k) || hr.includes(k));
}

function amountToNumber(s?: string): number {
  if (!s) return 0;
  const n = parseFloat(s.replace(/[^0-9.]/g, ''));
  return isNaN(n) ? 0 : n;
}

/** Rough USD price mapping — in production this would call a price oracle */
function priceUsd(token?: string): number {
  if (!token) return 1;
  const t = token.toUpperCase();
  if (t.includes('XLM')) return 0.12;
  if (t.includes('USDC') || t.includes('USDT')) return 1.0;
  if (t.includes('BTC') || t.includes('WBTC')) return 65000;
  if (t.includes('ETH') || t.includes('WETH')) return 3500;
  return 1;
}

function estimateAmountUsd(amount?: string, token?: string): number {
  return amountToNumber(amount) * priceUsd(token);
}

/**
 * Compute a confidence score (0–100) for a sandwich pattern.
 * Higher score = stronger evidence of intentional attack.
 */
function computeConfidence(params: {
  sameAttacker: boolean;
  samePool: boolean;
  oppositeDirections: boolean;
  positionGap: number; // tx positions between front and back
  profitRatio: number; // profit / victim amount
  txGap: number; // gap between front and back (should be 1 for tight sandwich)
}): number {
  let score = 0;

  // Must-have conditions
  if (!params.sameAttacker) return 0;
  score += 30; // same account on both sides

  if (params.samePool) score += 20;
  if (params.oppositeDirections) score += 15;

  // Tight positioning is a strong signal
  if (params.positionGap <= 2) score += 20;
  else if (params.positionGap <= 5) score += 10;
  else if (params.positionGap > 10) score -= 10;

  // Profit ratio — a real sandwich has a clear profit
  if (params.profitRatio > 0.001) score += 10;
  if (params.profitRatio > 0.01) score += 5;

  return Math.max(0, Math.min(100, score));
}

// ── Core detection functions ──────────────────────────────────────────────────

/**
 * Detect simple (single-pool) sandwich attacks within a ledger.
 * O(n²) over swap transactions — fast enough for 500-tx ledgers.
 */
export function detectSimpleSandwiches(txs: LedgerTx[]): SandwichPattern[] {
  const swaps = txs.filter(isSwapTx);
  const results: SandwichPattern[] = [];

  for (let i = 0; i < swaps.length - 2; i++) {
    const front = swaps[i];
    for (let v = i + 1; v < swaps.length - 1; v++) {
      const victim = swaps[v];
      if (victim.sourceAccount === front.sourceAccount) continue;

      for (let b = v + 1; b < swaps.length; b++) {
        const back = swaps[b];
        if (back.sourceAccount !== front.sourceAccount) continue;
        if (!front.contractAddress || front.contractAddress !== back.contractAddress) continue;

        const posGap = back.position - front.position;
        if (posGap > 20) break; // too far apart to be a tight sandwich

        const frontAmtUsd = estimateAmountUsd(front.amountIn, front.tokenIn);
        const victimAmtUsd = estimateAmountUsd(victim.amountIn, victim.tokenIn);
        const backAmtUsd = estimateAmountUsd(back.amountOut, back.tokenOut);

        // Simple profit estimate: back proceeds minus front cost
        const profitUsd = Math.max(0, backAmtUsd - frontAmtUsd);
        const profitRatio = victimAmtUsd > 0 ? profitUsd / victimAmtUsd : 0;

        // Victim loss: price impact caused by front-running
        const victimLossUsd = victimAmtUsd * 0.005 * (1 + profitRatio * 10);
        const victimLossPct = victimAmtUsd > 0 ? (victimLossUsd / victimAmtUsd) * 100 : 0;

        const confidence = computeConfidence({
          sameAttacker: true,
          samePool: true,
          oppositeDirections: front.tokenIn !== back.tokenIn || front.tokenOut !== back.tokenOut,
          positionGap: posGap,
          profitRatio,
          txGap: b - i,
        });

        if (confidence < 30) continue;

        results.push({
          type: 'simple_sandwich',
          frontrunTx: front.hash,
          victimTx: victim.hash,
          backrunTx: back.hash,
          attacker: front.sourceAccount,
          victim: victim.sourceAccount,
          protocol: front.contractAddress ?? '',
          confidence,
          profitEstimateUsd: profitUsd,
          victimLossUsd,
          victimLossPct,
          tokensInvolved: [
            ...new Set([front.tokenIn, front.tokenOut, victim.tokenIn].filter(Boolean) as string[]),
          ],
          poolsInvolved: [front.contractAddress ?? ''].filter(Boolean),
          ledgerSeq: front.ledgerSequence,
          timestamp: front.ledgerCloseTime,
          details: {
            frontPosition: front.position,
            victimPosition: victim.position,
            backPosition: back.position,
            positionGap: posGap,
            frontAmtUsd,
            victimAmtUsd,
            backAmtUsd,
          },
        });
      }
    }
  }

  return results;
}

/**
 * Detect multi-hop sandwiches (3+ transactions in the attack chain,
 * chained across multiple pools or hops).
 */
export function detectMultiHopSandwiches(txs: LedgerTx[]): SandwichPattern[] {
  const swaps = txs.filter(isSwapTx);
  const results: SandwichPattern[] = [];

  // Group by attacker account
  const byAttacker = new Map<string, LedgerTx[]>();
  for (const tx of swaps) {
    const list = byAttacker.get(tx.sourceAccount) ?? [];
    list.push(tx);
    byAttacker.set(tx.sourceAccount, list);
  }

  for (const [attacker, attackerTxs] of byAttacker) {
    if (attackerTxs.length < 2) continue;

    // Look for groups of 2+ attacker txs that bracket victim txs
    for (let fi = 0; fi < attackerTxs.length - 1; fi++) {
      const front = attackerTxs[fi];

      // Find victims between this front and subsequent attacker txs
      const victims = swaps.filter(
        (tx) =>
          tx.sourceAccount !== attacker &&
          tx.position > front.position &&
          tx.position < (attackerTxs[fi + 1]?.position ?? Infinity),
      );

      if (victims.length === 0) continue;

      // Collect all attacker txs after the victims (multi-hop back-run chain)
      const backChain = attackerTxs
        .slice(fi + 1)
        .filter((tx) => tx.position > (victims[victims.length - 1]?.position ?? 0));

      if (backChain.length === 0) continue;

      const hops = backChain.length;
      const mainVictim = victims[0];
      const mainBack = backChain[0];

      const profitUsd =
        estimateAmountUsd(mainBack.amountOut, mainBack.tokenOut) -
        estimateAmountUsd(front.amountIn, front.tokenIn);
      const victimAmtUsd = estimateAmountUsd(mainVictim.amountIn, mainVictim.tokenIn);
      const victimLossUsd = Math.max(0, victimAmtUsd * 0.008 * hops);
      const victimLossPct = victimAmtUsd > 0 ? (victimLossUsd / victimAmtUsd) * 100 : 0;

      const confidence =
        computeConfidence({
          sameAttacker: true,
          samePool: front.contractAddress === mainBack.contractAddress,
          oppositeDirections: true,
          positionGap: mainBack.position - front.position,
          profitRatio: victimAmtUsd > 0 ? profitUsd / victimAmtUsd : 0,
          txGap: backChain.length + victims.length,
        }) + Math.min(15, hops * 5); // multi-hop bonus

      if (confidence < 35) continue;

      const allPools = [
        ...new Set([front, ...backChain].map((t) => t.contractAddress).filter(Boolean) as string[]),
      ];

      results.push({
        type: 'multi_hop_sandwich',
        frontrunTx: front.hash,
        victimTx: mainVictim.hash,
        backrunTx: mainBack.hash,
        attacker,
        victim: mainVictim.sourceAccount,
        protocol: front.contractAddress ?? '',
        confidence: Math.min(100, confidence),
        profitEstimateUsd: Math.max(0, profitUsd),
        victimLossUsd,
        victimLossPct,
        tokensInvolved: [
          ...new Set(
            [front, mainVictim, mainBack]
              .flatMap((t) => [t.tokenIn, t.tokenOut])
              .filter(Boolean) as string[],
          ),
        ],
        poolsInvolved: allPools,
        ledgerSeq: front.ledgerSequence,
        timestamp: front.ledgerCloseTime,
        hops,
        details: {
          victimCount: victims.length,
          backChainLength: hops,
          frontPosition: front.position,
          backPosition: mainBack.position,
        },
      });
    }
  }

  return results;
}

/**
 * Detect cross-pool sandwiches (attack uses a different pool than the victim).
 */
export function detectCrossPoolSandwiches(txs: LedgerTx[]): SandwichPattern[] {
  const swaps = txs.filter(isSwapTx);
  const results: SandwichPattern[] = [];

  const byToken = new Map<string, LedgerTx[]>();
  for (const tx of swaps) {
    const key = [tx.tokenIn, tx.tokenOut].sort().join(':');
    if (!key.includes('undefined')) {
      const list = byToken.get(key) ?? [];
      list.push(tx);
      byToken.set(key, list);
    }
  }

  for (const [, tokenTxs] of byToken) {
    if (tokenTxs.length < 3) continue;

    for (let i = 0; i < tokenTxs.length - 2; i++) {
      const front = tokenTxs[i];
      const victim = tokenTxs[i + 1];
      const back = tokenTxs[i + 2];

      if (front.sourceAccount !== back.sourceAccount) continue;
      if (victim.sourceAccount === front.sourceAccount) continue;
      if (front.contractAddress === back.contractAddress) continue; // must be different pools

      const crossPoolBonus = 10; // higher value for cross-pool (harder to do)
      const victimAmtUsd = estimateAmountUsd(victim.amountIn, victim.tokenIn);
      const profitUsd =
        estimateAmountUsd(back.amountOut, back.tokenOut) -
        estimateAmountUsd(front.amountIn, front.tokenIn);
      const victimLossUsd = victimAmtUsd * 0.007;
      const victimLossPct = victimAmtUsd > 0 ? (victimLossUsd / victimAmtUsd) * 100 : 0;

      const confidence =
        computeConfidence({
          sameAttacker: true,
          samePool: false,
          oppositeDirections: true,
          positionGap: back.position - front.position,
          profitRatio: victimAmtUsd > 0 ? profitUsd / victimAmtUsd : 0,
          txGap: 2,
        }) + crossPoolBonus;

      if (confidence < 35) continue;

      results.push({
        type: 'cross_pool_sandwich',
        frontrunTx: front.hash,
        victimTx: victim.hash,
        backrunTx: back.hash,
        attacker: front.sourceAccount,
        victim: victim.sourceAccount,
        protocol: victim.contractAddress ?? front.contractAddress ?? '',
        confidence: Math.min(100, confidence),
        profitEstimateUsd: Math.max(0, profitUsd),
        victimLossUsd,
        victimLossPct,
        tokensInvolved: [
          ...new Set([front.tokenIn, front.tokenOut, victim.tokenIn].filter(Boolean) as string[]),
        ],
        poolsInvolved: [front.contractAddress, back.contractAddress].filter(Boolean) as string[],
        ledgerSeq: front.ledgerSequence,
        timestamp: front.ledgerCloseTime,
        details: {
          frontPool: front.contractAddress,
          victimPool: victim.contractAddress,
          backPool: back.contractAddress,
        },
      });
    }
  }

  return results;
}

/**
 * Detect frontrun/backrun pairs (without a clear victim sandwich —
 * purely ordering-based extraction).
 */
export function detectFrontrunBackrunPairs(txs: LedgerTx[]): SandwichPattern[] {
  const swaps = txs.filter(isSwapTx);
  const results: SandwichPattern[] = [];

  // Look for pairs where the same account has two txs on the same contract
  // with a gap of 1–5 positions between them (victim sits in between)
  const byAttacker = new Map<string, LedgerTx[]>();
  for (const tx of swaps) {
    const list = byAttacker.get(tx.sourceAccount) ?? [];
    list.push(tx);
    byAttacker.set(tx.sourceAccount, list);
  }

  for (const [attacker, aTxs] of byAttacker) {
    for (let i = 0; i < aTxs.length - 1; i++) {
      const front = aTxs[i];
      const back = aTxs[i + 1];

      const gap = back.position - front.position;
      if (gap < 2 || gap > 15) continue;

      // Find at least one victim in between
      const victims = swaps.filter(
        (tx) =>
          tx.sourceAccount !== attacker &&
          tx.position > front.position &&
          tx.position < back.position,
      );
      if (victims.length === 0) continue;

      const victim = victims[0];
      const victimAmtUsd = estimateAmountUsd(victim.amountIn, victim.tokenIn);
      const profitUsd =
        estimateAmountUsd(back.amountOut, back.tokenOut) -
        estimateAmountUsd(front.amountIn, front.tokenIn);
      const victimLossUsd = victimAmtUsd * 0.004;
      const victimLossPct = victimAmtUsd > 0 ? (victimLossUsd / victimAmtUsd) * 100 : 0;

      const confidence = computeConfidence({
        sameAttacker: true,
        samePool: front.contractAddress === back.contractAddress,
        oppositeDirections: front.tokenIn !== back.tokenIn,
        positionGap: gap,
        profitRatio: victimAmtUsd > 0 ? profitUsd / victimAmtUsd : 0,
        txGap: gap,
      });

      if (confidence < 25) continue;

      results.push({
        type: 'frontrun_backrun',
        frontrunTx: front.hash,
        victimTx: victim.hash,
        backrunTx: back.hash,
        attacker,
        victim: victim.sourceAccount,
        protocol: front.contractAddress ?? '',
        confidence,
        profitEstimateUsd: Math.max(0, profitUsd),
        victimLossUsd,
        victimLossPct,
        tokensInvolved: [front.tokenIn, front.tokenOut].filter(Boolean) as string[],
        poolsInvolved: [front.contractAddress, back.contractAddress]
          .filter(Boolean)
          .filter((v, i, a) => a.indexOf(v) === i) as string[],
        ledgerSeq: front.ledgerSequence,
        timestamp: front.ledgerCloseTime,
        details: { victimCount: victims.length, positionGap: gap },
      });
    }
  }

  return results;
}

/**
 * Run all sandwich detectors on a ledger's transactions.
 * Deduplicates results so the same frontrun-victim-backrun triple
 * is not reported multiple times.
 */
export function detectAllSandwiches(txs: LedgerTx[]): SandwichPattern[] {
  const seen = new Set<string>();

  const all = [
    ...detectSimpleSandwiches(txs),
    ...detectMultiHopSandwiches(txs),
    ...detectCrossPoolSandwiches(txs),
    ...detectFrontrunBackrunPairs(txs),
  ];

  return all.filter((p) => {
    const key = `${p.frontrunTx}:${p.victimTx}:${p.backrunTx}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── MEV Landscape Analysis ────────────────────────────────────────────────────

/**
 * Aggregate MEV landscape statistics for a set of patterns.
 */
export function computeMevLandscape(patterns: SandwichPattern[]): MevLandscape {
  const byType: Record<string, { count: number; totalUsd: number }> = {};
  const attackerProfit = new Map<string, { profit: number; count: number }>();
  const protocolLoss = new Map<string, { loss: number; count: number }>();

  for (const p of patterns) {
    const t = p.type;
    if (!byType[t]) byType[t] = { count: 0, totalUsd: 0 };
    byType[t].count++;
    byType[t].totalUsd += p.profitEstimateUsd;

    const aPrev = attackerProfit.get(p.attacker) ?? { profit: 0, count: 0 };
    attackerProfit.set(p.attacker, {
      profit: aPrev.profit + p.profitEstimateUsd,
      count: aPrev.count + 1,
    });

    const pPrev = protocolLoss.get(p.protocol) ?? { loss: 0, count: 0 };
    protocolLoss.set(p.protocol, { loss: pPrev.loss + p.victimLossUsd, count: pPrev.count + 1 });
  }

  const totalExtractedUsd = patterns.reduce((s, p) => s + p.profitEstimateUsd, 0);

  const topAttackers = [...attackerProfit.entries()]
    .sort(([, a], [, b]) => b.profit - a.profit)
    .slice(0, 10)
    .map(([address, v]) => ({ address, totalProfitUsd: v.profit, attackCount: v.count }));

  const mostVictimizedProtocols = [...protocolLoss.entries()]
    .sort(([, a], [, b]) => b.loss - a.loss)
    .slice(0, 10)
    .map(([protocol, v]) => ({ protocol, totalLossUsd: v.loss, attackCount: v.count }));

  // Herfindahl-Hirschman Index for MEV concentration (0 = distributed, 1 = monopoly)
  let mevConcentration = 0;
  if (totalExtractedUsd > 0) {
    const shares = [...attackerProfit.values()].map((v) => v.profit / totalExtractedUsd);
    mevConcentration = shares.reduce((s, share) => s + share * share, 0);
  }

  return { totalExtractedUsd, byType, topAttackers, mostVictimizedProtocols, mevConcentration };
}

// ── Protocol Fairness Analysis ────────────────────────────────────────────────

/**
 * Compute a fairness score (0–100) for a protocol based on observed sandwich attacks.
 * 100 = perfectly fair (no attacks detected), 0 = severely attacked.
 */
export function computeFairnessScore(
  protocol: string,
  allTxs: LedgerTx[],
  patterns: SandwichPattern[],
  dexComparisons: Array<{ dex: string; patterns: SandwichPattern[]; txCount: number }> = [],
): FairnessScore {
  const protocolTxs = allTxs.filter((t) => t.contractAddress === protocol);
  const protocolPatterns = patterns.filter((p) => p.protocol === protocol);

  const txCount = protocolTxs.length || 1;
  const sandwichRate = (protocolPatterns.length / txCount) * 1000;

  const totalVolumeUsd = protocolTxs.reduce(
    (s, tx) => s + estimateAmountUsd(tx.amountIn, tx.tokenIn),
    0,
  );
  const totalLossUsd = protocolPatterns.reduce((s, p) => s + p.victimLossUsd, 0);
  const mevExtractedPct = totalVolumeUsd > 0 ? (totalLossUsd / totalVolumeUsd) * 100 : 0;

  // Unfair ordering: fraction of txs whose position differs from fee-ordered expectation
  // (approximated by looking at same-contract txs with high fees arriving late)
  const unfairOrderingRate = Math.min(1, sandwichRate / 100);

  // Fairness score components:
  // - sandwich rate penalty: -2 per attack per 1000 txs (capped at -60)
  // - MEV extracted penalty: -3 per % extracted (capped at -30)
  const sandwichPenalty = Math.min(60, sandwichRate * 2);
  const mevPenalty = Math.min(30, mevExtractedPct * 3);
  const fairnessScore = Math.max(0, 100 - sandwichPenalty - mevPenalty);

  const crossDexComparison = dexComparisons.map(
    ({ dex, patterns: dexPatterns, txCount: dexTxCount }) => {
      const dexSandwichRate = (dexPatterns.length / (dexTxCount || 1)) * 1000;
      const dexPenalty = Math.min(60, dexSandwichRate * 2);
      return { dex, fairnessScore: Math.max(0, 100 - dexPenalty) };
    },
  );

  return {
    protocol,
    fairnessScore,
    sandwichRate,
    unfairOrderingRate,
    mevExtractedPct,
    crossDexComparison,
  };
}

// ── Pre-transaction probability ──────────────────────────────────────────────

export interface SandwichRisk {
  probability: number; // 0–100
  recommendedSlippage: number; // bps
  recommendedDeadline: number; // seconds
  riskFactors: string[];
}

/**
 * Estimate sandwich risk for a pending transaction based on recent pattern history.
 */
export function estimateSandwichRisk(
  pendingAmount: number,
  protocol: string,
  recentPatterns: SandwichPattern[],
): SandwichRisk {
  const recentOnProtocol = recentPatterns.filter((p) => p.protocol === protocol);
  const recentAttackRate = recentOnProtocol.length;
  const avgProfit =
    recentOnProtocol.reduce((s, p) => s + p.profitEstimateUsd, 0) / (recentOnProtocol.length || 1);

  const riskFactors: string[] = [];
  let probability = 0;

  if (recentAttackRate > 5) {
    probability += 30;
    riskFactors.push('High recent sandwich activity on this protocol');
  } else if (recentAttackRate > 1) {
    probability += 15;
    riskFactors.push('Moderate recent sandwich activity on this protocol');
  }

  if (pendingAmount > avgProfit * 100) {
    probability += 20;
    riskFactors.push('Large transaction size increases sandwich profitability');
  }

  if (pendingAmount > 10000) {
    probability += 15;
    riskFactors.push('Transaction value above $10,000 threshold');
  }

  const recommendedSlippage = Math.max(50, Math.min(1000, 50 + probability * 5)); // bps
  const recommendedDeadline = probability > 50 ? 30 : 60; // seconds

  return {
    probability: Math.min(100, probability),
    recommendedSlippage,
    recommendedDeadline,
    riskFactors,
  };
}
