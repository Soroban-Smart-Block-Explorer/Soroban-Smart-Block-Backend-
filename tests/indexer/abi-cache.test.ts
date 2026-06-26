import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getCachedAbi,
  setCachedAbi,
  deleteCachedAbi,
  invalidateCache,
  ContractAbi,
} from '../../src/indexer/abi-cache';

vi.mock('../../src/db', () => ({
  prismaRead: {
    contract: { findUnique: vi.fn() },
  },
  prismaWrite: {
    contract: { upsert: vi.fn(), update: vi.fn() },
  },
  get prisma() {
    return (this as any).prismaWrite;
  },
}));

import { prismaRead, prismaWrite } from '../../src/db';
import { z } from 'zod';

const ADDR = 'CTEST000000000000000000000000000000000000000000000000000001';
const SAMPLE_ABI: ContractAbi = {
  functions: [
    { name: 'swap', inputs: [{ name: 'amount', type: 'i128' }], humanTemplate: 'Swapped {amount}' },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  invalidateCache(ADDR);
});

describe('getCachedAbi', () => {
  it('returns null when DB has no ABI', async () => {
    vi.mocked(prismaRead.contract.findUnique).mockResolvedValue({ abi: null } as any);
    expect(await getCachedAbi(ADDR)).toBeNull();
  });

  it('reads from DB on cache miss and caches result', async () => {
    vi.mocked(prismaRead.contract.findUnique).mockResolvedValue({ abi: SAMPLE_ABI } as any);

    const first = await getCachedAbi(ADDR);
    expect(first).toEqual(SAMPLE_ABI);
    expect(prismaRead.contract.findUnique).toHaveBeenCalledTimes(1);

    // Second call should hit cache, not DB
    const second = await getCachedAbi(ADDR);
    expect(second).toEqual(SAMPLE_ABI);
    expect(prismaRead.contract.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe('setCachedAbi', () => {
  it('upserts to DB and updates cache', async () => {
    vi.mocked(prismaWrite.contract.upsert).mockResolvedValue({} as any);

    await setCachedAbi(ADDR, SAMPLE_ABI);
    expect(prismaWrite.contract.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { address: ADDR } }),
    );

    // Should now be in cache — no DB call needed
    const cached = await getCachedAbi(ADDR);
    expect(cached).toEqual(SAMPLE_ABI);
    expect(prismaRead.contract.findUnique).not.toHaveBeenCalled();
  });
});

describe('deleteCachedAbi', () => {
  it('removes from DB and evicts cache', async () => {
    vi.mocked(prismaWrite.contract.upsert).mockResolvedValue({} as any);
    vi.mocked(prismaWrite.contract.update).mockResolvedValue({} as any);
    vi.mocked(prismaRead.contract.findUnique).mockResolvedValue({ abi: null } as any);

    await setCachedAbi(ADDR, SAMPLE_ABI);
    await deleteCachedAbi(ADDR);

    expect(prismaWrite.contract.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { address: ADDR } }),
    );

    // Cache should be empty; DB returns null
    const result = await getCachedAbi(ADDR);
    expect(result).toBeNull();
  });
});

describe('abiBodySchema validation (via abi router logic)', () => {
  it('accepts a valid ABI shape', () => {
    const schema = z.object({
      functions: z
        .array(
          z.object({
            name: z.string().min(1),
            inputs: z.array(z.object({ name: z.string(), type: z.string() })),
            outputs: z.array(z.object({ type: z.string() })).optional(),
            humanTemplate: z.string().optional(),
          }),
        )
        .min(1),
    });
    expect(schema.safeParse(SAMPLE_ABI).success).toBe(true);
  });

  it('rejects an ABI with empty functions array', () => {
    const schema = z.object({
      functions: z.array(z.object({ name: z.string().min(1), inputs: z.array(z.any()) })).min(1),
    });
    expect(schema.safeParse({ functions: [] }).success).toBe(false);
  });

  it('rejects an ABI missing the functions key', () => {
    const schema = z.object({
      functions: z.array(z.object({ name: z.string().min(1), inputs: z.array(z.any()) })).min(1),
    });
    expect(schema.safeParse({ name: 'bad' }).success).toBe(false);
  });
});
