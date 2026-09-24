/**
 * Tests for SAC Trustlines API
 *
 * Verifies that all endpoints read real data from the sacTrustlineMapping
 * table (via the sac-trustline-mapper helpers) and that no response
 * contains the legacy "simulated" status value.
 *
 * Closes #637 [E8][STUB] SAC trustlines endpoint returns "simulated" status
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// ── Mock sac-trustline-mapper BEFORE importing the router ─────────────────────
vi.mock('../../src/indexer/sac-trustline-mapper', () => ({
  getTrustlinesByAccount: vi.fn(),
  getTrustlinesBySac: vi.fn(),
  getSacTrustlineStats: vi.fn(),
}));

// Mock prismaRead used for sacMapping lookups
vi.mock('../../src/db', () => ({
  prismaRead: {
    sacMapping: {
      findFirst: vi.fn(),
    },
    sacTrustlineMapping: {
      findMany: vi.fn(),
    },
  },
  prismaWrite: {},
}));

import { sacTrustlinesRouter } from '../../src/api/sac-trustlines';
import {
  getTrustlinesByAccount,
  getTrustlinesBySac,
  getSacTrustlineStats,
} from '../../src/indexer/sac-trustline-mapper';
import { prismaRead } from '../../src/db';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MOCK_TRUSTLINE = {
  gAccount: 'GABC123',
  sacAddress: 'CSAC456',
  assetCode: 'USDC',
  assetIssuer: 'GISSUER789',
  assetType: 'credit_alphanum4',
  trustlineLimit: '9223372036854775807',
  isUnlimited: true,
  status: 'active',
  transactionHash: 'txhash001',
  ledgerSequence: 100,
  ledgerCloseTime: new Date('2025-01-01T00:00:00Z'),
  changeTrustOpLedger: null,
  changeTrustOpTxHash: null,
  origin: 'soroban',
  humanReadable: 'GABC123 → USDC trustline (unlimited) [active]',
};

const MOCK_SAC_MAPPING = {
  id: 'cuid1',
  assetCode: 'USDC',
  assetIssuer: 'GISSUER789',
  assetType: 'credit_alphanum4',
  sacAddress: 'CSAC456',
  firstSeenLedger: 90,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const MOCK_STATS = {
  totalTrustlines: 42,
  activeTrustlines: 38,
  unlimitedTrustlines: 30,
  uniqueAssets: 5,
  topAssets: [{ assetCode: 'USDC', count: 20 }],
};

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/sac-trustlines', sacTrustlinesRouter);
  return app;
}

// ── Helper: assert no response field equals "simulated" ───────────────────────

function assertNoSimulatedStatus(body: unknown): void {
  const json = JSON.stringify(body);
  expect(json).not.toContain('"simulated"');
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /sac-trustlines
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /sac-trustlines', () => {
  it('returns service info', async () => {
    const res = await request(makeApp()).get('/sac-trustlines');
    expect(res.status).toBe(200);
    expect(res.body.service).toBe('SAC Trustlines API');
    expect(Array.isArray(res.body.endpoints)).toBe(true);
    assertNoSimulatedStatus(res.body);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /sac-trustlines/assets/:assetCode
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /sac-trustlines/assets/:assetCode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns trustlines from the indexer when SAC mapping exists', async () => {
    vi.mocked(prismaRead.sacMapping.findFirst).mockResolvedValue(MOCK_SAC_MAPPING as any);
    vi.mocked(getTrustlinesBySac).mockResolvedValue([MOCK_TRUSTLINE]);

    const res = await request(makeApp()).get('/sac-trustlines/assets/usdc');
    expect(res.status).toBe(200);
    expect(res.body.assetCode).toBe('USDC');
    expect(res.body.sacAddress).toBe('CSAC456');
    expect(Array.isArray(res.body.trustlines)).toBe(true);
    expect(res.body.trustlines).toHaveLength(1);
    expect(res.body.total).toBe(1);
    assertNoSimulatedStatus(res.body);
  });

  it('returns empty trustlines when no SAC mapping and no direct records', async () => {
    vi.mocked(prismaRead.sacMapping.findFirst).mockResolvedValue(null);
    vi.mocked(prismaRead.sacTrustlineMapping.findMany).mockResolvedValue([]);

    const res = await request(makeApp()).get('/sac-trustlines/assets/UNKNOWN');
    expect(res.status).toBe(200);
    expect(res.body.trustlines).toHaveLength(0);
    expect(res.body.sacAddress).toBeNull();
    assertNoSimulatedStatus(res.body);
  });

  it('filters by authorized=true, returning only active trustlines', async () => {
    const inactiveTrustline = { ...MOCK_TRUSTLINE, status: 'deactivated' };
    vi.mocked(prismaRead.sacMapping.findFirst).mockResolvedValue(MOCK_SAC_MAPPING as any);
    vi.mocked(getTrustlinesBySac).mockResolvedValue([MOCK_TRUSTLINE, inactiveTrustline]);

    const res = await request(makeApp()).get('/sac-trustlines/assets/usdc?authorized=true');
    expect(res.status).toBe(200);
    expect(res.body.trustlines).toHaveLength(1);
    expect(res.body.trustlines[0].status).toBe('active');
    assertNoSimulatedStatus(res.body);
  });

  it('filters by authorized=false, returning only non-active trustlines', async () => {
    const inactiveTrustline = { ...MOCK_TRUSTLINE, status: 'deactivated' };
    vi.mocked(prismaRead.sacMapping.findFirst).mockResolvedValue(MOCK_SAC_MAPPING as any);
    vi.mocked(getTrustlinesBySac).mockResolvedValue([MOCK_TRUSTLINE, inactiveTrustline]);

    const res = await request(makeApp()).get('/sac-trustlines/assets/usdc?authorized=false');
    expect(res.status).toBe(200);
    expect(res.body.trustlines).toHaveLength(1);
    expect(res.body.trustlines[0].status).toBe('deactivated');
    assertNoSimulatedStatus(res.body);
  });

  it('respects limit parameter (capped at 200)', async () => {
    vi.mocked(prismaRead.sacMapping.findFirst).mockResolvedValue(MOCK_SAC_MAPPING as any);
    vi.mocked(getTrustlinesBySac).mockResolvedValue([]);

    await request(makeApp()).get('/sac-trustlines/assets/usdc?limit=10');
    expect(getTrustlinesBySac).toHaveBeenCalledWith('CSAC456', 10);
  });

  it('returns 500 on database error', async () => {
    vi.mocked(prismaRead.sacMapping.findFirst).mockRejectedValue(new Error('DB error'));

    const res = await request(makeApp()).get('/sac-trustlines/assets/usdc');
    expect(res.status).toBe(500);
    assertNoSimulatedStatus(res.body);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /sac-trustlines/accounts/:address
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /sac-trustlines/accounts/:address', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns real trustlines for an account from the indexer', async () => {
    vi.mocked(getTrustlinesByAccount).mockResolvedValue([MOCK_TRUSTLINE]);

    const res = await request(makeApp()).get('/sac-trustlines/accounts/GABC123');
    expect(res.status).toBe(200);
    expect(res.body.address).toBe('GABC123');
    expect(Array.isArray(res.body.trustlines)).toBe(true);
    expect(res.body.trustlines).toHaveLength(1);
    expect(res.body.total).toBe(1);
    assertNoSimulatedStatus(res.body);
  });

  it('returns empty trustlines array when account has no SAC trustlines', async () => {
    vi.mocked(getTrustlinesByAccount).mockResolvedValue([]);

    const res = await request(makeApp()).get('/sac-trustlines/accounts/GNONE');
    expect(res.status).toBe(200);
    expect(res.body.trustlines).toHaveLength(0);
    expect(res.body.total).toBe(0);
    assertNoSimulatedStatus(res.body);
  });

  it('includes humanReadable field from mapper', async () => {
    vi.mocked(getTrustlinesByAccount).mockResolvedValue([MOCK_TRUSTLINE]);

    const res = await request(makeApp()).get('/sac-trustlines/accounts/GABC123');
    expect(res.body.trustlines[0].humanReadable).toContain('GABC123');
    assertNoSimulatedStatus(res.body);
  });

  it('respects limit parameter', async () => {
    vi.mocked(getTrustlinesByAccount).mockResolvedValue([]);

    await request(makeApp()).get('/sac-trustlines/accounts/GABC123?limit=5');
    expect(getTrustlinesByAccount).toHaveBeenCalledWith('GABC123', 5);
  });

  it('returns 500 on database error', async () => {
    vi.mocked(getTrustlinesByAccount).mockRejectedValue(new Error('DB failure'));

    const res = await request(makeApp()).get('/sac-trustlines/accounts/GABC123');
    expect(res.status).toBe(500);
    assertNoSimulatedStatus(res.body);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /sac-trustlines/accounts/:address/authorized
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /sac-trustlines/accounts/:address/authorized', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns only active (authorized) trustlines', async () => {
    const inactiveTrustline = { ...MOCK_TRUSTLINE, status: 'deactivated' };
    vi.mocked(getTrustlinesByAccount).mockResolvedValue([MOCK_TRUSTLINE, inactiveTrustline]);

    const res = await request(makeApp()).get('/sac-trustlines/accounts/GABC123/authorized');
    expect(res.status).toBe(200);
    expect(res.body.address).toBe('GABC123');
    expect(res.body.authorizedTrustlines).toHaveLength(1);
    expect(res.body.authorizedTrustlines[0].status).toBe('active');
    expect(res.body.total).toBe(1);
    assertNoSimulatedStatus(res.body);
  });

  it('returns empty authorized list when all trustlines are inactive', async () => {
    const frozen = { ...MOCK_TRUSTLINE, status: 'frozen' };
    const deactivated = { ...MOCK_TRUSTLINE, status: 'deactivated' };
    vi.mocked(getTrustlinesByAccount).mockResolvedValue([frozen, deactivated]);

    const res = await request(makeApp()).get('/sac-trustlines/accounts/GABC123/authorized');
    expect(res.status).toBe(200);
    expect(res.body.authorizedTrustlines).toHaveLength(0);
    expect(res.body.total).toBe(0);
    assertNoSimulatedStatus(res.body);
  });

  it('returns 500 on database error', async () => {
    vi.mocked(getTrustlinesByAccount).mockRejectedValue(new Error('DB failure'));

    const res = await request(makeApp()).get('/sac-trustlines/accounts/GABC123/authorized');
    expect(res.status).toBe(500);
    assertNoSimulatedStatus(res.body);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /sac-trustlines/stats
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /sac-trustlines/stats', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns real aggregate statistics from the indexer', async () => {
    vi.mocked(getSacTrustlineStats).mockResolvedValue(MOCK_STATS);

    const res = await request(makeApp()).get('/sac-trustlines/stats');
    expect(res.status).toBe(200);
    expect(res.body.totalTrustlines).toBe(42);
    expect(res.body.activeTrustlines).toBe(38);
    expect(res.body.uniqueAssets).toBe(5);
    expect(res.body.topAssets).toHaveLength(1);
    expect(typeof res.body.computedAt).toBe('string');
    assertNoSimulatedStatus(res.body);
  });

  it('returns 500 on database error', async () => {
    vi.mocked(getSacTrustlineStats).mockRejectedValue(new Error('DB error'));

    const res = await request(makeApp()).get('/sac-trustlines/stats');
    expect(res.status).toBe(500);
    assertNoSimulatedStatus(res.body);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /sac-trustlines/authorize
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /sac-trustlines/authorize', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns pending_submission status — never "simulated"', async () => {
    vi.mocked(prismaRead.sacMapping.findFirst).mockResolvedValue(MOCK_SAC_MAPPING as any);
    vi.mocked(getTrustlinesBySac).mockResolvedValue([MOCK_TRUSTLINE]);

    const res = await request(makeApp())
      .post('/sac-trustlines/authorize')
      .send({ assetCode: 'USDC', accountAddress: 'GABC123', adminKey: 'SADMIN' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending_submission');
    expect(res.body.status).not.toBe('simulated');
    assertNoSimulatedStatus(res.body);
  });

  it('includes sacAddress and operation type in response', async () => {
    vi.mocked(prismaRead.sacMapping.findFirst).mockResolvedValue(MOCK_SAC_MAPPING as any);
    vi.mocked(getTrustlinesBySac).mockResolvedValue([]);

    const res = await request(makeApp())
      .post('/sac-trustlines/authorize')
      .send({ assetCode: 'USDC', accountAddress: 'GNEW456', adminKey: 'SADMIN' });

    expect(res.status).toBe(200);
    expect(res.body.operation).toBe('authorize_trustline');
    expect(res.body.sacAddress).toBe('CSAC456');
    expect(res.body.currentState).toBeNull(); // no existing trustline for GNEW456
    assertNoSimulatedStatus(res.body);
  });

  it('includes currentState when trustline already exists', async () => {
    vi.mocked(prismaRead.sacMapping.findFirst).mockResolvedValue(MOCK_SAC_MAPPING as any);
    vi.mocked(getTrustlinesBySac).mockResolvedValue([MOCK_TRUSTLINE]);

    const res = await request(makeApp())
      .post('/sac-trustlines/authorize')
      .send({ assetCode: 'USDC', accountAddress: 'GABC123', adminKey: 'SADMIN' });

    expect(res.status).toBe(200);
    expect(res.body.currentState).not.toBeNull();
    expect(res.body.currentState.status).toBe('active');
    assertNoSimulatedStatus(res.body);
  });

  it('returns 400 for missing required fields', async () => {
    const res = await request(makeApp())
      .post('/sac-trustlines/authorize')
      .send({ assetCode: 'USDC' }); // missing accountAddress and adminKey

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
    assertNoSimulatedStatus(res.body);
  });

  it('returns 400 for assetCode exceeding max length (12)', async () => {
    const res = await request(makeApp())
      .post('/sac-trustlines/authorize')
      .send({ assetCode: 'TOOLONGASSET', accountAddress: 'GABC123', adminKey: 'SADMIN' });

    // 'TOOLONGASSET' is exactly 12 chars — should be valid
    // Let's test with 13 chars
    const res2 = await request(makeApp())
      .post('/sac-trustlines/authorize')
      .send({ assetCode: 'TOOLONGASSET1', accountAddress: 'GABC123', adminKey: 'SADMIN' });

    expect(res2.status).toBe(400);
    assertNoSimulatedStatus(res2.body);
  });

  it('applies default authorizeFlags of 1', async () => {
    vi.mocked(prismaRead.sacMapping.findFirst).mockResolvedValue(null);
    vi.mocked(getTrustlinesBySac).mockResolvedValue([]);

    const res = await request(makeApp())
      .post('/sac-trustlines/authorize')
      .send({ assetCode: 'XLM', accountAddress: 'GABC123', adminKey: 'SADMIN' });

    expect(res.status).toBe(200);
    expect(res.body.authorizeFlags).toBe(1);
    assertNoSimulatedStatus(res.body);
  });

  it('includes a note about network submission', async () => {
    vi.mocked(prismaRead.sacMapping.findFirst).mockResolvedValue(null);
    vi.mocked(getTrustlinesBySac).mockResolvedValue([]);

    const res = await request(makeApp())
      .post('/sac-trustlines/authorize')
      .send({ assetCode: 'XLM', accountAddress: 'GABC123', adminKey: 'SADMIN' });

    expect(res.status).toBe(200);
    expect(typeof res.body.note).toBe('string');
    expect(res.body.note).toContain('Stellar network');
    assertNoSimulatedStatus(res.body);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /sac-trustlines/revoke
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /sac-trustlines/revoke', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns pending_submission status — never "simulated"', async () => {
    vi.mocked(prismaRead.sacMapping.findFirst).mockResolvedValue(MOCK_SAC_MAPPING as any);
    vi.mocked(getTrustlinesBySac).mockResolvedValue([MOCK_TRUSTLINE]);

    const res = await request(makeApp())
      .post('/sac-trustlines/revoke')
      .send({ assetCode: 'USDC', accountAddress: 'GABC123', adminKey: 'SADMIN' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending_submission');
    expect(res.body.status).not.toBe('simulated');
    assertNoSimulatedStatus(res.body);
  });

  it('includes operation type and sacAddress', async () => {
    vi.mocked(prismaRead.sacMapping.findFirst).mockResolvedValue(MOCK_SAC_MAPPING as any);
    vi.mocked(getTrustlinesBySac).mockResolvedValue([]);

    const res = await request(makeApp())
      .post('/sac-trustlines/revoke')
      .send({ assetCode: 'USDC', accountAddress: 'GABC123', adminKey: 'SADMIN' });

    expect(res.status).toBe(200);
    expect(res.body.operation).toBe('revoke_trustline');
    expect(res.body.sacAddress).toBe('CSAC456');
    assertNoSimulatedStatus(res.body);
  });

  it('accepts an optional reason field', async () => {
    vi.mocked(prismaRead.sacMapping.findFirst).mockResolvedValue(null);
    vi.mocked(getTrustlinesBySac).mockResolvedValue([]);

    const res = await request(makeApp()).post('/sac-trustlines/revoke').send({
      assetCode: 'USDC',
      accountAddress: 'GABC123',
      adminKey: 'SADMIN',
      reason: 'KYC expired',
    });

    expect(res.status).toBe(200);
    expect(res.body.reason).toBe('KYC expired');
    assertNoSimulatedStatus(res.body);
  });

  it('returns 400 for missing required fields', async () => {
    const res = await request(makeApp()).post('/sac-trustlines/revoke').send({ assetCode: 'USDC' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
    assertNoSimulatedStatus(res.body);
  });

  it('includes a note about network submission', async () => {
    vi.mocked(prismaRead.sacMapping.findFirst).mockResolvedValue(null);
    vi.mocked(getTrustlinesBySac).mockResolvedValue([]);

    const res = await request(makeApp())
      .post('/sac-trustlines/revoke')
      .send({ assetCode: 'XLM', accountAddress: 'GABC123', adminKey: 'SADMIN' });

    expect(res.status).toBe(200);
    expect(typeof res.body.note).toBe('string');
    expect(res.body.note).toContain('Stellar network');
    assertNoSimulatedStatus(res.body);
  });
});
