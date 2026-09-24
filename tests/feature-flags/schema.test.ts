import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// schema.ts pulls prismaRead from db.ts → config.ts → profile validation, which
// requires DATABASE_URL. All checks here inject their own client, so stub the
// module to keep this unit test standalone.
vi.mock('../../src/db', () => ({
  prismaRead: {},
}));

import {
  loadExistingTables,
  tablesExist,
  tablesExistSync,
  invalidateSchemaCache,
} from '../../src/feature-flags/schema';

describe('feature-flag schema availability', () => {
  let client: { $queryRawUnsafe: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    invalidateSchemaCache();
    client = { $queryRawUnsafe: vi.fn() };
  });

  afterEach(() => {
    invalidateSchemaCache();
    vi.restoreAllMocks();
  });

  it('returns true when every required table exists', async () => {
    client.$queryRawUnsafe.mockResolvedValue([
      { table_name: '_dex_pools' },
      { table_name: '_pool_prices' },
      { table_name: '_price_deviations' },
    ]);
    expect(
      await tablesExist(['_dex_pools', '_pool_prices', '_price_deviations'], client as never),
    ).toBe(true);
  });

  it('returns false when any required table is missing', async () => {
    client.$queryRawUnsafe.mockResolvedValue([{ table_name: '_dex_pools' }]);
    expect(await tablesExist(['_dex_pools', '_pool_prices'], client as never)).toBe(false);
  });

  it('treats an empty table list as always available', async () => {
    expect(await tablesExist([], client as never)).toBe(true);
  });

  it('caches the table list within the TTL', async () => {
    client.$queryRawUnsafe.mockResolvedValue([{ table_name: '_dex_pools' }]);
    await tablesExist(['_dex_pools'], client as never);
    await tablesExist(['_dex_pools'], client as never);
    expect(client.$queryRawUnsafe).toHaveBeenCalledTimes(1);
  });

  it('fails safe (all tables missing) when the DB errors', async () => {
    client.$queryRawUnsafe.mockRejectedValue(new Error('db down'));
    expect(await tablesExist(['_dex_pools'], client as never)).toBe(false);
    // sync view agrees after the failed load
    expect(tablesExistSync(['_dex_pools'])).toBe(false);
  });

  it('tablesExistSync reflects the cached list after a warm-up', async () => {
    client.$queryRawUnsafe.mockResolvedValue([
      { table_name: '_dex_pools' },
      { table_name: '_pool_prices' },
    ]);
    await loadExistingTables(client as never);
    expect(tablesExistSync(['_dex_pools', '_pool_prices'])).toBe(true);
    expect(tablesExistSync(['_fee_events'])).toBe(false);
  });

  it('tablesExistSync reports unavailable while the cache is cold', () => {
    expect(tablesExistSync(['_dex_pools'])).toBe(false);
  });
});
