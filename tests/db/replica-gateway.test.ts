import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  measureReplicaLag,
  getReadClient,
  LAG_THRESHOLD_LEDGERS,
  _resetLagCache,
} from '../../src/db/replicaGateway';
import type { PrismaClient } from '@prisma/client';

vi.mock('../../src/metrics', () => ({
  replicaLagCheckErrors: { inc: vi.fn() },
}));

function makeClient(lastLedger: number | null) {
  return {
    $queryRawUnsafe: vi.fn().mockResolvedValue([{ exists: true }]),
    indexerState: {
      findUnique: vi.fn().mockResolvedValue(lastLedger !== null ? { lastLedger } : null),
    },
  } as unknown as PrismaClient;
}

beforeEach(() => _resetLagCache());

describe('measureReplicaLag', () => {
  it('returns 0 when replica is in sync', async () => {
    const lag = await measureReplicaLag(makeClient(100), makeClient(100));
    expect(lag).toBe(0);
  });

  it('returns positive lag when replica is behind', async () => {
    const lag = await measureReplicaLag(makeClient(98), makeClient(100));
    expect(lag).toBe(2);
  });

  it('never returns negative lag', async () => {
    const lag = await measureReplicaLag(makeClient(105), makeClient(100));
    expect(lag).toBe(0);
  });

  it('forces primary by returning excess-lag when the DB throws', async () => {
    const broken = {
      $queryRawUnsafe: vi.fn().mockResolvedValue([{ exists: true }]),
      indexerState: { findUnique: vi.fn().mockRejectedValue(new Error('db down')) },
    } as unknown as PrismaClient;
    const lag = await measureReplicaLag(broken, broken);
    expect(lag).toBeGreaterThan(LAG_THRESHOLD_LEDGERS);
  });

  it('forces primary when the indexer state table does not exist', async () => {
    const missingTable = {
      $queryRawUnsafe: vi.fn().mockResolvedValue([{ exists: false }]),
      indexerState: { findUnique: vi.fn() },
    } as unknown as PrismaClient;

    const lag = await measureReplicaLag(missingTable, missingTable);

    expect(lag).toBeGreaterThan(LAG_THRESHOLD_LEDGERS);
  });

  it('caches the result within TTL', async () => {
    const read = makeClient(98);
    const write = makeClient(100);
    await measureReplicaLag(read, write);
    await measureReplicaLag(read, write);
    expect(read.indexerState.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe('getReadClient', () => {
  it('returns the read client when lag is within threshold', async () => {
    const read = makeClient(99);
    const write = makeClient(100);
    const client = await getReadClient(read, write);
    expect(client).toBe(read);
  });

  it(`falls back to write client when lag exceeds ${LAG_THRESHOLD_LEDGERS} ledgers`, async () => {
    const read = makeClient(90);
    const write = makeClient(100);
    const client = await getReadClient(read, write);
    expect(client).toBe(write);
  });

  it('returns read client when lag equals threshold exactly', async () => {
    const read = makeClient(100 - LAG_THRESHOLD_LEDGERS);
    const write = makeClient(100);
    const client = await getReadClient(read, write);
    expect(client).toBe(read);
  });

  it('returns write client when DB throws (database-outage scenario)', async () => {
    const broken = {
      indexerState: { findUnique: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) },
    } as unknown as PrismaClient;
    const client = await getReadClient(broken, broken);
    // write === broken here; confirms primary is selected on outage
    expect(client).toBe(broken);
  });
});
