import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('axios');
vi.mock('../../src/db', () => ({
  prismaRead: {
    sacMapping: { findMany: vi.fn() },
    event: { count: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    transaction: { count: vi.fn() },
  },
}));

import * as db from '../../src/db';
import axios from 'axios';
import { computeAssetMetrics } from '../../src/indexer/assetTracker';

describe('computeAssetMetrics', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns empty array when no SAC mappings exist', async () => {
    vi.mocked(db.prismaRead.sacMapping.findMany).mockResolvedValue([]);
    const result = await computeAssetMetrics();
    expect(result).toEqual([]);
  });

  it('returns metrics for each SAC mapping', async () => {
    vi.mocked(db.prismaRead.sacMapping.findMany).mockResolvedValue([
      { sacAddress: 'CA_USDC', assetCode: 'USDC', assetIssuer: 'GA_ISSUER' },
    ] as any);

    // Mock axios price fetch to return empty (graceful degradation)
    vi.mocked(axios.get).mockRejectedValue(new Error('Network error'));

    vi.mocked(db.prismaRead.event.count).mockResolvedValue(10);
    vi.mocked(db.prismaRead.transaction.count).mockResolvedValue(5);
    vi.mocked(db.prismaRead.event.findFirst).mockResolvedValue(null);
    vi.mocked(db.prismaRead.event.findMany).mockResolvedValue([]);

    const result = await computeAssetMetrics();

    expect(result).toHaveLength(1);
    expect(result[0].contractAddress).toBe('CA_USDC');
    expect(result[0].assetCode).toBe('USDC');
    expect(result[0].totalEvents).toBe(10);
    expect(result[0].totalTransactions).toBe(5);
    expect(result[0].estimatedVolume).toBe(0);
    expect(result[0].priceXlm).toBeNull();
    expect(result[0].priceUsd).toBeNull();
  });

  it('sums transfer event amounts for estimatedVolume', async () => {
    vi.mocked(db.prismaRead.sacMapping.findMany).mockResolvedValue([
      { sacAddress: 'CA_TOKEN', assetCode: 'TOKEN', assetIssuer: null },
    ] as any);

    vi.mocked(axios.get).mockRejectedValue(new Error('offline'));
    vi.mocked(db.prismaRead.event.count).mockResolvedValue(3);
    vi.mocked(db.prismaRead.transaction.count).mockResolvedValue(2);
    vi.mocked(db.prismaRead.event.findFirst).mockResolvedValue(null);
    vi.mocked(db.prismaRead.event.findMany).mockResolvedValue([
      { decoded: { amount: 100 } },
      { decoded: { amount: 200 } },
      { decoded: { amount_in: 50 } },
    ] as any);

    const result = await computeAssetMetrics();
    expect(result[0].estimatedVolume).toBe(350);
  });

  it('applies price data when price fetch succeeds', async () => {
    vi.mocked(db.prismaRead.sacMapping.findMany).mockResolvedValue([
      { sacAddress: 'CA_USDC', assetCode: 'USDC', assetIssuer: 'GA' },
    ] as any);

    vi.mocked(axios.get)
      .mockResolvedValueOnce({
        data: {
          _embedded: {
            records: [{ asset: 'USDC-GA', price: 0.1 }],
          },
        },
      })
      .mockResolvedValueOnce({
        data: { stellar: { usd: 0.12 } },
      });

    vi.mocked(db.prismaRead.event.count).mockResolvedValue(5);
    vi.mocked(db.prismaRead.transaction.count).mockResolvedValue(2);
    vi.mocked(db.prismaRead.event.findFirst).mockResolvedValue(null);
    vi.mocked(db.prismaRead.event.findMany).mockResolvedValue([
      { decoded: { amount: 1000 } },
    ] as any);

    const result = await computeAssetMetrics();
    expect(result[0].priceXlm).toBe(0.1);
    expect(result[0].volumeXlm).toBe(100); // 1000 * 0.1
  });

  it('sorts results by totalEvents descending', async () => {
    vi.mocked(db.prismaRead.sacMapping.findMany).mockResolvedValue([
      { sacAddress: 'CA_LOW', assetCode: 'LOW', assetIssuer: null },
      { sacAddress: 'CA_HIGH', assetCode: 'HIGH', assetIssuer: null },
    ] as any);

    vi.mocked(axios.get).mockRejectedValue(new Error('offline'));
    vi.mocked(db.prismaRead.event.findFirst).mockResolvedValue(null);
    vi.mocked(db.prismaRead.event.findMany).mockResolvedValue([]);

    vi.mocked(db.prismaRead.event.count).mockResolvedValueOnce(5).mockResolvedValueOnce(50);
    vi.mocked(db.prismaRead.transaction.count).mockResolvedValue(0);

    const result = await computeAssetMetrics();
    expect(result[0].totalEvents).toBeGreaterThanOrEqual(result[1].totalEvents);
  });

  it('handles null assetCode gracefully', async () => {
    vi.mocked(db.prismaRead.sacMapping.findMany).mockResolvedValue([
      { sacAddress: 'CA_UNKNOWN', assetCode: null, assetIssuer: null },
    ] as any);

    vi.mocked(axios.get).mockRejectedValue(new Error('offline'));
    vi.mocked(db.prismaRead.event.count).mockResolvedValue(0);
    vi.mocked(db.prismaRead.transaction.count).mockResolvedValue(0);
    vi.mocked(db.prismaRead.event.findFirst).mockResolvedValue(null);
    vi.mocked(db.prismaRead.event.findMany).mockResolvedValue([]);

    const result = await computeAssetMetrics();
    expect(result[0].assetCode).toBeNull();
    expect(result[0].priceXlm).toBeNull();
  });
});
