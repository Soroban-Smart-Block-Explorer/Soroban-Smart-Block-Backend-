/**
 * src/services/governance/context.ts
 *
 * Prisma-backed StrategyContext factory: wires the pure strategy layer to
 * the database (docs/governance-framework.md §3). Token balances come from
 * indexed holder data with a zero fallback — the API layer can override
 * getTokenBalance with an RPC-backed lookup when live balances are needed.
 */
import type { PrismaClient } from '@prisma/client';
import type { GovernanceConfig, ProposalData, StrategyContext, VotingModel } from './types';
import { toBigInt } from './types';
import {
  buildGraph,
  hasDelegatedAway,
  resolveVotingPower,
  type DelegationEdge,
} from './delegation';

type PrismaReader = Pick<PrismaClient, '$queryRaw'> & {
  governanceContract: { findUnique: CallableFunction };
  governanceProposal: { findUnique: CallableFunction };
  governanceDelegation: { findMany: CallableFunction };
  governanceMultisigSigner: { findMany: CallableFunction };
  governanceVoiceCredit: { findUnique: CallableFunction };
  tokenBalance?: { findUnique: CallableFunction };
  ledger: { findFirst: CallableFunction };
};

export interface ContextOptions {
  /** Delegation category of the proposal (defaults to 'all'). */
  category?: string;
  /** Override for live SEP-41 balance lookups (e.g. RPC-backed). */
  getTokenBalance?: (holder: string) => Promise<bigint>;
  /** Total supply of the voting token (quorum denominator). */
  totalSupply?: bigint;
}

export class GovernanceNotFoundError extends Error {
  constructor(what: 'contract' | 'proposal', key: string) {
    super(`Governance ${what} not found: ${key}`);
    this.name = 'GovernanceNotFoundError';
  }
}

function toConfig(record: Record<string, unknown>): GovernanceConfig {
  return {
    contractAddress: record.contractAddress as string,
    governanceType: (record.governanceType as VotingModel) ?? 'token_based',
    votingToken: record.votingToken as string | null,
    quorumBps: record.quorumBps as number | null,
    votingPeriodLedgers: record.votingPeriodLedgers as number | null,
    proposalThreshold: record.proposalThreshold as string | null,
    timelockDelaySecs: record.timelockDelaySecs as number | null,
    guardian: record.guardian as string | null,
    categories: (record.categories as string[]) ?? [],
    voiceCreditsPerRound: record.voiceCreditsPerRound as number | null,
    minTokenHolding: record.minTokenHolding as string | null,
    minReputationScore: record.minReputationScore as number | null,
    convictionHalfLifeLedgers: record.convictionHalfLifeLedgers as number | null,
    convictionMaxRatioBps: record.convictionMaxRatioBps as number | null,
    multisigThreshold: record.multisigThreshold as number | null,
  };
}

function toProposalData(record: Record<string, unknown>): ProposalData {
  return {
    contractAddress: record.contractAddress as string,
    proposalId: record.proposalId as string,
    proposer: record.proposer as string,
    status: record.status as ProposalData['status'],
    template: (record.template as ProposalData['template']) ?? null,
    snapshotLedger: record.snapshotLedger as number | null,
    startBlock: record.startBlock as number,
    endBlock: record.endBlock as number,
    quorum: record.quorum as string | null,
  };
}

/**
 * Build a StrategyContext for (contractAddress, proposalId).
 * Delegation lookups are lazy and cached per context instance.
 */
export async function buildStrategyContext(
  prisma: PrismaReader,
  contractAddress: string,
  proposalId: string,
  options: ContextOptions = {},
): Promise<StrategyContext & { category: string }> {
  const contractRow = await prisma.governanceContract.findUnique({
    where: { contractAddress },
  });
  if (!contractRow) throw new GovernanceNotFoundError('contract', contractAddress);

  const proposalRow = await prisma.governanceProposal.findUnique({
    where: { contractAddress_proposalId: { contractAddress, proposalId } },
  });
  if (!proposalRow)
    throw new GovernanceNotFoundError('proposal', `${contractAddress}/${proposalId}`);

  const latestLedger = await prisma.ledger.findFirst({
    orderBy: { sequence: 'desc' },
    select: { sequence: true },
  });
  const currentLedger = latestLedger?.sequence ?? 0;
  const category = options.category ?? 'all';

  const getTokenBalance = options.getTokenBalance ?? (async (_holder: string) => 0n); // indexed-balance integration lands with the treasury phase

  // Lazy, cached delegation graph.
  let graphPromise: Promise<ReturnType<typeof buildGraph>> | null = null;
  function loadGraph(): Promise<ReturnType<typeof buildGraph>> {
    if (!graphPromise) {
      graphPromise = prisma.governanceDelegation
        .findMany({
          where: { contractAddress, revokedAt: null },
          select: { delegator: true, delegatee: true, category: true, revokedAt: true },
        })
        .then((edges: DelegationEdge[]) => buildGraph(edges)) as Promise<
        ReturnType<typeof buildGraph>
      >;
    }
    return graphPromise;
  }

  return {
    config: toConfig(contractRow as Record<string, unknown>),
    proposal: toProposalData(proposalRow as Record<string, unknown>),
    currentLedger,
    totalSupply: options.totalSupply,
    category,
    getTokenBalance,
    async getDelegatedPower(voter: string): Promise<bigint> {
      const graph = await loadGraph();
      const total = await resolveVotingPower({
        graph,
        wallet: voter,
        category,
        getOwnPower: getTokenBalance,
      });
      const own = hasDelegatedAway(graph, voter, category) ? 0n : await getTokenBalance(voter);
      return total - own;
    },
    async hasDelegatedAway(voter: string): Promise<boolean> {
      const graph = await loadGraph();
      return hasDelegatedAway(graph, voter, category);
    },
    async getActiveSigners(): Promise<string[]> {
      const rows = await prisma.governanceMultisigSigner.findMany({
        where: { contractAddress, removedAt: null },
        select: { signer: true },
      });
      return rows.map((r: { signer: string }) => r.signer);
    },
    async getSpentVoiceCredits(voter: string): Promise<number> {
      const round = Math.floor(toNumberSafe(proposalRow.startBlock));
      const credit = await prisma.governanceVoiceCredit.findUnique({
        where: { contractAddress_round_holder: { contractAddress, round, holder: voter } },
      });
      return credit?.spent ?? 0;
    },
  };
}

function toNumberSafe(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export { toBigInt };
