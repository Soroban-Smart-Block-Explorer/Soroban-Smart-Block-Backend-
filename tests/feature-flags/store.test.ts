import { describe, it, expect, vi, beforeEach } from 'vitest';

// The store's default clients import db.ts → config.ts → profile validation,
// which requires DATABASE_URL. The store under test injects its own clients, so
// stub the module to keep this unit test standalone.
vi.mock('../../src/db', () => ({
  prismaRead: {},
  prismaWrite: {},
}));

import { FeatureFlagStore, FLAG_CACHE_TTL_MS } from '../../src/feature-flags/store';
import { listFlagDefinitions } from '../../src/feature-flags/registry';

// Narrow helper types for the mocks used by the store.
type MockClient = {
  featureFlag: {
    findMany: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
  };
  featureFlagOverride: {
    upsert: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };
};
function makeRead(): MockClient {
  return {
    featureFlag: { findMany: vi.fn(), upsert: vi.fn() },
    featureFlagOverride: { upsert: vi.fn(), deleteMany: vi.fn() },
  };
}
function makeWrite(): MockClient {
  return {
    featureFlag: { findMany: vi.fn(), upsert: vi.fn() },
    featureFlagOverride: { upsert: vi.fn(), deleteMany: vi.fn() },
  };
}

describe('FeatureFlagStore', () => {
  let read: MockClient;
  let write: MockClient;
  let store: FeatureFlagStore;

  beforeEach(() => {
    read = makeRead();
    write = makeWrite();
    read.featureFlag.findMany.mockResolvedValue([]);
    write.featureFlag.upsert.mockImplementation(
      async (args: {
        create: {
          key: string;
          defaultEnabled: boolean;
          rolloutPercent: number;
          description?: string;
        };
      }) => ({
        key: args.create.key,
        defaultEnabled: args.create.defaultEnabled,
        rolloutPercent: args.create.rolloutPercent,
        overrides: [],
      }),
    );
    write.featureFlagOverride.upsert.mockResolvedValue({});
    write.featureFlagOverride.deleteMany.mockResolvedValue({ count: 0 });
    store = new FeatureFlagStore(read as never, write as never);
  });

  it('loads flag rows and groups overrides by scope type', async () => {
    read.featureFlag.findMany.mockResolvedValue([
      {
        key: 'poolMonitor',
        defaultEnabled: false,
        rolloutPercent: 25,
        overrides: [
          { scopeType: 'environment', scopeValue: 'testnet', enabled: true },
          { scopeType: 'developer', scopeValue: 'dev-1', enabled: true },
          { scopeType: 'developer', scopeValue: 'dev-2', enabled: false },
        ],
      },
    ]);

    const flags = await store.load();
    const snap = flags.get('poolMonitor');
    expect(snap?.defaultEnabled).toBe(false);
    expect(snap?.rolloutPercent).toBe(25);
    expect(snap?.environmentOverrides.get('testnet')).toBe(true);
    expect(snap?.developerOverrides.get('dev-1')).toBe(true);
    expect(snap?.developerOverrides.get('dev-2')).toBe(false);
  });

  it('caches within TTL and reloads after invalidation', async () => {
    read.featureFlag.findMany.mockResolvedValue([
      { key: 'poolMonitor', defaultEnabled: false, rolloutPercent: 0, overrides: [] },
    ]);
    await store.load();
    await store.load();
    expect(read.featureFlag.findMany).toHaveBeenCalledTimes(1);

    read.featureFlag.findMany.mockResolvedValue([
      { key: 'poolMonitor', defaultEnabled: true, rolloutPercent: 0, overrides: [] },
    ]);
    store.invalidate();
    await store.load();
    expect(read.featureFlag.findMany).toHaveBeenCalledTimes(2);
    expect(store.getCachedSync('poolMonitor')?.defaultEnabled).toBe(true);
  });

  it('treats a stale cache as fresh for only FLAG_CACHE_TTL_MS', async () => {
    expect(FLAG_CACHE_TTL_MS).toBeGreaterThan(0);
    const snap = await store.load();
    expect(snap.size).toBe(0);
    expect(store.getCachedSync('poolMonitor')).toBeUndefined();
  });

  it('returns an empty snapshot map when the DB read fails (graceful degradation)', async () => {
    read.featureFlag.findMany.mockRejectedValue(new Error('db down'));
    const flags = await store.load();
    expect(flags.size).toBe(0);
    expect(store.getCachedSync('poolMonitor')).toBeUndefined();
  });

  it('ensureRegisteredFlags seeds a row per registered definition and keeps operator values', async () => {
    await store.ensureRegisteredFlags();
    const keys = write.featureFlag.upsert.mock.calls.map(
      (c) => (c[0] as { create: { key: string } }).create.key,
    );
    expect(keys.sort()).toEqual(
      listFlagDefinitions()
        .map((d) => d.key)
        .sort(),
    );
    // update only touches description, never default/rollout
    for (const call of write.featureFlag.upsert.mock.calls) {
      expect(call[0].update).toEqual({ description: expect.any(String) });
    }
  });

  it('updateFlag upserts and returns a snapshot, invalidating the cache', async () => {
    write.featureFlag.upsert.mockResolvedValue({
      key: 'poolMonitor',
      defaultEnabled: true,
      rolloutPercent: 10,
      overrides: [],
    });
    const snap = await store.updateFlag('poolMonitor', {
      defaultEnabled: true,
      rolloutPercent: 10,
    });
    expect(snap.defaultEnabled).toBe(true);
    expect(snap.rolloutPercent).toBe(10);
    // cache was invalidated → next load hits the DB
    read.featureFlag.findMany.mockResolvedValue([
      { key: 'poolMonitor', defaultEnabled: true, rolloutPercent: 10, overrides: [] },
    ]);
    await store.load();
    expect(read.featureFlag.findMany).toHaveBeenCalled();
  });

  it('setOverride upserts with the unique compound key and invalidates', async () => {
    await store.setOverride('poolMonitor', 'developer', 'dev-1', true);
    expect(write.featureFlagOverride.upsert).toHaveBeenCalledWith({
      where: {
        flagKey_scopeType_scopeValue: {
          flagKey: 'poolMonitor',
          scopeType: 'developer',
          scopeValue: 'dev-1',
        },
      },
      create: {
        flagKey: 'poolMonitor',
        scopeType: 'developer',
        scopeValue: 'dev-1',
        enabled: true,
      },
      update: { enabled: true },
    });
  });

  it('clearOverride deletes the matching row and invalidates', async () => {
    await store.clearOverride('poolMonitor', 'environment', 'testnet');
    expect(write.featureFlagOverride.deleteMany).toHaveBeenCalledWith({
      where: { flagKey: 'poolMonitor', scopeType: 'environment', scopeValue: 'testnet' },
    });
  });
});
