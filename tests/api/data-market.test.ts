import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { dataMarketRouter } from '../../src/api/data-market';

vi.mock('../../src/db', () => ({
  prismaRead: {
    archivalNode: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      aggregate: vi.fn(),
    },
    archivalEpoch: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      groupBy: vi.fn(),
    },
    storageChallenge: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      groupBy: vi.fn(),
    },
    dataRetrieval: {
      findMany: vi.fn(),
      count: vi.fn(),
      groupBy: vi.fn(),
    },
    archivalSlash: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      aggregate: vi.fn(),
    },
    archivalAppeal: {
      findFirst: vi.fn(),
    },
    slaOffer: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
  },
  prismaWrite: {
    archivalNode: {
      create: vi.fn(),
      update: vi.fn(),
    },
    archivalEpoch: {
      create: vi.fn(),
      update: vi.fn(),
    },
    storageChallenge: {
      create: vi.fn(),
      update: vi.fn(),
    },
    dataRetrieval: {
      create: vi.fn(),
    },
    archivalSlash: {
      create: vi.fn(),
    },
    archivalAppeal: {
      create: vi.fn(),
    },
    slaOffer: {
      create: vi.fn(),
    },
    slaAcceptance: {
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

import { prismaRead, prismaWrite } from '../../src/db';

const r = prismaRead as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;
const w = prismaWrite as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;

const app = express();
app.use(express.json());
app.use('/data-market', dataMarketRouter);

const mockNode = {
  id: 'node1',
  address: 'GABC123',
  name: 'Test Node',
  endpoint: 'https://node.example.com',
  stakedAmount: 500,
  stakeAsset: 'XLM',
  commission: 2.5,
  reputation: 80,
  reputationHistory: null,
  totalEarnings: 100,
  totalServed: 200,
  totalChallenges: 10,
  challengesPassed: 9,
  challengesFailed: 1,
  uptime24h: 99.5,
  uptime7d: 99.2,
  uptime30d: 98.8,
  avgResponseTime: 150,
  p95ResponseTime: 300,
  maxStorageGb: 1000,
  usedStorageGb: 200,
  supportedEpochs: null,
  slashedAmount: 50,
  status: 'active',
  registeredAt: new Date(),
  lastSeen: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockEpoch = {
  id: 'epoch1',
  epochId: 42,
  startLedger: 1000,
  endLedger: 2000,
  sizeBytes: null,
  checksum: 'abc123checksum',
  merkleRoot: 'merkle_root_xyz',
  nodeId: 'node1',
  node: mockNode,
  status: 'stored',
  verifiedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockChallengeBase = {
  id: 'challenge1',
  epochId: 'epoch1',
  nodeId: 'node1',
  challengeType: 'random_byte_range',
  challengeData: { offset: 100, length: 64, checksum: 'abc123checksum' },
  responseData: null,
  status: 'issued',
  attempts: 0,
  proofVerified: null,
  slashed: false,
  issuedAt: new Date(),
  respondedAt: null,
  verifiedAt: null,
};

const mockChallenge = { ...mockChallengeBase, epoch: mockEpoch, node: mockNode };

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Must-Have: Core Data Market ───────────────────────────────────────────────

describe('POST /data-market/register', () => {
  it('registers a new archival node', async () => {
    r['archivalNode']['findUnique'].mockResolvedValue(null);
    w['archivalNode']['create'].mockResolvedValue(mockNode);

    const res = await request(app).post('/data-market/register').send({
      address: 'GABC123',
      endpoint: 'https://node.example.com',
      stakeAmount: 500,
    });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('node');
    expect(w['archivalNode']['create']).toHaveBeenCalledOnce();
  });

  it('returns 409 if node already registered', async () => {
    r['archivalNode']['findUnique'].mockResolvedValue(mockNode);

    const res = await request(app).post('/data-market/register').send({
      address: 'GABC123',
      endpoint: 'https://node.example.com',
      stakeAmount: 500,
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already registered/i);
  });

  it('returns 400 if stake is below minimum', async () => {
    const res = await request(app).post('/data-market/register').send({
      address: 'GABC123',
      endpoint: 'https://node.example.com',
      stakeAmount: 10,
    });

    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid endpoint URL', async () => {
    const res = await request(app).post('/data-market/register').send({
      address: 'GABC123',
      endpoint: 'not-a-url',
      stakeAmount: 500,
    });

    expect(res.status).toBe(400);
  });
});

describe('POST /data-market/stake', () => {
  it('stakes additional tokens on an existing node', async () => {
    r['archivalNode']['findUnique'].mockResolvedValue(mockNode);
    w['archivalNode']['update'].mockResolvedValue({ ...mockNode, stakedAmount: 700 });

    const res = await request(app)
      .post('/data-market/stake')
      .send({ address: 'GABC123', amount: 200 });

    expect(res.status).toBe(200);
    expect(res.body.stakedAmount).toBe(700);
  });

  it('returns 404 for unknown node', async () => {
    r['archivalNode']['findUnique'].mockResolvedValue(null);
    const res = await request(app)
      .post('/data-market/stake')
      .send({ address: 'UNKNOWN', amount: 200 });
    expect(res.status).toBe(404);
  });

  it('returns 403 for jailed node', async () => {
    r['archivalNode']['findUnique'].mockResolvedValue({ ...mockNode, status: 'jailed' });
    const res = await request(app)
      .post('/data-market/stake')
      .send({ address: 'GABC123', amount: 200 });
    expect(res.status).toBe(403);
  });
});

describe('POST /data-market/unstake', () => {
  it('unstakes tokens and returns cooldown info', async () => {
    r['archivalNode']['findUnique'].mockResolvedValue(mockNode);
    w['archivalNode']['update'].mockResolvedValue({ ...mockNode, stakedAmount: 300 });

    const res = await request(app)
      .post('/data-market/unstake')
      .send({ address: 'GABC123', amount: 200 });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('cooldownEnds');
    expect(res.body.remainingStake).toBe(300);
  });

  it('returns 400 if unstake amount exceeds staked balance', async () => {
    r['archivalNode']['findUnique'].mockResolvedValue({ ...mockNode, stakedAmount: 100 });

    const res = await request(app)
      .post('/data-market/unstake')
      .send({ address: 'GABC123', amount: 500 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/insufficient/i);
  });
});

describe('GET /data-market/nodes', () => {
  it('returns a paginated list of nodes', async () => {
    r['archivalNode']['findMany'].mockResolvedValue([mockNode]);
    r['archivalNode']['count'].mockResolvedValue(1);

    const res = await request(app).get('/data-market/nodes');

    expect(res.status).toBe(200);
    expect(res.body.nodes).toHaveLength(1);
    expect(res.body.total).toBe(1);
  });

  it('filters by status', async () => {
    r['archivalNode']['findMany'].mockResolvedValue([]);
    r['archivalNode']['count'].mockResolvedValue(0);

    const res = await request(app).get('/data-market/nodes?status=jailed');

    expect(res.status).toBe(200);
    expect(res.body.nodes).toHaveLength(0);
  });
});

describe('GET /data-market/nodes/:address', () => {
  it('returns node detail with reputation breakdown', async () => {
    r['archivalNode']['findUnique'].mockResolvedValue({
      ...mockNode,
      epochs: [],
      _count: { challenges: 10, retrievals: 200 },
    });

    const res = await request(app).get('/data-market/nodes/GABC123');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('node');
    expect(res.body).toHaveProperty('reputationBreakdown');
  });

  it('returns 404 for unknown address', async () => {
    r['archivalNode']['findUnique'].mockResolvedValue(null);
    const res = await request(app).get('/data-market/nodes/UNKNOWN');
    expect(res.status).toBe(404);
  });
});

describe('PATCH /data-market/nodes/:address', () => {
  it('updates node configuration', async () => {
    r['archivalNode']['findUnique'].mockResolvedValue(mockNode);
    w['archivalNode']['update'].mockResolvedValue({ ...mockNode, commission: 3.0 });

    const res = await request(app).patch('/data-market/nodes/GABC123').send({ commission: 3.0 });

    expect(res.status).toBe(200);
    expect(res.body.node.commission).toBe(3.0);
  });

  it('returns 400 for commission out of range', async () => {
    r['archivalNode']['findUnique'].mockResolvedValue(mockNode);
    const res = await request(app).patch('/data-market/nodes/GABC123').send({ commission: 150 });
    expect(res.status).toBe(400);
  });
});

describe('POST /data-market/nodes/:address/deactivate', () => {
  it('deactivates an active node', async () => {
    r['archivalNode']['findUnique'].mockResolvedValue(mockNode);
    w['archivalNode']['update'].mockResolvedValue({ ...mockNode, status: 'inactive' });

    const res = await request(app).post('/data-market/nodes/GABC123/deactivate');

    expect(res.status).toBe(200);
    expect(res.body.node.status).toBe('inactive');
  });
});

describe('GET /data-market/epochs', () => {
  it('returns paginated epoch list with node info', async () => {
    r['archivalEpoch']['findMany'].mockResolvedValue([
      {
        ...mockEpoch,
        node: { address: 'GABC123', name: 'Test Node', reputation: 80 },
        _count: { challenges: 2 },
      },
    ]);
    r['archivalEpoch']['count'].mockResolvedValue(1);

    const res = await request(app).get('/data-market/epochs');

    expect(res.status).toBe(200);
    expect(res.body.epochs).toHaveLength(1);
    expect(res.body.total).toBe(1);
  });
});

describe('GET /data-market/epochs/:epochId', () => {
  it('returns epoch detail with storage nodes', async () => {
    r['archivalEpoch']['findMany'].mockResolvedValue([{ ...mockEpoch, challenges: [] }]);

    const res = await request(app).get('/data-market/epochs/42');

    expect(res.status).toBe(200);
    expect(res.body.epochId).toBe(42);
    expect(res.body.storageNodes).toHaveLength(1);
  });

  it('returns 404 for missing epoch', async () => {
    r['archivalEpoch']['findMany'].mockResolvedValue([]);
    const res = await request(app).get('/data-market/epochs/99999');
    expect(res.status).toBe(404);
  });

  it('returns 400 for non-numeric epochId', async () => {
    const res = await request(app).get('/data-market/epochs/abc');
    expect(res.status).toBe(400);
  });
});

describe('GET /data-market/query', () => {
  it('returns matched archival nodes for a ledger', async () => {
    r['archivalEpoch']['findMany'].mockResolvedValue([{ ...mockEpoch, createdAt: new Date() }]);

    const res = await request(app).get('/data-market/query?ledger=1500');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('results');
    expect(res.body.results[0]).toHaveProperty('estimatedFee');
  });
});

describe('GET /data-market/overview', () => {
  it('returns market overview statistics', async () => {
    r['archivalNode']['count'].mockResolvedValueOnce(10).mockResolvedValueOnce(8);
    r['archivalEpoch']['count'].mockResolvedValueOnce(100).mockResolvedValueOnce(90);
    r['dataRetrieval']['count'].mockResolvedValue(500);
    r['archivalNode']['aggregate']
      .mockResolvedValueOnce({ _sum: { stakedAmount: 10000 } })
      .mockResolvedValueOnce({ _sum: { totalEarnings: 500 } });

    const res = await request(app).get('/data-market/overview');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      totalNodes: 10,
      activeNodes: 8,
      totalEpochs: 100,
      verifiedEpochs: 90,
      totalRetrievals: 500,
      totalStaked: 10000,
      totalEarnings: 500,
    });
  });
});

// ── Should-Have: Challenge-Response ───────────────────────────────────────────

describe('POST /data-market/challenge', () => {
  it('issues a storage challenge', async () => {
    r['archivalNode']['findUnique'].mockResolvedValue(mockNode);
    r['archivalEpoch']['findUnique'].mockResolvedValue(mockEpoch);
    w['storageChallenge']['create'].mockResolvedValue(mockChallengeBase);
    w['archivalNode']['update'].mockResolvedValue(mockNode);

    const res = await request(app).post('/data-market/challenge').send({
      nodeAddress: 'GABC123',
      epochId: 'epoch1',
    });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('challenge');
    expect(res.body).toHaveProperty('deadline');
  });

  it('returns 400 for inactive node', async () => {
    r['archivalNode']['findUnique'].mockResolvedValue({ ...mockNode, status: 'inactive' });

    const res = await request(app).post('/data-market/challenge').send({
      nodeAddress: 'GABC123',
      epochId: 'epoch1',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not active/i);
  });

  it('returns 400 if epoch not assigned to node', async () => {
    r['archivalNode']['findUnique'].mockResolvedValue(mockNode);
    r['archivalEpoch']['findUnique'].mockResolvedValue({ ...mockEpoch, nodeId: 'other_node' });

    const res = await request(app).post('/data-market/challenge').send({
      nodeAddress: 'GABC123',
      epochId: 'epoch1',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not assigned/i);
  });
});

describe('POST /data-market/challenge/:id/respond', () => {
  it('accepts a response for an issued challenge', async () => {
    r['storageChallenge']['findUnique'].mockResolvedValue({ ...mockChallenge, epoch: mockEpoch });
    w['storageChallenge']['update'].mockResolvedValue({
      ...mockChallengeBase,
      status: 'responded',
      responseData: { data: 'proof_data', hash: 'abc' },
    });

    const res = await request(app)
      .post('/data-market/challenge/challenge1/respond')
      .send({ responseData: { data: 'proof_data', hash: 'abc' } });

    expect(res.status).toBe(200);
    expect(res.body.challenge.status).toBe('responded');
  });

  it('returns 400 if challenge is not awaiting response', async () => {
    r['storageChallenge']['findUnique'].mockResolvedValue({
      ...mockChallenge,
      status: 'verified',
      epoch: mockEpoch,
    });

    const res = await request(app)
      .post('/data-market/challenge/challenge1/respond')
      .send({ responseData: {} });

    expect(res.status).toBe(400);
  });
});

describe('POST /data-market/challenge/:id/verify', () => {
  it('marks a challenge as verified when proof passes', async () => {
    const respondedChallenge = {
      ...mockChallenge,
      status: 'responded',
      responseData: { data: 'proof', hash: 'valid_hash' },
      epoch: { ...mockEpoch, checksum: null, merkleRoot: null },
      node: mockNode,
    };
    r['storageChallenge']['findUnique'].mockResolvedValue(respondedChallenge);

    const verifiedChallenge = { ...mockChallengeBase, status: 'verified', proofVerified: true };
    w['$transaction'].mockResolvedValue([verifiedChallenge, mockNode]);

    const res = await request(app).post('/data-market/challenge/challenge1/verify');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('passed');
    expect(res.body).toHaveProperty('slashAmount');
  });

  it('returns 400 if challenge has not been responded to', async () => {
    r['storageChallenge']['findUnique'].mockResolvedValue({
      ...mockChallenge,
      status: 'issued',
      epoch: mockEpoch,
      node: mockNode,
    });

    const res = await request(app).post('/data-market/challenge/challenge1/verify');
    expect(res.status).toBe(400);
  });
});

describe('POST /data-market/challenge/zk-proof', () => {
  it('accepts a valid ZK proof submission', async () => {
    r['storageChallenge']['findUnique'].mockResolvedValue({
      ...mockChallenge,
      challengeType: 'zk_proof',
    });
    w['storageChallenge']['update'].mockResolvedValue({ ...mockChallenge, proofVerified: true });

    const res = await request(app)
      .post('/data-market/challenge/zk-proof')
      .send({
        challengeId: 'challenge1',
        proof: 'valid_proof_string_abc123',
        publicSignals: { inputHash: 'abc', outputHash: 'xyz' },
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('verified');
    expect(res.body.circuit).toBe('poseidon_storage_v1');
  });

  it('returns 400 for non-ZK challenge', async () => {
    r['storageChallenge']['findUnique'].mockResolvedValue({
      ...mockChallenge,
      challengeType: 'random_byte_range',
    });

    const res = await request(app).post('/data-market/challenge/zk-proof').send({
      challengeId: 'challenge1',
      proof: 'proof_abc',
      publicSignals: {},
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not a zk-proof/i);
  });
});

describe('GET /data-market/challenges/:nodeId', () => {
  it('returns challenge history for a node', async () => {
    r['archivalNode']['findUnique'].mockResolvedValue(mockNode);
    r['storageChallenge']['findMany'].mockResolvedValue([
      { ...mockChallenge, epoch: { epochId: 42, startLedger: 1000, endLedger: 2000 } },
    ]);
    r['storageChallenge']['count'].mockResolvedValue(1);

    const res = await request(app).get('/data-market/challenges/node1');

    expect(res.status).toBe(200);
    expect(res.body.challenges).toHaveLength(1);
    expect(res.body.total).toBe(1);
  });
});

describe('GET /data-market/slashes', () => {
  it('returns slashing event history', async () => {
    r['archivalSlash']['findMany'].mockResolvedValue([
      {
        id: 'slash1',
        nodeId: 'node1',
        challengeId: 'challenge1',
        amount: 50,
        reason: 'Failed challenge',
        createdAt: new Date(),
        node: { address: 'GABC123', name: 'Test Node' },
        challenge: { challengeType: 'random_byte_range', status: 'failed' },
      },
    ]);
    r['archivalSlash']['count'].mockResolvedValue(1);

    const res = await request(app).get('/data-market/slashes');

    expect(res.status).toBe(200);
    expect(res.body.slashes).toHaveLength(1);
    expect(res.body.slashes[0].amount).toBe(50);
  });
});

describe('POST /data-market/appeal', () => {
  it('creates an appeal for a slashing decision', async () => {
    r['archivalSlash']['findUnique'].mockResolvedValue({
      id: 'slash1',
      nodeId: 'node1',
      amount: 50,
      reason: 'Test',
    });
    r['archivalAppeal']['findFirst'].mockResolvedValue(null);
    w['archivalAppeal']['create'].mockResolvedValue({
      id: 'appeal1',
      slashId: 'slash1',
      reason: 'I was wrongly slashed',
      status: 'pending',
    });

    const res = await request(app)
      .post('/data-market/appeal')
      .send({
        slashId: 'slash1',
        reason: 'I was wrongly slashed, the data was correct',
        evidence: { txHash: '0xabc' },
      });

    expect(res.status).toBe(201);
    expect(res.body.appeal.status).toBe('pending');
  });

  it('returns 409 if appeal already submitted', async () => {
    r['archivalSlash']['findUnique'].mockResolvedValue({ id: 'slash1', nodeId: 'node1' });
    r['archivalAppeal']['findFirst'].mockResolvedValue({ id: 'appeal1', status: 'pending' });

    const res = await request(app).post('/data-market/appeal').send({
      slashId: 'slash1',
      reason: 'I was wrongly slashed again',
    });

    expect(res.status).toBe(409);
  });

  it('returns 400 if reason is too short', async () => {
    const res = await request(app).post('/data-market/appeal').send({
      slashId: 'slash1',
      reason: 'short',
    });

    expect(res.status).toBe(400);
  });
});

// ── Nice-to-Have: SLA, Pricing, Redundancy ────────────────────────────────────

describe('POST /data-market/slas', () => {
  it('creates a gold SLA offer', async () => {
    r['archivalNode']['findUnique'].mockResolvedValue(mockNode);
    w['slaOffer']['create'].mockResolvedValue({
      id: 'sla1',
      nodeId: 'node1',
      tier: 'gold',
      uptime: 0.9999,
      responseMs: 100,
      pricePerGb: 0.05,
    });

    const res = await request(app).post('/data-market/slas').send({
      nodeAddress: 'GABC123',
      tier: 'gold',
      responseMs: 100,
      pricePerGb: 0.05,
    });

    expect(res.status).toBe(201);
    expect(res.body.sla.tier).toBe('gold');
    expect(res.body.sla.uptime).toBe(0.9999);
  });

  it('returns 400 for inactive node', async () => {
    r['archivalNode']['findUnique'].mockResolvedValue({ ...mockNode, status: 'jailed' });

    const res = await request(app).post('/data-market/slas').send({
      nodeAddress: 'GABC123',
      tier: 'bronze',
      responseMs: 500,
      pricePerGb: 0.01,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must be active/i);
  });
});

describe('GET /data-market/slas', () => {
  it('returns active SLA offers', async () => {
    r['slaOffer']['findMany'].mockResolvedValue([
      { id: 'sla1', tier: 'gold', pricePerGb: 0.05, active: true, node: mockNode },
    ]);
    r['slaOffer']['count'].mockResolvedValue(1);

    const res = await request(app).get('/data-market/slas');

    expect(res.status).toBe(200);
    expect(res.body.slas).toHaveLength(1);
  });

  it('filters by tier', async () => {
    r['slaOffer']['findMany'].mockResolvedValue([]);
    r['slaOffer']['count'].mockResolvedValue(0);

    const res = await request(app).get('/data-market/slas?tier=gold');

    expect(res.status).toBe(200);
    expect(res.body.slas).toHaveLength(0);
  });
});

describe('POST /data-market/slas/:id/accept', () => {
  it('accepts a SLA offer', async () => {
    r['slaOffer']['findUnique'].mockResolvedValue({
      id: 'sla1',
      active: true,
      pricePerGb: 0.05,
      tier: 'gold',
      node: { address: 'GABC123', avgResponseTime: 150, reputation: 80 },
    });
    w['slaAcceptance']['create'].mockResolvedValue({
      id: 'acc1',
      offerId: 'sla1',
      requester: 'GREQ123',
      fee: 0.05,
      status: 'active',
    });

    const res = await request(app)
      .post('/data-market/slas/sla1/accept')
      .send({ requester: 'GREQ123' });

    expect(res.status).toBe(201);
    expect(res.body.acceptance.status).toBe('active');
  });

  it('returns 400 for inactive SLA offer', async () => {
    r['slaOffer']['findUnique'].mockResolvedValue({ id: 'sla1', active: false, node: mockNode });
    const res = await request(app)
      .post('/data-market/slas/sla1/accept')
      .send({ requester: 'GREQ123' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no longer active/i);
  });
});

describe('GET /data-market/prices', () => {
  it('returns current price feed', async () => {
    r['archivalNode']['findMany'].mockResolvedValue([
      {
        id: 'node1',
        address: 'GABC123',
        name: 'Test',
        reputation: 80,
        commission: 2.5,
        avgResponseTime: 150,
      },
    ]);
    r['archivalEpoch']['count'].mockResolvedValue(50);

    const res = await request(app).get('/data-market/prices');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('prices');
    expect(res.body.prices[0]).toHaveProperty('pricePerRequest');
    expect(res.body.prices[0]).toHaveProperty('pricePerGb');
    expect(res.body).toHaveProperty('timestamp');
  });
});

describe('GET /data-market/prices/history', () => {
  it('returns price history for specified days', async () => {
    const res = await request(app).get('/data-market/prices/history?days=7');

    expect(res.status).toBe(200);
    expect(res.body.history).toHaveLength(7);
    expect(res.body.days).toBe(7);
  });
});

describe('GET /data-market/redundancy', () => {
  it('returns redundancy map with underreplicated epochs', async () => {
    r['archivalEpoch']['groupBy'].mockResolvedValue([
      { epochId: 1, _count: { nodeId: 1 } },
      { epochId: 2, _count: { nodeId: 3 } },
    ]);

    const res = await request(app).get('/data-market/redundancy');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('redundancyMap');
    expect(res.body.underReplicated).toBe(1);
    expect(res.body.totalEpochs).toBe(2);
  });
});

describe('POST /data-market/rebalance', () => {
  it('triggers a rebalance job', async () => {
    r['archivalEpoch']['groupBy'].mockResolvedValue([{ epochId: 1, _count: { nodeId: 2 } }]);

    const res = await request(app).post('/data-market/rebalance');

    expect(res.status).toBe(200);
    expect(res.body.triggered).toBe(true);
    expect(res.body).toHaveProperty('underReplicatedEpochs');
  });
});

describe('GET /data-market/reputation/:address', () => {
  it('returns detailed reputation breakdown', async () => {
    r['archivalNode']['findUnique'].mockResolvedValue(mockNode);

    const res = await request(app).get('/data-market/reputation/GABC123');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('reputationScore');
    expect(res.body).toHaveProperty('decayedScore');
    expect(res.body.breakdown).toHaveProperty('uptime');
    expect(res.body.breakdown).toHaveProperty('challengeSuccess');
    expect(res.body.breakdown).toHaveProperty('responseTime');
    expect(res.body.breakdown).toHaveProperty('dataIntegrity');
    expect(res.body.breakdown).toHaveProperty('communityVotes');
  });

  it('reputation score reflects challenge success rate', async () => {
    r['archivalNode']['findUnique'].mockResolvedValue({
      ...mockNode,
      challengesPassed: 100,
      totalChallenges: 100,
      challengesFailed: 0,
    });

    const res = await request(app).get('/data-market/reputation/GABC123');

    expect(res.status).toBe(200);
    expect(res.body.reputationScore).toBeGreaterThan(0);
  });
});

// ── Stretch: Routing Fabric & Analytics ───────────────────────────────────────

describe('GET /data-market/router/status', () => {
  it('returns routing fabric health', async () => {
    r['archivalNode']['count'].mockResolvedValue(5);
    r['dataRetrieval']['count'].mockResolvedValue(3);

    const res = await request(app).get('/data-market/router/status');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('healthy');
    expect(res.body).toHaveProperty('activeNodes');
    expect(res.body).toHaveProperty('cacheHitRate');
    expect(res.body).toHaveProperty('avgFailoverMs');
  });
});

describe('GET /data-market/router/routes', () => {
  it('returns active routing rules', async () => {
    r['archivalNode']['findMany'].mockResolvedValue([
      {
        id: 'node1',
        address: 'GABC123',
        name: 'Test',
        reputation: 80,
        commission: 2.5,
        avgResponseTime: 150,
      },
    ]);

    const res = await request(app).get('/data-market/router/routes');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('routes');
    expect(res.body.routes[0]).toHaveProperty('priority');
    expect(res.body.routes[0]).toHaveProperty('score');
  });
});

describe('POST /data-market/router/rules', () => {
  it('adds a custom routing rule', async () => {
    const res = await request(app).post('/data-market/router/rules').send({
      name: 'prefer-low-latency',
      preference: 'latency',
    });

    expect(res.status).toBe(201);
    expect(res.body.rule.name).toBe('prefer-low-latency');
    expect(res.body.rule.preference).toBe('latency');
  });
});

describe('GET /data-market/analytics/dashboard', () => {
  it('returns full analytics dashboard', async () => {
    r['archivalNode']['aggregate'].mockResolvedValue({
      _count: 10,
      _avg: { reputation: 75, uptime30d: 98, avgResponseTime: 200 },
      _sum: { stakedAmount: 10000, totalEarnings: 500 },
    });
    r['storageChallenge']['groupBy'].mockResolvedValue([
      { status: 'verified', _count: 8 },
      { status: 'failed', _count: 2 },
    ]);
    r['dataRetrieval']['groupBy'].mockResolvedValue([{ status: 'completed', _count: 100 }]);
    r['archivalSlash']['aggregate'].mockResolvedValue({ _sum: { amount: 50 }, _count: 2 });
    r['archivalNode']['count'].mockResolvedValue(8);

    const res = await request(app).get('/data-market/analytics/dashboard');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('nodes');
    expect(res.body).toHaveProperty('challenges');
    expect(res.body).toHaveProperty('retrievals');
    expect(res.body).toHaveProperty('slashing');
    expect(res.body).toHaveProperty('timestamp');
  });
});

describe('GET /data-market/analytics/epoch-coverage', () => {
  it('identifies underserved epochs', async () => {
    r['archivalEpoch']['groupBy'].mockResolvedValue([
      { epochId: 1, status: 'stored', _count: { nodeId: 1 } },
      { epochId: 2, status: 'verified', _count: { nodeId: 4 } },
    ]);

    const res = await request(app).get('/data-market/analytics/epoch-coverage');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('underserved');
    expect(res.body.underservedCount).toBe(1);
    expect(res.body.underserved[0].epochId).toBe(1);
  });
});

describe('GET /data-market/analytics/node-churn', () => {
  it('returns node churn metrics', async () => {
    r['archivalNode']['count']
      .mockResolvedValueOnce(3) // registered
      .mockResolvedValueOnce(1) // deactivated
      .mockResolvedValueOnce(0) // jailed
      .mockResolvedValueOnce(20); // totalActive

    const res = await request(app).get('/data-market/analytics/node-churn?days=30');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ days: 30, registered: 3, deactivated: 1, jailed: 0 });
    expect(res.body).toHaveProperty('churnRate');
  });
});

describe('GET /data-market/tokenomics', () => {
  it('returns tokenomics data', async () => {
    r['archivalNode']['aggregate']
      .mockResolvedValueOnce({ _sum: { stakedAmount: 50000 } })
      .mockResolvedValueOnce({ _sum: { totalEarnings: 2500 } });
    r['archivalSlash']['aggregate'].mockResolvedValue({ _sum: { amount: 500 } });
    r['archivalNode']['count'].mockResolvedValue(25);

    const res = await request(app).get('/data-market/tokenomics');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      totalStaked: 50000,
      totalEarnings: 2500,
      totalBurned: 500,
      nodeCount: 25,
    });
    expect(res.body.stakingYield).toBeCloseTo(5, 0);
    expect(res.body).toHaveProperty('burnRate');
  });
});

describe('GET /data-market/leaderboard', () => {
  it('returns top nodes sorted by earnings', async () => {
    r['archivalNode']['findMany'].mockResolvedValue([
      { ...mockNode },
      { ...mockNode, address: 'GDEF456', totalEarnings: 50 },
    ]);

    const res = await request(app).get('/data-market/leaderboard?by=earnings&limit=10');

    expect(res.status).toBe(200);
    expect(res.body.leaderboard).toHaveLength(2);
    expect(res.body.leaderboard[0].rank).toBe(1);
    expect(res.body.sortedBy).toBe('earnings');
  });

  it('sorts by reputation when requested', async () => {
    r['archivalNode']['findMany'].mockResolvedValue([mockNode]);

    const res = await request(app).get('/data-market/leaderboard?by=reputation');

    expect(res.status).toBe(200);
    expect(res.body.sortedBy).toBe('reputation');
  });
});
