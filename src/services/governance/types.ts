/**
 * src/services/governance/types.ts
 *
 * Shared types for the governance framework (issue #567).
 * Design: docs/governance-framework.md §3.
 *
 * All on-chain amounts are bigint in memory and i128-safe integer strings at
 * rest (matching the indexer's addIntegerStrings arithmetic). Strategies are
 * pure: every external lookup (token balances, reputation, signer sets) is
 * injected through StrategyContext so the services are unit-testable without
 * a database or RPC connection.
 */

export type VotingModel = 'token_based' | 'quadratic' | 'conviction' | 'multisig';

export type ProposalStatus =
  | 'draft'
  | 'pending'
  | 'active'
  | 'queued'
  | 'executing'
  | 'executed'
  | 'defeated'
  | 'failed'
  | 'cancelled'
  | 'expired';

export type SupportValue = 'for' | 'against' | 'abstain' | 'confirm';

export type ProposalTemplate = 'parameter_change' | 'fund_transfer' | 'contract_upgrade' | 'text';

/** Subset of the GovernanceContract row a strategy needs. */
export interface GovernanceConfig {
  contractAddress: string;
  governanceType: VotingModel;
  votingToken?: string | null;
  quorumBps?: number | null;
  votingPeriodLedgers?: number | null;
  proposalThreshold?: string | null;
  timelockDelaySecs?: number | null;
  guardian?: string | null;
  categories?: string[];
  // quadratic
  voiceCreditsPerRound?: number | null;
  minTokenHolding?: string | null;
  minReputationScore?: number | null;
  // conviction
  convictionHalfLifeLedgers?: number | null;
  convictionMaxRatioBps?: number | null;
  // multisig
  multisigThreshold?: number | null;
}

/** Subset of the GovernanceProposal row a strategy needs. */
export interface ProposalData {
  contractAddress: string;
  proposalId: string;
  proposer: string;
  status: ProposalStatus;
  template?: ProposalTemplate | null;
  snapshotLedger?: number | null;
  startBlock: number;
  endBlock: number;
  quorum?: string | null;
  /** Conviction: fraction of the shared pool requested, in basis points. */
  requestedRatioBps?: number | null;
}

/** Subset of a GovernanceVote row used at tally time. */
export interface VoteData {
  voter: string;
  support: SupportValue | 'unknown';
  weight?: string | null;
  voiceCredits?: number | null;
  stakeAmount?: string | null;
  convictionAt?: string | null;
  lastUpdateLedger?: number | null;
}

/** A vote being cast, before validation. */
export interface VoteIntent {
  voter: string;
  support: SupportValue;
  /** Token-weighted / conviction: token amount (conviction: stake). */
  amount?: bigint;
  /** Quadratic: number of votes to cast (cost = votes²). */
  votes?: number;
  reason?: string;
}

export interface VoteValidation {
  valid: boolean;
  reason?: string;
  /** Weight the vote will carry if recorded. */
  weight: bigint;
  /** Quadratic: credits this vote consumes. */
  voiceCreditCost?: number;
}

export interface Tally {
  for: bigint;
  against: bigint;
  abstain: bigint;
  totalVoters: number;
  /** Conviction: total accrued conviction. Multisig: confirmation count (as bigint in `for`). */
  conviction?: bigint;
}

export type Outcome = 'succeeded' | 'defeated' | 'pending';

/** Injected data access — implemented against Prisma/RPC in the API layer. */
export interface StrategyContext {
  config: GovernanceConfig;
  proposal: ProposalData;
  /** Current ledger sequence (drives voting-window and conviction decay). */
  currentLedger: number;
  /** Total supply of the voting token at the snapshot (quorum denominator). */
  totalSupply?: bigint;
  /** SEP-41 balance of `holder` at the proposal snapshot. */
  getTokenBalance(holder: string): Promise<bigint>;
  /** Resolved inbound delegated power for `voter` (delegation.ts). */
  getDelegatedPower?(voter: string): Promise<bigint>;
  /** True when `voter` has delegated their own power away for this category. */
  hasDelegatedAway?(voter: string): Promise<boolean>;
  /** Reputation score 0..100 (src/reputation) for optional gates/blends. */
  getReputationScore?(voter: string): Promise<number>;
  /** Multisig: active signer set (removedAt IS NULL). */
  getActiveSigners?(): Promise<string[]>;
  /** Quadratic: credits already spent by `voter` this round. */
  getSpentVoiceCredits?(voter: string): Promise<number>;
}

export interface VotingStrategy {
  readonly model: VotingModel;
  /** Voting power for `voter` at the proposal's snapshot. */
  getVotingPower(ctx: StrategyContext, voter: string): Promise<bigint>;
  /** Validate (and price) a vote before it is recorded. */
  validateVote(ctx: StrategyContext, intent: VoteIntent): Promise<VoteValidation>;
  /** Fold recorded votes into a tally (conviction recomputes decay here). */
  tally(ctx: StrategyContext, votes: VoteData[]): Promise<Tally>;
  /** Decide the outcome from a tally. `pending` while voting is open. */
  outcome(ctx: StrategyContext, tally: Tally): Outcome;
}

/** Integer-string helpers shared with the indexer's storage convention. */
export function toBigInt(value: string | null | undefined, fallback = 0n): bigint {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    return BigInt(value);
  } catch {
    // Legacy rows may hold decimals (old Float columns) — truncate.
    const n = Number(value);
    return Number.isFinite(n) ? BigInt(Math.trunc(n)) : fallback;
  }
}

export function fromBigInt(value: bigint): string {
  return value.toString();
}
