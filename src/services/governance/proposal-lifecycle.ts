/**
 * src/services/governance/proposal-lifecycle.ts
 *
 * Proposal state machine (docs/governance-framework.md §5).
 *
 * The canonical status set matches what the indexer and schedule.ts already
 * write as strings. Transitions are enforced through an explicit table;
 * anything not listed throws a typed error the API layer maps to 400.
 */
import type { ProposalStatus, VotingModel } from './types';

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: ProposalStatus,
    public readonly to: ProposalStatus,
  ) {
    super(`Invalid proposal transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

/** from -> allowed targets (shared FSM; see model-specific overrides below). */
const TRANSITIONS: Record<ProposalStatus, ProposalStatus[]> = {
  draft: ['pending', 'cancelled'],
  pending: ['active', 'cancelled'],
  active: ['queued', 'defeated', 'cancelled', 'expired', 'executed'],
  queued: ['executing', 'cancelled', 'expired'],
  executing: ['executed', 'failed'],
  executed: [],
  defeated: [],
  failed: [],
  cancelled: [],
  expired: [],
};

// Model quirks (docs §5):
//  - multisig proposals skip `pending` (immediately active once created)
//  - text proposals go active -> executed directly (nothing to queue/execute)
//  - conviction proposals have no endBlock defeat; they stay active until
//    conviction passes threshold (-> queued) or they are cancelled/expired.

export function canTransition(from: ProposalStatus, to: ProposalStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: ProposalStatus, to: ProposalStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export function terminalStatuses(): ProposalStatus[] {
  return Object.entries(TRANSITIONS)
    .filter(([, targets]) => targets.length === 0)
    .map(([status]) => status as ProposalStatus);
}

export function isTerminal(status: ProposalStatus): boolean {
  return (TRANSITIONS[status] ?? []).length === 0;
}

/**
 * Compute the effective status of a proposal from stored status + ledger
 * clock. Stored status is authoritative for terminal states; time-driven
 * transitions (pending->active, active->expired for conviction, queue
 * expiry) are derived so no cron is needed to keep rows fresh.
 */
export function deriveStatus(params: {
  stored: ProposalStatus;
  model: VotingModel;
  currentLedger: number;
  startBlock: number;
  endBlock: number;
  /** Grace period in ledgers a queued op stays executable (0 = forever). */
  queueExpiryLedger?: number;
}): ProposalStatus {
  const { stored, model, currentLedger, startBlock, endBlock, queueExpiryLedger } = params;
  if (isTerminal(stored)) return stored;

  if (stored === 'pending' && currentLedger >= startBlock) return 'active';

  if (stored === 'active' && model !== 'conviction' && model !== 'multisig') {
    // Voting window closed but outcome not yet applied: report as active —
    // the tally decides queued/defeated when applyOutcome runs. Only flag
    // expiry when the window closed long ago without resolution.
    if (endBlock > 0 && currentLedger > endBlock * 2) return 'expired';
  }

  if (stored === 'queued' && queueExpiryLedger && currentLedger > queueExpiryLedger) {
    return 'expired';
  }

  return stored;
}

/** Guardian cancellation is allowed any time before execution starts. */
export function canGuardianCancel(status: ProposalStatus): boolean {
  return status === 'pending' || status === 'active' || status === 'queued';
}
