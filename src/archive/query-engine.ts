import { prismaRead } from '../db';

const prisma = prismaRead as any;

export interface StateAtLedger {
  contractAddress: string;
  ledger: number;
  entries: {
    key: string;
    keyHuman: string | null;
    value: string | null;
    valueHuman: string | null;
  }[];
  totalKeys: number;
}

export interface KeyHistory {
  contractAddress: string;
  storageKey: string;
  history: {
    ledger: number;
    ledgerCloseTime: Date;
    operation: string;
    valueBefore: string | null;
    valueAfter: string | null;
    valueHuman: string | null;
    transactionHash: string | null;
  }[];
}

export interface LedgerDiff {
  contractAddress: string;
  fromLedger: number;
  toLedger: number;
  added: { key: string; keyHuman: string | null; value: string | null }[];
  updated: {
    key: string;
    keyHuman: string | null;
    valueBefore: string | null;
    valueAfter: string | null;
  }[];
  deleted: { key: string; keyHuman: string | null }[];
}

export async function getStateAtLedger(
  contractAddress: string,
  ledger: number,
  options: { page?: number; pageSize?: number; search?: string } = {},
): Promise<StateAtLedger> {
  const page = options.page ?? 1;
  const pageSize = Math.min(options.pageSize ?? 100, 1000);
  const skip = (page - 1) * pageSize;

  // For each key, find the latest change at or before `ledger`
  const allKeys: Array<{ storageKey: string }> = await prisma.contractStateChange.findMany({
    where: { contractAddress, ledger: { lte: ledger } },
    select: { storageKey: true },
    distinct: ['storageKey'],
  });

  const keyList = allKeys.map((k) => k.storageKey);
  const search = options.search?.toLowerCase();
  const filteredKeys = search ? keyList.filter((k) => k.toLowerCase().includes(search)) : keyList;

  const pageKeys: string[] = filteredKeys.slice(skip, skip + pageSize);

  const entries = await Promise.all(
    pageKeys.map(async (key) => {
      const latest = await prisma.contractStateChange.findFirst({
        where: {
          contractAddress,
          storageKey: key,
          ledger: { lte: ledger },
          operation: { not: 'delete' },
        },
        orderBy: { ledger: 'desc' },
        select: { storageKey: true, storageKeyHuman: true, valueAfter: true, valueHuman: true },
      });
      return {
        key,
        keyHuman: latest?.storageKeyHuman ?? null,
        value: latest?.valueAfter ?? null,
        valueHuman: latest?.valueHuman ?? null,
      };
    }),
  );

  return { contractAddress, ledger, entries, totalKeys: filteredKeys.length };
}

export async function getKeyHistory(
  contractAddress: string,
  storageKey: string,
): Promise<KeyHistory> {
  const history = await prisma.contractStateChange.findMany({
    where: { contractAddress, storageKey },
    orderBy: { ledger: 'asc' },
    select: {
      ledger: true,
      ledgerCloseTime: true,
      operation: true,
      valueBefore: true,
      valueAfter: true,
      valueHuman: true,
      transactionHash: true,
    },
  });

  return { contractAddress, storageKey, history };
}

export async function getLedgerDiff(
  contractAddress: string,
  fromLedger: number,
  toLedger: number,
): Promise<LedgerDiff> {
  if (fromLedger >= toLedger) {
    throw new Error('fromLedger must be less than toLedger');
  }

  const changes: Array<{
    storageKey: string;
    valueBefore: string | null;
    valueAfter: string | null;
    operation: string;
    storageKeyHuman: string | null;
  }> = await prisma.contractStateChange.findMany({
    where: { contractAddress, ledger: { gt: fromLedger, lte: toLedger } },
    orderBy: [{ storageKey: 'asc' }, { ledger: 'asc' }],
  });

  const keyMap = new Map<
    string,
    {
      firstBefore: string | null;
      lastAfter: string | null;
      lastOp: string;
      keyHuman: string | null;
    }
  >();

  for (const c of changes) {
    if (!keyMap.has(c.storageKey)) {
      keyMap.set(c.storageKey, {
        firstBefore: c.valueBefore,
        lastAfter: c.valueAfter,
        lastOp: c.operation,
        keyHuman: c.storageKeyHuman,
      });
    } else {
      const existing = keyMap.get(c.storageKey)!;
      existing.lastAfter = c.valueAfter;
      existing.lastOp = c.operation;
    }
  }

  const added: LedgerDiff['added'] = [];
  const updated: LedgerDiff['updated'] = [];
  const deleted: LedgerDiff['deleted'] = [];

  for (const [key, info] of keyMap) {
    if (info.lastOp === 'create') {
      added.push({ key, keyHuman: info.keyHuman, value: info.lastAfter });
    } else if (info.lastOp === 'delete') {
      deleted.push({ key, keyHuman: info.keyHuman });
    } else {
      updated.push({
        key,
        keyHuman: info.keyHuman,
        valueBefore: info.firstBefore,
        valueAfter: info.lastAfter,
      });
    }
  }

  return { contractAddress, fromLedger, toLedger, added, updated, deleted };
}

export async function getFullSnapshot(
  contractAddress: string,
  ledger: number,
): Promise<{
  contractAddress: string;
  ledger: number;
  snapshot: Record<string, string | null>;
  snapshotHuman: Record<string, string | null>;
}> {
  const state = await getStateAtLedger(contractAddress, ledger, { pageSize: 1000 });
  const snapshot: Record<string, string | null> = {};
  const snapshotHuman: Record<string, string | null> = {};

  for (const entry of state.entries) {
    if (entry.value !== null) {
      snapshot[entry.key] = entry.value;
      snapshotHuman[entry.keyHuman ?? entry.key] = entry.valueHuman ?? entry.value;
    }
  }

  return { contractAddress, ledger, snapshot, snapshotHuman };
}
