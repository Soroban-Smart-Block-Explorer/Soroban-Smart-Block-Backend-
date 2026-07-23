import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SEVERITY_MULTIPLIER } from '../src/indexer/severity';

const prismaMock = {
  vulnerabilityAdvisory: {
    findUnique: vi.fn(),
  },
  dexPool: {
    findMany: vi.fn(),
  },
  propagationAnalysis: {
    create: vi.fn(),
  },
};

vi.mock('../src/db', () => ({
  prisma: prismaMock,
}));

describe('SEVERITY_MULTIPLIER', () => {
  it('defines multipliers for all severity levels', () => {
    expect(SEVERITY_MULTIPLIER.low).toBe(0.02);
    expect(SEVERITY_MULTIPLIER.medium).toBe(0.1);
    expect(SEVERITY_MULTIPLIER.high).toBe(0.5);
    expect(SEVERITY_MULTIPLIER.critical).toBe(1.0);
  });
});

describe('loadAffectedPoolsTvl', () => {
  beforeEach(() => {
    prismaMock.dexPool.findMany.mockReset();
  });

  it('returns empty array for empty addresses', async () => {
    const { loadAffectedPoolsTvl } = await import('../src/indexer/propagation-engine');
    const result = await loadAffectedPoolsTvl([]);
    expect(result).toEqual([]);
    expect(prismaMock.dexPool.findMany).not.toHaveBeenCalled();
  });

  it('returns TVL values for matching pools', async () => {
    prismaMock.dexPool.findMany.mockResolvedValue([{ tvlUsd: 100000 }, { tvlUsd: 200000 }]);

    const { loadAffectedPoolsTvl } = await import('../src/indexer/propagation-engine');
    const result = await loadAffectedPoolsTvl(['CA', 'CB']);
    expect(result).toEqual([100000, 200000]);
    expect(prismaMock.dexPool.findMany).toHaveBeenCalledWith({
      where: { address: { in: ['CA', 'CB'] } },
      select: { tvlUsd: true },
    });
  });
});

describe('persistPropagation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it.each([
    { severity: 'low', multiplier: 0.02 },
    { severity: 'medium', multiplier: 0.1 },
    { severity: 'high', multiplier: 0.5 },
    { severity: 'critical', multiplier: 1.0 },
  ])('computes totalValueAtRisk for $severity severity', async ({ severity, multiplier }) => {
    prismaMock.vulnerabilityAdvisory.findUnique.mockResolvedValue({ severity });
    prismaMock.dexPool.findMany.mockResolvedValue([{ tvlUsd: 50000 }]);

    const { persistPropagation } = await import('../src/indexer/propagation-engine');

    await persistPropagation({
      advisoryId: 'adv-1',
      result: {
        vulnerableContract: 'C1',
        directAffected: ['C2', 'C3'],
        affectedByDepth: { '1': ['C4'] },
        analysisDepth: 5,
      },
    });

    const expectedTvl = 50000;
    const expectedTotal = 2 * multiplier * expectedTvl;

    expect(prismaMock.propagationAnalysis.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        advisoryId: 'adv-1',
        vulnerableContract: 'C1',
        directAffected: ['C2', 'C3'],
        affectedByDepth: { '1': ['C4'] },
        totalValueAtRisk: expectedTotal,
        analysisDepth: 5,
      }),
    });
  });

  it('produces deterministic numeric value (not null) with empty DexPool', async () => {
    prismaMock.vulnerabilityAdvisory.findUnique.mockResolvedValue({ severity: 'high' });
    prismaMock.dexPool.findMany.mockResolvedValue([]);

    const { persistPropagation } = await import('../src/indexer/propagation-engine');

    await persistPropagation({
      advisoryId: 'adv-empty-pool',
      result: {
        vulnerableContract: 'C1',
        directAffected: ['C2'],
        affectedByDepth: {},
        analysisDepth: 3,
      },
    });

    expect(prismaMock.propagationAnalysis.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        totalValueAtRisk: 0.5,
      }),
    });
  });

  it('throws when advisory is not found', async () => {
    prismaMock.vulnerabilityAdvisory.findUnique.mockResolvedValue(null);

    const { persistPropagation } = await import('../src/indexer/propagation-engine');

    await expect(
      persistPropagation({
        advisoryId: 'nonexistent',
        result: {
          vulnerableContract: 'C1',
          directAffected: [],
          affectedByDepth: {},
          analysisDepth: 5,
        },
      }),
    ).rejects.toThrow('Advisory nonexistent not found');
  });
});
