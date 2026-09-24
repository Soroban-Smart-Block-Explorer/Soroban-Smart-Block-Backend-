import { describe, it, expect, vi, beforeEach } from 'vitest';

// gasAnalytics.ts builds its singleton GasAnalyticsProcessor through
// services/container (dependency injection), not by importing src/db directly.
// Mock the container's services so the processor computes against stubs.
const h = vi.hoisted(() => ({
  prismaRead: { transaction: { findMany: vi.fn() } },
  prismaWrite: { gasAnalyticsSnapshot: { upsert: vi.fn() } },
}));

vi.mock('../../src/db', () => ({
  prismaRead: h.prismaRead,
  prismaWrite: h.prismaWrite,
}));

vi.mock('../../src/services/container', () => ({
  container: {
    getPrismaRead: () => h.prismaRead,
    getPrismaWrite: () => h.prismaWrite,
    getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
}));

vi.mock('../../src/scheduler/cron-scheduler', () => ({
  scheduler: { register: vi.fn(), stop: vi.fn() },
}));

import { runGasAnalytics, startGasAnalyticsScheduler } from '../../src/indexer/gasAnalytics';
import { scheduler } from '../../src/scheduler/cron-scheduler';

describe('runGasAnalytics', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does nothing when no transactions found', async () => {
    vi.mocked(h.prismaRead.transaction.findMany).mockResolvedValue([]);
    await runGasAnalytics();
    expect(h.prismaWrite.gasAnalyticsSnapshot.upsert).not.toHaveBeenCalled();
  });

  it('upserts a snapshot for each bucket when transactions exist', async () => {
    vi.mocked(h.prismaRead.transaction.findMany).mockResolvedValue([
      { feeCharged: '100' },
      { feeCharged: '200' },
      { feeCharged: '300' },
    ]);
    vi.mocked(h.prismaWrite.gasAnalyticsSnapshot.upsert).mockResolvedValue({} as any);

    await runGasAnalytics();

    // Called once for hour, day, week
    expect(h.prismaWrite.gasAnalyticsSnapshot.upsert).toHaveBeenCalledTimes(3);
  });

  it('computes correct avg, median, peak, min', async () => {
    vi.mocked(h.prismaRead.transaction.findMany).mockResolvedValue([
      { feeCharged: '100' },
      { feeCharged: '200' },
      { feeCharged: '300' },
    ]);
    vi.mocked(h.prismaWrite.gasAnalyticsSnapshot.upsert).mockResolvedValue({} as any);

    await runGasAnalytics();

    const call = vi.mocked(h.prismaWrite.gasAnalyticsSnapshot.upsert).mock.calls[0][0];
    expect(call.create.avgFee).toBeCloseTo(200);
    expect(call.create.medianFee).toBe(200);
    expect(call.create.peakFee).toBe(300);
    expect(call.create.minFee).toBe(100);
    expect(call.create.txCount).toBe(3);
  });

  it('skips non-finite fee values', async () => {
    vi.mocked(h.prismaRead.transaction.findMany).mockResolvedValue([
      { feeCharged: 'NaN' },
      { feeCharged: null },
      { feeCharged: '0' },
      { feeCharged: '500' },
    ]);
    vi.mocked(h.prismaWrite.gasAnalyticsSnapshot.upsert).mockResolvedValue({} as any);

    await runGasAnalytics();

    const call = vi.mocked(h.prismaWrite.gasAnalyticsSnapshot.upsert).mock.calls[0][0];
    // Only fee=500 is valid (0 is filtered out, NaN and null are filtered)
    expect(call.create.txCount).toBe(1);
    expect(call.create.peakFee).toBe(500);
  });

  it('handles even-length array for median', async () => {
    vi.mocked(h.prismaRead.transaction.findMany).mockResolvedValue([
      { feeCharged: '100' },
      { feeCharged: '200' },
    ]);
    vi.mocked(h.prismaWrite.gasAnalyticsSnapshot.upsert).mockResolvedValue({} as any);

    await runGasAnalytics();

    const call = vi.mocked(h.prismaWrite.gasAnalyticsSnapshot.upsert).mock.calls[0][0];
    expect(call.create.medianFee).toBe(150); // (100+200)/2
  });
});

describe('startGasAnalyticsScheduler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers the recurring job with the central cron scheduler', () => {
    vi.mocked(h.prismaRead.transaction.findMany).mockResolvedValue([]);

    startGasAnalyticsScheduler({ runOnStart: false });

    expect(scheduler.register).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'gas-analytics',
        taskName: 'Gas Analytics Computation',
      }),
    );
  });
});
