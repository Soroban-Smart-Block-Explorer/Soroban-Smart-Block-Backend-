import { PrismaClient } from '@prisma/client';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

function makeClient(url?: string) {
  return new PrismaClient({
    datasources: { db: { url: url ?? TEST_DB_URL } },
  });
}

const describeIf = TEST_DB_URL ? describe : describe.skip;

describeIf('PostgreSQL integration – migration & query compatibility', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = makeClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // ─── Connection & migration schema compatibility ──────────────────────────

  it('connects to PostgreSQL and confirms `Ledger` table schema', async () => {
    const schema = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_name = 'Ledger'
       ORDER BY ordinal_position`,
    );
    const cols = schema.map((r: any) => r.column_name as string);
    expect(cols).toContain('sequence');
    expect(cols).toContain('hash');
    expect(cols).toContain('closeTime');
    expect(cols).toContain('txCount');
    expect(cols).toContain('createdAt');
  });

  it('confirms all migration tables exist in `information_schema`', async () => {
    const expectedTables = [
      'Ledger',
      'Contract',
      'Transaction',
      'Event',
      'EventDefinition',
      'SessionAuthorization',
      'IndexerState',
      'SacMapping',
      'SacTrustlineMapping',
      'VerificationJob',
      'ContractState',
      'RestorationLog',
      'FailedItem',
      'ApiKey',
      'SmartWallet',
      'SponsoredTransaction',
      'AuthDecomposition',
      'SanctionsList',
      'ScreeningResult',
      'TravelRuleRecord',
      'ComplianceReport',
      'ContractResourceMetric',
      'TranslationKey',
      'Translation',
      'WasmUpgradeHistory',
    ];
    const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    const existing: string[] = rows.map((r: any) => r.table_name as string);
    const existingLower = existing.map((n) => n.toLowerCase());
    for (const t of expectedTables) {
      expect(existingLower).toContain(t.toLowerCase());
    }
  });

  it('confirms primary key and unique indexes on `Ledger`', async () => {
    const indexes = await prisma.$queryRawUnsafe<Array<{ indexname: string }>>(
      `SELECT indexname FROM pg_indexes
       WHERE tablename = 'Ledger' AND indexdef LIKE 'CREATE UNIQUE%'`,
    );
    const names = indexes.map((c: any) => c.indexname as string);
    expect(names).toContain('Ledger_pkey');
    expect(names).toContain('Ledger_hash_key');
  });

  it('confirms composite indexes on `Transaction`', async () => {
    const indexes = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT indexdef FROM pg_indexes
       WHERE tablename = 'Transaction'`,
    );
    const defs = indexes.map((r: any) => r.indexdef as string).join('\n');
    expect(defs).toMatch(/contractAddress.*ledgerSequence.*id/);
    expect(defs).toMatch(/sourceAccount.*ledgerSequence.*id/);
  });

  // ─── CRUD operations ───────────────────────────────────────────────────────

  it('creates and reads a Ledger record', async () => {
    const seq = Math.floor(Math.random() * 100_000_000) + 1;
    const hash = `test-hash-${seq}`;
    const now = new Date();

    await prisma.ledger.create({
      data: { sequence: seq, hash, closeTime: now, txCount: 5 },
    });

    const found = await prisma.ledger.findUnique({ where: { sequence: seq } });
    expect(found).not.toBeNull();
    expect(found!.hash).toBe(hash);
    expect(found!.txCount).toBe(5);
    expect(found!.closeTime.getTime()).toBeCloseTo(now.getTime(), -2);

    await prisma.ledger.delete({ where: { sequence: seq } });
  });

  it('creates and reads a Contract record', async () => {
    const addr = `CA${Math.random().toString(36).slice(2, 10)}`;
    await prisma.contract.create({
      data: {
        address: addr,
        name: 'Test Contract',
        isToken: false,
        isVerified: true,
      },
    });

    const found = await prisma.contract.findUnique({ where: { address: addr } });
    expect(found).not.toBeNull();
    expect(found!.name).toBe('Test Contract');
    expect(found!.isVerified).toBe(true);

    await prisma.contract.delete({ where: { address: addr } });
  });

  it('creates Ledger + Transaction + Event in a nested write', async () => {
    const seq = Math.floor(Math.random() * 100_000_000) + 1;
    const ledgerHash = `nested-ledger-${seq}`;
    const txHash = `nested-tx-${seq}`;
    const now = new Date();

    const ledger = await prisma.ledger.create({
      data: {
        sequence: seq,
        hash: ledgerHash,
        closeTime: now,
        txCount: 1,
        transactions: {
          create: {
            hash: txHash,
            ledgerCloseTime: now,
            sourceAccount: 'GA' + Math.random().toString(36).slice(2, 10),
            rawXdr: 'AAAA',
            status: 'success',
          },
        },
      },
      include: { transactions: true },
    });

    expect(ledger.transactions).toHaveLength(1);
    expect(ledger.transactions[0].hash).toBe(txHash);

    // Cascade cleanup
    await prisma.transaction.delete({ where: { hash: txHash } });
    await prisma.ledger.delete({ where: { sequence: seq } });
  });

  it('handles upsert (create vs update)', async () => {
    const seq = Math.floor(Math.random() * 100_000_000) + 1;
    const hash = `upsert-${seq}`;
    const now = new Date();

    const created = await prisma.ledger.upsert({
      where: { sequence: seq },
      create: { sequence: seq, hash, closeTime: now, txCount: 0 },
      update: { txCount: 99 },
    });
    expect(created.txCount).toBe(0);

    const updated = await prisma.ledger.upsert({
      where: { sequence: seq },
      create: { sequence: seq, hash, closeTime: now, txCount: 0 },
      update: { txCount: 99 },
    });
    expect(updated.txCount).toBe(99);

    await prisma.ledger.delete({ where: { sequence: seq } });
  });

  // ─── Null handling ─────────────────────────────────────────────────────────

  it('stores and retrieves nullable fields as null', async () => {
    const addr = `CA-null-${Math.random().toString(36).slice(2, 8)}`;
    await prisma.contract.create({
      data: {
        address: addr,
        name: null,
        description: null,
        tokenSymbol: null,
        tokenDecimals: null,
        isToken: false,
      },
    });

    const found = await prisma.contract.findUnique({ where: { address: addr } });
    expect(found!.name).toBeNull();
    expect(found!.description).toBeNull();
    expect(found!.tokenSymbol).toBeNull();
    expect(found!.tokenDecimals).toBeNull();

    await prisma.contract.delete({ where: { address: addr } });
  });

  it('stores JSON fields and preserves structure', async () => {
    const addr = `CA-json-${Math.random().toString(36).slice(2, 8)}`;
    const abi = { functions: [{ name: 'hello', inputs: [] }] };

    await prisma.contract.create({
      data: { address: addr, abi: abi, isToken: false },
    });

    const found = await prisma.contract.findUnique({ where: { address: addr } });
    expect(found!.abi).toEqual(abi);

    await prisma.contract.delete({ where: { address: addr } });
  });

  // ─── Update semantics ──────────────────────────────────────────────────────

  it('updates a single field without affecting others', async () => {
    const seq = Math.floor(Math.random() * 100_000_000) + 1;
    const hash = `update-sem-${seq}`;
    const now = new Date();

    await prisma.ledger.create({
      data: { sequence: seq, hash, closeTime: now, txCount: 10 },
    });

    await prisma.ledger.update({
      where: { sequence: seq },
      data: { txCount: 42 },
    });

    const updated = await prisma.ledger.findUnique({ where: { sequence: seq } });
    expect(updated!.txCount).toBe(42);
    expect(updated!.hash).toBe(hash); // unchanged
    expect(updated!.closeTime.getTime()).toBeCloseTo(now.getTime(), -2); // unchanged

    await prisma.ledger.delete({ where: { sequence: seq } });
  });

  it('updates updatedAt on Contract', async () => {
    const addr = `CA-upd-${Math.random().toString(36).slice(2, 8)}`;
    const before = new Date();
    await prisma.contract.create({
      data: { address: addr, name: 'Before', isToken: false },
    });

    await prisma.contract.update({
      where: { address: addr },
      data: { name: 'After' },
    });

    const found = await prisma.contract.findUnique({ where: { address: addr } });
    expect(found!.name).toBe('After');
    expect(found!.updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());

    await prisma.contract.delete({ where: { address: addr } });
  });

  // ─── Composite index queries ───────────────────────────────────────────────

  it('queries Transaction by contract + ledger composite index', async () => {
    const seq = Math.floor(Math.random() * 100_000_000) + 1;
    const ledgerHash = `composite-idx-${seq}`;
    const now = new Date();

    await prisma.ledger.create({
      data: { sequence: seq, hash: ledgerHash, closeTime: now, txCount: 2 },
    });

    const contractAddr = `CA-comp-${Math.random().toString(36).slice(2, 8)}`;
    await prisma.contract.create({
      data: { address: contractAddr, isToken: false },
    });

    const txHashes: string[] = [];
    for (let i = 0; i < 3; i++) {
      const th = `comp-tx-${seq}-${i}`;
      txHashes.push(th);
      await prisma.transaction.create({
        data: {
          hash: th,
          ledgerSequence: seq,
          ledgerCloseTime: now,
          sourceAccount: 'GA' + Math.random().toString(36).slice(2, 10),
          contractAddress: contractAddr,
          rawXdr: 'AAAA',
          status: 'success',
        },
      });
    }

    const found = await prisma.transaction.findMany({
      where: { contractAddress: contractAddr, ledgerSequence: seq },
      orderBy: { id: 'desc' },
    });
    expect(found).toHaveLength(3);
    expect(found.map((t) => t.hash).sort()).toEqual(txHashes.sort());

    await prisma.transaction.deleteMany({ where: { ledgerSequence: seq } });
    await prisma.ledger.delete({ where: { sequence: seq } });
    await prisma.contract.delete({ where: { address: contractAddr } });
  });

  it('queries Event by contract + topic symbol composite index', async () => {
    const seq = Math.floor(Math.random() * 100_000_000) + 1;
    const ledgerHash = `event-idx-${seq}`;
    const txHash = `event-idx-tx-${seq}`;
    const now = new Date();

    await prisma.ledger.create({
      data: { sequence: seq, hash: ledgerHash, closeTime: now, txCount: 1 },
    });
    await prisma.transaction.create({
      data: {
        hash: txHash,
        ledgerSequence: seq,
        ledgerCloseTime: now,
        sourceAccount: 'GA' + Math.random().toString(36).slice(2, 10),
        rawXdr: 'AAAA',
        status: 'success',
      },
    });

    const contractAddr = `CA-ev-${Math.random().toString(36).slice(2, 8)}`;
    await prisma.contract.create({
      data: { address: contractAddr, isToken: false },
    });

    await prisma.event.create({
      data: {
        transactionHash: txHash,
        contractAddress: contractAddr,
        eventType: 'transfer',
        topicSymbol: 'transfer',
        topics: [],
        data: {},
        ledgerSequence: seq,
        ledgerCloseTime: now,
      },
    });

    const matching = await prisma.event.findMany({
      where: { contractAddress: contractAddr, topicSymbol: 'transfer' },
    });
    expect(matching).toHaveLength(1);
    expect(matching[0].eventType).toBe('transfer');

    await prisma.event.deleteMany({ where: { transactionHash: txHash } });
    await prisma.transaction.delete({ where: { hash: txHash } });
    await prisma.ledger.delete({ where: { sequence: seq } });
    await prisma.contract.delete({ where: { address: contractAddr } });
  });

  // ─── Edge cases ────────────────────────────────────────────────────────────

  it('returns empty array when no rows match', async () => {
    const result = await prisma.ledger.findMany({
      where: { sequence: -999_999 },
    });
    expect(result).toEqual([]);
  });

  it('returns null for findUnique on non-existent record', async () => {
    const result = await prisma.ledger.findUnique({
      where: { sequence: -999_999 },
    });
    expect(result).toBeNull();
  });

  it('handles string array fields', async () => {
    const addr = `CA-arr-${Math.random().toString(36).slice(2, 8)}`;
    await prisma.contract.create({
      data: {
        address: addr,
        isToken: false,
      },
    });

    await prisma.wasmUpgradeHistory.create({
      data: {
        contractAddress: addr,
        newHash: 'abc123',
        ledgerSequence: 1,
        ledgerCloseTime: new Date(),
        criticalFnChanges: ['approve', 'transfer'],
        suspiciousFlags: [],
        isSuspicious: false,
      },
    });

    const found = await prisma.wasmUpgradeHistory.findFirst({
      where: { contractAddress: addr },
    });
    expect(found!.criticalFnChanges).toEqual(['approve', 'transfer']);
    expect(found!.suspiciousFlags).toEqual([]);

    await prisma.wasmUpgradeHistory.deleteMany({ where: { contractAddress: addr } });
    await prisma.contract.delete({ where: { address: addr } });
  });

  // ─── Transaction support ────────────────────────────────────────────────────

  it('commits a transaction that creates related records', async () => {
    const seq = Math.floor(Math.random() * 100_000_000) + 1;
    const ledgerHash = `txn-ledger-${seq}`;
    const txHash = `txn-tx-${seq}`;
    const now = new Date();

    await prisma.$transaction(async (tx) => {
      await tx.ledger.create({
        data: { sequence: seq, hash: ledgerHash, closeTime: now, txCount: 1 },
      });
      await tx.transaction.create({
        data: {
          hash: txHash,
          ledgerSequence: seq,
          ledgerCloseTime: now,
          sourceAccount: 'GA' + Math.random().toString(36).slice(2, 10),
          rawXdr: 'AAAA',
          status: 'success',
        },
      });
    });

    const ledgerCheck = await prisma.ledger.findUnique({ where: { sequence: seq } });
    expect(ledgerCheck).not.toBeNull();

    await prisma.transaction.delete({ where: { hash: txHash } });
    await prisma.ledger.delete({ where: { sequence: seq } });
  });

  // ─── count and aggregate ────────────────────────────────────────────────────

  it('counts records and returns zero for empty filters', async () => {
    const zero = await prisma.ledger.count({ where: { sequence: -1 } });
    expect(zero).toBe(0);
  });

  it('findFirst returns null when no match', async () => {
    const result = await prisma.ledger.findFirst({ where: { sequence: -1 } });
    expect(result).toBeNull();
  });

  // ─── IndexerState singleton pattern ─────────────────────────────────────────

  it('upserts IndexerState singleton', async () => {
    await prisma.indexerState.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', lastLedger: 42 },
      update: { lastLedger: 42 },
    });

    const state = await prisma.indexerState.findUnique({
      where: { id: 'singleton' },
    });
    expect(state).not.toBeNull();
    expect(state!.lastLedger).toBe(42);

    await prisma.indexerState.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', lastLedger: 99 },
      update: { lastLedger: 99 },
    });
    const updated = await prisma.indexerState.findUnique({
      where: { id: 'singleton' },
    });
    expect(updated!.lastLedger).toBe(99);

    await prisma.indexerState.delete({ where: { id: 'singleton' } });
  });

  // ─── Enum type compatibility ───────────────────────────────────────────────

  it('reads enum values on GovernanceContract tables', async () => {
    const addr = `CA-gov-enum-${Math.random().toString(36).slice(2, 6)}`;
    await prisma.governanceContract.create({
      data: { contractAddress: addr, governanceType: 'token_based' },
    });

    const found = await prisma.governanceContract.findUnique({
      where: { contractAddress: addr },
    });
    expect(found!.governanceType).toBe('token_based');

    await prisma.governanceContract.delete({ where: { contractAddress: addr } });
  });
});
