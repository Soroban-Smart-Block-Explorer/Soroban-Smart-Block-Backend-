import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/config', () => ({
  config: { stellarNetwork: 'testnet' },
}));

vi.mock('../../src/db', () => ({
  prismaRead: {
    featureFlag: { findMany: vi.fn() },
    $queryRawUnsafe: vi.fn(),
  },
  prismaWrite: {
    featureFlag: { upsert: vi.fn() },
    featureFlagOverride: { upsert: vi.fn(), deleteMany: vi.fn() },
  },
}));

import { prismaRead, prismaWrite } from '../../src/db';
import { featureFlags } from '../../src/feature-flags';
import { invalidateSchemaCache } from '../../src/feature-flags/schema';

function flagRow(
  overrides: Array<Record<string, unknown>> = [],
  extra: Partial<{ defaultEnabled: boolean; rolloutPercent: number }> = {},
) {
  return {
    key: 'poolMonitor',
    defaultEnabled: false,
    rolloutPercent: 0,
    overrides,
    ...extra,
  };
}

describe('FeatureFlags service', () => {
  beforeEach(() => {
    invalidateSchemaCache();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    (prismaRead.featureFlag.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prismaWrite.featureFlag.upsert as ReturnType<typeof vi.fn>).mockResolvedValue(
      flagRow() as never,
    );
    (prismaWrite.featureFlagOverride.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (prismaWrite.featureFlagOverride.deleteMany as ReturnType<typeof vi.fn>).mockResolvedValue({
      count: 0,
    });
    (prismaRead.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValue([
      { table_name: '_dex_pools' },
      { table_name: '_pool_prices' },
      { table_name: '_price_deviations' },
      { table_name: '_arbitrage_opportunities' },
    ]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    invalidateSchemaCache();
  });

  it('falls back to the legacy env var when the DB cache is empty (no rows)', async () => {
    // Cache cold + DB returns no rows → env var decides.
    vi.stubEnv('ENABLE_POOL_MONITOR', 'true');
    expect(featureFlags.isEnabledSync('poolMonitor')).toBe(true);
    vi.stubEnv('ENABLE_POOL_MONITOR', 'false');
    expect(featureFlags.isEnabledSync('poolMonitor')).toBe(false);
    vi.unstubAllEnvs();
    expect(featureFlags.isEnabledSync('poolMonitor')).toBe(false);
  });

  it('uses the DB default once a row exists and no env var is set', async () => {
    (prismaRead.featureFlag.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([flagRow()]);
    await featureFlags.bootstrap();
    expect(featureFlags.isEnabledSync('poolMonitor')).toBe(false);

    (prismaRead.featureFlag.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      flagRow([], { defaultEnabled: true }),
    ]);
    await featureFlags.refresh();
    expect(featureFlags.isEnabledSync('poolMonitor')).toBe(true);
  });

  it('honors a developer override from the DB (per-account toggle)', async () => {
    (prismaRead.featureFlag.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      flagRow([
        { scopeType: 'developer', scopeValue: 'dev-1', enabled: true },
        { scopeType: 'developer', scopeValue: 'dev-2', enabled: false },
      ]),
    ]);
    await featureFlags.bootstrap();
    expect(featureFlags.isEnabledSync('poolMonitor')).toBe(false);
    expect(featureFlags.isEnabledForDeveloper('poolMonitor', 'dev-1')).toBe(true);
    expect(featureFlags.isEnabledForDeveloper('poolMonitor', 'dev-2')).toBe(false);
    expect(featureFlags.isEnabledSync('poolMonitor', { developerId: 'dev-1' })).toBe(true);
  });

  it('honors an environment override scoped to the current network', async () => {
    (prismaRead.featureFlag.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      flagRow([{ scopeType: 'environment', scopeValue: 'testnet', enabled: true }]),
    ]);
    await featureFlags.bootstrap();
    expect(featureFlags.isEnabledSync('poolMonitor')).toBe(true);
    // Other environments are unaffected.
    expect(featureFlags.isEnabledSync('poolMonitor', { environment: 'mainnet' })).toBe(false);
  });

  it('applies gradual rollout to named developers only', async () => {
    (prismaRead.featureFlag.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      flagRow([], { defaultEnabled: false, rolloutPercent: 50 }),
    ]);
    await featureFlags.bootstrap();
    // Anonymous callers skip the bucket and get the default.
    expect(featureFlags.isEnabledSync('poolMonitor')).toBe(false);

    // Named developers are bucketed — some on, some off, stable across calls.
    const inBucket = new Set<boolean>();
    for (let i = 0; i < 200; i++) {
      const on = featureFlags.isEnabledForDeveloper('poolMonitor', `dev-${i}`);
      expect(on).toBe(featureFlags.isEnabledForDeveloper('poolMonitor', `dev-${i}`));
      inBucket.add(on);
    }
    expect(inBucket.has(true)).toBe(true);
    expect(inBucket.has(false)).toBe(true);
  });

  it('shouldStartSync requires the toggle AND schema availability', async () => {
    (prismaRead.featureFlag.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      flagRow([], { defaultEnabled: true }),
    ]);
    await featureFlags.bootstrap();

    // Tables exist → start.
    expect(featureFlags.isAvailableSync('poolMonitor')).toBe(true);
    expect(featureFlags.shouldStartSync('poolMonitor')).toBe(true);

    // Missing required table → flag on but schema unavailable → do not start.
    (prismaRead.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValue([
      { table_name: '_dex_pools' },
    ]);
    await featureFlags.refresh();
    expect(featureFlags.isEnabledSync('poolMonitor')).toBe(true);
    expect(featureFlags.isAvailableSync('poolMonitor')).toBe(false);
    expect(featureFlags.shouldStartSync('poolMonitor')).toBe(false);
  });

  it('a flag without requiredTables is always available', async () => {
    expect(featureFlags.isAvailableSync('composabilityWs')).toBe(true);
    expect(featureFlags.shouldStartSync('composabilityWs')).toBe(false); // default off
  });
});
