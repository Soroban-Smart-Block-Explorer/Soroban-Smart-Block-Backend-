/**
 * Extension point for token staking (explicitly out of scope for v1 — see
 * requirements). Reputation/challenge logic call through this interface so a
 * real on-chain-stake implementation can be dropped in later without
 * touching challenge-scheduler.ts or reputation-scorer.ts.
 */
export interface StakeProvider {
  getStake(peerId: string): Promise<bigint>;
  slash(peerId: string, amount: bigint, reason: string): Promise<void>;
  isStakingEnabled(): boolean;
}

/** v1 default: staking is disabled, stake is always 0, slashing is a no-op that just logs. */
export class NullStakeProvider implements StakeProvider {
  async getStake(_peerId: string): Promise<bigint> {
    return 0n;
  }

  async slash(peerId: string, amount: bigint, reason: string): Promise<void> {
    // eslint-disable-next-line no-console
    console.log(
      `[p2p:stake] (no-op, staking disabled) would slash ${amount} from ${peerId}: ${reason}`,
    );
  }

  isStakingEnabled(): boolean {
    return false;
  }
}

export const defaultStakeProvider: StakeProvider = new NullStakeProvider();
