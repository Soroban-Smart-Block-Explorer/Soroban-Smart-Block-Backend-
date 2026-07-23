/**
 * src/services/governance/strategies/conviction.ts
 *
 * Conviction voting (1Hive-style; docs/governance-framework.md §4.3).
 *
 * Voters stake tokens on a proposal; conviction accrues toward the staked
 * amount with an exponential moving average parameterised by a half-life:
 *
 *   conviction(t+Δ) = conviction(t) · decay^Δ + stake · (1 − decay^Δ)
 *   where decay^halfLife = 1/2  ⇒  decay^Δ = 2^(−Δ/halfLife)
 *
 * Conviction is stored per vote as (convictionAt, lastUpdateLedger) and
 * recomputed lazily with the closed form — no cron. A proposal passes when
 * total conviction crosses a threshold that scales with the fraction of the
 * shared pool requested (bigger asks need more conviction).
 */
import type {
  StrategyContext,
  Tally,
  VoteData,
  VoteIntent,
  VoteValidation,
  VotingStrategy,
  Outcome,
} from '../types';
import { toBigInt } from '../types';

export const DEFAULT_HALF_LIFE_LEDGERS = 43_200; // ≈3 days at 6s ledgers

/** Fixed-point scale for the decay factor. */
const SCALE = 1_000_000_000n;

/** decay^Δ = 2^(−Δ/halfLife), in fixed point (0..SCALE). */
export function decayFactor(deltaLedgers: number, halfLifeLedgers: number): bigint {
  if (deltaLedgers <= 0) return SCALE;
  if (halfLifeLedgers <= 0) return 0n;
  const factor = Math.pow(2, -deltaLedgers / halfLifeLedgers);
  return BigInt(Math.round(factor * Number(SCALE)));
}

/** Closed-form conviction update from a stored checkpoint to `currentLedger`. */
export function convictionNow(params: {
  storedConviction: bigint;
  stake: bigint;
  lastUpdateLedger: number;
  currentLedger: number;
  halfLifeLedgers: number;
}): bigint {
  const { storedConviction, stake, lastUpdateLedger, currentLedger, halfLifeLedgers } = params;
  const delta = currentLedger - lastUpdateLedger;
  const decay = decayFactor(delta, halfLifeLedgers);
  return (storedConviction * decay + stake * (SCALE - decay)) / SCALE;
}

/**
 * Passing threshold: proportional to requested pool share. With no request
 * ratio configured, the threshold is a flat convictionMaxRatioBps-independent
 * fraction of total supply (defaults to 10%). Shape follows 1Hive's insight
 * (threshold grows superlinearly near the max ratio) simplified to:
 *
 *   threshold = totalSupply · ratioBps / (maxRatioBps − ratioBps) · 1/10000
 *
 * capped at totalSupply when ratio approaches the max.
 */
export function convictionThreshold(params: {
  totalSupply: bigint;
  requestedRatioBps: number;
  maxRatioBps: number;
}): bigint {
  const { totalSupply, requestedRatioBps, maxRatioBps } = params;
  if (requestedRatioBps <= 0) return totalSupply / 10n; // text/no-ask default: 10%
  if (requestedRatioBps >= maxRatioBps) return totalSupply; // effectively unpassable
  const numerator = totalSupply * BigInt(requestedRatioBps);
  const denominator = BigInt(maxRatioBps - requestedRatioBps) * 10_000n;
  const threshold = numerator / denominator;
  return threshold > totalSupply ? totalSupply : threshold;
}

export class ConvictionStrategy implements VotingStrategy {
  readonly model = 'conviction' as const;

  async getVotingPower(ctx: StrategyContext, voter: string): Promise<bigint> {
    // Power = stakeable balance at present (conviction has no snapshot).
    return ctx.getTokenBalance(voter);
  }

  async validateVote(ctx: StrategyContext, intent: VoteIntent): Promise<VoteValidation> {
    if (
      intent.support === 'against' ||
      intent.support === 'abstain' ||
      intent.support === 'confirm'
    ) {
      // Conviction voting has no negative votes: you support by staking,
      // contest by staking elsewhere or letting conviction decay (docs §4.3).
      return {
        valid: false,
        reason: 'Conviction voting only accepts stakes in support',
        weight: 0n,
      };
    }
    const stake = intent.amount ?? 0n;
    if (stake <= 0n) return { valid: false, reason: 'Stake must be positive', weight: 0n };
    const balance = await ctx.getTokenBalance(intent.voter);
    if (stake > balance) {
      return { valid: false, reason: 'Stake exceeds token balance', weight: 0n };
    }
    return { valid: true, weight: stake };
  }

  async tally(ctx: StrategyContext, votes: VoteData[]): Promise<Tally> {
    const halfLife = ctx.config.convictionHalfLifeLedgers ?? DEFAULT_HALF_LIFE_LEDGERS;
    let conviction = 0n;
    let stakeTotal = 0n;
    let voters = 0;
    for (const vote of votes) {
      const stake = toBigInt(vote.stakeAmount);
      if (stake <= 0n) continue;
      conviction += convictionNow({
        storedConviction: toBigInt(vote.convictionAt),
        stake,
        lastUpdateLedger: vote.lastUpdateLedger ?? ctx.currentLedger,
        currentLedger: ctx.currentLedger,
        halfLifeLedgers: halfLife,
      });
      stakeTotal += stake;
      voters += 1;
    }
    return { for: stakeTotal, against: 0n, abstain: 0n, totalVoters: voters, conviction };
  }

  outcome(ctx: StrategyContext, tally: Tally): Outcome {
    if (ctx.totalSupply === undefined || ctx.totalSupply <= 0n) return 'pending';
    const threshold = convictionThreshold({
      totalSupply: ctx.totalSupply,
      requestedRatioBps: ctx.proposal.requestedRatioBps ?? 0,
      maxRatioBps: ctx.config.convictionMaxRatioBps ?? 10_000,
    });
    // Conviction proposals are never "defeated" by time — they pass when
    // conviction crosses the threshold, otherwise remain pending (docs §5).
    return (tally.conviction ?? 0n) >= threshold ? 'succeeded' : 'pending';
  }
}
