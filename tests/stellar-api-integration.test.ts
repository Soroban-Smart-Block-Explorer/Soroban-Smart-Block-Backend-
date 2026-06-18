/**
 * Integration tests for /api/v1/stellar/* endpoints.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

vi.mock('../src/db', () => ({
  prismaRead: {
    stellarAccount: { findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    transaction: { findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn() },
    contract: { findMany: vi.fn(), count: vi.fn() },
    wasmUpgradeHistory: { findMany: vi.fn(), count: vi.fn() },
    sacMapping: { findFirst: vi.fn(), findMany: vi.fn() },
    sacTrustlineMapping: { findMany: vi.fn() },
    bridgedAsset: { findFirst: vi.fn(), findMany: vi.fn() },
    anchorsRegistry: { findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn() },
    stellarAsset: { findMany: vi.fn(), findUnique: vi.fn(), count: vi.fn() },
    unifiedTransaction: { findMany: vi.fn(), count: vi.fn() },
    networkNode: { findMany: vi.fn(), findUnique: vi.fn(), count: vi.fn() },
    stellarNetworkHealth: { findFirst: vi.fn(), findMany: vi.fn() },
    event: { count: vi.fn() },
    anchorReview: { findMany: vi.fn() },
  },
  prismaWrite: {
    stellarAccount: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
    anchorsRegistry: { create: vi.fn(), update: vi.fn() },
    anchorReview: { create: vi.fn() },
  },
}));

vi.mock('../src/stellar/horizon-client', () => ({
  fetchHorizonAccount: vi.fn(),
  fetchHorizonClaimableBalances: vi.fn().mockResolvedValue([]),
  fetchHorizonOperations: vi.fn().mockResolvedValue({ records: [], nextCursor: null }),
  fetchHorizonPayments: vi.fn().mockResolvedValue([]),
  fetchHorizonAssets: vi.fn().mockResolvedValue({ records: [], nextCursor: null }),
  fetchHorizonAsset: vi.fn().mockResolvedValue(null),
  fetchHorizonOrderbook: vi.fn().mockResolvedValue(null),
  fetchHorizonNetworkStats: vi.fn().mockResolvedValue({
    current_ledger: '1000000',
    protocol_version: 20,
    num_accounts: 1000,
    num_transactions: 50000,
    num_operations: 85000,
    base_fee_in_stroops: 100,
  }),
  fetchStellarToml: vi.fn().mockResolvedValue(null),
  verifyHomeDomain: vi.fn().mockResolvedValue(false),
}));

import { prismaRead as prisma } from '../src/db';
import { fetchHorizonAccount } from '../src/stellar/horizon-client';
import { stellarRouter } from '../src/api/stellar';
import { Keypair } from '@stellar/stellar-sdk';

const G_ADDRESS = Keypair.random().publicKey();

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/stellar', stellarRouter);

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

describe('GET /api/v1/stellar/accounts/:address', () => {
  it('returns unified account view', async () => {
    vi.mocked(fetchHorizonAccount).mockResolvedValue({
      account_id: G_ADDRESS,
      sequence: '100',
      subentry_count: 2,
      thresholds: { low_threshold: 0, med_threshold: 1, high_threshold: 1 },
      flags: { auth_required: false, auth_revocable: false, auth_immutable: false, auth_clawback_enabled: false },
      balances: [{ balance: '500', buying_liabilities: '0', selling_liabilities: '0', asset_type: 'native' }],
      signers: [{ key: G_ADDRESS, weight: 1, type: 'ed25519_public_key' }],
      data: {},
      num_sponsoring: 0,
      num_sponsored: 0,
      last_modified_time: '2025-06-17T10:00:00Z',
    } as any);

    vi.mocked(prisma.contract.findMany).mockResolvedValue([]);
    vi.mocked(prisma.wasmUpgradeHistory.findMany).mockResolvedValue([]);
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([]);
    vi.mocked(prisma.transaction.count).mockResolvedValue(5);
    vi.mocked(prisma.transaction.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.stellarAccount.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.sacTrustlineMapping.findMany).mockResolvedValue([]);

    const res = await fetch(`${baseUrl}/api/v1/stellar/accounts/${G_ADDRESS}`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.classic).toBeDefined();
    expect(body.soroban).toBeDefined();
    expect(body.crossDomain).toBeDefined();
    expect(body.metadata).toBeDefined();
    expect(body.classic.balance).toContain('XLM');
    expect(body.soroban.totalSorobanTx).toBe(5);
  });

  it('returns 400 for invalid address', async () => {
    const res = await fetch(`${baseUrl}/api/v1/stellar/accounts/invalid`);
    expect(res.status).toBe(400);
  });
});

describe('GET /api/v1/stellar/anchors', () => {
  it('returns anchor list', async () => {
    vi.mocked(prisma.anchorsRegistry.findMany).mockResolvedValue([
      {
        id: 'uuid-1',
        name: 'TestAnchor',
        homeDomain: 'test.com',
        address: G_ADDRESS,
        assets: ['USDC'],
        regions: ['US'],
        kycRequired: true,
        kycTypes: ['individual'],
        supportedSeps: ['SEP-6', 'SEP-24'],
        isVerified: true,
        rating: 4.5 as any,
        reviewCount: 10,
        status: 'active',
        fees: null,
        limits: null,
        metadata: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    vi.mocked(prisma.anchorsRegistry.count).mockResolvedValue(1);

    const res = await fetch(`${baseUrl}/api/v1/stellar/anchors`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.anchors).toHaveLength(1);
    expect(body.anchors[0].name).toBe('TestAnchor');
    expect(body.totalAnchors).toBe(1);
  });
});

describe('GET /api/v1/stellar/overview', () => {
  it('returns ecosystem overview', async () => {
    vi.mocked(prisma.contract.count).mockResolvedValue(100);
    vi.mocked(prisma.transaction.count).mockResolvedValue(50);
    vi.mocked(prisma.wasmUpgradeHistory.count).mockResolvedValue(20);
    vi.mocked(prisma.event.count).mockResolvedValue(1000);
    vi.mocked(prisma.stellarAccount.count).mockResolvedValue(500);
    vi.mocked(prisma.stellarAsset.count).mockResolvedValue(25);
    vi.mocked(prisma.anchorsRegistry.findMany).mockResolvedValue([]);
    vi.mocked(prisma.anchorsRegistry.count).mockResolvedValue(0);
    vi.mocked(prisma.bridgedAsset.findMany).mockResolvedValue([]);
    vi.mocked(prisma.sacMapping.findMany).mockResolvedValue([]);

    const res = await fetch(`${baseUrl}/api/v1/stellar/overview`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.classic).toBeDefined();
    expect(body.soroban).toBeDefined();
    expect(body.bridged).toBeDefined();
    expect(body.comparisons).toBeDefined();
  });
});

describe('GET /api/v1/stellar/network-health', () => {
  it('returns network health status', async () => {
    vi.mocked(prisma.networkNode.findMany).mockResolvedValue([
      {
        id: '1',
        publicKey: G_ADDRESS,
        name: 'SDF Node',
        organization: 'SDF',
        isValidator: true,
        activeInNetwork: true,
        uptime30d: 99.9,
        country: 'US',
        firstSeen: new Date(),
        lastSeen: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any,
    ]);
    vi.mocked(prisma.stellarNetworkHealth.findFirst).mockResolvedValue(null);

    const res = await fetch(`${baseUrl}/api/v1/stellar/network-health`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.overall.status).toBe('healthy');
    expect(body.nodes.total).toBe(1);
    expect(body.consensus).toBeDefined();
  });
});

describe('GET /api/v1/stellar/bridge/assets', () => {
  it('returns bridged assets list', async () => {
    vi.mocked(prisma.bridgedAsset.findMany).mockResolvedValue([]);
    vi.mocked(prisma.sacMapping.findMany).mockResolvedValue([
      {
        id: '1',
        assetCode: 'USDC',
        assetIssuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUFR3T9HYTWWTKSBBPFEG3QIWE4VNO',
        assetType: 'credit_alphanum4',
        sacAddress: 'CABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDE',
        firstSeenLedger: 100,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const res = await fetch(`${baseUrl}/api/v1/stellar/bridge/assets`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.bridgedAssets).toHaveLength(1);
    expect(body.bridgedAssets[0].classic.code).toBe('USDC');
  });
});
