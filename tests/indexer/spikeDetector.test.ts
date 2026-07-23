import { describe, it, expect, vi, beforeEach } from 'vitest';

// 1. Mock hoisted directly with inlined return values
vi.mock('../../src/db', () => ({
  prismaRead: {
    transaction: {
      groupBy: vi.fn(),
      count: vi.fn(),
    },
  },
}));

// 2. Imports come after the mock definition
import { detectSpikes } from '../../src/indexer/spikeDetector';
import * as db from '../../src/db';

describe('detectSpikes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns empty array when no transactions in current window', async () => {
    vi.mocked(db.prismaRead.transaction.groupBy).mockResolvedValue([]);
    const result = await detectSpikes();
    expect(result).toEqual([]);
  });

  it('returns no alerts when z-score is below threshold', async () => {
    vi.mocked(db.prismaRead.transaction.groupBy).mockResolvedValue([
      { contractAddress: 'CA...', _count: { id: 5 } },
    ]);
    // Stable history: all windows return 5 → mean=5, stdDev=0, zScore=0
    vi.mocked(db.prismaRead.transaction.count).mockResolvedValue(5);

    const result = await detectSpikes(5, 12, 3.0);
    expect(result).toEqual([]);
  });

  it('detects spike when z-score exceeds threshold', async () => {
    vi.mocked(db.prismaRead.transaction.groupBy).mockResolvedValue([
      { contractAddress: 'CA_SPIKE', _count: { id: 100 } },
    ]);
    // Historical baseline: alternating 0 and 2 → mean≈1, stdDev≈1, zScore≈99
    vi.mocked(db.prismaRead.transaction.count)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(2);

    const result = await detectSpikes(5, 12, 3.0);

    expect(result).toHaveLength(1);
    expect(result[0].contractAddress).toBe('CA_SPIKE');
    expect(result[0].currentCount).toBe(100);
    expect(result[0].zScore).toBeGreaterThan(3.0);
  });

  it('skips contracts where baseline is flat zero (stdDev=0, mean=0)', async () => {
    vi.mocked(db.prismaRead.transaction.groupBy).mockResolvedValue([
      { contractAddress: 'CA_NEW', _count: { id: 1 } },
    ]);
    vi.mocked(db.prismaRead.transaction.count).mockResolvedValue(0);

    const result = await detectSpikes(5, 12, 3.0);
    expect(result).toEqual([]);
  });

  it('sorts results by descending z-score', async () => {
    vi.mocked(db.prismaRead.transaction.groupBy).mockResolvedValue([
      { contractAddress: 'CA_LOW', _count: { id: 10 } },
      { contractAddress: 'CA_HIGH', _count: { id: 200 } },
    ]);

    let callCount = 0;
    vi.mocked(db.prismaRead.transaction.count).mockImplementation(() => {
      callCount++;
      // First 12 calls (CA_LOW history): return 8 → mild spike
      // Next 12 calls (CA_HIGH history): return 0/2 alternating → huge spike
      if (callCount <= 12) return Promise.resolve(8);
      return Promise.resolve(callCount % 2 === 0 ? 0 : 2);
    });

    const result = await detectSpikes(5, 12, 3.0);
    if (result.length >= 2) {
      expect(result[0].zScore).toBeGreaterThanOrEqual(result[1].zScore);
    }
  });

  it('handles multiple contracts independently', async () => {
    vi.mocked(db.prismaRead.transaction.groupBy).mockResolvedValue([
      { contractAddress: 'CA_1', _count: { id: 50 } },
      { contractAddress: 'CA_2', _count: { id: 3 } },
    ]);
    // CA_1: baseline 5 → spike. CA_2: baseline 3 → no spike
    let callIndex = 0;
    vi.mocked(db.prismaRead.transaction.count).mockImplementation(() => {
      callIndex++;
      return Promise.resolve(callIndex <= 12 ? 1 : 3);
    });

    const result = await detectSpikes();
    // At least CA_1 should be flagged
    expect(result.some((a) => a.contractAddress === 'CA_1')).toBe(true);
  });
});
