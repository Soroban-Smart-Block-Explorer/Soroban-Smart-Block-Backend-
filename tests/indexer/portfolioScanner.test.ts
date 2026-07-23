import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as db from '../../src/db';

vi.mock('../../src/db', () => ({
  prismaWrite: {
    portfolioSnapshot: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
  },
}));

vi.mock('../../src/indexer/assetTracker', () => ({
  computeAssetMetrics: vi.fn(),
}));

import { runPortfolioScan, startPortfolioScanner } from '../../src/indexer/portfolioScanner';
import { computeAssetMetrics } from '../../src/indexer/assetTracker';

describe('runPortfolioScan', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does nothing when computeAssetMetrics returns empty array', async () => {
    vi.mocked(computeAssetMetrics).mockResolvedValue([]);
    await runPortfolioScan();
    expect(db.prismaWrite.portfolioSnapshot.createMany).not.toHaveBeenCalled();
  });

  it('creates snapshots for each metric', async () => {
    vi.mocked(computeAssetMetrics).mockResolvedValue([
      {
        contractAddress: 'CA_1',
        assetCode: 'USDC',
        assetIssuer: 'GA_ISSUER',
        totalEvents: 100,
        totalTransactions: 50,
        estimatedVolume: 1000,
        volumeXlm: 2000,
        volumeUsd: 400,
        priceXlm: 2,
        priceUsd: 0.4,
        lastActivityAt: new Date(),
      },
      {
        contractAddress: 'CA_2',
        assetCode: 'XLM',
        assetIssuer: null,
        totalEvents: 200,
        totalTransactions: 100,
        estimatedVolume: 5000,
        volumeXlm: 5000,
        volumeUsd: 1000,
        priceXlm: 1,
        priceUsd: 0.2,
        lastActivityAt: null,
      },
    ] as any);

    await runPortfolioScan();

    expect(db.prismaWrite.portfolioSnapshot.createMany).toHaveBeenCalledOnce();
    const { data } = vi.mocked(db.prismaWrite.portfolioSnapshot.createMany).mock.calls[0][0] as any;
    expect(data).toHaveLength(2);
    expect(data[0].contractAddress).toBe('CA_1');
    expect(data[0].assetCode).toBe('USDC');
    expect(data[1].contractAddress).toBe('CA_2');
  });

  it('maps null pricing fields correctly', async () => {
    vi.mocked(computeAssetMetrics).mockResolvedValue([
      {
        contractAddress: 'CA_3',
        assetCode: null,
        assetIssuer: null,
        totalEvents: 10,
        totalTransactions: 5,
        estimatedVolume: 100,
        volumeXlm: null,
        volumeUsd: null,
        priceXlm: null,
        priceUsd: null,
        lastActivityAt: null,
      },
    ] as any);

    await runPortfolioScan();

    const { data } = vi.mocked(db.prismaWrite.portfolioSnapshot.createMany).mock.calls[0][0] as any;
    expect(data[0].priceXlm).toBeNull();
    expect(data[0].priceUsd).toBeNull();
    expect(data[0].valueXlm).toBeNull();
    expect(data[0].valueUsd).toBeNull();
  });
});

describe('startPortfolioScanner', () => {
  it('returns a NodeJS.Timeout handle', () => {
    vi.useFakeTimers();
    vi.mocked(computeAssetMetrics).mockResolvedValue([]);

    const handle = startPortfolioScanner(1000);
    expect(handle).toBeDefined();
    clearInterval(handle);
    vi.useRealTimers();
  });
});
