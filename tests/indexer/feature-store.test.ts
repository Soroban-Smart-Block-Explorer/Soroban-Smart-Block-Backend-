import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db', () => ({
  prismaWrite: {
    ledger: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    transaction: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    event: {
      findMany: vi.fn(),
    },
    featureDefinition: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    featureValue: {
      createMany: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

vi.mock('../../src/config', () => ({
  config: {
    forecastMode: 'demo',
    forecastSeed: 42,
  },
}));

import { prismaWrite } from '../../src/db';
import { FeatureStore } from '../../src/indexer/feature-store';

const toDate = (iso: string) => new Date(iso);

describe('FeatureStore computeAndStoreFeatures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('computes real on-chain tx volume and related metrics', async () => {
    const store = new FeatureStore();

    vi.mocked(prismaWrite.ledger.findUnique).mockResolvedValue({
      sequence: 1,
      hash: 'hash',
      closeTime: toDate('2026-07-24T10:00:00Z'),
      txCount: 3,
    } as any);

    vi.mocked(prismaWrite.transaction.count).mockImplementation(async ({ where }: any) => {
      if (where.status?.not) {
        return 1;
      }
      if (where.ledgerSequence === 1) {
        return 3;
      }
      return 0;
    });

    vi.mocked(prismaWrite.transaction.findMany).mockResolvedValue([
      { sourceAccount: 'ACC1' },
      { sourceAccount: 'ACC2' },
      { sourceAccount: 'ACC3' },
    ] as any);

    vi.mocked(prismaWrite.event.findMany).mockResolvedValue([
      { contractAddress: 'CONTRACT1' },
    ] as any);

    vi.mocked(prismaWrite.ledger.findFirst).mockResolvedValue({
      sequence: 1,
      closeTime: toDate('2026-07-24T10:00:00Z'),
    } as any);

    vi.mocked(prismaWrite.featureDefinition.findUnique).mockResolvedValue(null);
    vi.mocked(prismaWrite.featureDefinition.create).mockImplementation(async ({ data }: any) => ({
      id: data.name,
      ...data,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    vi.mocked(prismaWrite.featureValue.createMany).mockResolvedValue({ count: 6 } as any);

    await store.computeAndStoreFeatures(1, toDate('2026-07-24T10:05:00Z'));

    expect(prismaWrite.featureValue.createMany).toHaveBeenCalledTimes(1);
    const createdRows = vi.mocked(prismaWrite.featureValue.createMany).mock.calls[0][0]
      .data as Array<Record<string, unknown>>;

    const rowsByName = Object.fromEntries(createdRows.map((row) => [row.featureId, row]));
    expect(rowsByName['tx_volume'].value).toBe(3);
    expect(rowsByName['unique_source_accounts'].value).toBe(3);
    expect(rowsByName['contracts_with_events'].value).toBe(1);
    expect(rowsByName['tx_failure_ratio'].value).toBeCloseTo(1 / 3, 5);
    expect(rowsByName['data_freshness_seconds'].value).toBe(300);
    expect(rowsByName['tx_volume_7d_ma'].value).toBe(0);
  });
});

describe('FeatureStore getHistoricalData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty array when metric definition does not exist', async () => {
    const store = new FeatureStore();

    vi.mocked(prismaWrite.featureDefinition.findUnique).mockResolvedValue(null);

    const result = await store.getHistoricalData('tx_volume', 5);
    expect(result).toEqual([]);
  });

  it('returns stored values ordered newest-first and limited by limit', async () => {
    const store = new FeatureStore();

    vi.mocked(prismaWrite.featureDefinition.findUnique).mockResolvedValue({
      id: 'tx_volume',
    } as any);
    vi.mocked(prismaWrite.featureValue.findMany).mockResolvedValue([
      { value: 30 },
      { value: 20 },
    ] as any);

    const result = await store.getHistoricalData('tx_volume', 2);
    expect(result).toEqual([30, 20]);
  });
});
