/**
 * src/services/governance/strategies/quadratic.ts
 *
 * Quadratic voting (docs/governance-framework.md §4.2): each voter has a
 * voice-credit budget per round; casting N votes on a proposal costs N²
 * credits. Sybil dampeners: minimum token holding for any budget, and the
 * budget scales sub-linearly (never linearly) with balance so wallet
 * splitting is power-neutral at best. Optional reputation gate.
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

export const DEFAULT_VOICE_CREDITS = 100;

export class QuadraticStrategy implements VotingStrategy {
  readonly model = 'quadratic' as const;

  /** Credit budget for a holder: 0 below the Sybil floor, full budget above. */
  async creditBudget(ctx: StrategyContext, voter: string): Promise<number> {
    const minHolding = toBigInt(ctx.config.minTokenHolding, 0n);
    if (minHolding > 0n) {
      const balance = await ctx.getTokenBalance(voter);
      if (balance < minHolding) return 0;
    }
    if (ctx.config.minReputationScore != null && ctx.getReputationScore) {
      const score = await ctx.getReputationScore(voter);
      if (score < ctx.config.minReputationScore) return 0;
    }
    return ctx.config.voiceCreditsPerRound ?? DEFAULT_VOICE_CREDITS;
  }

  async getVotingPower(ctx: StrategyContext, voter: string): Promise<bigint> {
    // "Power" in QV terms = max votes castable with the remaining budget.
    const budget = await this.creditBudget(ctx, voter);
    const spent = (await ctx.getSpentVoiceCredits?.(voter)) ?? 0;
    const remaining = Math.max(0, budget - spent);
    return BigInt(Math.floor(Math.sqrt(remaining)));
  }

  async validateVote(ctx: StrategyContext, intent: VoteIntent): Promise<VoteValidation> {
    if (ctx.currentLedger < ctx.proposal.startBlock) {
      return { valid: false, reason: 'Voting has not started', weight: 0n };
    }
    if (ctx.proposal.endBlock > 0 && ctx.currentLedger > ctx.proposal.endBlock) {
      return { valid: false, reason: 'Voting period has ended', weight: 0n };
    }
    if (intent.support === 'confirm') {
      return { valid: false, reason: 'confirm is a multisig-only support value', weight: 0n };
    }
    const votes = intent.votes ?? 1;
    if (!Number.isInteger(votes) || votes <= 0) {
      return { valid: false, reason: 'votes must be a positive integer', weight: 0n };
    }
    const cost = votes * votes;
    const budget = await this.creditBudget(ctx, intent.voter);
    if (budget === 0) {
      return {
        valid: false,
        reason: 'Below minimum holding/reputation for voice credits',
        weight: 0n,
      };
    }
    const spent = (await ctx.getSpentVoiceCredits?.(intent.voter)) ?? 0;
    if (spent + cost > budget) {
      return {
        valid: false,
        reason: `Insufficient voice credits: need ${cost}, have ${budget - spent}`,
        weight: 0n,
      };
    }
    return { valid: true, weight: BigInt(votes), voiceCreditCost: cost };
  }

  async tally(_ctx: StrategyContext, votes: VoteData[]): Promise<Tally> {
    const tally: Tally = { for: 0n, against: 0n, abstain: 0n, totalVoters: 0 };
    for (const vote of votes) {
      // Weight = √credits = number of votes cast; stored on the row.
      const weight = toBigInt(vote.weight);
      if (weight <= 0n) continue;
      if (vote.support === 'for') tally.for += weight;
      else if (vote.support === 'against') tally.against += weight;
      else if (vote.support === 'abstain') tally.abstain += weight;
      else continue;
      tally.totalVoters += 1;
    }
    return tally;
  }

  outcome(ctx: StrategyContext, tally: Tally): Outcome {
    if (ctx.proposal.endBlock > 0 && ctx.currentLedger <= ctx.proposal.endBlock) {
      return 'pending';
    }
    // Quorum for QV counts voters, not weight: quorumBps of... supply makes no
    // sense here, so an absolute voter count may be stored on the proposal.
    if (ctx.proposal.quorum) {
      const required = Number(toBigInt(ctx.proposal.quorum));
      if (tally.totalVoters < required) return 'defeated';
    }
    return tally.for > tally.against ? 'succeeded' : 'defeated';
  }
}
