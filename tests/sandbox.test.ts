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

vi.mock('../src/config', () => ({
  config: {
    networkPassphrase: 'Test SDF Network ; September 2015',
  },
}));

vi.mock('../src/db', () => ({
  prismaRead: {
    sandboxSession: {
      findUnique: vi.fn(async ({ where }: any) => sessionStore.get(where.id) ?? null),
      count: vi.fn(async ({ where }: any) => sessionStore.has(where?.id) ? 1 : 0),
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
        for (const row of data) {
          getArrayStore(accountStore, row.sessionId).push({ id: uniqueId('account'), ...clone(row) });
        }
        return { count: data.length };
      }),
      create: vi.fn(async ({ data }: any) => {
        const row = { id: uniqueId('account'), ...clone(data) };
        getArrayStore(accountStore, data.sessionId).push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const rows = getArrayStore(accountStore, where.sessionId_publicKey.sessionId);
        const row = rows.find((entry) => entry.publicKey === where.sessionId_publicKey.publicKey);
        if (!row) throw new Error('account not found');
        Object.assign(row, clone(data));
        return row;
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        accountStore.set(where.sessionId, []);
        return { count: 0 };
      }),
    },
    sandboxContract: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: uniqueId('contract'), ...clone(data) };
        getArrayStore(contractStore, data.sessionId).push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const rows = getArrayStore(contractStore, where.sessionId_contractId.sessionId);
        const row = rows.find((entry) => entry.contractId === where.sessionId_contractId.contractId);
        if (!row) throw new Error('contract not found');
        Object.assign(row, clone(data));
        return row;
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        contractStore.set(where.sessionId, []);
        return { count: 0 };
      }),
    },
    sandboxSnapshot: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: uniqueId('snapshot'), createdAt: new Date('2026-06-18T00:00:00.000Z'), ...clone(data) };
        getArrayStore(snapshotStore, data.sessionId).push(row);
        return row;
      }),
    },
    sandboxCall: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: uniqueId('call'), ...clone(data) };
        getArrayStore(callStore, data.sessionId).push(row);
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
        const first = data[0];
        const runId = first?.fuzzRunId;
        if (!runId) return { count: 0 };
        const rows = getArrayStore(fuzzFindingStore, runId);
        for (const row of data) {
          rows.push({ id: uniqueId('finding'), ...clone(row) });
        }
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

describe('SandboxEngine', () => {
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

  it('creates a deterministic session with prefunded accounts', async () => {
    const { sandboxEngine } = await import('../src/sandbox/runtime');
    const session = await sandboxEngine.createSession({ seed: 'seed-a' });

    expect(session.status).toBe('active');
    expect(session.accountCount).toBe(20);
    const accounts = await sandboxEngine.listAccounts(session.id);
    expect(accounts).toHaveLength(20);
    expect(accounts[0].balance).toBe('10000');
  });

  it('deploys a template contract and updates state on call', async () => {
    const { sandboxEngine } = await import('../src/sandbox/runtime');
    const session = await sandboxEngine.createSession({ seed: 'seed-b' });
    const contract = await sandboxEngine.deployFromTemplate({
      sessionId: session.id,
      templateId: 'sep41-token',
      name: 'Token',
      deployer: (await sandboxEngine.listAccounts(session.id))[0].publicKey,
    });

    const mintResult = await sandboxEngine.call({
      sessionId: session.id,
      contractId: contract.contractId,
      functionName: 'mint',
      args: { to: (await sandboxEngine.listAccounts(session.id))[1].publicKey, amount: '250' },
      sourceAccount: (await sandboxEngine.listAccounts(session.id))[0].publicKey,
    });

    expect(mintResult.success).toBe(true);
    expect(mintResult.result).toEqual({ minted: '250' });
    const state = await sandboxEngine.getContractState(session.id, contract.contractId);
    expect((state as any).totalSupply).toBe('250');
  });

  it('captures fuzz findings for known attack patterns', async () => {
    const { sandboxEngine } = await import('../src/sandbox/runtime');
    const session = await sandboxEngine.createSession({ seed: 'seed-c' });
    const contract = await sandboxEngine.deployFromTemplate({
      sessionId: session.id,
      templateId: 'sep41-token',
      name: 'Token',
      deployer: (await sandboxEngine.listAccounts(session.id))[0].publicKey,
    });

    const fuzzRun = await sandboxEngine.startFuzz({
      sessionId: session.id,
      contractId: contract.contractId,
      strategies: [{ type: 'known_attack', iterations: 10 }],
    });

    expect(fuzzRun.findings).toHaveLength(3);
    expect(fuzzRun.findings[0].severity).toBe('critical');
  });

  it('executes CI steps and stores the result', async () => {
    const { sandboxEngine } = await import('../src/sandbox/runtime');
    const session = await sandboxEngine.createSession({ seed: 'seed-d' });
    const contract = await sandboxEngine.deployFromTemplate({
      sessionId: session.id,
      templateId: 'sep41-token',
      name: 'Token',
      deployer: (await sandboxEngine.listAccounts(session.id))[0].publicKey,
    });

    const result = await sandboxEngine.executeCi({
      sessionId: session.id,
      onFailure: 'stop',
      steps: [
        { action: 'call', contract: contract.contractId, function: 'mint', args: { to: (await sandboxEngine.listAccounts(session.id))[1].publicKey, amount: '42' } },
        { action: 'assert', contract: contract.contractId, function: 'balance_of', expected: { balance: '42' }, args: { owner: (await sandboxEngine.listAccounts(session.id))[1].publicKey } },
      ],
    });

    expect(result.passed).toBe(true);
    expect(result.results).toHaveLength(2);
  });
});
