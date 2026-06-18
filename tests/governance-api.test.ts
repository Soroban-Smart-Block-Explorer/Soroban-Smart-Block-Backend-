import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

vi.mock('../src/db', () => ({
  prismaRead: {
    governanceProposal: {
      findMany: vi.fn(),
      count: vi.fn(),
      findUnique: vi.fn(),
      groupBy: vi.fn(),
    },
    governanceVote: {
      findMany: vi.fn(),
      groupBy: vi.fn(),
      count: vi.fn(),
    },
    governanceContract: {
      findUnique: vi.fn(),
      count: vi.fn(),
    },
    governanceDelegate: {
      findMany: vi.fn(),
    },
  },
  prismaWrite: {},
}));

import { prismaRead as prisma } from '../src/db';
import { governanceRouter } from '../src/api/governance';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/governance', governanceRouter);

  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

beforeEach(() => {
  vi.clearAllMocks();
});

const VALID_CONTRACT_ADDRESS = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';

const PROPOSAL_FIXTURE = {
  contractAddress: VALID_CONTRACT_ADDRESS,
  proposalId: '1',
  proposer: 'GPROPOSER1234567890ABCDEFGHIJKLMNO1234567890',
  title: 'Test Proposal',
  status: 'active',
  startBlock: 100,
  endBlock: 200,
  votesFor: '100',
  votesAgainst: '10',
  votesAbstain: '5',
  quorum: '50',
  executionTxHash: null,
  executedAt: null,
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

const VOTE_FIXTURE = [
  { voter: 'GVOTER1', weight: '60', support: 'for', reason: 'Yes vote' },
  { voter: 'GVOTER2', weight: '30', support: 'against', reason: 'No vote' },
  { voter: 'GVOTER3', weight: '10', support: 'abstain', reason: '' },
];

const CONTRACT_FIXTURE = {
  contractAddress: VALID_CONTRACT_ADDRESS,
  governanceType: 'token_based',
  votingToken: 'TOKEN',
  proposals: [PROPOSAL_FIXTURE],
  votes: VOTE_FIXTURE,
  delegates: [{ delegatee: 'GDELEGATE1', delegatedVotes: '100', delegators: 2, proposalsVoted: 1 }],
};

describe('Governance API', () => {
  it('returns paginated proposals', async () => {
    (prisma.governanceProposal.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([PROPOSAL_FIXTURE]);
    (prisma.governanceProposal.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    const res = await fetch(`${baseUrl}/api/v1/governance/proposals?limit=10`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.page).toBe(1);
    expect(body.limit).toBe(10);
    expect(body.data[0].proposalId).toBe('1');
  });

  it('returns proposal details with vote summary', async () => {
    (prisma.governanceProposal.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...PROPOSAL_FIXTURE,
      votes: VOTE_FIXTURE,
    });

    const res = await fetch(`${baseUrl}/api/v1/governance/proposals/${PROPOSAL_FIXTURE.contractAddress}/${PROPOSAL_FIXTURE.proposalId}`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.proposal.proposalId).toBe('1');
    expect(body.voteSummary.totalVotes).toBe(3);
    expect(body.voteSummary.votesFor).toBe('100');
    expect(body.voteSummary.votesAgainst).toBe('10');
    expect(body.voteSummary.votesAbstain).toBe('5');
    expect(body.voteSummary.forCount).toBe(1);
    expect(body.voteSummary.againstCount).toBe(1);
    expect(body.voteSummary.abstainCount).toBe(1);
  });

  it('returns votes for a proposal', async () => {
    (prisma.governanceVote.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(VOTE_FIXTURE);

    const res = await fetch(`${baseUrl}/api/v1/governance/proposals/${PROPOSAL_FIXTURE.contractAddress}/${PROPOSAL_FIXTURE.proposalId}/votes`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.votes).toHaveLength(3);
    expect(body.totalVoters).toBe(3);
    expect(body.voterParticipation).toBe(1);
  });

  it('returns contract governance metadata', async () => {
    (prisma.governanceContract.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(CONTRACT_FIXTURE);
    (prisma.governanceProposal.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([
      { proposer: CONTRACT_FIXTURE.proposals[0].proposer, _count: { proposer: 1 } },
    ]);
    (prisma.governanceVote.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([
      { voter: VOTE_FIXTURE[0].voter, _count: { voter: 1 } },
    ]);

    const res = await fetch(`${baseUrl}/api/v1/governance/contracts/${CONTRACT_FIXTURE.contractAddress}`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.contract).toBe(CONTRACT_FIXTURE.contractAddress);
    expect(body.totalProposals).toBe(1);
    expect(body.executedProposals).toBe(0);
    expect(body.topProposers[0].address).toBe(CONTRACT_FIXTURE.proposals[0].proposer);
    expect(body.topVoters[0].address).toBe(VOTE_FIXTURE[0].voter);
  });

  it('returns delegate data for a contract', async () => {
    (prisma.governanceDelegate.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { delegatee: 'GDELEGATE1', delegatedVotes: '100', delegators: 2, proposalsVoted: 1 },
      { delegatee: 'GDELEGATE2', delegatedVotes: '50', delegators: 1, proposalsVoted: 0 },
    ]);

    const res = await fetch(`${baseUrl}/api/v1/governance/contracts/${CONTRACT_FIXTURE.contractAddress}/delegates`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.delegates).toHaveLength(2);
    expect(body.delegates[0].delegatee).toBe('GDELEGATE1');
    expect(body.delegates[1].delegatedVotes).toBe('50');
  });

  it('returns governance stats', async () => {
    (prisma.governanceContract.count as ReturnType<typeof vi.fn>).mockResolvedValue(2);
    (prisma.governanceProposal.count as ReturnType<typeof vi.fn>).mockResolvedValue(10);
    (prisma.governanceVote.count as ReturnType<typeof vi.fn>).mockResolvedValue(25);
    (prisma.governanceProposal.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([
      { contractAddress: CONTRACT_FIXTURE.contractAddress, _count: { contractAddress: 5 } },
    ]);

    const res = await fetch(`${baseUrl}/api/v1/governance/stats`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.totalGovernanceContracts).toBe(2);
    expect(body.totalProposals).toBe(10);
    expect(body.totalVotesCast).toBe(25);
    expect(body.mostActiveGovernance.contract).toBe(CONTRACT_FIXTURE.contractAddress);
    expect(body.mostActiveGovernance.proposals).toBe(5);
  });

  it('returns governance calendar data', async () => {
    (prisma.governanceProposal.findMany as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([{ contractAddress: CONTRACT_FIXTURE.contractAddress, proposalId: '1', title: 'Active', endBlock: 200, status: 'active', startBlock: 100 }])
      .mockResolvedValueOnce([{ contractAddress: CONTRACT_FIXTURE.contractAddress, proposalId: '2', title: 'Queued', status: 'queued', executionTxHash: 'txhash' }]);

    const res = await fetch(`${baseUrl}/api/v1/governance/calendar`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.upcoming).toHaveLength(1);
    expect(body.queued).toHaveLength(1);
    expect(body.upcoming[0].status).toBe('active');
    expect(body.queued[0].status).toBe('queued');
  });
});
