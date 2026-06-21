import { xdr, scValToNative } from '@stellar/stellar-sdk';
import { prismaWrite as prisma } from '../db';
import { fetchEvents, type LedgerEvent } from './rpc';

/**
 * #320: Yield Farming & Staking Optimizer
 *
 * Provides four core capabilities:
 *  1. Source detection — recognises yield events from LP farming, staking,
 *     lending, liquid staking and vault contracts.
 *  2. Yield calculation engine — APR/APY math tuned for DeFi.
 *  3. Portfolio optimizer — risk-aware allocation across opportunities.
 *  4. Risk scoring — composite 0-100 score (higher = riskier).
 */

// ---------------------------------------------------------------------------
// Constants and types
// ---------------------------------------------------------------------------

/** Recognised yield source categories. */
export type YieldType = 'lp_farming' | 'staking' | 'lending' | 'liquid_staking' | 'vault';

/** Symbol topics that mark the start of a yield-generating flow. */
const YIELD_OPPORTUNITY_TOPICS: Record<YieldType, ReadonlySet<string>> = {
  lp_farming: new Set([
    'add_liquidity',
    'remove_liquidity',
    'claim_fees',
    'claim_rewards',
    'mint_pool_token',
    'burn_pool_token',
  ]),
  staking: new Set(['stake', 'unstake', 'claim_staking_rewards', 'compound_stake']),
  lending: new Set(['deposit', 'withdraw', 'borrow', 'repay', 'claim_lending_rewards']),
  liquid_staking: new Set([
    'mint_lp_token',
    'redeem_lp_token',
    'rebase',
    'liquid_stake',
    'liquid_unstake',
  ]),
  vault: new Set(['vault_deposit', 'vault_withdraw', 'vault_harvest', 'auto_compound']),
};

export interface YieldOpportunityData {
  contractAddress: string;
  name?: string;
  type: YieldType;
  tokens: string[];
  baseApy: number;
  incentiveApy: number;
  tvl: string;
  lockupDays?: number;
  minDeposit?: string;
  depositFee?: number;
  withdrawFee?: number;
}

export interface Allocation {
  opportunityId: string;
  protocol: string;
  pool?: string;
  type: YieldType | string;
  allocationPct: number;
  apy: number;
  riskLabel: string;
}

export interface OptimizerResult {
  recommendations: Allocation[];
  expectedWeightedApy: number;
  riskScore: number;
}

export interface SimulationResult {
  deposit: string;
  periodDays: number;
  projectedEarnings: string;
  projectedApy: number;
  fees: string;
  netEarnings: string;
}

export type RiskTolerance = 'conservative' | 'moderate' | 'aggressive';

// ---------------------------------------------------------------------------
// Yield calculation engine
// ---------------------------------------------------------------------------

/** Simple APR: `(earnings / principal) * 365 / days * 100`. */
export function computeSimpleAPR(earnings: number, principal: number, days: number): number {
  if (!Number.isFinite(earnings) || !Number.isFinite(principal) || !Number.isFinite(days)) return 0;
  if (principal <= 0 || days <= 0) return 0;
  const dailyRate = earnings / principal / days;
  return dailyRate * 365 * 100;
}

/** Compound APY: `(1 + dailyRate)^365 - 1` expressed as a percentage. */
export function computeCompoundAPY(dailyRate: number): number {
  if (!Number.isFinite(dailyRate)) return 0;
  return (Math.pow(1 + dailyRate, 365) - 1) * 100;
}

/** Scheduled simple APY from an APR and compounding period (days). */
export function aprToApy(aprPct: number, compoundDays = 1): number {
  if (!Number.isFinite(aprPct) || compoundDays <= 0) return 0;
  const rate = aprPct / 100;
  const n = 365 / compoundDays;
  return (Math.pow(1 + rate / n, n) - 1) * 100;
}

/**
 * Impermanent loss for a 2-asset constant-product pool, given the price
 * ratio change `priceRatio = newPrice / oldPrice`. Returns a fraction in
 * `[0, 1]` representing the loss relative to simply holding.
 */
export function impermanentLoss(priceRatio: number): number {
  if (!Number.isFinite(priceRatio) || priceRatio <= 0) return 0;
  const r = priceRatio;
  return (2 * Math.sqrt(r)) / (1 + r) - 1;
}

/**
 * Estimate adjusted APY after applying impermanent loss for an LP position.
 * IL is treated as a drag on base APY (i.e. negative return contribution).
 */
export function adjustedLApy(baseApy: number, incentiveApy: number, priceRatio: number): number {
  const il = impermanentLoss(priceRatio); // negative
  return Math.max(0, baseApy + incentiveApy + il * 100);
}

// ---------------------------------------------------------------------------
// Source detection
// ---------------------------------------------------------------------------

/** Infer the yield type from a topic symbol and event payload. */
export function inferYieldType(
  topicSymbol: string | null,
  decoded: Record<string, unknown> | null,
): YieldType | null {
  if (!topicSymbol) return null;
  const sym = topicSymbol.toLowerCase();
  for (const [type, set] of Object.entries(YIELD_OPPORTUNITY_TOPICS)) {
    if (set.has(sym)) return type as YieldType;
  }

  // Heuristics from the decoded payload
  if (decoded && typeof decoded === 'object') {
    const d = decoded as Record<string, unknown>;
    const nested = d.data && typeof d.data === 'object' ? (d.data as Record<string, unknown>) : d;
    const poolKeys = ['pool', 'pair', 'lp_token', 'liquidity'];
    if (poolKeys.some((k) => k in nested)) return 'lp_farming';
    if ('stake_id' in nested || 'validator' in nested) return 'staking';
    if ('borrow_amount' in nested || 'collateral' in nested) return 'lending';
    if ('lst_token' in nested || sym.includes('rebase')) return 'liquid_staking';
    if ('vault_id' in nested || 'shares' in nested) return 'vault';
  }

  return null;
}

/**
 * Extract token symbols from an arbitrary decoded payload using common
 * heuristic field names. Returns up to the first 4 unique symbols.
 */
export function extractTokens(decoded: Record<string, unknown> | null): string[] {
  if (!decoded) return [];
  const d =
    (decoded as any).data && typeof (decoded as any).data === 'object'
      ? (decoded as any).data
      : decoded;

  const out = new Set<string>();
  const tokenKeys = ['tokens', 'assets', 'symbol', 'symbols', 'token_a', 'token_b'];

  for (const k of tokenKeys) {
    const v = (d as Record<string, unknown>)[k];
    if (typeof v === 'string' && v.length <= 16) {
      out.add(v.toUpperCase());
    } else if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === 'string' && item.length <= 16) out.add(item.toUpperCase());
      }
    }
  }

  return Array.from(out).slice(0, 4);
}

/**
 * Build the canonical stable ID for an opportunity (contract + type).
 * Used for upsert keying.
 */
export function buildOpportunityId(contractAddress: string, type: YieldType): string {
  return `${contractAddress.toLowerCase()}-${type}`;
}

/** Default human-friendly name if the contract does not provide one. */
export function defaultOpportunityName(
  contractAddress: string,
  type: YieldType,
  tokens: string[],
): string {
  const short = contractAddress.slice(0, 6).toUpperCase();
  if (tokens.length >= 2) return `${tokens.join('-')} ${type.replace('_', ' ')}`;
  if (tokens.length === 1) return `${tokens[0]} ${type.replace('_', ' ')}`;
  return `${short} ${type.replace('_', ' ')}`;
}

// ---------------------------------------------------------------------------
// Risk scoring
// ---------------------------------------------------------------------------

const RISK_LABELS = ['low', 'medium', 'high'] as const;
export type RiskLabel = (typeof RISK_LABELS)[number] | 'unknown';

/** Map a 0-100 risk score to a coarse label. */
export function riskLabelFor(score: number): RiskLabel {
  if (!Number.isFinite(score)) return 'unknown';
  if (score < 25) return 'low';
  if (score < 60) return 'medium';
  return 'high';
}

export interface RiskFactors {
  smartContractRisk: number; // 0-100
  impermanentLossRisk: number; // 0-100
  concentrationRisk: number; // 0-100
  incentiveRisk: number; // 0-100
  lockupRisk: number; // 0-100
}

/**
 * Compute a weighted composite risk score (0-100, higher = riskier).
 * Weights: smart contract 35, IL 25 (only counted for LP), incentive 20,
 * concentration 15, lockup 5.
 */
export function computeRiskScore(
  type: YieldType,
  factors: Partial<RiskFactors> & {
    smartContractRisk?: number;
    incentiveApy?: number;
    totalApy?: number;
    concentrationRisk?: number;
    lockupDays?: number;
  },
): number {
  const sc = clamp(factors.smartContractRisk ?? 25, 0, 100);
  const con = clamp(factors.concentrationRisk ?? 20, 0, 100);
  const incRaw = clamp(factors.incentiveApy ?? 0, 0, 100);
  // incentive risk: ratio of incentive APY to total APY (0-100)
  const total = Math.max(0.01, factors.totalApy ?? 0.01);
  const incShare = clamp((incRaw / total) * 100, 0, 100);
  const lock = clamp(((factors.lockupDays ?? 0) / 90) * 100, 0, 100);
  const il = type === 'lp_farming' ? clamp(factors.impermanentLossRisk ?? 20, 0, 100) : 0;

  const weighted = sc * 0.35 + il * 0.25 + incShare * 0.2 + con * 0.15 + lock * 0.05;

  return Math.round(weighted);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

// ---------------------------------------------------------------------------
// Portfolio optimizer
// ---------------------------------------------------------------------------

/**
 * Risk tolerance maximum allowable weighted risk score (0-100).
 * Conservative < 30, Moderate < 60, Aggressive allow any.
 */
const RISK_CEILINGS: Record<RiskTolerance, number> = {
  conservative: 30,
  moderate: 60,
  aggressive: 100,
};

/**
 * Greedy allocation across yield opportunities:
 *   1. Filter by minAPY / minTVL and risk ceiling for the tolerance.
 *   2. Sort candidates by `apy / (1 + riskScore)` — risk-adjusted yield.
 *   3. Allocate in rounded 10% buckets (down to remainder) to the top picks
 *      that include at least 3 distinct types (when possible).
 *
 * Returns up to 5 picks, with allocations summing to 100.
 */
export function optimizePortfolio(input: {
  amount: string;
  tokens?: string[];
  riskTolerance: RiskTolerance;
  minAPY?: number;
  minTVL?: number;
  opportunities: YieldOpportunityData[];
}): OptimizerResult {
  const tolerance = input.riskTolerance ?? 'moderate';
  const minAPY = Math.max(0, input.minAPY ?? 0);
  const minTVL = Math.max(0, input.minTVL ?? 0);
  const tokensFilter = (input.tokens ?? []).map((t) => t.toUpperCase());

  const riskCeiling = RISK_CEILINGS[tolerance];

  // Pre-filter candidates
  const candidates = input.opportunities
    .map((o) => normalizeOpportunity(o))
    .filter((o) => o.totalApy >= minAPY)
    .filter((o) => parseAmount(o.tvl) >= minTVL)
    .filter((o) => o.riskScore <= riskCeiling)
    .filter((o) => {
      if (tokensFilter.length === 0) return true;
      return tokensFilter.some((t) => o.tokens.includes(t));
    });

  if (candidates.length === 0) {
    return { recommendations: [], expectedWeightedApy: 0, riskScore: 0 };
  }

  // Risk-adjusted APY: penalise riskier options
  const scored = candidates
    .map((o) => ({
      o,
      score: o.totalApy / (1 + o.riskScore),
    }))
    .sort((a, b) => b.score - a.score);

  // Pick up to 5 picks, preferring type diversity
  const picks: typeof scored = [];
  const seenTypes = new Set<string>();
  for (const s of scored) {
    if (picks.length >= 5) break;
    if (picks.length < 3 || seenTypes.has(s.o.type)) {
      picks.push(s);
      seenTypes.add(s.o.type);
    }
  }

  // If we still have <3 picks and more candidates exist, fill them
  for (const s of scored) {
    if (picks.length >= 3) break;
    if (!picks.includes(s)) picks.push(s);
  }

  // Allocate in 10% buckets, then distribution of remainder.
  const allocations = pickAllocations(picks);

  const recommendations: Allocation[] = picks.map((s, idx) => ({
    opportunityId: s.o.id,
    protocol: s.o.contractAddress,
    pool: s.o.name,
    type: s.o.type,
    allocationPct: allocations[idx],
    apy: round2(s.o.totalApy),
    riskLabel: s.o.riskLabel,
  }));

  const expectedWeightedApy = round2(
    recommendations.reduce((sum, r) => sum + r.apy * (r.allocationPct / 100), 0),
  );
  const riskScore = Math.round(
    picks.reduce((sum, s, idx) => sum + s.o.riskScore * (allocations[idx] / 100), 0),
  );

  const result: OptimizerResult = {
    recommendations,
    expectedWeightedApy,
    riskScore,
  };
  // amount is accepted for traceability & future per-pick $ math
  void input.amount;
  return result;
}

/**
 * Decide allocation percentages (sum to 100). Higher-scored picks get larger
 * buckets, but never less than 10% each. Remainder (after 10/20/30/...) goes
 * to the highest-scored pick.
 */
function pickAllocations(picks: { score: number }[]): number[] {
  if (picks.length === 0) return [];
  const n = picks.length;
  const baseShare = Math.floor(100 / n / 10) * 10;
  const minShare = Math.max(10, baseShare);
  const totalMin = minShare * n;
  const remainder = 100 - totalMin;

  const allocations = picks.map(() => minShare);
  if (remainder > 0 && picks.length > 0) {
    // Distribute the remainder in 10% chunks to the top scorer(s)
    let extra = remainder;
    let i = 0;
    while (extra >= 10 && i < picks.length) {
      allocations[i] += 10;
      extra -= 10;
      i += 1;
    }
  }
  // Final clamp & renormalisation safety
  const sum = allocations.reduce((s, v) => s + v, 0);
  if (sum !== 100) {
    allocations[0] += 100 - sum;
  }
  return allocations;
}

function normalizeOpportunity(o: YieldOpportunityData): {
  id: string;
  contractAddress: string;
  name: string;
  type: YieldType;
  tokens: string[];
  baseApy: number;
  incentiveApy: number;
  totalApy: number;
  tvl: string;
  lockupDays: number;
  minDeposit: string;
  riskScore: number;
  riskLabel: RiskLabel;
} {
  const total = round2((o.baseApy ?? 0) + (o.incentiveApy ?? 0));
  const id = buildOpportunityId(o.contractAddress, o.type);
  const riskScore = computeRiskScore(o.type, {
    smartContractRisk: 20,
    incentiveApy: o.incentiveApy ?? 0,
    totalApy: total,
    lockupDays: o.lockupDays ?? 0,
    concentrationRisk: 15,
  });
  const tokens = Array.from(new Set(o.tokens.map((t) => t.toUpperCase())));
  return {
    id,
    contractAddress: o.contractAddress,
    name: o.name ?? defaultOpportunityName(o.contractAddress, o.type, tokens),
    type: o.type,
    tokens,
    baseApy: round2(o.baseApy ?? 0),
    incentiveApy: round2(o.incentiveApy ?? 0),
    totalApy: total,
    tvl: o.tvl ?? '0',
    lockupDays: o.lockupDays ?? 0,
    minDeposit: o.minDeposit ?? '0',
    riskScore,
    riskLabel: riskLabelFor(riskScore),
  };
}

function parseAmount(s: string | undefined): number {
  if (!s) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

/**
 * Estimate returns for a fixed deposit over a period at the given APY.
 * Accounts for fees (entry + claimed exit) and produces decimal-string outputs.
 *
 * APY is assumed to compound daily.
 */
export function simulateDeposit(
  deposit: string,
  periodDays: number,
  apyPct: number,
  feesPct = 0,
): SimulationResult {
  const principal = Math.max(0, Number(deposit) || 0);
  const days = Math.max(0, Math.floor(periodDays));
  const dailyRate = apyPct / 100 / 365;
  const balance = principal * Math.pow(1 + dailyRate, days);
  const gross = balance - principal;
  const fees = principal * (Math.max(0, feesPct) / 100);
  const net = Math.max(0, gross - fees);

  return {
    deposit: principal.toFixed(2),
    periodDays: days,
    projectedEarnings: roundStr(gross, 2),
    projectedApy: round2(apyPct),
    fees: roundStr(fees, 2),
    netEarnings: roundStr(net, 2),
  };
}

function roundStr(n: number, decimals: number): string {
  const m = Math.pow(10, decimals);
  return (Math.round(n * m) / m).toFixed(decimals);
}

// ---------------------------------------------------------------------------
// Process yield opportunity events
// ---------------------------------------------------------------------------

/**
 * Detect and upsert yield opportunities from contract events.
 * Called from eventIngestor after an event is stored.
 */
export async function processYieldOpportunityEvent(
  transactionHash: string,
  contractAddress: string,
  topicSymbol: string | null,
  decoded: Record<string, unknown> | null,
  ledgerSequence: number,
  ledgerCloseTime: Date,
): Promise<void> {
  const type = inferYieldType(topicSymbol, decoded);
  if (!type) return;

  const tokens = extractTokens(decoded);
  const id = buildOpportunityId(contractAddress, type);

  // Pull previous state to keep a moving average of totalApy
  const prev = await prisma.yieldOpportunity.findUnique({ where: { id } });

  // If the event payload carries no APY at all, skip the upsert rather than
  // synthesise a 5% default rate — fake APYs would pollute the registry.
  const basePresent = hasNumericField(decoded, ['base_apy', 'base_apy_pct', 'apy']);
  const incentivePresent = hasNumericField(decoded, [
    'incentive_apy',
    'reward_apy',
    'emission_apy',
  ]);
  if (!basePresent && !incentivePresent && !prev) {
    // Brand-new opportunity with no APY signal yet — wait for a richer event.
    return;
  }

  const base = basePresent
    ? readNumericField(decoded, ['base_apy', 'base_apy_pct', 'apy'], prev?.baseApy ?? 0)
    : (prev?.baseApy ?? 0);
  const incentive = incentivePresent
    ? readNumericField(
        decoded,
        ['incentive_apy', 'reward_apy', 'emission_apy'],
        prev?.incentiveApy ?? 0,
      )
    : (prev?.incentiveApy ?? 0);
  const total = round2(base + incentive);
  const tvl = readStringField(decoded, ['tvl', 'total_value_locked']) ?? prev?.tvl ?? '0';
  const lockup = readIntField(
    decoded,
    ['lockup_days', 'lockup', 'lock_period_days'],
    prev?.lockupDays ?? 0,
  );
  const minDeposit =
    readStringField(decoded, ['min_deposit', 'minimum_deposit']) ?? prev?.minDeposit ?? '0';
  const depositFee = readNumericField(decoded, ['deposit_fee', 'entry_fee'], prev?.depositFee ?? 0);
  const withdrawFee = readNumericField(
    decoded,
    ['withdraw_fee', 'exit_fee'],
    prev?.withdrawFee ?? 0,
  );
  const name =
    readStringField(decoded, ['name', 'pool_name']) ??
    defaultOpportunityName(contractAddress, type, tokens);

  const riskScore = computeRiskScore(type, {
    smartContractRisk: prev?.riskScore ? Math.min(prev.riskScore, 70) : 30,
    incentiveApy: incentive,
    totalApy: total,
    lockupDays: lockup,
  });

  await prisma.yieldOpportunity.upsert({
    where: { id },
    update: {
      name,
      tokens,
      baseApy: base,
      incentiveApy: incentive,
      totalApy: total,
      tvl,
      lockupDays: lockup,
      minDeposit,
      depositFee,
      withdrawFee,
      riskScore,
      riskLabel: riskLabelFor(riskScore),
      lastObservedAt: ledgerCloseTime,
    },
    create: {
      id,
      contractAddress,
      name,
      type,
      tokens,
      baseApy: base,
      incentiveApy: incentive,
      totalApy: total,
      tvl,
      lockupDays: lockup,
      minDeposit,
      depositFee,
      withdrawFee,
      riskScore,
      riskLabel: riskLabelFor(riskScore),
      lastObservedAt: ledgerCloseTime,
    },
  });

  // Daily history snapshot
  const snapshotDate = startOfUtcDay(ledgerCloseTime);
  const snapshotId = `${id}-${snapshotDate.toISOString().slice(0, 10)}`;
  await prisma.yieldHistorySnapshot.upsert({
    where: { id: snapshotId },
    update: {
      apy: total,
      baseApy: base,
      incentiveApy: incentive,
      tvl,
      ledgerSequence,
    },
    create: {
      id: snapshotId,
      opportunityId: id,
      snapshotDate,
      apy: total,
      baseApy: base,
      incentiveApy: incentive,
      tvl,
      ledgerSequence,
    },
  });

  void transactionHash;
}

function startOfUtcDay(d: Date): Date {
  const c = new Date(d);
  c.setUTCHours(0, 0, 0, 0);
  return c;
}

function readNumericField(
  obj: Record<string, unknown> | null,
  keys: string[],
  fallback: number,
): number {
  if (!obj) return fallback;
  const root = (obj as any).data && typeof (obj as any).data === 'object' ? (obj as any).data : obj;
  for (const k of keys) {
    const v = (root as Record<string, unknown>)[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v as number;
    if (typeof v === 'string') {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return fallback;
}

function hasNumericField(obj: Record<string, unknown> | null, keys: string[]): boolean {
  if (!obj) return false;
  const root = (obj as any).data && typeof (obj as any).data === 'object' ? (obj as any).data : obj;
  for (const k of keys) {
    const v = (root as Record<string, unknown>)[k];
    if (typeof v === 'number' && Number.isFinite(v)) return true;
    if (typeof v === 'string' && Number.isFinite(Number(v))) return true;
  }
  return false;
}

function readStringField(obj: Record<string, unknown> | null, keys: string[]): string | null {
  if (!obj) return null;
  const root = (obj as any).data && typeof (obj as any).data === 'object' ? (obj as any).data : obj;
  for (const k of keys) {
    const v = (root as Record<string, unknown>)[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

function readIntField(
  obj: Record<string, unknown> | null,
  keys: string[],
  fallback: number,
): number {
  if (!obj) return fallback;
  const root = (obj as any).data && typeof (obj as any).data === 'object' ? (obj as any).data : obj;
  for (const k of keys) {
    const v = (root as Record<string, unknown>)[k];
    if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v as number);
  }
  return fallback;
}

/**
 * Backfill yield opportunities by scanning a ledger range for matching events.
 */
export async function backfillYieldOpportunities(
  startLedger: number,
  endLedger: number,
): Promise<number> {
  const events = await fetchEvents(startLedger, endLedger);
  let stored = 0;

  for (const event of events) {
    if (!event.topics.length) continue;

    let topicSymbol: string | null = null;
    try {
      const scVal = xdr.ScVal.fromXDR(event.topics[0], 'base64');
      if (scVal.switch().name === 'scvSymbol') {
        topicSymbol = (scVal as any).sym()?.toString() ?? null;
      }
    } catch {
      continue;
    }

    let decoded: Record<string, unknown> | null = null;
    try {
      const sc = xdr.ScVal.fromXDR(event.data, 'base64');
      const native = scValToNative(sc);
      decoded =
        typeof native === 'object' && native !== null
          ? (native as Record<string, unknown>)
          : { value: String(native) };
    } catch {
      decoded = null;
    }

    const type = inferYieldType(topicSymbol, decoded);
    if (!type) continue;

    await processYieldOpportunityEvent(
      event.transactionHash,
      event.contractId,
      topicSymbol,
      decoded,
      event.ledgerSequence,
      event.ledgerCloseTime,
    );
    stored += 1;
  }
  return stored;
}
