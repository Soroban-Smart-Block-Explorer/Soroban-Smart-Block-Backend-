import { vi } from 'vitest';

// ─── Shared test constants ───────────────────────────────────────────────────

export const TEST_CONTRACT_A = 'CABC1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB';
export const TEST_CONTRACT_B = 'CBBC1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB';
export const TEST_ACCOUNT_A = 'GABC1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB';
export const TEST_TX_HASH = 'abc123def456abc123def456abc123def456abc123def456abc123def456abcd';
export const TEST_TX_HASH_2 = 'bcd234ef0567bcd234ef0567bcd234ef0567bcd234ef0567bcd234ef0567bcde';

// ─── Mock Prisma factory ─────────────────────────────────────────────────────

export function makePrisma(overrides: Record<string, unknown> = {}) {
  return {
    transaction: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(0),
      groupBy: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
      create: vi.fn().mockResolvedValue({}),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      upsert: vi.fn().mockResolvedValue({}),
    },
    event: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(0),
    },
    contract: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    sacMapping: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    priceAlert: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    gasAnalyticsSnapshot: {
      upsert: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
    },
    portfolioSnapshot: {
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    exportJob: {
      create: vi
        .fn()
        .mockResolvedValue({
          id: 'job-1',
          exportType: 'transactions',
          filters: {},
          status: 'pending',
        }),
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
    reentrancyAlert: {
      upsert: vi.fn().mockResolvedValue({}),
    },
    tokenPriceHistory: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    tokenMarketData: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    tokenPrice: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    $transaction: vi.fn().mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops)),
    ...overrides,
  };
}

// ─── Factory functions ───────────────────────────────────────────────────────

export function makeTx(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tx-id-1',
    hash: TEST_TX_HASH,
    ledgerSequence: 1000,
    ledgerCloseTime: new Date('2024-01-01T00:00:00Z'),
    sourceAccount: TEST_ACCOUNT_A,
    contractAddress: TEST_CONTRACT_A,
    functionName: 'transfer',
    status: 'SUCCESS',
    humanReadable: null,
    feeCharged: '100',
    createdAt: new Date('2024-01-01T00:00:00Z'),
    reentrantAlert: false,
    ...overrides,
  };
}

export function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt-id-1',
    transactionHash: TEST_TX_HASH,
    contractAddress: TEST_CONTRACT_A,
    eventType: 'transfer',
    topics: ['transfer'],
    data: '',
    decoded: { asset: 'USDC', amount: 100000000 },
    ledgerSequence: 1000,
    ledgerCloseTime: new Date('2024-01-01T00:00:00Z'),
    createdAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

export function makeWhaleEvent(overrides: Record<string, unknown> = {}) {
  return {
    transactionHash: TEST_TX_HASH,
    contractAddress: TEST_CONTRACT_A,
    eventType: 'transfer',
    sourceAccount: TEST_ACCOUNT_A,
    ledgerSequence: 1000,
    ledgerCloseTime: new Date('2024-01-01T00:00:00Z'),
    decoded: { asset: 'USDC', amount: 100_000e6 }, // well above 50k threshold
    ...overrides,
  };
}
