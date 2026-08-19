import { beforeEach, describe, expect, it, vi } from 'vitest';

const transactionStore = new Map<string, any>();

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

vi.mock('../../src/config', () => ({
  config: {
    networkPassphrase: 'Test SDF Network ; September 2015',
  },
}));

vi.mock('../../src/db', () => ({
  prismaRead: {
    transaction: {
      findUnique: vi.fn(async ({ where, include }: any) => {
        const tx = transactionStore.get(where.hash);
        if (!tx) return null;
        if (include?.operations) {
          return { ...clone(tx), operations: [] };
        }
        return clone(tx);
      }),
    },
    sandboxSession: {
      findUnique: vi.fn(async () => null),
    },
    sandboxAccount: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
    sandboxContract: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
    },
    sandboxSnapshot: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      count: vi.fn(async () => 0),
    },
    sandboxCall: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      count: vi.fn(async () => 0),
    },
    fuzzRun: { findUnique: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    fuzzFinding: { findUnique: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    sandboxCiRun: { findUnique: vi.fn(async () => null) },
    sandboxShare: { findUnique: vi.fn(async () => null) },
    contractTemplate: { upsert: vi.fn(async ({ create }: any) => create) },
    contract: { findUnique: vi.fn(async () => null) },
    $transaction: vi.fn(async (ops: any[]) => Promise.all(ops)),
  },
  prismaWrite: {
    sandboxSession: { create: vi.fn(async () => null), update: vi.fn(async () => null) },
    sandboxAccount: {
      createMany: vi.fn(async () => ({ count: 0 })),
      update: vi.fn(async () => null),
    },
    sandboxContract: {
      create: vi.fn(async () => null),
      update: vi.fn(async () => null),
      createMany: vi.fn(async () => ({ count: 0 })),
    },
    sandboxSnapshot: { create: vi.fn(async () => null) },
    sandboxCall: { create: vi.fn(async () => null) },
    fuzzRun: { create: vi.fn(async () => null), update: vi.fn(async () => null) },
    fuzzFinding: { createMany: vi.fn(async () => ({ count: 0 })) },
    sandboxCiRun: { create: vi.fn(async () => null), update: vi.fn(async () => null) },
    sandboxShare: { create: vi.fn(async () => null) },
    contractTemplate: { upsert: vi.fn(async ({ create }: any) => create) },
    $transaction: vi.fn(async (ops: any[]) => Promise.all(ops)),
  },
}));

describe('replay-oracle', () => {
  beforeEach(() => {
    transactionStore.clear();
    vi.clearAllMocks();
  });

  describe('UNSUPPORTED_HOST_FUNCTIONS', () => {
    it('contains expected unsupported functions', async () => {
      const { UNSUPPORTED_HOST_FUNCTIONS } = await import('../../src/sandbox/replay-oracle');
      expect(UNSUPPORTED_HOST_FUNCTIONS.has('get_contract_code')).toBe(true);
      expect(UNSUPPORTED_HOST_FUNCTIONS.has('upload_contract_wasm')).toBe(true);
      expect(UNSUPPORTED_HOST_FUNCTIONS.has('create_contract')).toBe(true);
      expect(UNSUPPORTED_HOST_FUNCTIONS.has('require_auth')).toBe(true);
      expect(UNSUPPORTED_HOST_FUNCTIONS.has('verify_ed25519_sig')).toBe(true);
    });
  });

  describe('replayMainnet', () => {
    it('returns not-found for unknown tx hash', async () => {
      const { replayMainnet } = await import('../../src/sandbox/replay-oracle');
      const result = await replayMainnet(
        '0000000000000000000000000000000000000000000000000000000000000000',
      );
      expect(result.txHash).toBe(
        '0000000000000000000000000000000000000000000000000000000000000000',
      );
      expect(result.comparison.equal).toBe(false);
      expect(result.comparison.reason).toBe('transaction not found in indexer');
    });

    it('returns not-found when tx is not in store', async () => {
      const { replayMainnet } = await import('../../src/sandbox/replay-oracle');
      const result = await replayMainnet('some-tx-hash-not-in-store');
      expect(result.comparison.equal).toBe(false);
      expect(typeof result.comparison.reason).toBe('string');
      expect(result.comparison.reason.length).toBeGreaterThan(0);
    });
  });
});
