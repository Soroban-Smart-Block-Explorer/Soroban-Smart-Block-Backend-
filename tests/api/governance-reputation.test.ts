import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

vi.mock('../../src/auth/middleware', () => ({
  requireAuth: vi.fn((_req: any, _res: any, next: any) => next()),
  optionalAuth: vi.fn((_req: any, _res: any, next: any) => next()),
  requireRole: vi.fn(() => (_req: any, _res: any, next: any) => next()),
  requireTier: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

vi.mock('../../src/db', () => ({
  prismaRead: {
    governanceContract: { count: vi.fn(), findUnique: vi.fn() },
    governanceProposal: {
      count: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      groupBy: vi.fn(),
    },
    governanceVote: { count: vi.fn(), findMany: vi.fn(), groupBy: vi.fn() },
    governanceDelegate: { findMany: vi.fn() },
    reputationProfile: { findMany: vi.fn(), findUnique: vi.fn() },
    attestation: { findUnique: vi.fn() },
    reputationDispute: { findUnique: vi.fn() },
    reputationDelegation: { findMany: vi.fn() },
    reputationNft: { findMany: vi.fn(), findFirst: vi.fn() },
  },
  prismaWrite: {
    reputationProfile: { findUnique: vi.fn(), create: vi.fn() },
    attestation: { upsert: vi.fn() },
    verifiableCredential: { upsert: vi.fn() },
    reputationSignal: { create: vi.fn() },
    linkedIdentity: { upsert: vi.fn(), delete: vi.fn() },
    endorsement: { create: vi.fn() },
    reputationDispute: { create: vi.fn(), update: vi.fn() },
    reputationDisputeVote: { create: vi.fn() },
    reputationDelegation: { upsert: vi.fn() },
    reputationGovernanceVote: { upsert: vi.fn() },
    reputationNft: { create: vi.fn() },
    registeredDapp: { create: vi.fn() },
    authSession: { findFirst: vi.fn(), update: vi.fn() },
  },
}));

vi.mock('../../src/middleware/sanitize', () => ({
  validateAddressParam: () => (_req: any, _res: any, next: any) => next(),
  isValidStellarAddress: vi.fn().mockReturnValue(true),
  sanitizeInputs: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../src/reputation/score', () => ({
  canonicalAddress: (addr: string) => addr,
  computeReputationScore: vi.fn().mockReturnValue({
    address: 'ADDR',
    score: 50,
    breakdown: [],
    chainScores: [],
  }),
  computeReputationScoreForIdentity: vi.fn().mockReturnValue({
    address: 'ADDR',
    score: 50,
    breakdown: [],
    chainScores: [],
  }),
  createLeaderboard: vi.fn().mockReturnValue([]),
  createOracleResponse: vi.fn().mockReturnValue({ proof: { type: 'oracle' } }),
  earnBadges: vi.fn().mockReturnValue([]),
  fetchProfileData: vi.fn().mockResolvedValue([]),
  isAttestationVerifiable: vi.fn().mockReturnValue(true),
  isVerifiableCredential: vi.fn().mockReturnValue(true),
  normalizeAttestation: vi.fn().mockImplementation((x: any) => ({
    ...x,
    uid: 'uid-1',
    verified: true,
    verificationMessage: 'ok',
  })),
  normalizeCredential: vi.fn().mockImplementation((x: any) => x),
  saveReputationToDb: vi.fn().mockResolvedValue(undefined),
  verifyIdentityLinks: vi.fn().mockReturnValue([]),
  assessSybilRisk: vi.fn().mockReturnValue({ riskScore: 0.1, riskLevel: 'low' }),
}));

vi.mock('../../src/reputation/trustGraph', () => ({
  buildTrustGraph: vi.fn().mockReturnValue({ nodes: [], edges: [] }),
  findTrustPath: vi.fn().mockReturnValue(null),
  weightedEndorsements: vi.fn().mockReturnValue([]),
}));

vi.mock('../../src/reputation/governance', () => ({
  calculateDelegatedVotingPower: vi.fn().mockReturnValue([]),
}));

vi.mock('../../src/reputation/arbitration', () => ({
  createArbitrationCase: vi.fn().mockReturnValue({
    id: 'case-1',
    challenger: 'A',
    respondent: 'B',
    challenge: 'test',
    evidenceHash: 'hash',
    quorumVotes: 5,
    status: 'open',
    createdAt: new Date().toISOString(),
  }),
  resolveArbitrationCase: vi.fn().mockReturnValue({
    caseId: 'case-1',
    status: 'resolved',
    outcome: 'upheld',
    votesFor: 3,
    votesAgainst: 1,
    votesAbstain: 0,
    quorumVotes: 5,
    quorumReached: false,
    winner: 'challenger',
  }),
}));

const { governanceRouter } = await import('../../src/api/governance');
const { reputationRouter } = await import('../../src/api/reputation');
const { requireAuth } = await import('../../src/auth/middleware');

function createGovernanceApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/governance', governanceRouter);
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  return app;
}

function createReputationApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/reputation', reputationRouter);
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  return app;
}

async function withServer(
  createApp: () => express.Express,
  prefix: string,
  fn: (base: string) => Promise<void>,
) {
  const app = createApp();
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://localhost:${port}${prefix}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAuth).mockImplementation((_req: any, _res: any, next: any) => next());
});

// ─── Route-registry ───────────────────────────────────────────────────────────

describe('route-registry: governance router', () => {
  it('GET /governance/stats is reachable and returns aggregate counts', async () => {
    const { prismaRead } = await import('../../src/db');
    (prismaRead.governanceContract.count as any).mockResolvedValue(3);
    (prismaRead.governanceProposal.count as any).mockResolvedValue(7);
    (prismaRead.governanceVote.count as any).mockResolvedValue(42);
    (prismaRead.governanceProposal.groupBy as any).mockResolvedValue([]);

    await withServer(createGovernanceApp, '/api/v1/governance', async (base) => {
      const res = await fetch(`${base}/stats`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        totalGovernanceContracts: 3,
        totalProposals: 7,
        totalVotesCast: 42,
      });
    });
  });

  it('GET /governance/proposals is reachable and returns paginated data', async () => {
    const { prismaRead } = await import('../../src/db');
    (prismaRead.governanceProposal.findMany as any).mockResolvedValue([]);
    (prismaRead.governanceProposal.count as any).mockResolvedValue(0);

    await withServer(createGovernanceApp, '/api/v1/governance', async (base) => {
      const res = await fetch(`${base}/proposals`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('total', 0);
    });
  });

  it('GET /governance/calendar is reachable', async () => {
    const { prismaRead } = await import('../../src/db');
    (prismaRead.governanceProposal.findMany as any).mockResolvedValue([]);

    await withServer(createGovernanceApp, '/api/v1/governance', async (base) => {
      const res = await fetch(`${base}/calendar`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('upcoming');
      expect(body).toHaveProperty('queued');
    });
  });
});

describe('route-registry: reputation router', () => {
  it('GET /reputation/leaderboard is reachable and returns leaderboard', async () => {
    const { prismaRead } = await import('../../src/db');
    (prismaRead.reputationProfile.findMany as any).mockResolvedValue([]);

    await withServer(createReputationApp, '/api/v1/reputation', async (base) => {
      const res = await fetch(`${base}/leaderboard`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('category', 'overall');
      expect(Array.isArray(body.leaderboard)).toBe(true);
    });
  });

  it('GET /reputation/search returns 400 when q param is missing', async () => {
    await withServer(createReputationApp, '/api/v1/reputation', async (base) => {
      const res = await fetch(`${base}/search`);
      expect(res.status).toBe(400);
    });
  });

  it('GET /reputation/search returns results when q param provided', async () => {
    const { prismaRead } = await import('../../src/db');
    (prismaRead.reputationProfile.findMany as any).mockResolvedValue([]);

    await withServer(createReputationApp, '/api/v1/reputation', async (base) => {
      const res = await fetch(`${base}/search?q=GBZX`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('results');
    });
  });
});

// ─── Authorization ────────────────────────────────────────────────────────────

describe('authorization: reputation mutation endpoints require auth', () => {
  beforeEach(() => {
    vi.mocked(requireAuth).mockImplementation((_req: any, res: any, _next: any) => {
      res.status(401).json({ error: 'Authentication required' });
    });
  });

  const mutationRoutes: Array<{ method: string; path: string; body?: object }> = [
    { method: 'POST', path: '/ADDR/attest', body: {} },
    { method: 'POST', path: '/ADDR/credentials', body: {} },
    { method: 'POST', path: '/verify-cross-chain', body: {} },
    { method: 'POST', path: '/link', body: {} },
    { method: 'DELETE', path: '/link/some-id' },
    { method: 'POST', path: '/endorse', body: {} },
    { method: 'POST', path: '/disputes', body: {} },
    { method: 'POST', path: '/disputes/some-id/vote', body: {} },
    { method: 'POST', path: '/disputes/some-id/resolve', body: {} },
    { method: 'POST', path: '/governance/delegate', body: {} },
    { method: 'POST', path: '/governance/vote', body: {} },
    { method: 'POST', path: '/nfts/mint/whale', body: {} },
    { method: 'POST', path: '/sdk/register', body: {} },
  ];

  for (const { method, path, body } of mutationRoutes) {
    it(`${method} /reputation${path} returns 401 without auth`, async () => {
      await withServer(createReputationApp, '/api/v1/reputation', async (base) => {
        const res = await fetch(`${base}${path}`, {
          method,
          headers: { 'Content-Type': 'application/json' },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        expect(res.status).toBe(401);
      });
    });
  }
});

describe('authorization: stateless reputation endpoints do not require auth', () => {
  it('POST /reputation/credentials/verify is open (no auth gate)', async () => {
    await withServer(createReputationApp, '/api/v1/reputation', async (base) => {
      const res = await fetch(`${base}/credentials/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
    });
  });

  it('POST /reputation/score is open (no auth gate)', async () => {
    await withServer(createReputationApp, '/api/v1/reputation', async (base) => {
      const res = await fetch(`${base}/score`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: 'GBZXTEST' }),
      });
      expect(res.status).toBe(200);
    });
  });
});
