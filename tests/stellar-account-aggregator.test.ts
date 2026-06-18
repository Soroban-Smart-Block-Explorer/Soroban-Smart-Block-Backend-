import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';

vi.mock('../src/db', () => ({
  prismaRead: {
    stellarAccount: { findUnique: vi.fn(), count: vi.fn() },
    transaction: { findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn() },
    contract: { findMany: vi.fn() },
    wasmUpgradeHistory: { findMany: vi.fn() },
    sacMapping: { findFirst: vi.fn() },
    sacTrustlineMapping: { findMany: vi.fn() },
    bridgedAsset: { findFirst: vi.fn() },
  },
  prismaWrite: {
    stellarAccount: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
  },
}));

vi.mock('../src/stellar/horizon-client', () => ({
  fetchHorizonAccount: vi.fn(),
  fetchHorizonClaimableBalances: vi.fn(),
  fetchHorizonOperations: vi.fn(),
  verifyHomeDomain: vi.fn(),
}));

import { prismaRead as prisma, prismaWrite } from '../src/db';
import {
  fetchHorizonAccount,
  fetchHorizonClaimableBalances,
  fetchHorizonOperations,
  verifyHomeDomain,
} from '../src/stellar/horizon-client';
import { getUnifiedAccountView } from '../src/stellar/account-aggregator';

const G_ADDRESS = Keypair.random().publicKey();

describe('account-aggregator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses classic account data from Horizon response', async () => {
    vi.mocked(fetchHorizonAccount).mockResolvedValue({
      id: G_ADDRESS,
      account_id: G_ADDRESS,
      sequence: '123456789',
      subentry_count: 5,
      home_domain: 'example.com',
      last_modified_ledger: 100,
      last_modified_time: '2025-06-17T10:00:00Z',
      thresholds: { low_threshold: 0, med_threshold: 1, high_threshold: 1 },
      flags: { auth_required: false, auth_revocable: false, auth_immutable: false, auth_clawback_enabled: false },
      balances: [
        { balance: '1000', buying_liabilities: '0', selling_liabilities: '0', asset_type: 'native' },
        {
          balance: '5000',
          buying_liabilities: '0',
          selling_liabilities: '0',
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUFR3T9HYTWWTKSBBPFEG3QIWE4VNO',
          limit: '100000',
          is_authorized: true,
        },
      ],
      signers: [{ key: G_ADDRESS, weight: 1, type: 'ed25519_public_key' }],
      data: { 'config:key': 'value' },
      num_sponsoring: 0,
      num_sponsored: 0,
    } as any);

    vi.mocked(fetchHorizonClaimableBalances).mockResolvedValue([
      {
        id: '0000000000000000000000000000000000000000000000000000000000000001',
        asset: 'native',
        amount: '100',
        claimants: [{ destination: G_ADDRESS, predicate: {} }],
      },
    ]);

    vi.mocked(verifyHomeDomain).mockResolvedValue(true);
    vi.mocked(fetchHorizonOperations).mockResolvedValue({ records: [], nextCursor: null });
    vi.mocked(prisma.contract.findMany).mockResolvedValue([]);
    vi.mocked(prisma.wasmUpgradeHistory.findMany).mockResolvedValue([]);
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([]);
    vi.mocked(prisma.transaction.count).mockResolvedValue(0);
    vi.mocked(prisma.transaction.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.stellarAccount.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.sacMapping.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.sacTrustlineMapping.findMany).mockResolvedValue([]);
    vi.mocked(prisma.bridgedAsset.findFirst).mockResolvedValue(null);
    vi.mocked(prismaWrite.stellarAccount.findUnique).mockResolvedValue(null);

    const view = await getUnifiedAccountView(G_ADDRESS);

    expect(view.classic.address).toBe(G_ADDRESS);
    expect(view.classic.balance).toBe('1000.0000000 XLM');
    expect(view.classic.homeDomainVerified).toBe(true);
    expect(view.classic.trustlines).toHaveLength(1);
    expect(view.classic.trustlines[0].asset).toBe('USDC');
    expect(view.classic.trustlines[0].authorized).toBe(true);
    expect(view.classic.signers[0].type).toBe('ed25519');
    expect(view.classic.dataEntries['config:key']).toBe('value');
    expect(view.classic.claimableBalances).toHaveLength(1);
    expect(view.classic.flags.authRequired).toBe(false);
    expect(view.classic.thresholds.medium).toBe(1);
  });

  it('returns empty classic view for unfunded account', async () => {
    vi.mocked(fetchHorizonAccount).mockResolvedValue(null);
    vi.mocked(fetchHorizonClaimableBalances).mockResolvedValue([]);
    vi.mocked(fetchHorizonOperations).mockResolvedValue({ records: [], nextCursor: null });
    vi.mocked(prisma.contract.findMany).mockResolvedValue([]);
    vi.mocked(prisma.wasmUpgradeHistory.findMany).mockResolvedValue([]);
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([]);
    vi.mocked(prisma.transaction.count).mockResolvedValue(0);
    vi.mocked(prisma.transaction.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.stellarAccount.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.sacTrustlineMapping.findMany).mockResolvedValue([]);

    const view = await getUnifiedAccountView(G_ADDRESS);

    expect(view.classic.balance).toBe('0.0000000 XLM');
    expect(view.classic.trustlines).toHaveLength(0);
    expect(view.soroban.totalSorobanTx).toBe(0);
  });
});
