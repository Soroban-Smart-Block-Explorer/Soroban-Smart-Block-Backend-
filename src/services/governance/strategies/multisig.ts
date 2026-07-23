/**
 * src/services/governance/strategies/multisig.ts
 *
 * Gnosis Safe-style M-of-N multisig (docs/governance-framework.md §4.4).
 * "Votes" are confirmations by active signers; the proposal succeeds the
 * moment the threshold is met (no quorum, no voting window). Rejections by
 * (N − M + 1) signers make the threshold unreachable -> defeated.
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

export class MultisigStrategy implements VotingStrategy {
  readonly model = 'multisig' as const;

  private async signers(ctx: StrategyContext): Promise<string[]> {
    return (await ctx.getActiveSigners?.()) ?? [];
  }

  async getVotingPower(ctx: StrategyContext, voter: string): Promise<bigint> {
    const signers = await this.signers(ctx);
    return signers.includes(voter) ? 1n : 0n;
  }

  async validateVote(ctx: StrategyContext, intent: VoteIntent): Promise<VoteValidation> {
    const signers = await this.signers(ctx);
    if (!signers.includes(intent.voter)) {
      return { valid: false, reason: 'Not an active signer', weight: 0n };
    }
    if (intent.support === 'abstain') {
      return { valid: false, reason: 'Multisig votes are confirm or against', weight: 0n };
    }
    return { valid: true, weight: 1n };
  }

  async tally(_ctx: StrategyContext, votes: VoteData[]): Promise<Tally> {
    const tally: Tally = { for: 0n, against: 0n, abstain: 0n, totalVoters: 0 };
    const seen = new Set<string>();
    for (const vote of votes) {
      if (seen.has(vote.voter)) continue; // one confirmation per signer
      seen.add(vote.voter);
      if (vote.support === 'confirm' || vote.support === 'for') tally.for += 1n;
      else if (vote.support === 'against') tally.against += 1n;
      else continue;
      tally.totalVoters += 1;
    }
    return tally;
  }

  outcome(ctx: StrategyContext, tally: Tally): Outcome {
    const threshold = BigInt(ctx.config.multisigThreshold ?? 1);
    if (tally.for >= threshold) return 'succeeded';
    // Unreachability (defeated) needs the live signer count, which requires
    // an async lookup — use outcomeWithSignerCount for the full decision.
    return 'pending';
  }

  /**
   * Multisig outcome needs the live signer count to detect unreachability;
   * outcome() is sync per the interface, so the API layer should pass the
   * signer count via tally (abstain slot unused) or call this helper.
   */
  outcomeWithSignerCount(ctx: StrategyContext, tally: Tally, signerCount: number): Outcome {
    const threshold = BigInt(ctx.config.multisigThreshold ?? 1);
    if (tally.for >= threshold) return 'succeeded';
    const remaining = BigInt(signerCount) - tally.for - tally.against;
    if (tally.for + remaining < threshold) return 'defeated';
    return 'pending';
  }
}
