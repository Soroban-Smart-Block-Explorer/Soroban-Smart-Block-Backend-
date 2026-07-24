import { prismaWrite as prisma } from '../db';
import { LedgerEvent } from './rpc';

const GOVERNANCE_EVENT_TOPICS = new Set([
  'proposal_created',
  'proposal_created_event',
  'vote_cast',
  'vote_cast_event',
  'proposal_executed',
  'proposal_cancelled',
  'proposal_queued',
  'proposal_defeated',
  'delegate_changed',
  'delegated',
  'delegate_votes_changed',
  'proposal_succeeded',
  'proposal_failed',
]);

const PROPOSAL_STATUS_BY_TOPIC: Record<string, string> = {
  proposal_created: 'active',
  proposal_created_event: 'active',
  proposal_queued: 'queued',
  proposal_executed: 'executed',
  proposal_cancelled: 'cancelled',
  proposal_defeated: 'defeated',
  proposal_failed: 'defeated',
  proposal_succeeded: 'queued',
};

function normalizeString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return undefined;
}

function normalizeSupport(value: unknown): 'for' | 'against' | 'abstain' | 'unknown' {
  const raw =
    typeof value === 'string'
      ? value.toLowerCase()
      : typeof value === 'number'
        ? String(value)
        : undefined;
  if (!raw) return 'unknown';
  if (['for', 'yes', 'aye', '1', 'true', 'supported'].includes(raw)) return 'for';
  if (['against', 'no', 'nay', '0', 'false', 'opposed'].includes(raw)) return 'against';
  if (['abstain', 'abstention', '2', 'neutral'].includes(raw)) return 'abstain';
  return 'unknown';
}

function parseProposalId(decoded: Record<string, unknown>): string | undefined {
  return (
    normalizeString(decoded.proposalId) ??
    normalizeString(decoded.proposal_id) ??
    normalizeString(decoded.id) ??
    normalizeString(decoded.proposal) ??
    normalizeString(decoded.proposal_index)
  );
}

function parseProposalFields(decoded: Record<string, unknown>) {
  return {
    proposalId: parseProposalId(decoded),
    proposer:
      normalizeString(decoded.proposer) ??
      normalizeString(decoded.initiator) ??
      normalizeString(decoded.creator) ??
      'unknown',
    title: normalizeString(decoded.title) ?? normalizeString(decoded.name),
    description: normalizeString(decoded.description) ?? normalizeString(decoded.body),
    targets:
      decoded.targets ?? decoded.actions ?? decoded.targets_list ?? decoded.targets ?? undefined,
    startBlock:
      typeof decoded.startBlock === 'number'
        ? decoded.startBlock
        : typeof decoded.startBlock === 'string'
          ? Number(decoded.startBlock)
          : undefined,
    endBlock:
      typeof decoded.endBlock === 'number'
        ? decoded.endBlock
        : typeof decoded.endBlock === 'string'
          ? Number(decoded.endBlock)
          : undefined,
    quorum:
      normalizeString(decoded.quorum) ??
      normalizeString(decoded.quorumThreshold) ??
      normalizeString(decoded.quorum_required),
  };
}

function parseVoteFields(decoded: Record<string, unknown>) {
  return {
    proposalId: parseProposalId(decoded),
    voter:
      normalizeString(decoded.voter) ??
      normalizeString(decoded.voterAddress) ??
      normalizeString(decoded.caller) ??
      'unknown',
    support: normalizeSupport(
      decoded.support ?? decoded.supported ?? decoded.choice ?? decoded.side,
    ),
    weight:
      normalizeString(decoded.weight) ??
      normalizeString(decoded.votingPower) ??
      normalizeString(decoded.votes) ??
      '0',
    reason:
      normalizeString(decoded.reason) ??
      normalizeString(decoded.comment) ??
      normalizeString(decoded.note),
    delegatee:
      normalizeString(decoded.delegatee) ??
      normalizeString(decoded.delegate) ??
      normalizeString(decoded.delegate_address),
  };
}

function parseTargets(value: unknown) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string')
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  return value ? [value] : undefined;
}

function addIntegerStrings(a: string, b: string): string {
  try {
    return String(BigInt(a) + BigInt(b));
  } catch {
    const aFloat = Number(a);
    const bFloat = Number(b);
    if (Number.isFinite(aFloat) && Number.isFinite(bFloat)) {
      return String(aFloat + bFloat);
    }
    return a;
  }
}

function subtractIntegerStrings(a: string, b: string): string {
  try {
    return String(BigInt(a) - BigInt(b));
  } catch {
    const aFloat = Number(a);
    const bFloat = Number(b);
    if (Number.isFinite(aFloat) && Number.isFinite(bFloat)) {
      return String(aFloat - bFloat);
    }
    return a;
  }
}

function normalizeEventSymbol(
  eventType: string | null,
  topicSymbol: string | null,
  decoded: Record<string, unknown>,
) {
  const symbol =
    normalizeString(topicSymbol) ?? normalizeString(decoded.event) ?? normalizeString(eventType);
  return symbol ? symbol.toLowerCase() : undefined;
}

function isGovernanceEvent(
  eventType: string | null,
  topicSymbol: string | null,
  decoded: Record<string, unknown>,
) {
  const symbol = normalizeEventSymbol(eventType, topicSymbol, decoded);
  return (
    !!symbol &&
    (GOVERNANCE_EVENT_TOPICS.has(symbol) ||
      symbol.includes('proposal') ||
      symbol.includes('vote') ||
      symbol.includes('delegate'))
  );
}

export async function processGovernanceEvent(
  event: LedgerEvent,
  eventType: string | null,
  topicSymbol: string | null,
  decoded: Record<string, unknown>,
  transactionHash: string,
  sourceAccount: string,
): Promise<void> {
  if (!isGovernanceEvent(eventType, topicSymbol, decoded)) {
    return;
  }

  const contractAddress = event.contractId;
  await prisma.governanceContract.upsert({
    where: { contractAddress },
    update: { updatedAt: new Date() },
    create: { contractAddress, governanceType: 'token_based' },
  });

  const symbol = normalizeEventSymbol(eventType, topicSymbol, decoded) ?? 'proposal';
  const proposalFields = parseProposalFields(decoded);

  if (proposalFields.proposalId) {
    const status = PROPOSAL_STATUS_BY_TOPIC[symbol] ?? 'active';
    const targets = proposalFields.targets ? parseTargets(proposalFields.targets) : undefined;

    const updateData: Record<string, unknown> = {
      proposer: proposalFields.proposer,
      title: proposalFields.title,
      description: proposalFields.description,
      quorum: proposalFields.quorum ?? undefined,
      status,
      executedAt: symbol === 'proposal_executed' ? new Date() : undefined,
      executionTxHash: symbol === 'proposal_executed' ? transactionHash : undefined,
    };
    if (targets !== undefined) updateData.targets = targets as object;
    if (proposalFields.startBlock !== undefined) updateData.startBlock = proposalFields.startBlock;
    if (proposalFields.endBlock !== undefined) updateData.endBlock = proposalFields.endBlock;

    await prisma.governanceProposal.upsert({
      where: {
        contractAddress_proposalId: { contractAddress, proposalId: proposalFields.proposalId },
      },
      update: updateData,
      create: {
        contractAddress,
        proposalId: proposalFields.proposalId,
        proposer: proposalFields.proposer,
        title: proposalFields.title ?? `Proposal ${proposalFields.proposalId}`,
        description: proposalFields.description,
        targets: (targets as object) ?? [],
        startBlock: proposalFields.startBlock ?? 0,
        endBlock: proposalFields.endBlock ?? 0,
        quorum: proposalFields.quorum ?? undefined,
        status,
        executedAt: symbol === 'proposal_executed' ? new Date() : undefined,
        executionTxHash: symbol === 'proposal_executed' ? transactionHash : undefined,
      },
    });
  }

  if (symbol === 'vote_cast' || symbol === 'vote_cast_event' || symbol.includes('vote')) {
    const voteFields = parseVoteFields(decoded);
    if (!voteFields.proposalId || !voteFields.voter) return;

    const proposalId = voteFields.proposalId;
    const support = voteFields.support;
    const weight = voteFields.weight ?? '0';

    const existingVote = await prisma.governanceVote.findUnique({
      where: {
        contractAddress_proposalId_voter: {
          contractAddress,
          proposalId,
          voter: voteFields.voter,
        },
      },
    });

    const voteColumn =
      support === 'against' ? 'votesAgainst' : support === 'abstain' ? 'votesAbstain' : 'votesFor';

    if (!existingVote) {
      await prisma.governanceVote.create({
        data: {
          contractAddress,
          proposalId,
          voter: voteFields.voter,
          weight,
          support,
          reason: voteFields.reason,
          transactionHash,
          ledgerSequence: event.ledgerSequence,
        },
      });

      const proposal = await prisma.governanceProposal.upsert({
        where: { contractAddress_proposalId: { contractAddress, proposalId } },
        update: {},
        create: {
          contractAddress,
          proposalId,
          proposer: voteFields.voter,
          title: `Proposal ${proposalId}`,
          targets: [],
          startBlock: event.ledgerSequence,
          endBlock: event.ledgerSequence,
          status: 'active',
        },
      });

      const voteTotals = {
        votesFor: proposal.votesFor,
        votesAgainst: proposal.votesAgainst,
        votesAbstain: proposal.votesAbstain,
      };
      const newValue = addIntegerStrings(
        voteTotals[voteColumn as keyof typeof voteTotals] ?? '0',
        weight,
      );
      await prisma.governanceProposal.update({
        where: { contractAddress_proposalId: { contractAddress, proposalId } },
        data: { [voteColumn]: newValue },
      });
    } else if (existingVote.support !== support || existingVote.weight !== weight) {
      const proposal = await prisma.governanceProposal.findUnique({
        where: { contractAddress_proposalId: { contractAddress, proposalId } },
        select: { votesFor: true, votesAgainst: true, votesAbstain: true },
      });
      if (!proposal) return;

      const oldColumn =
        existingVote.support === 'against'
          ? 'votesAgainst'
          : existingVote.support === 'abstain'
            ? 'votesAbstain'
            : 'votesFor';
      const oldValue = subtractIntegerStrings(
        proposal[oldColumn as keyof typeof proposal] ?? '0',
        existingVote.weight ?? '0',
      );
      const newValue = addIntegerStrings(
        proposal[voteColumn as keyof typeof proposal] ?? '0',
        weight,
      );

      const updatePayload: Record<string, string> = {
        [oldColumn]: oldValue,
        [voteColumn]: newValue,
      };

      await prisma.governanceVote.update({
        where: {
          contractAddress_proposalId_voter: {
            contractAddress,
            proposalId,
            voter: voteFields.voter,
          },
        },
        data: {
          weight,
          support,
          reason: voteFields.reason,
          transactionHash,
          ledgerSequence: event.ledgerSequence,
        },
      });
      await prisma.governanceProposal.update({
        where: { contractAddress_proposalId: { contractAddress, proposalId } },
        data: updatePayload,
      });
    }
  }

  if (symbol.includes('delegate')) {
    const voteFields = parseVoteFields(decoded);
    if (!voteFields.delegatee) return;

    await prisma.governanceDelegate.upsert({
      where: { contractAddress_delegatee: { contractAddress, delegatee: voteFields.delegatee } },
      update: {
        delegatedVotes: addIntegerStrings(
          '0',
          normalizeString(decoded.delegatedVotes) ?? weightFromEvent(decoded) ?? '0',
        ),
        delegators: { increment: 1 },
        updatedAt: new Date(),
      },
      create: {
        contractAddress,
        delegatee: voteFields.delegatee,
        delegatedVotes: normalizeString(decoded.delegatedVotes) ?? weightFromEvent(decoded) ?? '0',
        delegators: 1,
        proposalsVoted: 0,
      },
    });
  }
}

function weightFromEvent(decoded: Record<string, unknown>): string | undefined {
  return (
    normalizeString(decoded.weight) ??
    normalizeString(decoded.votingPower) ??
    normalizeString(decoded.delegatedVotes) ??
    normalizeString(decoded.votes)
  );
}
