import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db', () => ({
  prismaWrite: {
    rwaComplianceEvent: {
      upsert: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

import * as db from '../../src/db';
import {
  trackRwaClawback,
  getAssetComplianceEvents,
  getAddressComplianceHistory,
  getIssuerComplianceActions,
} from '../../src/indexer/rwa-compliance-tracker';

const TX_HASH = 'abc123';
const LEDGER = 1000;
const TIME = new Date('2024-01-01T00:00:00Z');
const ASSET = 'CA_ASSET';
const ISSUER = 'GA_ISSUER';
const TARGET = 'GA_TARGET';

describe('trackRwaClawback', () => {
  beforeEach(() => vi.clearAllMocks());

  it('upserts a compliance event with human statement', async () => {
    vi.mocked(db.prismaWrite.rwaComplianceEvent.upsert).mockResolvedValue({} as any);

    await trackRwaClawback(TX_HASH, LEDGER, TIME, ASSET, ISSUER, TARGET, '500', 'regulatory_order');

    expect(db.prismaWrite.rwaComplianceEvent.upsert).toHaveBeenCalledOnce();
    const call = vi.mocked(db.prismaWrite.rwaComplianceEvent.upsert).mock.calls[0][0];
    expect(call.where).toEqual({ transactionHash: TX_HASH });
    expect(call.create.humanStatement).toContain('500');
    expect(call.create.humanStatement).toContain(TARGET);
    expect(call.create.humanStatement).toContain('regulatory_order');
    expect(call.create.complianceReason).toBe('regulatory_order');
  });

  it('does not overwrite existing event (update is empty)', async () => {
    vi.mocked(db.prismaWrite.rwaComplianceEvent.upsert).mockResolvedValue({} as any);

    await trackRwaClawback(TX_HASH, LEDGER, TIME, ASSET, ISSUER, TARGET, '100', 'court_order');

    const call = vi.mocked(db.prismaWrite.rwaComplianceEvent.upsert).mock.calls[0][0];
    expect(call.update).toEqual({});
  });
});

describe('getAssetComplianceEvents', () => {
  beforeEach(() => vi.clearAllMocks());

  it('queries by assetContractAddress ordered by ledgerSequence desc', async () => {
    vi.mocked(db.prismaWrite.rwaComplianceEvent.findMany).mockResolvedValue([]);

    await getAssetComplianceEvents(ASSET);

    expect(db.prismaWrite.rwaComplianceEvent.findMany).toHaveBeenCalledWith({
      where: { assetContractAddress: ASSET },
      orderBy: { ledgerSequence: 'desc' },
    });
  });

  it('returns array of events', async () => {
    vi.mocked(db.prismaWrite.rwaComplianceEvent.findMany).mockResolvedValue([
      { transactionHash: TX_HASH, amount: '500' } as any,
    ]);

    const result = await getAssetComplianceEvents(ASSET);
    expect(result).toHaveLength(1);
    expect(result[0].transactionHash).toBe(TX_HASH);
  });
});

describe('getAddressComplianceHistory', () => {
  beforeEach(() => vi.clearAllMocks());

  it('queries by targetAddress', async () => {
    vi.mocked(db.prismaWrite.rwaComplianceEvent.findMany).mockResolvedValue([]);

    await getAddressComplianceHistory(TARGET);

    expect(db.prismaWrite.rwaComplianceEvent.findMany).toHaveBeenCalledWith({
      where: { targetAddress: TARGET },
      orderBy: { ledgerSequence: 'desc' },
    });
  });
});

describe('getIssuerComplianceActions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('queries by issuerAddress', async () => {
    vi.mocked(db.prismaWrite.rwaComplianceEvent.findMany).mockResolvedValue([]);

    await getIssuerComplianceActions(ISSUER);

    expect(db.prismaWrite.rwaComplianceEvent.findMany).toHaveBeenCalledWith({
      where: { issuerAddress: ISSUER },
      orderBy: { ledgerSequence: 'desc' },
    });
  });
});
