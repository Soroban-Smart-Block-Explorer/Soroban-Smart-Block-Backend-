/**
 * #917 — Per-route cache TTL policy: a single TTL registry must exist,
 * volatile routes (prices, fees, arbitrage) must use short TTLs while stable
 * routes (ABIs, metadata, proofs) use long TTLs, and cacheSet() must resolve
 * the TTL from the registry when the caller passes none.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

// Force in-memory mode so TTL expiry is driven by the mocked clock.
vi.stubEnv('CACHE_URL', 'memory://');

const VOLATILE_NAMESPACES = [
  'cg_price',
  'cmc_price',
  'se_price',
  'chain_price',
  'dex_price',
  'composite_price',
  'arbitrage',
  'graph',
  'fee',
];

const STABLE_NAMESPACES = ['abi', 'token-metadata', 'classic-asset', 'ledger', 'proof'];

afterEach(() => {
  vi.useRealTimers();
});

describe('cache TTL registry (#917)', () => {
  it('gives volatile resources short TTLs (seconds)', async () => {
    const { ttlForResource } = await import('../src/cache-ttl');
    for (const ns of VOLATILE_NAMESPACES) {
      expect(ttlForResource(ns), `${ns} should be <= 60s`).toBeLessThanOrEqual(60);
    }
  });

  it('gives stable resources long TTLs (hours-days)', async () => {
    const { ttlForResource } = await import('../src/cache-ttl');
    for (const ns of STABLE_NAMESPACES) {
      expect(ttlForResource(ns), `${ns} should be >= 1h`).toBeGreaterThanOrEqual(3600);
    }
  });

  it('maps unknown namespaces to the legacy default', async () => {
    const { cacheResourceFor, ttlForResource } = await import('../src/cache-ttl');
    expect(cacheResourceFor('some-new-route:123')).toBe('default');
    expect(ttlForResource(cacheResourceFor('some-new-route:123'))).toBe(300);
  });

  it('resolves the resource namespace from the key prefix', async () => {
    const { cacheResourceFor } = await import('../src/cache-ttl');
    expect(cacheResourceFor('abi:CA3D...')).toBe('abi');
    expect(cacheResourceFor('cg_price:USDC')).toBe('cg_price');
    expect(cacheResourceFor('ledger:12345')).toBe('ledger');
  });

  it('applies registry TTLs when cacheSet receives no explicit TTL', async () => {
    vi.resetModules();
    const mod = await import('../src/cache');
    mod.cacheClear();

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    await mod.cacheSet('abi:CA3D...', { abi: true }); // registry: 7 days
    await mod.cacheSet('cg_price:USDC', 1.23); // registry: 30s

    // Both readable within the volatile window...
    vi.setSystemTime(new Date('2026-01-01T00:00:29Z'));
    expect(await mod.cacheGet('abi:CA3D...')).toEqual({ abi: true });
    expect(await mod.cacheGet('cg_price:USDC')).toBe(1.23);

    // ...after 30s the price is gone, the stable ABI survives.
    vi.setSystemTime(new Date('2026-01-01T00:00:31Z'));
    expect(await mod.cacheGet('cg_price:USDC')).toBeNull();
    expect(await mod.cacheGet('abi:CA3D...')).toEqual({ abi: true });
  });

  it('still honours an explicit TTL over the registry', async () => {
    vi.resetModules();
    const mod = await import('../src/cache');
    mod.cacheClear();

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    await mod.cacheSet('abi:CA3D...', 'x', 2); // explicit 2s beats registry 7d
    vi.setSystemTime(new Date('2026-01-01T00:00:03Z'));
    expect(await mod.cacheGet('abi:CA3D...')).toBeNull();
  });

  it('keeps null TTL semantics (no expiry)', async () => {
    vi.resetModules();
    const mod = await import('../src/cache');
    mod.cacheClear();

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    await mod.cacheSet('ledger:0', 'immutable', null);
    vi.setSystemTime(new Date('2026-01-02T00:00:00Z'));
    expect(await mod.cacheGet('ledger:0')).toBe('immutable');
  });
});
