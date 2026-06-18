import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

// ── Mock Prisma before importing ──────────────────────────────────────────────

vi.mock('../src/db', () => ({
  prismaRead: {
    privacyTransaction: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      aggregate: vi.fn(),
      groupBy: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    privacyAnalytics: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    privacyProtocolDetail: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
    deAnonymizationFinding: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
    privacyComplianceReport: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      groupBy: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    anonymitySetSnapshot: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
    transaction: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
    contract: {
      findMany: vi.fn(),
    },
  },
  prismaWrite: {
    privacyTransaction: {
      upsert: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    privacyAnalytics: {
      create: vi.fn(),
    },
    privacyProtocolDetail: {
      create: vi.fn(),
    },
    deAnonymizationFinding: {
      create: vi.fn(),
    },
    privacyComplianceReport: {
      create: vi.fn(),
      update: vi.fn(),
    },
    anonymitySetSnapshot: {
      create: vi.fn(),
    },
  },
}));

import { prismaRead, prismaWrite } from '../src/db';
import { privacyRouter } from '../src/api/privacy';

// ── Test server setup ─────────────────────────────────────────────────────────

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/privacy', privacyRouter);

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

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PRIVACY_TX_FIXTURE = {
  id: 'priv-1',
  txHash: 'abc123priv',
  protocols: ['SHIELDED_TRANSFER', 'ZK_SNARK'],
  guarantees: ['AMOUNT_PRIVACY', 'FULL_PRIVACY'],
  cryptographicPrimitives: { zkSnark: true, shieldedTransfer: true, scheme: 'Groth16' },
  anonymitySetSize: 150,
  effectiveAnonymitySet: 120,
  privacyScore: 85.5,
  riskScore: 12.3,
  totalValue: '10000',
  usdValue: 10000.50,
  assetType: 'USDC',
  contractAddresses: ['CABCDEF1234567890'],
  participants: ['GABCDEF1234567890', 'G1234567890ABCDEF'],
  participantCount: 2,
  ledgerSequence: 12345,
  timestamp: new Date('2024-06-01T00:00:00Z'),
};

const PRIVACY_TX_2 = {
  ...PRIVACY_TX_FIXTURE,
  id: 'priv-2',
  txHash: 'def456priv',
  protocols: ['MIXER'],
  guarantees: ['FULL_PRIVACY'],
  anonymitySetSize: 500,
  privacyScore: 45.0,
  riskScore: 65.0,
  totalValue: '50000',
};

const COMPLIANCE_FIXTURE = {
  id: 'comp-1',
  address: 'GABCDEF1234567890',
  totalPrivateTx: 5,
  protocolsUsed: ['SHIELDED_TRANSFER', 'ZK_SNARK'],
  riskScore: 25.0,
  flagged: false,
  flagReason: null,
  complianceLabel: null,
  linkedAddresses: ['G1234567890ABCDEF'],
  lastActivity: new Date('2024-06-01T00:00:00Z'),
  reportGeneratedAt: new Date('2024-06-01T00:00:00Z'),
};

const FINDING_FIXTURE = {
  id: 'finding-1',
  sourceTx: 'abc123priv',
  targetAddress: 'GABCDEF1234567890',
  technique: 'common_input_ownership',
  confidence: 0.85,
  evidence: { matchingInputs: ['GABCDEF1234567890', 'G0987654321'] },
  linkedAddresses: ['G0987654321'],
  probability: 0.75,
  detectedAt: new Date('2024-06-01T00:00:00Z'),
};

// ── GET /api/v1/privacy/overview ─────────────────────────────────────────────

describe('GET /api/v1/privacy/overview', () => {
  it('returns privacy landscape overview', async () => {
    (prismaRead.privacyTransaction.count as ReturnType<typeof vi.fn>).mockResolvedValue(100);
    (prismaRead.transaction.count as ReturnType<typeof vi.fn>).mockResolvedValue(1000);
    (prismaRead.privacyTransaction.aggregate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      _sum: { usdValue: 500000 },
    });
    (prismaRead.privacyAnalytics.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (prismaRead.privacyTransaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      PRIVACY_TX_FIXTURE, PRIVACY_TX_2,
    ]);
    (prismaRead.privacyTransaction.aggregate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      _avg: { privacyScore: 65.25, riskScore: 38.65, anonymitySetSize: 325 },
    });

    const res = await fetch(`${baseUrl}/api/v1/privacy/overview`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveProperty('totalPrivateTx', 100);
    expect(body).toHaveProperty('totalTx', 1000);
    expect(body).toHaveProperty('privacyShare', 0.1);
    expect(body).toHaveProperty('byProtocol');
  });
});

// ── GET /api/v1/privacy/protocols ─────────────────────────────────────────────

describe('GET /api/v1/privacy/protocols', () => {
  it('returns all supported privacy protocols', async () => {
    (prismaRead.privacyTransaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      PRIVACY_TX_FIXTURE, PRIVACY_TX_2,
    ]);

    const res = await fetch(`${baseUrl}/api/v1/privacy/protocols`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.protocols.length).toBeGreaterThanOrEqual(10);
    expect(body.total).toBeGreaterThanOrEqual(10);
    expect(body.protocols[0]).toHaveProperty('id');
    expect(body.protocols[0]).toHaveProperty('name');
    expect(body.protocols[0]).toHaveProperty('description');
    expect(body.protocols[0]).toHaveProperty('category');
  });
});

// ── GET /api/v1/privacy/protocols/:protocol ──────────────────────────────────

describe('GET /api/v1/privacy/protocols/:protocol', () => {
  it('returns analytics for a specific protocol', async () => {
    (prismaRead.privacyProtocolDetail.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prismaRead.privacyTransaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([PRIVACY_TX_FIXTURE]);
    (prismaRead.privacyTransaction.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);
    (prismaRead.privacyTransaction.aggregate as ReturnType<typeof vi.fn>).mockResolvedValue({
      _avg: { privacyScore: 85.5, riskScore: 12.3, anonymitySetSize: 150 },
    });

    const res = await fetch(`${baseUrl}/api/v1/privacy/protocols/ZK_SNARK`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.protocol).toBeDefined();
    expect(body.totalTx).toBe(1);
  });

  it('returns 400 for unknown protocol', async () => {
    const res = await fetch(`${baseUrl}/api/v1/privacy/protocols/UNKNOWN_PROTOCOL`);
    expect(res.status).toBe(400);
  });
});

// ── GET /api/v1/privacy/transactions ─────────────────────────────────────────

describe('GET /api/v1/privacy/transactions', () => {
  it('returns paginated privacy transactions', async () => {
    (prismaRead.privacyTransaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([PRIVACY_TX_FIXTURE]);
    (prismaRead.privacyTransaction.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    const res = await fetch(`${baseUrl}/api/v1/privacy/transactions`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].txHash).toBe('abc123priv');
    expect(body.total).toBe(1);
  });

  it('filters by protocol', async () => {
    (prismaRead.privacyTransaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([PRIVACY_TX_FIXTURE]);
    (prismaRead.privacyTransaction.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    const res = await fetch(`${baseUrl}/api/v1/privacy/transactions?protocol=ZK_SNARK`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
  });

  it('filters by address', async () => {
    (prismaRead.privacyTransaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([PRIVACY_TX_FIXTURE]);
    (prismaRead.privacyTransaction.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    const res = await fetch(`${baseUrl}/api/v1/privacy/transactions?address=GABCDEF1234567890`);
    expect(res.status).toBe(200);
  });

  it('filters by date range', async () => {
    (prismaRead.privacyTransaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prismaRead.privacyTransaction.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);

    const res = await fetch(`${baseUrl}/api/v1/privacy/transactions?fromDate=2024-01-01&toDate=2024-12-31`);
    expect(res.status).toBe(200);
  });

  it('returns 400 for invalid limit', async () => {
    const res = await fetch(`${baseUrl}/api/v1/privacy/transactions?limit=999`);
    expect(res.status).toBe(400);
  });
});

// ── GET /api/v1/privacy/transactions/:txHash ─────────────────────────────────

describe('GET /api/v1/privacy/transactions/:txHash', () => {
  it('returns detailed privacy analysis for known tx', async () => {
    (prismaRead.privacyTransaction.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(PRIVACY_TX_FIXTURE);
    (prismaRead.transaction.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      hash: 'abc123priv',
      sourceAccount: 'GABCDEF1234567890',
    });
    (prismaRead.deAnonymizationFinding.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prismaRead.privacyComplianceReport.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const res = await fetch(`${baseUrl}/api/v1/privacy/transactions/abc123priv`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.txHash).toBe('abc123priv');
    expect(body.protocols).toContain('SHIELDED_TRANSFER');
    expect(body.protocolDetails).toHaveLength(2);
    expect(body).toHaveProperty('baseTransaction');
    expect(body).toHaveProperty('deAnonymizationFindings');
  });

  it('returns 404 for unknown tx', async () => {
    (prismaRead.privacyTransaction.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const res = await fetch(`${baseUrl}/api/v1/privacy/transactions/unknown`);
    expect(res.status).toBe(404);
  });
});

// ── GET /api/v1/privacy/history ──────────────────────────────────────────────

describe('GET /api/v1/privacy/history', () => {
  it('returns privacy adoption trend', async () => {
    (prismaRead.privacyAnalytics.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { timestamp: new Date(), period: 'day', totalPrivateTx: 10, totalTx: 100 },
    ]);

    const res = await fetch(`${baseUrl}/api/v1/privacy/history?days=30&granularity=day`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.days).toBe(30);
    expect(body.granularity).toBe('day');
    expect(body.data).toHaveLength(1);
  });
});

// ── GET /api/v1/privacy/leaderboard ──────────────────────────────────────────

describe('GET /api/v1/privacy/leaderboard', () => {
  it('returns top privacy-using contracts', async () => {
    (prismaRead.privacyTransaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      PRIVACY_TX_FIXTURE, PRIVACY_TX_2,
    ]);

    const res = await fetch(`${baseUrl}/api/v1/privacy/leaderboard`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveProperty('data');
    expect(body).toHaveProperty('metric');
  });
});

// ── GET /api/v1/privacy/anonymity-sets ───────────────────────────────────────

describe('GET /api/v1/privacy/anonymity-sets', () => {
  it('returns current anonymity set sizes', async () => {
    (prismaRead.anonymitySetSnapshot.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: '1', protocol: 'SHIELDED_TRANSFER', setSize: 150, effectiveSetSize: 120, timestamp: new Date() },
    ]);
    (prismaRead.privacyTransaction.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([
      { protocols: ['SHIELDED_TRANSFER'], _max: { anonymitySetSize: 150 }, _avg: { anonymitySetSize: 75 } },
    ]);

    const res = await fetch(`${baseUrl}/api/v1/privacy/anonymity-sets`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveProperty('snapshots');
    expect(body).toHaveProperty('current');
  });
});

// ── GET /api/v1/privacy/scores/transactions ──────────────────────────────────

describe('GET /api/v1/privacy/scores/transactions', () => {
  it('returns transactions ranked by privacy score', async () => {
    (prismaRead.privacyTransaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([PRIVACY_TX_FIXTURE]);
    (prismaRead.privacyTransaction.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    const res = await fetch(`${baseUrl}/api/v1/privacy/scores/transactions`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].privacyScore).toBe(85.5);
  });

  it('supports sorting by risk score', async () => {
    (prismaRead.privacyTransaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([PRIVACY_TX_2]);
    (prismaRead.privacyTransaction.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    const res = await fetch(`${baseUrl}/api/v1/privacy/scores/transactions?order=risk`);
    const body = await res.json();

    expect(res.status).toBe(200);
  });
});

// ── GET /api/v1/privacy/compliance/:address ──────────────────────────────────

describe('GET /api/v1/privacy/compliance/:address', () => {
  it('returns compliance report for address', async () => {
    (prismaRead.privacyComplianceReport.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(COMPLIANCE_FIXTURE);

    const res = await fetch(`${baseUrl}/api/v1/privacy/compliance/GABCDEF1234567890`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.address).toBe('GABCDEF1234567890');
    expect(body.totalPrivateTx).toBe(5);
  });

  it('generates new report when none exists', async () => {
    (prismaRead.privacyComplianceReport.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (prismaRead.privacyTransaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prismaWrite.privacyComplianceReport.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...COMPLIANCE_FIXTURE,
      id: 'comp-new',
    });

    const res = await fetch(`${baseUrl}/api/v1/privacy/compliance/GNEWADDRESS`);
    const body = await res.json();

    expect(res.status).toBe(200);
  });
});

// ── GET /api/v1/privacy/compliance/flagged ───────────────────────────────────

describe('GET /api/v1/privacy/compliance/flagged', () => {
  it('returns flagged addresses', async () => {
    (prismaRead.privacyComplianceReport.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { ...COMPLIANCE_FIXTURE, flagged: true, flagReason: 'Mixer usage', id: 'flagged-1' },
    ]);
    (prismaRead.privacyComplianceReport.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    const res = await fetch(`${baseUrl}/api/v1/privacy/compliance/flagged`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.total).toBe(1);
  });
});

// ── GET /api/v1/privacy/de-anonymization/findings ────────────────────────────

describe('GET /api/v1/privacy/de-anonymization/findings', () => {
  it('returns de-anonymization findings', async () => {
    (prismaRead.deAnonymizationFinding.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([FINDING_FIXTURE]);
    (prismaRead.deAnonymizationFinding.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    const res = await fetch(`${baseUrl}/api/v1/privacy/de-anonymization/findings`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].technique).toBe('common_input_ownership');
  });

  it('filters by technique', async () => {
    (prismaRead.deAnonymizationFinding.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([FINDING_FIXTURE]);
    (prismaRead.deAnonymizationFinding.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    const res = await fetch(`${baseUrl}/api/v1/privacy/de-anonymization/findings?technique=common_input_ownership`);
    expect(res.status).toBe(200);
  });
});

// ── Should-Have Endpoints ─────────────────────────────────────────────────────

describe('Should-Have Endpoints', () => {
  beforeEach(() => {
    (prismaRead.transaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { hash: 'tx1', sourceAccount: 'GADDR1', contractAddress: null, ledgerSequence: 100, ledgerCloseTime: new Date(), functionName: 'transfer', status: 'success' },
      { hash: 'tx2', sourceAccount: 'GADDR2', contractAddress: null, ledgerSequence: 101, ledgerCloseTime: new Date(), functionName: 'swap', status: 'success' },
    ]);
    (prismaRead.privacyTransaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prismaRead.privacyTransaction.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (prismaRead.privacyComplianceReport.count as ReturnType<typeof vi.fn>).mockResolvedValue(50);
    (prismaRead.privacyComplianceReport.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prismaRead.privacyComplianceReport.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prismaRead.anonymitySetSnapshot.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  });

  it('GET /privacy/de-anonymization/clusters', async () => {
    const res = await fetch(`${baseUrl}/api/v1/privacy/de-anonymization/clusters`);
    expect(res.status).toBe(200);
  });

  it('GET /privacy/de-anonymization/timing/:address', async () => {
    const res = await fetch(`${baseUrl}/api/v1/privacy/de-anonymization/timing/GABCDEF1234567890`);
    expect(res.status).toBe(200);
  });

  it('GET /privacy/de-anonymization/amount/:address', async () => {
    const res = await fetch(`${baseUrl}/api/v1/privacy/de-anonymization/amount/GABCDEF1234567890`);
    expect(res.status).toBe(200);
  });

  it('GET /privacy/de-anonymization/taint/:address', async () => {
    const res = await fetch(`${baseUrl}/api/v1/privacy/de-anonymization/taint/GABCDEF1234567890?depth=3`);
    expect(res.status).toBe(200);
  });

  it('GET /privacy/anonymity-sets/effective', async () => {
    const res = await fetch(`${baseUrl}/api/v1/privacy/anonymity-sets/effective`);
    expect(res.status).toBe(200);
  });

  it('GET /privacy/compliance/dashboard', async () => {
    const res = await fetch(`${baseUrl}/api/v1/privacy/compliance/dashboard`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveProperty('totalReports');
    expect(body).toHaveProperty('flaggedReports');
  });
});

// ── POST /api/v1/privacy/compliance/flag ─────────────────────────────────────

describe('POST /api/v1/privacy/compliance/flag', () => {
  it('flags an address for compliance', async () => {
    (prismaRead.privacyComplianceReport.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (prismaWrite.privacyComplianceReport.create as ReturnType<typeof vi.fn>).mockResolvedValue(COMPLIANCE_FIXTURE);

    const res = await fetch(`${baseUrl}/api/v1/privacy/compliance/flag`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: 'GFLAGGED123', reason: 'Suspicious activity' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.flagged).toBe(true);
  });

  it('returns 400 for missing address', async () => {
    const res = await fetch(`${baseUrl}/api/v1/privacy/compliance/flag`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

// ── POST /api/v1/privacy/compliance/unflag/:address ──────────────────────────

describe('POST /api/v1/privacy/compliance/unflag/:address', () => {
  it('unflags an address', async () => {
    (prismaWrite.privacyComplianceReport.update as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...COMPLIANCE_FIXTURE,
      flagged: false,
    });

    const res = await fetch(`${baseUrl}/api/v1/privacy/compliance/unflag/GABCDEF1234567890`, {
      method: 'POST',
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.flagged).toBe(false);
  });
});

// ── GET /api/v1/privacy/compliance/report/:address/export ─────────────────────

describe('GET /api/v1/privacy/compliance/report/:address/export', () => {
  it('exports compliance report as JSON', async () => {
    (prismaRead.privacyComplianceReport.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(COMPLIANCE_FIXTURE);

    const res = await fetch(`${baseUrl}/api/v1/privacy/compliance/report/GABCDEF1234567890/export?format=json`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.address).toBe('GABCDEF1234567890');
  });

  it('exports compliance report as text', async () => {
    (prismaRead.privacyComplianceReport.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(COMPLIANCE_FIXTURE);

    const res = await fetch(`${baseUrl}/api/v1/privacy/compliance/report/GABCDEF1234567890/export?format=txt`);

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('Compliance Report for GABCDEF1234567890');
  });

  it('returns 404 for unknown address', async () => {
    (prismaRead.privacyComplianceReport.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const res = await fetch(`${baseUrl}/api/v1/privacy/compliance/report/GUNKNOWN/export`);
    expect(res.status).toBe(404);
  });
});

// ── Nice-to-Have: Research Tools ──────────────────────────────────────────────

describe('POST /api/v1/privacy/research/graph', () => {
  beforeEach(() => {
    (prismaRead.transaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { hash: 'tx1', sourceAccount: 'GABCDEF1234567890', contractAddress: 'CABC123', ledgerSequence: 100, ledgerCloseTime: new Date(), functionName: 'transfer', status: 'success' },
    ]);
    (prismaRead.privacyTransaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  });

  it('exports transaction graph as JSON', async () => {
    const res = await fetch(`${baseUrl}/api/v1/privacy/research/graph`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addresses: ['GABCDEF1234567890'], depth: 1, format: 'json' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveProperty('nodes');
    expect(body).toHaveProperty('edges');
    expect(body).toHaveProperty('metadata');
  });

  it('exports transaction graph as CSV', async () => {
    const res = await fetch(`${baseUrl}/api/v1/privacy/research/graph`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addresses: ['GABCDEF1234567890'], depth: 1, format: 'csv' }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/csv');
  });

  it('exports transaction graph as GraphML', async () => {
    const res = await fetch(`${baseUrl}/api/v1/privacy/research/graph`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addresses: ['GABCDEF1234567890'], depth: 1, format: 'graphml' }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/xml');
  });

  it('exports transaction graph as GEXF', async () => {
    const res = await fetch(`${baseUrl}/api/v1/privacy/research/graph`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addresses: ['GABCDEF1234567890'], depth: 1, format: 'gexf' }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/xml');
  });
});

describe('POST /api/v1/privacy/research/analyze-cluster', () => {
  beforeEach(() => {
    (prismaRead.transaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { hash: 'tx1', sourceAccount: 'GADDR1', contractAddress: 'CABC1', ledgerSequence: 100, ledgerCloseTime: new Date(), functionName: 'transfer', status: 'success' },
      { hash: 'tx2', sourceAccount: 'GADDR2', contractAddress: 'CABC2', ledgerSequence: 101, ledgerCloseTime: new Date(), functionName: 'swap', status: 'success' },
    ]);
    (prismaRead.privacyTransaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  });

  it('analyzes a cluster of addresses', async () => {
    const res = await fetch(`${baseUrl}/api/v1/privacy/research/analyze-cluster`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addresses: ['GADDR1', 'GADDR2', 'GADDR3'] }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveProperty('addresses');
    expect(body).toHaveProperty('totalTx');
    expect(body).toHaveProperty('privacyTx');
  });
});

describe('GET /api/v1/privacy/research/datasets', () => {
  it('returns available research datasets', async () => {
    (prismaRead.privacyTransaction.count as ReturnType<typeof vi.fn>).mockResolvedValue(100);
    (prismaRead.privacyTransaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      PRIVACY_TX_FIXTURE, PRIVACY_TX_2,
    ]);

    const res = await fetch(`${baseUrl}/api/v1/privacy/research/datasets`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.datasets).toHaveLength(1);
    expect(body).toHaveProperty('availableProtocols');
  });
});

// ── Nice-to-Have: Protocol Registry ───────────────────────────────────────────

describe('GET /api/v1/privacy/registry', () => {
  it('returns privacy protocol registry', async () => {
    const res = await fetch(`${baseUrl}/api/v1/privacy/registry`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.protocols.length).toBeGreaterThanOrEqual(10);
    expect(body.total).toBeGreaterThanOrEqual(10);
  });
});

// ── Nice-to-Have: Compliance Screening ────────────────────────────────────────

describe('POST /api/v1/privacy/compliance/screen', () => {
  it('screens an address for compliance', async () => {
    (prismaRead.privacyTransaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([PRIVACY_TX_FIXTURE]);

    const res = await fetch(`${baseUrl}/api/v1/privacy/compliance/screen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: 'GABCDEF1234567890' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveProperty('riskLevel');
    expect(body).toHaveProperty('riskScore');
    expect(body).toHaveProperty('flags');
  });
});

// ── Nice-to-Have: Cross-Protocol Analysis ─────────────────────────────────────

describe('GET /api/v1/privacy/cross-protocol/:address', () => {
  it('analyzes privacy posture across protocols', async () => {
    (prismaRead.privacyTransaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      PRIVACY_TX_FIXTURE, PRIVACY_TX_2,
    ]);

    const res = await fetch(`${baseUrl}/api/v1/privacy/cross-protocol/GABCDEF1234567890`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveProperty('totalPrivacyTx');
    expect(body).toHaveProperty('uniqueProtocols');
    expect(body).toHaveProperty('protocolUsage');
    expect(body).toHaveProperty('aggregatePrivacyScore');
    expect(body).toHaveProperty('assessment');
  });
});

// ── Stretch: ZK Dashboard ─────────────────────────────────────────────────────

describe('GET /api/v1/privacy/zk/verifiers', () => {
  it('returns ZK verifier contracts', async () => {
    (prismaRead.privacyTransaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([PRIVACY_TX_FIXTURE]);

    const res = await fetch(`${baseUrl}/api/v1/privacy/zk/verifiers`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveProperty('verifiers');
  });
});

describe('GET /api/v1/privacy/zk/proofs', () => {
  it('returns ZK proofs', async () => {
    (prismaRead.privacyTransaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([PRIVACY_TX_FIXTURE]);
    (prismaRead.privacyTransaction.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    const res = await fetch(`${baseUrl}/api/v1/privacy/zk/proofs`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveProperty('data');
  });
});

describe('GET /api/v1/privacy/zk/benchmarks', () => {
  it('returns ZK proof benchmarks', async () => {
    (prismaRead.privacyTransaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([PRIVACY_TX_FIXTURE]);

    const res = await fetch(`${baseUrl}/api/v1/privacy/zk/benchmarks`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveProperty('benchmarks');
    expect(body).toHaveProperty('totalSamples');
  });
});

// ── Stretch: DeFi Privacy ─────────────────────────────────────────────────────

describe('GET /api/v1/privacy/defi', () => {
  it('returns DeFi privacy dashboard', async () => {
    (prismaRead.contract.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { address: 'CDEFI123', name: 'DefiProtocol' },
    ]);
    (prismaRead.privacyTransaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prismaRead.transaction.count as ReturnType<typeof vi.fn>).mockResolvedValue(100);

    const res = await fetch(`${baseUrl}/api/v1/privacy/defi`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveProperty('totalDefiTx');
    expect(body).toHaveProperty('defiPrivacyTx');
    expect(body).toHaveProperty('privacyAdoptionRate');
  });
});

// ── Stretch: Cross-Chain Bridges ──────────────────────────────────────────────

describe('GET /api/v1/privacy/bridges', () => {
  it('returns cross-chain privacy flow dashboard', async () => {
    (prismaRead.privacyTransaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      PRIVACY_TX_FIXTURE, PRIVACY_TX_2,
    ]);

    const res = await fetch(`${baseUrl}/api/v1/privacy/bridges`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveProperty('totalBridgeTxs');
    expect(body).toHaveProperty('totalVolume');
    expect(body).toHaveProperty('uniqueUsers');
  });
});

// ── Score History ─────────────────────────────────────────────────────────────

describe('GET /api/v1/privacy/history/:protocol', () => {
  it('returns protocol-specific trend', async () => {
    (prismaRead.privacyProtocolDetail.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: '1', protocol: 'SHIELDED_TRANSFER', txCount: 10, timestamp: new Date() },
    ]);

    const res = await fetch(`${baseUrl}/api/v1/privacy/history/SHIELDED_TRANSFER?days=30`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.protocol).toBeDefined();
    expect(body.data).toHaveLength(1);
  });
});

// ── Leaderboard Users ─────────────────────────────────────────────────────────

describe('GET /api/v1/privacy/leaderboard/users', () => {
  it('returns top privacy-using addresses', async () => {
    (prismaRead.privacyTransaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      PRIVACY_TX_FIXTURE, PRIVACY_TX_2,
    ]);

    const res = await fetch(`${baseUrl}/api/v1/privacy/leaderboard/users`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveProperty('data');
  });
});

// ── Anonymity Set History ─────────────────────────────────────────────────────

describe('GET /api/v1/privacy/anonymity-sets/:protocol/history', () => {
  it('returns anonymity set growth over time', async () => {
    (prismaRead.anonymitySetSnapshot.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: '1', protocol: 'SHIELDED_TRANSFER', setSize: 100, timestamp: new Date() },
      { id: '2', protocol: 'SHIELDED_TRANSFER', setSize: 150, timestamp: new Date() },
    ]);

    const res = await fetch(`${baseUrl}/api/v1/privacy/anonymity-sets/SHIELDED_TRANSFER/history?days=30`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.protocol).toBe('SHIELDED_TRANSFER');
    expect(body.data).toHaveLength(2);
  });
});

// ── Contract Scores ───────────────────────────────────────────────────────────

describe('GET /api/v1/privacy/scores/contracts', () => {
  it('returns contracts ranked by privacy score', async () => {
    (prismaRead.privacyTransaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      PRIVACY_TX_FIXTURE, PRIVACY_TX_2,
    ]);

    const res = await fetch(`${baseUrl}/api/v1/privacy/scores/contracts`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveProperty('data');
  });
});

// ── ML Prediction ─────────────────────────────────────────────────────────────

describe('GET /api/v1/privacy/ml/predict-anonymity', () => {
  it('predicts future anonymity set size', async () => {
    (prismaRead.privacyTransaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { anonymitySetSize: 100, timestamp: new Date(), protocols: ['SHIELDED_TRANSFER'] },
      { anonymitySetSize: 150, timestamp: new Date(), protocols: ['SHIELDED_TRANSFER'] },
      { anonymitySetSize: 200, timestamp: new Date(), protocols: ['SHIELDED_TRANSFER'] },
    ]);

    const res = await fetch(`${baseUrl}/api/v1/privacy/ml/predict-anonymity?protocol=SHIELDED_TRANSFER&days=30`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveProperty('predicted');
    expect(body).toHaveProperty('trend');
    expect(body).toHaveProperty('confidence');
  });
});

// ── ZK Verifier Detail ────────────────────────────────────────────────────────

describe('GET /api/v1/privacy/zk/verifiers/:address', () => {
  it('returns specific verifier analytics', async () => {
    (prismaRead.privacyTransaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([PRIVACY_TX_FIXTURE]);

    const res = await fetch(`${baseUrl}/api/v1/privacy/zk/verifiers/CZKVERIFIER123`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveProperty('address');
    expect(body).toHaveProperty('totalTx');
  });
});

// ── Compliance Periodic Reports ───────────────────────────────────────────────

describe('GET /api/v1/privacy/compliance/reports/periodic', () => {
  it('returns periodic compliance reports', async () => {
    (prismaRead.privacyComplianceReport.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      COMPLIANCE_FIXTURE,
    ]);

    const res = await fetch(`${baseUrl}/api/v1/privacy/compliance/reports/periodic?days=30`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveProperty('totalReports');
    expect(body).toHaveProperty('flaggedReports');
    expect(body).toHaveProperty('period');
  });
});

// ── Privacy Detection Engine Tests ────────────────────────────────────────────

describe('Privacy Detection Engine (unit)', () => {
  it('detects ZK_SNARK from function name', async () => {
    const { detectPrivacyTechniques } = await import('../src/indexer/privacy-detector');
    const result = detectPrivacyTechniques('verify_groth16', []);
    expect(result.protocols).toContain('ZK_SNARK');
    expect(result.cryptographicPrimitives.scheme).toBe('Groth16');
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('detects ZK_STARK from function name', async () => {
    const { detectPrivacyTechniques } = await import('../src/indexer/privacy-detector');
    const result = detectPrivacyTechniques('verify_stark_proof', []);
    expect(result.protocols).toContain('ZK_STARK');
  });

  it('detects BULLETPROOF from function name', async () => {
    const { detectPrivacyTechniques } = await import('../src/indexer/privacy-detector');
    const result = detectPrivacyTechniques('verify_range_proof', []);
    expect(result.protocols).toContain('BULLETPROOF');
    expect(result.cryptographicPrimitives.proofType).toBe('range_proof');
  });

  it('detects STEALTH_ADDRESS from function name', async () => {
    const { detectPrivacyTechniques } = await import('../src/indexer/privacy-detector');
    const result = detectPrivacyTechniques('generate_stealth_address', []);
    expect(result.protocols).toContain('STEALTH_ADDRESS');
  });

  it('detects MIXER from function name', async () => {
    const { detectPrivacyTechniques } = await import('../src/indexer/privacy-detector');
    const result = detectPrivacyTechniques('mixer_deposit', []);
    expect(result.protocols).toContain('MIXER');
    expect(result.cryptographicPrimitives.mixerAction).toBe('deposit');
  });

  it('detects PRIVATE_VOTING from function name', async () => {
    const { detectPrivacyTechniques } = await import('../src/indexer/privacy-detector');
    const result = detectPrivacyTechniques('commit_vote_private', []);
    expect(result.protocols).toContain('PRIVATE_VOTING');
  });

  it('detects OFF_CHAIN_DATA from function name', async () => {
    const { detectPrivacyTechniques } = await import('../src/indexer/privacy-detector');
    const result = detectPrivacyTechniques('submit_offchain_proof', []);
    expect(result.protocols).toContain('OFF_CHAIN_DATA');
  });

  it('detects ENCRYPTED_STATE from function name', async () => {
    const { detectPrivacyTechniques } = await import('../src/indexer/privacy-detector');
    const result = detectPrivacyTechniques('store_encrypted_state', []);
    expect(result.protocols).toContain('ENCRYPTED_STATE');
  });

  it('detects DIFFERENTIAL_PRIVACY from function name', async () => {
    const { detectPrivacyTechniques } = await import('../src/indexer/privacy-detector');
    const result = detectPrivacyTechniques('dp_aggregator_query', []);
    expect(result.protocols).toContain('DIFFERENTIAL_PRIVACY');
  });

  it('detects SHIELDED_TRANSFER from function name', async () => {
    const { detectPrivacyTechniques } = await import('../src/indexer/privacy-detector');
    const result = detectPrivacyTechniques('shielded_transfer', []);
    expect(result.protocols).toContain('SHIELDED_TRANSFER');
  });

  it('detects multiple protocols in one transaction', async () => {
    const { detectPrivacyTechniques } = await import('../src/indexer/privacy-detector');
    const result = detectPrivacyTechniques('verify_groth16_shielded_transfer', []);
    expect(result.protocols).toContain('ZK_SNARK');
    expect(result.protocols).toContain('SHIELDED_TRANSFER');
  });

  it('returns empty protocols for non-privacy function', async () => {
    const { detectPrivacyTechniques } = await import('../src/indexer/privacy-detector');
    const result = detectPrivacyTechniques('transfer', []);
    expect(result.protocols).toHaveLength(0);
    expect(result.confidence).toBe(0);
  });

  it('returns empty protocols for null function name', async () => {
    const { detectPrivacyTechniques } = await import('../src/indexer/privacy-detector');
    const result = detectPrivacyTechniques(null, []);
    expect(result.protocols).toHaveLength(0);
  });
});

// ── Privacy Scoring Engine Tests ──────────────────────────────────────────────

describe('Privacy Scoring Engine (unit)', () => {
  it('computes high privacy score for strong protocols with large anonymity set', async () => {
    const { computePrivacyScore } = await import('../src/indexer/privacy-scorer');
    const result = await computePrivacyScore(
      ['ZK_SNARK', 'SHIELDED_TRANSFER'],
      ['FULL_PRIVACY', 'AMOUNT_PRIVACY'],
      500,
      'GABCDEF1234567890',
      ['CABC123'],
    );
    expect(result.privacyScore).toBeGreaterThanOrEqual(50);
    expect(result.privacyScore).toBeLessThanOrEqual(100);
    expect(result.breakdown.protocolDiversity).toBeGreaterThan(0);
    expect(result.breakdown.anonymitySetScore).toBe(20);
    expect(result.breakdown.cryptographicStrength).toBeGreaterThan(0);
  });

  it('computes low privacy score for weak protocols without anonymity set', async () => {
    const { computePrivacyScore } = await import('../src/indexer/privacy-scorer');
    const result = await computePrivacyScore(
      ['SHIELDED_TRANSFER'],
      ['AMOUNT_PRIVACY'],
      null,
      null,
      [],
    );
    expect(result.privacyScore).toBeGreaterThanOrEqual(0);
  });

  it('computes risk score inversely related to privacy', async () => {
    const { computePrivacyScore } = await import('../src/indexer/privacy-scorer');
    const highPrivacy = await computePrivacyScore(
      ['ZK_SNARK', 'ZK_STARK', 'BULLETPROOF'],
      ['FULL_PRIVACY'],
      5000,
      null,
      [],
    );
    const lowPrivacy = await computePrivacyScore(
      ['SHIELDED_TRANSFER'],
      ['AMOUNT_PRIVACY'],
      3,
      null,
      [],
    );
    expect(highPrivacy.riskScore).toBeLessThanOrEqual(lowPrivacy.riskScore);
  });

  it('computes scores consistently (0-100 range)', async () => {
    const { computePrivacyScore } = await import('../src/indexer/privacy-scorer');
    const result = await computePrivacyScore(
      ['ZK_SNARK'],
      ['FULL_PRIVACY'],
      100,
      'GABCDEF1234567890',
      ['CABC123'],
    );
    expect(result.privacyScore).toBeGreaterThanOrEqual(0);
    expect(result.privacyScore).toBeLessThanOrEqual(100);
    expect(result.riskScore).toBeGreaterThanOrEqual(0);
    expect(result.riskScore).toBeLessThanOrEqual(100);
  });

  it('scores increase with protocol diversity', async () => {
    const { computePrivacyScore } = await import('../src/indexer/privacy-scorer');
    const single = await computePrivacyScore(['ZK_SNARK'], ['FULL_PRIVACY'], 100, null, []);
    const multi = await computePrivacyScore(
      ['ZK_SNARK', 'BULLETPROOF', 'STEALTH_ADDRESS'],
      ['FULL_PRIVACY', 'AMOUNT_PRIVACY', 'RECIPIENT_PRIVACY'],
      100,
      null,
      [],
    );
    expect(multi.breakdown.protocolDiversity).toBeGreaterThan(single.breakdown.protocolDiversity);
  });

  it('scores increase with larger anonymity sets', async () => {
    const { computePrivacyScore } = await import('../src/indexer/privacy-scorer');
    const small = await computePrivacyScore(['ZK_SNARK'], ['FULL_PRIVACY'], 5, null, []);
    const large = await computePrivacyScore(['ZK_SNARK'], ['FULL_PRIVACY'], 5000, null, []);
    expect(large.breakdown.anonymitySetScore).toBeGreaterThan(small.breakdown.anonymitySetScore);
  });
});

// ── Privacy Graph Analysis Tests ──────────────────────────────────────────────

describe('Privacy Graph Analysis (unit)', () => {
  beforeEach(() => {
    (prismaRead.transaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { hash: 'tx1', sourceAccount: 'GADDR1', contractAddress: 'CADDR1', ledgerSequence: 100, ledgerCloseTime: new Date(), functionName: 'transfer', status: 'success' },
      { hash: 'tx2', sourceAccount: 'GADDR2', contractAddress: 'CADDR2', ledgerSequence: 101, ledgerCloseTime: new Date(), functionName: 'swap', status: 'success' },
    ]);
    (prismaRead.privacyTransaction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { txHash: 'tx1', protocols: ['SHIELDED_TRANSFER'], privacyScore: 80, totalValue: '1000', timestamp: new Date(), participants: ['GADDR1'] },
    ]);
    (prismaRead.privacyTransaction.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  });

  it('analyzeTiming returns correlations and patterns', async () => {
    const { analyzeTiming } = await import('../src/indexer/privacy-graph');
    const result = await analyzeTiming('GABCDEF1234567890');
    expect(result).toHaveProperty('address');
    expect(result).toHaveProperty('correlations');
    expect(result).toHaveProperty('patterns');
  });

  it('analyzeAmountCorrelation detects round numbers', async () => {
    const { analyzeAmountCorrelation } = await import('../src/indexer/privacy-graph');
    const result = await analyzeAmountCorrelation('GABCDEF1234567890');
    expect(result).toHaveProperty('address');
    expect(result).toHaveProperty('matches');
  });

  it('buildTransactionGraph returns graph structure', async () => {
    const { buildTransactionGraph } = await import('../src/indexer/privacy-graph');
    const result = await buildTransactionGraph(['GABCDEF1234567890'], 1);
    expect(result).toHaveProperty('nodes');
    expect(result).toHaveProperty('edges');
    expect(result).toHaveProperty('metadata');
  });

  it('analyzeCluster returns cluster analysis', async () => {
    const { analyzeCluster } = await import('../src/indexer/privacy-graph');
    const result = await analyzeCluster(['GADDR1', 'GADDR2']);
    expect(result).toHaveProperty('totalTx');
    expect(result).toHaveProperty('privacyTx');
    expect(result).toHaveProperty('privacyRate');
  });

  it('findCommonInputClusters returns clusters', async () => {
    const { findCommonInputClusters } = await import('../src/indexer/privacy-graph');
    const result = await findCommonInputClusters(100);
    expect(Array.isArray(result)).toBe(true);
  });

  it('getEffectiveAnonymitySets returns comparison data', async () => {
    (prismaRead.anonymitySetSnapshot.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: '1', protocol: 'SHIELDED_TRANSFER', setSize: 150, effectiveSetSize: 120, timestamp: new Date() },
    ]);
    const { getEffectiveAnonymitySets } = await import('../src/indexer/privacy-graph');
    const result = await getEffectiveAnonymitySets();
    expect(Array.isArray(result)).toBe(true);
  });

  it('analyzeTaint traces funds through protocols', async () => {
    (prismaRead.privacyTransaction.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      txHash: 'tx1', protocols: ['MIXER'], totalValue: '5000', participants: ['GADDR1', 'GADDR2'],
    });
    const { analyzeTaint } = await import('../src/indexer/privacy-graph');
    const result = await analyzeTaint('GADDR1', 2);
    expect(result).toHaveProperty('address');
    expect(result).toHaveProperty('depth', 2);
    expect(result).toHaveProperty('path');
  });
});

// ── POST /api/v1/privacy/detect ──────────────────────────────────────────────

describe('POST /api/v1/privacy/detect', () => {
  it('detects and scores privacy techniques', async () => {
    const res = await fetch(`${baseUrl}/api/v1/privacy/detect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        functionName: 'verify_groth16_private_transfer',
        protocols: ['ZK_SNARK', 'SHIELDED_TRANSFER'],
        anonymitySetSize: 500,
        sourceAccount: 'GABCDEF1234567890',
        contractAddresses: ['CABC123'],
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.detection.protocols).toContain('ZK_SNARK');
    expect(body.detection.protocols).toContain('SHIELDED_TRANSFER');
    expect(body.score).toHaveProperty('privacyScore');
    expect(body.score).toHaveProperty('riskScore');
    expect(body.score).toHaveProperty('breakdown');
  });
});
