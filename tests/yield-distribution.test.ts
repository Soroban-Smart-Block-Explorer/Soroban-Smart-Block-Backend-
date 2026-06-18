import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractDistributionData, processYieldEvent } from '../src/indexer/yield-distribution';

vi.mock('../src/db', () => ({
  prismaWrite: {
    yieldDistribution: {
      upsert: vi.fn().mockResolvedValue({}),
    },
  },
  prismaRead: {
    yieldDistribution: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      findFirst: vi.fn().mockResolvedValue(null),
      groupBy: vi.fn().mockResolvedValue([]),
    },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('extractDistributionData', () => {
  it('returns null for null decoded', () => {
    expect(extractDistributionData(null)).toBeNull();
  });

  it('extracts recipient and amount from flat decoded', () => {
    const result = extractDistributionData({
      recipient: 'GAXXXX',
      amount: '1000000000',
      tokenSymbol: 'USDC',
    });
    expect(result).not.toBeNull();
    expect(result!.recipient).toBe('GAXXXX');
    expect(result!.amount).toBe('1000000000');
    expect(result!.tokenSymbol).toBe('USDC');
  });

  it('extracts from nested data field', () => {
    const result = extractDistributionData({
      data: { recipient: 'GBYYYY', amount: '5000000', distributionId: 'batch-1' },
    } as Record<string, unknown>);
    expect(result).not.toBeNull();
    expect(result!.recipient).toBe('GBYYYY');
    expect(result!.amount).toBe('5000000');
    expect(result!.distributionId).toBe('batch-1');
  });

  it('returns null for zero amount', () => {
    expect(extractDistributionData({ recipient: 'GAXXXX', amount: '0' })).toBeNull();
  });

  it('returns null when recipient is missing', () => {
    expect(extractDistributionData({ amount: '1000' })).toBeNull();
  });

  it('accepts alternate field names', () => {
    const result = extractDistributionData({ to: 'GCZZZZ', value: '2500', batchId: 'b2' });
    expect(result).not.toBeNull();
    expect(result!.recipient).toBe('GCZZZZ');
    expect(result!.amount).toBe('2500');
    expect(result!.distributionId).toBe('b2');
  });
});

describe('processYieldEvent', () => {
  it('skips non-distribution topic symbols', async () => {
    const { prismaWrite } = await import('../src/db');
    await processYieldEvent('tx1', 'CA', 'transfer', null, 100, new Date());
    expect(prismaWrite.yieldDistribution.upsert).not.toHaveBeenCalled();
  });

  it('skips when no distribution data', async () => {
    const { prismaWrite } = await import('../src/db');
    await processYieldEvent('tx1', 'CA', 'yield_payout', { data: { amount: '0' } } as Record<string, unknown>, 100, new Date());
    expect(prismaWrite.yieldDistribution.upsert).not.toHaveBeenCalled();
  });

  it('upserts a yield distribution row for valid events', async () => {
    const { prismaWrite } = await import('../src/db');
    const closeTime = new Date();
    await processYieldEvent('tx-hash-1', 'CA-FACTORY', 'distribute_yield', {
      data: { recipient: 'GA-USER-1', amount: '1000000', tokenSymbol: 'USDC', distributionId: 'd-42' },
    } as Record<string, unknown>, 5000, closeTime);

    expect(prismaWrite.yieldDistribution.upsert).toHaveBeenCalledTimes(1);
    const call = (prismaWrite.yieldDistribution.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.create.transactionHash).toBe('tx-hash-1');
    expect(call.create.recipient).toBe('GA-USER-1');
    expect(call.create.amount).toBe('1000000');
    expect(call.create.tokenSymbol).toBe('USDC');
    expect(call.create.distributionId).toBe('d-42');
    expect(call.create.windowLabel).toBe('Corporate Yield Distribution Sync');
    expect(call.create.ledgerSequence).toBe(5000);
  });
});
