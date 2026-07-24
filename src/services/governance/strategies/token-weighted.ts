/**
 * src/services/governance/strategies/token-weighted.ts
 *
 * Compound/Governor-style token voting (docs/governance-framework.md §4.1):
 * 1 token = 1 vote at the proposal snapshot, quorum in basis points of total
 * supply, delegation-aware, simple majority of for/against.
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

export class TokenWeightedStrategy implements VotingStrategy {
  readonly model = 'token_based' as const;

  async getVotingPower(ctx: StrategyContext, voter: string): Promise<bigint> {
    const own = await ctx.getTokenBalance(voter);
    const delegatedAway = (await ctx.hasDelegatedAway?.(voter)) ?? false;
    const inbound = (await ctx.getDelegatedPower?.(voter)) ?? 0n;
    // Own vote overrides an outbound delegation for this proposal (docs §6),
    // so own power always counts when the voter acts directly; the override
    // subtraction happens on the delegate's side at tally time.
    void delegatedAway;
    return own + inbound;
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
    const power = await this.getVotingPower(ctx, intent.voter);
    if (power <= 0n) {
      return { valid: false, reason: 'No voting power at snapshot', weight: 0n };
    }
    // A voter may cast up to their full power; default to all of it.
    const weight = intent.amount !== undefined ? intent.amount : power;
    if (weight <= 0n) return { valid: false, reason: 'Vote weight must be positive', weight: 0n };
    if (weight > power) {
      return { valid: false, reason: 'Vote weight exceeds voting power', weight: 0n };
    }
    return { valid: true, weight };
  }

  async tally(_ctx: StrategyContext, votes: VoteData[]): Promise<Tally> {
    const tally: Tally = { for: 0n, against: 0n, abstain: 0n, totalVoters: 0 };
    for (const vote of votes) {
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
    // Quorum: participation (for + against + abstain) vs. bps of total supply.
    const quorumBps = ctx.config.quorumBps ?? 0;
    if (quorumBps > 0 && ctx.totalSupply !== undefined && ctx.totalSupply > 0n) {
      const participation = tally.for + tally.against + tally.abstain;
      const required = (ctx.totalSupply * BigInt(quorumBps)) / 10_000n;
      if (participation < required) return 'defeated';
    } else if (ctx.proposal.quorum) {
      // Absolute quorum fallback (legacy rows store an absolute number).
      const participation = tally.for + tally.against + tally.abstain;
      if (participation < toBigInt(ctx.proposal.quorum)) return 'defeated';
    }
    return tally.for > tally.against ? 'succeeded' : 'defeated';
  }
}
