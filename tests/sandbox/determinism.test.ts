import { beforeEach, describe, expect, it, vi } from 'vitest';

const sessionStore = new Map<string, any>();
const accountStore = new Map<string, any[]>();
const contractStore = new Map<string, any[]>();
const snapshotStore = new Map<string, any[]>();
const callStore = new Map<string, any[]>();
const fuzzRunStore = new Map<string, any>();
const fuzzFindingStore = new Map<string, any[]>();
const ciRunStore = new Map<string, any>();
const shareStore = new Map<string, any>();
const templateStore = new Map<string, any>();

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function getArrayStore(map: Map<string, any[]>, key: string): any[] {
  if (!map.has(key)) map.set(key, []);
  return map.get(key)!;
}

function uniqueId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

vi.mock('../../src/config', () => ({
  config: {
    networkPassphrase: 'Test SDF Network ; September 2015',
  },
}));

vi.mock('../../src/db', () => ({
  prismaRead: {
    sandboxSession: {
      findUnique: vi.fn(async ({ where }: any) => sessionStore.get(where.id) ?? null),
      count: vi.fn(async ({ where }: any) => (sessionStore.has(where?.id) ? 1 : 0)),
    },
    sandboxAccount: {
      findMany: vi.fn(async ({ where }: any) => getArrayStore(accountStore, where.sessionId)),
      count: vi.fn(async ({ where }: any) => getArrayStore(accountStore, where.sessionId).length),
    },
    sandboxContract: {
      findMany: vi.fn(async ({ where }: any) => getArrayStore(contractStore, where.sessionId)),
      findUnique: vi.fn(async ({ where }: any) => {
        const rows = getArrayStore(contractStore, where.sessionId);
        return rows.find((row) => row.contractId === where.contractId) ?? null;
      }),
    },
    sandboxSnapshot: {
      findMany: vi.fn(async ({ where }: any) => getArrayStore(snapshotStore, where.sessionId)),
      findUnique: vi.fn(async ({ where }: any) => {
        for (const rows of snapshotStore.values()) {
          const found = rows.find((row) => row.id === where.id);
          if (found) return found;
        }
        return null;
      }),
      count: vi.fn(async ({ where }: any) => getArrayStore(snapshotStore, where.sessionId).length),
    },
    sandboxCall: {
      findMany: vi.fn(async ({ where }: any) => getArrayStore(callStore, where.sessionId)),
      findUnique: vi.fn(async ({ where }: any) => {
        for (const rows of callStore.values()) {
          const found = rows.find((row) => row.id === where.id);
          if (found) return found;
        }
        return null;
      }),
      count: vi.fn(async ({ where }: any) => getArrayStore(callStore, where.sessionId).length),
    },
    fuzzRun: {
      findUnique: vi.fn(async ({ where }: any) => fuzzRunStore.get(where.id) ?? null),
      findMany: vi.fn(async ({ where }: any) => {
        if (where?.sessionId) {
          return [...fuzzRunStore.values()].filter((row) => row.sessionId === where.sessionId);
        }
        return [...fuzzRunStore.values()];
      }),
    },
    fuzzFinding: {
      findUnique: vi.fn(async ({ where }: any) => {
        for (const rows of fuzzFindingStore.values()) {
          const found = rows.find((row) => row.id === where.id);
          if (found) return found;
        }
        return null;
      }),
      findMany: vi.fn(async ({ where }: any) => getArrayStore(fuzzFindingStore, where.fuzzRunId)),
    },
    sandboxCiRun: {
      findUnique: vi.fn(async ({ where }: any) => ciRunStore.get(where.id) ?? null),
    },
    sandboxShare: {
      findUnique: vi.fn(async ({ where }: any) => shareStore.get(where.shareId) ?? null),
    },
    contractTemplate: {
      upsert: vi.fn(async ({ create }: any) => create),
    },
    contract: {
      findUnique: vi.fn(async () => null),
    },
    transaction: {
      findUnique: vi.fn(async () => null),
    },
    $transaction: vi.fn(async (ops: any[]) => Promise.all(ops)),
  },
  prismaWrite: {
    sandboxSession: {
      create: vi.fn(async ({ data }: any) => {
        const row = {
          id: uniqueId('session'),
          createdAt: new Date('2026-06-18T00:00:00.000Z'),
          lastAccessed: new Date('2026-06-18T00:00:00.000Z'),
          ...clone(data),
        };
        sessionStore.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = sessionStore.get(where.id);
        if (!row) throw new Error('session not found');
        Object.assign(row, clone(data));
        row.lastAccessed = new Date('2026-06-18T00:00:00.000Z');
        return row;
      }),
    },
    sandboxAccount: {
      createMany: vi.fn(async ({ data }: any) => {
        for (const d of data) {
          getArrayStore(accountStore, d.sessionId).push(clone(d));
        }
        return { count: data.length };
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const rows = getArrayStore(accountStore, where.sessionId_publicKey.sessionId);
        const idx = rows.findIndex((r) => r.publicKey === where.sessionId_publicKey.publicKey);
        if (idx >= 0) {
          Object.assign(rows[idx], clone(data));
          return rows[idx];
        }
        throw new Error('account not found');
      }),
    },
    sandboxContract: {
      create: vi.fn(async ({ data }: any) => {
        const row = clone(data);
        getArrayStore(contractStore, row.sessionId).push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const rows = getArrayStore(contractStore, where.sessionId_contractId.sessionId);
        const idx = rows.findIndex((r) => r.contractId === where.sessionId_contractId.contractId);
        if (idx >= 0) {
          Object.assign(rows[idx], clone(data));
          return rows[idx];
        }
        throw new Error('contract not found');
      }),
      createMany: vi.fn(async ({ data }: any) => {
        for (const d of data) {
          getArrayStore(contractStore, d.sessionId).push(clone(d));
        }
        return { count: data.length };
      }),
    },
    sandboxSnapshot: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: uniqueId('snapshot'), ...clone(data) };
        getArrayStore(snapshotStore, row.sessionId).push(row);
        return row;
      }),
    },
    sandboxCall: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: uniqueId('call'), ...clone(data) };
        getArrayStore(callStore, row.sessionId).push(row);
        return row;
      }),
    },
    fuzzRun: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: uniqueId('fuzz'), ...clone(data) };
        fuzzRunStore.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = fuzzRunStore.get(where.id);
        if (!row) throw new Error('fuzz run not found');
        Object.assign(row, clone(data));
        return row;
      }),
    },
    fuzzFinding: {
      createMany: vi.fn(async ({ data }: any) => {
        const runId = data[0]?.fuzzRunId;
        if (!runId) return { count: 0 };
        const arr = getArrayStore(fuzzFindingStore, runId);
        for (const d of data) arr.push(clone(d));
        return { count: data.length };
      }),
    },
    sandboxCiRun: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: uniqueId('ci'), ...clone(data) };
        ciRunStore.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = ciRunStore.get(where.id);
        if (!row) throw new Error('ci run not found');
        Object.assign(row, clone(data));
        return row;
      }),
    },
    sandboxShare: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: uniqueId('share'), ...clone(data) };
        shareStore.set(row.shareId, row);
        return row;
      }),
    },
    contractTemplate: {
      upsert: vi.fn(async ({ create }: any) => create),
    },
    $transaction: vi.fn(async (ops: any[]) => Promise.all(ops)),
  },
}));

describe('sandbox determinism', () => {
  beforeEach(() => {
    sessionStore.clear();
    accountStore.clear();
    contractStore.clear();
    snapshotStore.clear();
    callStore.clear();
    fuzzRunStore.clear();
    fuzzFindingStore.clear();
    ciRunStore.clear();
    shareStore.clear();
    templateStore.clear();
    vi.clearAllMocks();
  });

  async function runSession(seed: string) {
    const { sandboxEngine } = await import('../../src/sandbox/runtime');
    const session = await sandboxEngine.createSession({
      seed,
      accountCount: 5,
      preFundedBalance: '10000',
    });
    const accounts = await sandboxEngine.listAccounts(session.id);
    const deployer = accounts[0].publicKey;

    const contract = await sandboxEngine.deployFromTemplate({
      sessionId: session.id,
      templateId: 'sep41-token',
      name: 'Test Token',
      deployer,
      initArgs: { name: 'Test', symbol: 'TST', decimals: 7 },
    });

    const mint1 = await sandboxEngine.call({
      sessionId: session.id,
      contractId: contract.contractId,
      functionName: 'mint',
      args: { to: accounts[1].publicKey, amount: '500' },
      sourceAccount: deployer,
    });

    const mint2 = await sandboxEngine.call({
      sessionId: session.id,
      contractId: contract.contractId,
      functionName: 'mint',
      args: { to: accounts[2].publicKey, amount: '300' },
      sourceAccount: deployer,
    });

    const transfer = await sandboxEngine.call({
      sessionId: session.id,
      contractId: contract.contractId,
      functionName: 'transfer',
      args: { from: accounts[1].publicKey, to: accounts[3].publicKey, amount: '150' },
      sourceAccount: accounts[1].publicKey,
    });

    const balance = await sandboxEngine.call({
      sessionId: session.id,
      contractId: contract.contractId,
      functionName: 'balance_of',
      args: { owner: accounts[3].publicKey },
      sourceAccount: deployer,
    });

    const finalState = await sandboxEngine.getContractState(session.id, contract.contractId);

    return {
      sessionId: session.id,
      mint1Result: mint1.result,
      mint2Result: mint2.result,
      transferResult: transfer.result,
      balanceResult: balance.result,
      finalState: JSON.stringify(finalState, null, 2),
      calls: [mint1, mint2, transfer, balance].map((c) => ({
        success: c.success,
        events: c.events,
        metrics: c.metrics,
      })),
    };
  }

  it('produces identical results for identical seeds across two sessions', async () => {
    const seed = 'determinism-test-seed-12345';

    const run1 = await runSession(seed);
    const run2 = await runSession(seed);

    expect(run1.mint1Result).toEqual(run2.mint1Result);
    expect(run1.mint2Result).toEqual(run2.mint2Result);
    expect(run1.transferResult).toEqual(run2.transferResult);
    expect(run1.balanceResult).toEqual(run2.balanceResult);
    expect(run1.finalState).toEqual(run2.finalState);

    for (let i = 0; i < run1.calls.length; i++) {
      expect(run1.calls[i].success).toBe(run2.calls[i].success);
      expect(JSON.stringify(run1.calls[i].events)).toBe(JSON.stringify(run2.calls[i].events));
      expect(run1.calls[i].metrics).toEqual(run2.calls[i].metrics);
    }
  });

  it('produces different results for different seeds', async () => {
    const run1 = await runSession('seed-a');
    const run2 = await runSession('seed-b');

    expect(run1.sessionId).not.toBe(run2.sessionId);
  });
});
