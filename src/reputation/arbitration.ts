import { ArbitrationCase, ArbitrationResult, ArbitrationVote } from './types';
import { deterministicHash } from './score';

export function createArbitrationCase(
  input: Omit<ArbitrationCase, 'id' | 'status' | 'createdAt'>,
): ArbitrationCase {
  const id = deterministicHash({
    challenger: input.challenger,
    respondent: input.respondent,
    challenge: input.challenge,
    evidenceHash: input.evidenceHash,
    quorumVotes: input.quorumVotes,
  }).slice(0, 16);
  return {
    ...input,
    id,
    status: 'open',
    createdAt: new Date(0).toISOString(),
  };
}

export function castArbitrationVote(
  caseId: string,
  voter: string,
  vote: ArbitrationVote['vote'],
  weight: number,
  signature?: string,
  transactionHash?: string,
): ArbitrationVote {
  return { caseId, voter, vote, weight: Math.max(0, weight), signature, transactionHash };
}

export function resolveArbitrationCase(
  arbitrationCase: ArbitrationCase,
  votes: ArbitrationVote[],
): ArbitrationResult {
  const caseVotes = votes.filter((vote) => vote.caseId === arbitrationCase.id);
  const votesFor = caseVotes
    .filter((vote) => vote.vote === 'uphold')
    .reduce((total, vote) => total + vote.weight, 0);
  const votesAgainst = caseVotes
    .filter((vote) => vote.vote === 'reject')
    .reduce((total, vote) => total + vote.weight, 0);
  const votesAbstain = caseVotes
    .filter((vote) => vote.vote === 'abstain')
    .reduce((total, vote) => total + vote.weight, 0);
  const quorumReached = votesFor + votesAgainst >= arbitrationCase.quorumVotes;
  const resolved = quorumReached
    ? votesFor > votesAgainst
      ? 'upheld'
      : votesAgainst > votesFor
        ? 'rejected'
        : 'rejected'
    : undefined;

  return {
    caseId: arbitrationCase.id,
    status: resolved ? 'resolved' : 'open',
    outcome: resolved,
    votesFor,
    votesAgainst,
    votesAbstain,
    quorumVotes: arbitrationCase.quorumVotes,
    quorumReached,
    winner: resolved === 'upheld' ? 'challenger' : resolved === 'rejected' ? 'respondent' : 'none',
  };
}
