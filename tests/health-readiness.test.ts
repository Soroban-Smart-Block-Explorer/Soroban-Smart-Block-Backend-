import { describe, it, expect, vi } from 'vitest';
import { getReadinessState } from '../src/readiness';
import { getHealthStatus } from '../src/health';

vi.mock('../src/db', () => ({
  prismaRead: {
    $queryRaw: vi.fn().mockResolvedValue([{}]),
  },
  prismaWrite: {
    $queryRaw: vi.fn().mockResolvedValue([{}]),
  },
}));

vi.mock('../src/scheduler/cron-scheduler', () => ({
  scheduler: {
    getHealthSummary: vi.fn().mockReturnValue({ status: 'healthy', jobs: [] }),
  },
}));

vi.mock('../src/indexer/indexer', () => ({
  getLastIndexedLedger: vi.fn().mockResolvedValue(0),
}));

vi.mock('../src/indexer/rpc', () => ({
  getLatestLedger: vi.fn().mockResolvedValue(0),
}));

vi.mock('../src/db/replicaGateway', () => ({
  measureReplicaLag: vi.fn().mockResolvedValue(0),
}));

describe('Health and Readiness dependency set alignment', () => {
  it('asserts that /readyz and /health never disagree on the dependency set', async () => {
    const readinessState = getReadinessState();
    const healthStatus = await getHealthStatus(false);

    const readinessKeys = Object.keys(readinessState).sort();
    const healthKeys = Object.keys(healthStatus.dependencies).sort();

    // Mapping between readiness dependency names and health response dependency keys
    const readinessToHealthMap: Record<string, string> = {
      db: 'database',
      cache: 'cache',
      rpc: 'rpc',
      indexer: 'indexer',
      coldStorage: 'coldStorage',
      p2p: 'p2p',
      worker: 'worker',
    };

    const mappedReadinessKeys = readinessKeys.map(k => readinessToHealthMap[k] || k).sort();

    expect(mappedReadinessKeys).toEqual(healthKeys);
  });
});
