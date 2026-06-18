import { describe, it, expect, vi, beforeEach } from 'vitest';

const ledgerAggregate = vi.fn();
const getLatestLedgerMock = vi.fn();

vi.mock('../src/db', () => ({
  prismaRead: {
    ledger: { aggregate: ledgerAggregate },
  },
  prismaWrite: {},
  get prisma() { return (this as any).prismaWrite; },
}));

vi.mock('../src/indexer/rpc', () => ({
  getLatestLedger: getLatestLedgerMock,
}));

describe('getSyncState', () => {
  beforeEach(() => {
    ledgerAggregate.mockReset();
    getLatestLedgerMock.mockReset();
  });

  it('returns 100% and isSynced=true when db matches network', async () => {
    ledgerAggregate.mockResolvedValue({ _max: { sequence: 5000 } });
    getLatestLedgerMock.mockResolvedValue(5000);

    const { getSyncState } = await import('../src/api/sync-state');
    const result = await getSyncState();

    expect(result).toEqual({
      dbLedger: 5000,
      networkLedger: 5000,
      syncPercent: 100,
      isSynced: true,
    });
  });

  it('returns correct percentage when db lags behind', async () => {
    ledgerAggregate.mockResolvedValue({ _max: { sequence: 999 } });
    getLatestLedgerMock.mockResolvedValue(1000);

    const { getSyncState } = await import('../src/api/sync-state');
    const result = await getSyncState();

    expect(result.dbLedger).toBe(999);
    expect(result.networkLedger).toBe(1000);
    expect(result.syncPercent).toBe(99.9);
    expect(result.isSynced).toBe(false);
  });

  it('handles empty DB (no ledgers yet) gracefully', async () => {
    ledgerAggregate.mockResolvedValue({ _max: { sequence: null } });
    getLatestLedgerMock.mockResolvedValue(5000);

    const { getSyncState } = await import('../src/api/sync-state');
    const result = await getSyncState();

    expect(result.dbLedger).toBe(0);
    expect(result.syncPercent).toBe(0);
    expect(result.isSynced).toBe(false);
  });

  it('caps syncPercent at 100 even if db somehow exceeds network', async () => {
    ledgerAggregate.mockResolvedValue({ _max: { sequence: 5001 } });
    getLatestLedgerMock.mockResolvedValue(5000);

    const { getSyncState } = await import('../src/api/sync-state');
    const result = await getSyncState();

    expect(result.syncPercent).toBe(100);
    expect(result.isSynced).toBe(true);
  });
});
