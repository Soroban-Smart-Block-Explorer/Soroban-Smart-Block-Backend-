/**
 * MEV Prediction Engine — forward-looking, ranked opportunity signals.
 *
 * Extends the reactive MEV classifier (src/indexer/mev-classifier.ts) with a
 * predictive layer that scores the likelihood that a *contract or transaction
 * will become* an arbitrage, sandwich, or liquidation target. The engine is
 * deliberately:
 *
 *   - **Signature-based** (not a hosted model): each candidate is reduced to a
 *     normalized feature vector (deviation, liquidity, history, mempool
 *     pressure, notional, slippage, volatility, signature) and scored with
 *     static per-type weights.
 *   - **Deterministic**: scoring is a pure function of its inputs; identical
 *     inputs always yield identical scores/ids. This makes the engine safe to
 *     run in a sandbox and reproducible in tests.
 *   - **Read-only by default**: `generateMevPredictions` only reads indexed
 *     state. "Preview" callers can recompute signals without persisting
 *     pending transactions or broadcasting to WebSocket clients.
 *
 * Inputs combine:
 *   - pending transactions (in-memory buffer, fed by the API ingest endpoint)
 *   - recently indexed transactions
 *   - DEX state (pool prices, TWAPs, liquidity) and cross-DEX deviations
 *   - historical MEV events on the same contracts/pairs
 */

import { createHash } from 'crypto';
import { prismaRead } from '../db';

// ─── Public types ─────────────────────────────────────────────────────────────

export type MevSignalType = 'arbitrage' | 'sandwich' | 'liquidation';
export type MevSignalStage = 'pending' | 'recent';

export const MEV_SIGNAL_TYPES: MevSignalType[] = ['arbitrage', 'sandwich', 'liquidation'];

export interface PendingTransaction {
  hash: string;
  sourceAccount: string;
  contractAddress?: string | null;
  functionName?: string | null;
  functionArgs?: Record<string, unknown> | null;
  ledgerSequence?: number | null;
  submittedAt?: string | Date | null;
  /** Estimated transaction notional in USD (optional but materially improves scoring). */
  notionalUsd?: number | null;
  /** Slippage tolerance as a fraction (0.01 = 1%). */
  slippageTolerance?: number | null;
  /** True when the transaction is routed through a private mempool / protected submission. */
  usesPrivateMempool?: boolean | null;
}

export interface RecentTransaction {
  hash: string;
  sourceAccount: string;
  contractAddress?: string | null;
  functionName?: string | null;
  ledgerSequence?: number | null;
  ledgerCloseTime: string;
  status?: string | null;
}

export interface DexPoolState {
  poolId: string;
  contractAddress: string;
  dexName: string;
  pair: string;
  tokenA: string;
  tokenB: string;
  spotPrice: number;
  twap5m: number | null;
  liquidityUsd: number;
  volume24hUsd: number;
  updatedAt: string;
}

export interface DeviationInput {
  poolIdA: string;
  poolIdB: string;
  tokenA: string;
  tokenB: string;
  priceA: number;
  priceB: number;
  deviationPercentage: number;
  timestamp: string;
}

export interface MevHistoryEntry {
  mevType: string;
  protocolAddress?: string | null;
  tokenIn?: string | null;
  tokenOut?: string | null;
  confidence?: number | null;
  timestamp: string;
}

/** Normalized (0..1) feature vector describing a candidate opportunity. */
export interface SignalFeatures {
  /** Cross-DEX price dislocation or price/TWAP divergence. */
  deviation?: number;
  /** Depth of the pool/liquidity available to extract. */
  liquidity?: number;
  /** Historical confirmation: prior MEV activity on the same target. */
  history?: number;
  /** Competing/pending flow pressure on the same target. */
  mempool?: number;
  /** Victim notional relative to pool depth (sandwich). */
  notional?: number;
  /** How unprotected the flow is (high tolerance / public mempool = 1). */
  slippage?: number;
  /** Spot vs TWAP volatility. */
  volatility?: number;
  /** Explicit on-chain signature match (e.g. a `liquidate` call). */
  signature?: number;
}

export type FeatureKey = keyof SignalFeatures;

export interface MevPrediction {
  id: string;
  type: MevSignalType;
  stage: MevSignalStage;
  target: {
    txHash?: string;
    contractAddress?: string;
    poolId?: string;
    pair?: string;
  };
  /** Ranked score, 0-100. */
  score: number;
  /** Confidence, 0-1. */
  confidence: number;
  sensitivity: number;
  expectedProfitUsd: number;
  /** Estimated time-to-opportunity for the consumer to act. */
  leadTimeMs: number;
  rationale: string[];
  features: SignalFeatures;
  predictedAt: string;
}

export interface PredictInputs {
  pendingTransactions?: PendingTransaction[];
  recentTransactions?: RecentTransaction[];
  pools?: DexPoolState[];
  deviations?: DeviationInput[];
  history?: MevHistoryEntry[];
}

export interface PredictOptions {
  types?: MevSignalType[];
  /** Hard floor on score (0-100). Combined with the sensitivity-derived threshold. */
  minScore?: number;
  /** 0 = conservative (few, high-conviction), 1 = aggressive (more, weaker). */
  sensitivity?: number;
  limit?: number;
  lookbackMinutes?: number;
  stage?: MevSignalStage | 'all';
  now?: Date;
}

export interface MevPredictionResult {
  predictions: MevPrediction[];
  count: number;
  threshold: number;
  sensitivity: number;
  types: MevSignalType[];
  generatedAt: string;
  sources: {
    pendingTxCount: number;
    recentTxCount: number;
    poolCount: number;
    deviationCount: number;
    historyEventCount: number;
  };
}

// ─── Tunables ─────────────────────────────────────────────────────────────────

/** Deviation (%) at which the deviation feature saturates. */
const DEVIATION_SATURATION_PCT = 2;
/** Liquidity (USD) at which the liquidity feature saturates. */
const LIQUIDITY_SATURATION_USD = 1_000_000;
/** Prior MEV events at which the history feature saturates. */
const HISTORY_SATURATION = 10;
/** Concurrent pending flow at which the mempool feature saturates. */
const MEMPOOL_SATURATION = 5;
/** Pool impact (victim notional / pool liquidity) at which notional saturates. */
const IMPACT_SATURATION = 0.05;
/** Slippage tolerance (fraction) at which the slippage feature saturates. */
const SLIPPAGE_SATURATION = 0.05;
/** Cap on notional used for profit estimates. */
const CAPITAL_CAP_USD = 250_000;

const DEFAULT_SENSITIVITY = 0.5;
const DEFAULT_LIMIT = 25;
const DEFAULT_LOOKBACK_MINUTES = 15;
const MAX_PENDING_TRANSACTIONS = 500;
const PENDING_TTL_MS = 2 * 60 * 1000;

/** Per-type base weights — keyed by the features that matter for that signal. */
const TYPE_WEIGHTS: Record<MevSignalType, Partial<Record<FeatureKey, number>>> = {
  arbitrage: { deviation: 0.45, liquidity: 0.2, history: 0.2, mempool: 0.15 },
  sandwich: { notional: 0.4, mempool: 0.2, history: 0.2, slippage: 0.2 },
  liquidation: { deviation: 0.35, volatility: 0.25, history: 0.2, liquidity: 0.2 },
};

const SENSITIVITY_PRESETS: Record<string, number> = {
  conservative: 0.25,
  balanced: 0.5,
  aggressive: 0.8,
};

// ─── Small helpers ────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/** Coerce Prisma Decimal | string | number | null into a finite number. */
function num(value: unknown, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  const parsed = typeof value === 'number' ? value : Number(String(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeSensitivity(sensitivity?: number): number {
  if (sensitivity === undefined || sensitivity === null || Number.isNaN(sensitivity)) {
    return DEFAULT_SENSITIVITY;
  }
  return clamp01(sensitivity);
}

/**
 * Sensitivity adjusts both the pass threshold and the relative weight of
 * reactive features. Conservative settings demand historical confirmation and
 * deep liquidity; aggressive settings weight raw dislocation and mempool
 * pressure more heavily.
 */
function sensitivityWeights(sensitivity: number): Record<FeatureKey, number> {
  const s = clamp01(sensitivity);
  return {
    deviation: 0.6 + 0.5 * s,
    volatility: 0.6 + 0.5 * s,
    mempool: 0.5 + 0.6 * s,
    notional: 0.7 + 0.5 * s,
    slippage: 0.8 + 0.4 * s,
    liquidity: 1.2 - 0.5 * s,
    history: 1.2 - 0.5 * s,
    signature: 1,
  };
}

/** Score threshold (0-100) implied by a sensitivity setting. */
export function sensitivityThreshold(sensitivity?: number): number {
  return Math.round(80 - 52 * normalizeSensitivity(sensitivity));
}

/** Resolve named presets (conservative | balanced | aggressive) or a numeric value. */
export function resolveSensitivity(input?: number | string): number {
  if (typeof input === 'string') {
    const preset = SENSITIVITY_PRESETS[input.toLowerCase()];
    if (preset !== undefined) return preset;
    return normalizeSensitivity(Number(input));
  }
  return normalizeSensitivity(input);
}

export function getSensitivityPresets(): Record<string, number> {
  return { ...SENSITIVITY_PRESETS };
}

function isSwapLike(functionName?: string | null): boolean {
  if (!functionName) return false;
  const fn = functionName.toLowerCase();
  return fn.includes('swap') || fn.includes('trade') || fn.includes('exchange');
}

function isLiquidationLike(functionName?: string | null): boolean {
  if (!functionName) return false;
  const fn = functionName.toLowerCase();
  return fn.includes('liquidat') || fn.includes('seiz') || fn.includes('auction');
}

function pairKeyOf(tokenA?: string | null, tokenB?: string | null): string {
  const a = (tokenA ?? '').trim();
  const b = (tokenB ?? '').trim();
  return [a, b].sort().join('/');
}

function shortId(type: MevSignalType, targetKey: string): string {
  const digest = createHash('sha1').update(`${type}:${targetKey}`).digest('hex');
  return `mevpred_${digest.slice(0, 12)}`;
}

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

/**
 * Score a normalized feature vector for a given signal type.
 * Returns 0..1. Pure — safe to call from a sandbox with fabricated inputs.
 */
export function scoreSignalFeatures(
  type: MevSignalType,
  features: SignalFeatures,
  sensitivity?: number,
): number {
  const weights = TYPE_WEIGHTS[type];
  const mult = sensitivityWeights(normalizeSensitivity(sensitivity));

  let weighted = 0;
  let total = 0;
  for (const [key, weight] of Object.entries(weights) as [FeatureKey, number][]) {
    const value = clamp01(features[key] ?? 0);
    const effective = weight * (mult[key] ?? 1);
    weighted += value * effective;
    total += effective;
  }
  return total > 0 ? clamp01(weighted / total) : 0;
}

/** Fraction of the type's features that carry non-zero evidence. */
function evidenceCoverage(type: MevSignalType, features: SignalFeatures): number {
  const keys = Object.keys(TYPE_WEIGHTS[type]) as FeatureKey[];
  if (keys.length === 0) return 0;
  const present = keys.filter((k) => (features[k] ?? 0) > 0).length;
  return present / keys.length;
}

function confidenceFor(type: MevSignalType, features: SignalFeatures, score: number): number {
  return round(clamp01(0.35 + 0.5 * score + 0.15 * evidenceCoverage(type, features)), 3);
}

interface Candidate {
  type: MevSignalType;
  stage: MevSignalStage;
  target: MevPrediction['target'];
  targetKey: string;
  features: SignalFeatures;
  expectedProfitUsd: number;
  leadTimeMs: number;
  rationale: string[];
}

function toPrediction(candidate: Candidate, sensitivity: number, now: Date): MevPrediction {
  const score01 = scoreSignalFeatures(candidate.type, candidate.features, sensitivity);
  const score = Math.round(score01 * 100);
  return {
    id: shortId(candidate.type, candidate.targetKey),
    type: candidate.type,
    stage: candidate.stage,
    target: candidate.target,
    score,
    confidence: confidenceFor(candidate.type, candidate.features, score01),
    sensitivity: round(sensitivity, 3),
    expectedProfitUsd: round(candidate.expectedProfitUsd, 2),
    leadTimeMs: candidate.leadTimeMs,
    rationale: candidate.rationale,
    features: candidate.features,
    predictedAt: now.toISOString(),
  };
}

// ─── Candidate builders ───────────────────────────────────────────────────────

function buildArbitrageCandidates(
  deviations: DeviationInput[],
  pools: DexPoolState[],
  pending: PendingTransaction[],
  history: MevHistoryEntry[],
): Candidate[] {
  const poolById = new Map(pools.map((p) => [p.poolId, p]));
  const pendingByPair = new Map<string, number>();
  for (const tx of pending) {
    if (!isSwapLike(tx.functionName)) continue;
    const pool = tx.contractAddress ? findPoolByContract(pools, tx.contractAddress) : undefined;
    const key = pool ? pairKeyOf(pool.tokenA, pool.tokenB) : '';
    if (key) pendingByPair.set(key, (pendingByPair.get(key) ?? 0) + 1);
  }

  const candidates: Candidate[] = [];
  for (const dev of deviations) {
    const poolA = poolById.get(dev.poolIdA);
    const poolB = poolById.get(dev.poolIdB);
    // Only count liquidity we actually observed; missing pool state must not
    // be treated as unlimited depth.
    const observedLiquidity = [poolA, poolB].map((p) => p?.liquidityUsd ?? 0).filter((v) => v > 0);
    const liquidityUsd = observedLiquidity.length > 0 ? Math.min(...observedLiquidity) : 0;
    const pair = pairKeyOf(dev.tokenA, dev.tokenB);
    const devPct = Math.abs(num(dev.deviationPercentage));
    const pendingTouches = pendingByPair.get(pair) ?? 0;
    const historyCount = history.filter(
      (h) =>
        (h.mevType === 'cross_dex_arbitrage' || h.mevType === 'cex_dex_arbitrage') &&
        pairKeyOf(h.tokenIn, h.tokenOut) === pair,
    ).length;

    const deviation = clamp01(devPct / DEVIATION_SATURATION_PCT);
    const liquidity = clamp01(liquidityUsd / LIQUIDITY_SATURATION_USD);
    const historyFeature = clamp01(historyCount / HISTORY_SATURATION);
    const mempool = clamp01(pendingTouches / MEMPOOL_SATURATION);

    const tradeableLiquidity = Math.min(liquidityUsd, CAPITAL_CAP_USD);
    const expectedProfitUsd = (devPct / 100) * tradeableLiquidity * 0.5;

    candidates.push({
      type: 'arbitrage',
      stage: pendingTouches > 0 ? 'pending' : 'recent',
      target: {
        pair,
        poolId: poolA?.poolId ?? dev.poolIdA,
        contractAddress: poolA?.contractAddress || poolB?.contractAddress || undefined,
      },
      targetKey: `arbitrage:${poolA?.poolId ?? dev.poolIdA}:${poolB?.poolId ?? dev.poolIdB}:${dev.tokenA}:${dev.tokenB}`,
      features: {
        deviation,
        liquidity,
        history: historyFeature,
        mempool,
        volatility: averageSpotTwapDivergence([poolA, poolB]),
      },
      expectedProfitUsd,
      leadTimeMs: pendingTouches > 0 ? 3_000 : 12_000,
      rationale: [
        `Cross-DEX deviation ${devPct.toFixed(3)}% on ${pair}`,
        `Depth ~$${Math.round(tradeableLiquidity).toLocaleString('en-US')}`,
        `${historyCount} prior arbitrage event(s) on pair in lookback`,
        pendingTouches > 0
          ? `${pendingTouches} pending swap(s) touching pair`
          : 'No pending flow yet',
      ],
    });
  }
  return candidates;
}

function buildSandwichCandidates(
  pending: PendingTransaction[],
  recent: RecentTransaction[],
  pools: DexPoolState[],
  history: MevHistoryEntry[],
): Candidate[] {
  const candidates: Candidate[] = [];

  const pendingByPool = new Map<string, number>();
  for (const tx of pending) {
    if (!tx.contractAddress || !isSwapLike(tx.functionName)) continue;
    pendingByPool.set(tx.contractAddress, (pendingByPool.get(tx.contractAddress) ?? 0) + 1);
  }

  for (const tx of pending) {
    if (!isSwapLike(tx.functionName)) continue;
    const pool = tx.contractAddress ? findPoolByContract(pools, tx.contractAddress) : undefined;
    if (!pool) continue;

    const notional = num(tx.notionalUsd, 0);
    const impact = pool.liquidityUsd > 0 ? notional / pool.liquidityUsd : 0;
    const notionalFeature = clamp01(impact / IMPACT_SATURATION);
    const slippageFeature = resolveSlippageFeature(tx);
    const historyCount = countSandwichHistory(history, pool);
    const mempool = clamp01(
      (pendingByPool.get(tx.contractAddress ?? '') ?? 0) / MEMPOOL_SATURATION,
    );
    const expectedProfitUsd = notional * clamp01(impact) * 0.5;

    candidates.push({
      type: 'sandwich',
      stage: 'pending',
      target: {
        txHash: tx.hash,
        contractAddress: tx.contractAddress ?? undefined,
        pair: pool.pair,
      },
      targetKey: `sandwich:${tx.hash}`,
      features: {
        notional: notionalFeature,
        mempool,
        history: clamp01(historyCount / HISTORY_SATURATION),
        slippage: slippageFeature,
      },
      expectedProfitUsd,
      leadTimeMs: 2_500,
      rationale: [
        `Pending swap notional ~$${Math.round(notional).toLocaleString('en-US')} (${(impact * 100).toFixed(2)}% of pool)`,
        tx.usesPrivateMempool
          ? 'Protected submission (private mempool)'
          : 'Submitted to public mempool',
        `${historyCount} historical sandwich(es) on ${pool.dexName} pool`,
      ],
    });
  }

  // Recent large swaps on a shallow pool signal an active attacker pool.
  const recentByContract = new Map<string, number>();
  for (const tx of recent) {
    if (!tx.contractAddress || !isSwapLike(tx.functionName)) continue;
    recentByContract.set(tx.contractAddress, (recentByContract.get(tx.contractAddress) ?? 0) + 1);
  }
  for (const [contractAddress, swapCount] of recentByContract) {
    if (swapCount < 2) continue;
    const pool = findPoolByContract(pools, contractAddress);
    if (!pool) continue;

    const historyCount = countSandwichHistory(history, pool);
    const pendingHere = pendingByPool.get(contractAddress) ?? 0;
    candidates.push({
      type: 'sandwich',
      stage: 'recent',
      target: { contractAddress, poolId: pool.poolId, pair: pool.pair },
      targetKey: `sandwich:pool:${pool.poolId}`,
      features: {
        notional: clamp01(swapCount / (HISTORY_SATURATION - 2)),
        mempool: clamp01(pendingHere / MEMPOOL_SATURATION),
        history: clamp01(historyCount / HISTORY_SATURATION),
        slippage: 0.5,
      },
      expectedProfitUsd: pool.liquidityUsd * Math.min(swapCount, 10) * 0.0005,
      leadTimeMs: 15_000,
      rationale: [
        `${swapCount} recent swaps on ${pool.dexName} ${pool.pair}`,
        `${historyCount} historical sandwich(es) on pool`,
        pendingHere > 0 ? `${pendingHere} pending swap(s) queued` : 'No pending flow yet',
      ],
    });
  }

  return candidates;
}

function buildLiquidationCandidates(
  pending: PendingTransaction[],
  recent: RecentTransaction[],
  pools: DexPoolState[],
  history: MevHistoryEntry[],
): Candidate[] {
  const candidates: Candidate[] = [];

  const liquidationLike = [
    ...pending.map((tx) => ({ ...tx, stage: 'pending' as MevSignalStage })),
    ...recent.map((tx) => ({ ...tx, stage: 'recent' as MevSignalStage })),
  ].filter((tx) => isLiquidationLike(tx.functionName));

  for (const tx of liquidationLike) {
    const pool = tx.contractAddress ? findPoolByContract(pools, tx.contractAddress) : undefined;
    const notional = num(
      (tx as PendingTransaction).notionalUsd,
      pool ? pool.liquidityUsd * 0.1 : 0,
    );
    const historyCount = history.filter((h) => h.mevType === 'liquidation').length;
    const volatility = pool ? spotTwapDivergence(pool) : 0;

    candidates.push({
      type: 'liquidation',
      stage: tx.stage,
      target: {
        txHash: tx.hash,
        contractAddress: tx.contractAddress ?? undefined,
        pair: pool?.pair,
        poolId: pool?.poolId,
      },
      targetKey: `liquidation:tx:${tx.hash}`,
      features: {
        signature: 1,
        deviation: clamp01(volatility / 0.1),
        volatility: clamp01(volatility / 0.1),
        liquidity: clamp01(notional / LIQUIDITY_SATURATION_USD),
        history: clamp01(historyCount / HISTORY_SATURATION),
      },
      expectedProfitUsd: notional * 0.05,
      leadTimeMs: 5_000,
      rationale: [
        `Explicit liquidation signature in ${tx.functionName ?? 'transaction'}`,
        `Protocol notional ~$${Math.round(notional).toLocaleString('en-US')}`,
        `${historyCount} historical liquidation event(s)`,
      ],
    });
  }

  // Dislocated pools with thin depth are prime liquidation venues even
  // without an observed liquidation call.
  for (const pool of pools) {
    const volatility = spotTwapDivergence(pool);
    if (volatility < 0.02) continue;
    const historyCount = history.filter(
      (h) => h.mevType === 'liquidation' && h.protocolAddress === pool.contractAddress,
    ).length;
    candidates.push({
      type: 'liquidation',
      stage: 'recent',
      target: { contractAddress: pool.contractAddress, poolId: pool.poolId, pair: pool.pair },
      targetKey: `liquidation:pool:${pool.poolId}`,
      features: {
        deviation: clamp01(volatility / 0.1),
        volatility: clamp01(volatility / 0.1),
        liquidity: clamp01(pool.liquidityUsd / LIQUIDITY_SATURATION_USD),
        history: clamp01(historyCount / HISTORY_SATURATION),
      },
      expectedProfitUsd: pool.liquidityUsd * Math.min(volatility, 0.1) * 0.3,
      leadTimeMs: 20_000,
      rationale: [
        `Spot/TWAP divergence ${(volatility * 100).toFixed(2)}% on ${pool.dexName} ${pool.pair}`,
        `Pool depth ~$${Math.round(pool.liquidityUsd).toLocaleString('en-US')}`,
        `${historyCount} prior liquidation(s) on contract`,
      ],
    });
  }

  return candidates;
}

// ─── Prediction entrypoint (pure) ─────────────────────────────────────────────

/**
 * Rank MEV predictions from explicit inputs. Pure and deterministic — the
 * sandbox-safe entrypoint: no DB access, no writes, no broadcasts.
 */
export function predictFromInputs(
  inputs: PredictInputs,
  options: PredictOptions = {},
): MevPredictionResult {
  const sensitivity = normalizeSensitivity(options.sensitivity);
  const now = options.now ?? new Date();
  const types = (
    options.types && options.types.length > 0 ? options.types : MEV_SIGNAL_TYPES
  ).filter((t): t is MevSignalType => MEV_SIGNAL_TYPES.includes(t));
  const stage = options.stage ?? 'all';
  const lookbackMs = (options.lookbackMinutes ?? DEFAULT_LOOKBACK_MINUTES) * 60_000;
  const since = now.getTime() - lookbackMs;

  const pending = (inputs.pendingTransactions ?? []).filter(isWithinLookback(since));
  const recent = (inputs.recentTransactions ?? []).filter(
    (tx) => new Date(tx.ledgerCloseTime).getTime() >= since,
  );
  const history = (inputs.history ?? []).filter((h) => new Date(h.timestamp).getTime() >= since);
  const pools = inputs.pools ?? [];
  const deviations = (inputs.deviations ?? []).filter(
    (d) => new Date(d.timestamp).getTime() >= since,
  );

  const candidates: Candidate[] = [
    ...buildArbitrageCandidates(deviations, pools, pending, history),
    ...buildSandwichCandidates(pending, recent, pools, history),
    ...buildLiquidationCandidates(pending, recent, pools, history),
  ];

  const threshold = Math.max(sensitivityThreshold(sensitivity), options.minScore ?? 0);

  const predictions = candidates
    .filter((c) => types.includes(c.type))
    .filter((c) => stage === 'all' || c.stage === stage)
    .map((c) => toPrediction(c, sensitivity, now))
    .filter((p) => p.score >= threshold)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.confidence - a.confidence ||
        a.type.localeCompare(b.type) ||
        a.id.localeCompare(b.id),
    )
    .slice(0, options.limit ?? DEFAULT_LIMIT);

  return {
    predictions,
    count: predictions.length,
    threshold,
    sensitivity: round(sensitivity, 3),
    types,
    generatedAt: now.toISOString(),
    sources: {
      pendingTxCount: pending.length,
      recentTxCount: recent.length,
      poolCount: pools.length,
      deviationCount: deviations.length,
      historyEventCount: history.length,
    },
  };
}

// ─── Pending transaction buffer ───────────────────────────────────────────────

/** In-memory pending-tx buffer. Bounded and TTL-pruned; process-local. */
const pendingTransactions = new Map<string, PendingTransaction>();

/** Remove expired entries. Exported for tests. */
export function prunePendingTransactions(now: Date = new Date()): number {
  const cutoff = now.getTime() - PENDING_TTL_MS;
  let removed = 0;
  for (const [hash, tx] of pendingTransactions) {
    const submitted = tx.submittedAt ? new Date(tx.submittedAt).getTime() : now.getTime();
    if (submitted < cutoff) {
      pendingTransactions.delete(hash);
      removed++;
    }
  }
  return removed;
}

/** Add/replace a pending transaction, enforcing TTL and capacity. */
export function ingestPendingTransaction(
  input: PendingTransaction,
  now: Date = new Date(),
): PendingTransaction {
  prunePendingTransactions(now);
  const normalized: PendingTransaction = {
    ...input,
    submittedAt: input.submittedAt ?? now,
  };
  // Refresh insertion order for existing hash
  pendingTransactions.delete(normalized.hash);
  pendingTransactions.set(normalized.hash, normalized);

  while (pendingTransactions.size > MAX_PENDING_TRANSACTIONS) {
    const oldest = pendingTransactions.keys().next().value;
    if (oldest === undefined) break;
    pendingTransactions.delete(oldest);
  }
  return normalized;
}

export function listPendingTransactions(now: Date = new Date()): PendingTransaction[] {
  prunePendingTransactions(now);
  return [...pendingTransactions.values()];
}

export function clearPendingTransactions(): void {
  pendingTransactions.clear();
}

export function getPendingTransactionCount(): number {
  return pendingTransactions.size;
}

// ─── Prediction entrypoint (DB-backed) ────────────────────────────────────────

/** Fetch prediction inputs from indexed state, tolerating partial DB availability. */
export async function loadPredictionInputs(options: PredictOptions = {}): Promise<PredictInputs> {
  const now = options.now ?? new Date();
  const lookbackMs = (options.lookbackMinutes ?? DEFAULT_LOOKBACK_MINUTES) * 60_000;
  const since = new Date(now.getTime() - lookbackMs);
  const historySince = new Date(now.getTime() - Math.max(lookbackMs, 6 * 60 * 60 * 1000));

  const [recentTransactions, poolPrices, deviations, history] = await Promise.all([
    prismaRead.transaction
      .findMany({
        where: { ledgerCloseTime: { gte: since } },
        orderBy: { ledgerCloseTime: 'desc' },
        take: 200,
        select: {
          hash: true,
          sourceAccount: true,
          contractAddress: true,
          functionName: true,
          ledgerSequence: true,
          ledgerCloseTime: true,
          status: true,
        },
      })
      .catch(() => [] as Awaited<ReturnType<typeof prismaRead.transaction.findMany>>),
    prismaRead.poolPrice
      .findMany({
        orderBy: { timestamp: 'desc' },
        take: 400,
        include: { pool: true },
      })
      .catch(() => [] as Awaited<ReturnType<typeof prismaRead.poolPrice.findMany>>),
    prismaRead.priceDeviation
      .findMany({
        where: { timestamp: { gte: since } },
        orderBy: { deviationPercentage: 'desc' },
        take: 100,
      })
      .catch(() => [] as Awaited<ReturnType<typeof prismaRead.priceDeviation.findMany>>),
    prismaRead.mevEvent
      .findMany({
        where: { timestamp: { gte: historySince } },
        orderBy: { timestamp: 'desc' },
        take: 500,
        select: {
          mevType: true,
          protocolAddress: true,
          tokenIn: true,
          tokenOut: true,
          confidence: true,
          timestamp: true,
        },
      })
      .catch(() => [] as Awaited<ReturnType<typeof prismaRead.mevEvent.findMany>>),
  ]);

  return {
    pendingTransactions: listPendingTransactions(now),
    recentTransactions: recentTransactions as unknown as RecentTransaction[],
    pools: normalizePools(poolPrices as unknown as PoolPriceWithPool[]),
    deviations: (deviations as unknown[]).map((row) =>
      normalizeDeviation(row as Parameters<typeof normalizeDeviation>[0]),
    ),
    history: history as unknown as MevHistoryEntry[],
  };
}

/** Compute ranked MEV predictions from indexed state (read-only). */
export async function generateMevPredictions(
  options: PredictOptions = {},
): Promise<MevPredictionResult> {
  const inputs = await loadPredictionInputs(options);
  return predictFromInputs(inputs, options);
}

// ─── Normalization helpers ────────────────────────────────────────────────────

function isWithinLookback(since: number) {
  return (tx: PendingTransaction): boolean => {
    if (!tx.submittedAt) return true;
    return new Date(tx.submittedAt).getTime() >= since;
  };
}

function findPoolByContract(
  pools: DexPoolState[],
  contractAddress: string,
): DexPoolState | undefined {
  return pools.find((p) => p.contractAddress === contractAddress);
}

function spotTwapDivergence(pool: DexPoolState | undefined): number {
  if (!pool || !pool.twap5m || pool.spotPrice <= 0) return 0;
  return Math.abs(pool.spotPrice - pool.twap5m) / pool.spotPrice;
}

function averageSpotTwapDivergence(pools: (DexPoolState | undefined)[]): number {
  const values = pools.filter((p): p is DexPoolState => Boolean(p)).map(spotTwapDivergence);
  if (values.length === 0) return 0;
  return clamp01(values.reduce((a, b) => a + b, 0) / values.length / 0.1);
}

function resolveSlippageFeature(tx: PendingTransaction): number {
  if (tx.usesPrivateMempool) return 0;
  const argsTolerance = num((tx.functionArgs ?? {})['slippageTolerance'], NaN);
  const override = num(
    (tx.functionArgs ?? {})['slippage'] ?? (tx.functionArgs ?? {})['maxSlippage'],
    NaN,
  );
  const raw = num(tx.slippageTolerance, Number.isFinite(override) ? override : argsTolerance);
  if (!Number.isFinite(raw)) return 0.5; // unknown → neutral
  const fraction = raw > 1 ? raw / 100 : raw; // accept percent or fraction
  return clamp01(fraction / SLIPPAGE_SATURATION);
}

function countSandwichHistory(history: MevHistoryEntry[], pool: DexPoolState): number {
  const pair = pool.pair;
  return history.filter(
    (h) =>
      h.mevType === 'sandwich' &&
      (h.protocolAddress === pool.contractAddress || pairKeyOf(h.tokenIn, h.tokenOut) === pair),
  ).length;
}

interface PoolPriceWithPool {
  poolId: string;
  spotPrice?: number | null;
  twap5m?: number | null;
  timestamp: Date;
  pool?: {
    contractAddress?: string | null;
    dexName?: string | null;
    tokenA?: string | null;
    tokenB?: string | null;
    tokenASymbol?: string | null;
    tokenBSymbol?: string | null;
    tvlUsd?: number | null;
    totalLiquidity?: unknown;
    reserveA?: unknown;
    reserveB?: unknown;
    priceAUsd?: number | null;
    priceBUsd?: number | null;
    volume24hUsd?: number | null;
    volume24h?: unknown;
  } | null;
}

export function normalizePools(rows: PoolPriceWithPool[]): DexPoolState[] {
  const latest = new Map<string, PoolPriceWithPool>();
  for (const row of rows) {
    if (!latest.has(row.poolId)) latest.set(row.poolId, row);
  }

  const pools: DexPoolState[] = [];
  for (const row of latest.values()) {
    const pool = row.pool;
    if (!pool) continue;
    const reserveAUsd = num(pool.reserveA) * num(pool.priceAUsd);
    const reserveBUsd = num(pool.reserveB) * num(pool.priceBUsd);
    const derivedLiquidity = reserveAUsd + reserveBUsd;
    const liquidityUsd = num(pool.tvlUsd) || num(pool.totalLiquidity) || derivedLiquidity;
    const reserveA = num(pool.reserveA);
    const reserveB = num(pool.reserveB);
    const derivedSpot = reserveA > 0 ? reserveB / reserveA : 0;

    pools.push({
      poolId: row.poolId,
      contractAddress: pool.contractAddress ?? '',
      dexName: pool.dexName ?? 'unknown',
      pair: `${pool.tokenASymbol || pool.tokenA || 'A'}/${pool.tokenBSymbol || pool.tokenB || 'B'}`,
      tokenA: pool.tokenA ?? '',
      tokenB: pool.tokenB ?? '',
      spotPrice: num(row.spotPrice) || derivedSpot,
      twap5m: row.twap5m === null || row.twap5m === undefined ? null : num(row.twap5m),
      liquidityUsd,
      volume24hUsd: num(pool.volume24hUsd) || num(pool.volume24h),
      updatedAt: new Date(row.timestamp).toISOString(),
    });
  }
  return pools;
}

function normalizeDeviation(row: {
  poolIdA: string;
  poolIdB: string;
  tokenA: string;
  tokenB: string;
  priceA: unknown;
  priceB: unknown;
  deviationPercentage: unknown;
  timestamp: Date;
}): DeviationInput {
  return {
    poolIdA: row.poolIdA,
    poolIdB: row.poolIdB,
    tokenA: row.tokenA,
    tokenB: row.tokenB,
    priceA: num(row.priceA),
    priceB: num(row.priceB),
    deviationPercentage: num(row.deviationPercentage),
    timestamp: new Date(row.timestamp).toISOString(),
  };
}
