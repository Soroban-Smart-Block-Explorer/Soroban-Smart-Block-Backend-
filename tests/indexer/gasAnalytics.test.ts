import { describe, it, expect, vi, beforeEach } from 'vitest';

// 1. Inlined setup inside vi.mock
vi.mock('../../src/db', () => ({
  prismaRead: { transaction: { findMany: vi.fn() } },
  prismaWrite: { gasAnalyticsSnapshot: { upsert: vi.fn() } },
}));

// 2. Target code and db references
import { runGasAnalytics, startGasAnalyticsScheduler } from '../../src/indexer/gasAnalytics';
import * as db from '../../src/db';

describe('runGasAnalytics', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does nothing when no transactions found', async () => {
    vi.mocked(db.prismaRead.transaction.findMany).mockResolvedValue([]);
    await runGasAnalytics();
    expect(db.prismaWrite.gasAnalyticsSnapshot.upsert).not.toHaveBeenCalled();
  });

  it('upserts a snapshot for each bucket when transactions exist', async () => {
    vi.mocked(db.prismaRead.transaction.findMany).mockResolvedValue([
      { feeCharged: '100' },
      { feeCharged: '200' },
      { feeCharged: '300' },
    ]);
    vi.mocked(db.prismaWrite.gasAnalyticsSnapshot.upsert).mockResolvedValue({} as any);

    await runGasAnalytics();

    // Called once for hour, day, week
    expect(db.prismaWrite.gasAnalyticsSnapshot.upsert).toHaveBeenCalledTimes(3);
  });

  it('computes correct avg, median, peak, min', async () => {
    vi.mocked(db.prismaRead.transaction.findMany).mockResolvedValue([
      { feeCharged: '100' },
      { feeCharged: '200' },
      { feeCharged: '300' },
    ]);
    vi.mocked(db.prismaWrite.gasAnalyticsSnapshot.upsert).mockResolvedValue({} as any);

    await runGasAnalytics();

    const call = vi.mocked(db.prismaWrite.gasAnalyticsSnapshot.upsert).mock.calls[0][0];
    expect(call.create.avgFee).toBeCloseTo(200);
    expect(call.create.medianFee).toBe(200);
    expect(call.create.peakFee).toBe(300);
    expect(call.create.minFee).toBe(100);
    expect(call.create.txCount).toBe(3);
  });

  it('skips non-finite fee values', async () => {
    vi.mocked(db.prismaRead.transaction.findMany).mockResolvedValue([
      { feeCharged: 'NaN' },
      { feeCharged: null },
      { feeCharged: '0' },
      { feeCharged: '500' },
    ]);
    vi.mocked(db.prismaWrite.gasAnalyticsSnapshot.upsert).mockResolvedValue({} as any);

    await runGasAnalytics();

    const call = vi.mocked(db.prismaWrite.gasAnalyticsSnapshot.upsert).mock.calls[0][0];
    // Only fee=500 is valid (0 is filtered out, NaN and null are filtered)
    expect(call.create.txCount).toBe(1);
    expect(call.create.peakFee).toBe(500);
  });

  it('handles even-length array for median', async () => {
    vi.mocked(db.prismaRead.transaction.findMany).mockResolvedValue([
      { feeCharged: '100' },
      { feeCharged: '200' },
    ]);
    vi.mocked(db.prismaWrite.gasAnalyticsSnapshot.upsert).mockResolvedValue({} as any);

    await runGasAnalytics();

    const call = vi.mocked(db.prismaWrite.gasAnalyticsSnapshot.upsert).mock.calls[0][0];
    expect(call.create.medianFee).toBe(150); // (100+200)/2
  });
});

describe('startGasAnalyticsScheduler', () => {
  it('returns a NodeJS.Timeout handle', () => {
    vi.useFakeTimers();
    vi.mocked(db.prismaRead.transaction.findMany).mockResolvedValue([]);

    const handle = startGasAnalyticsScheduler(1000);
    expect(handle).toBeDefined();
    clearInterval(handle);
    vi.useRealTimers();
  });
});
