/**
 * tests/cache.test.ts
 * Issue #254 — Cache Layer Exhaustive Testing
 *
 * Tests the in-memory path only (Redis is skipped in CI via CACHE_URL=memory://).
 * Redis-specific tests use vi.mock to simulate behaviour without a live Redis.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Force in-memory mode for all tests
vi.stubEnv('TESTNET_CACHE_URL', 'memory://');
vi.stubEnv('CACHE_URL', 'memory://');

async function freshCache() {
  vi.resetModules();
  const mod = await import('../src/cache');
  mod.cacheClear();
  return mod;
}

// ── Phase 1: In-Memory CRUD ────────────────────────────────────────────────────

describe('cache — in-memory CRUD', () => {
  it('set and get returns the stored value', async () => {
    const { cacheSet, cacheGet } = await freshCache();
    await cacheSet('key1', { x: 42 });
    expect(await cacheGet('key1')).toEqual({ x: 42 });
  });

  it('get returns null for missing key', async () => {
    const { cacheGet } = await freshCache();
    expect(await cacheGet('missing')).toBeNull();
  });

  it('delete removes the key', async () => {
    const { cacheSet, cacheGet, cacheDelete } = await freshCache();
    await cacheSet('del', 'value');
    await cacheDelete('del');
    expect(await cacheGet('del')).toBeNull();
  });

  it('delete is a no-op for non-existent keys', async () => {
    const { cacheDelete } = await freshCache();
    await expect(cacheDelete('ghost')).resolves.not.toThrow();
  });

  it('overwrite replaces existing value', async () => {
    const { cacheSet, cacheGet } = await freshCache();
    await cacheSet('ov', 'first');
    await cacheSet('ov', 'second');
    expect(await cacheGet('ov')).toBe('second');
  });

  it('stores and retrieves complex objects', async () => {
    const { cacheSet, cacheGet } = await freshCache();
    const obj = { nested: { arr: [1, 2, 3], flag: true }, str: 'hello' };
    await cacheSet('complex', obj);
    expect(await cacheGet('complex')).toEqual(obj);
  });

  it('handles numeric values', async () => {
    const { cacheSet, cacheGet } = await freshCache();
    await cacheSet('num', 999);
    expect(await cacheGet('num')).toBe(999);
  });

  it('handles null value stored as JSON', async () => {
    const { cacheSet, cacheGet } = await freshCache();
    await cacheSet('nullval', null);
    expect(await cacheGet('nullval')).toBeNull();
  });

  it('different keys are independent', async () => {
    const { cacheSet, cacheGet } = await freshCache();
    await cacheSet('a', 1);
    await cacheSet('b', 2);
    expect(await cacheGet('a')).toBe(1);
    expect(await cacheGet('b')).toBe(2);
  });

  it('cacheClear wipes all entries', async () => {
    const { cacheSet, cacheGet, cacheClear } = await freshCache();
    await cacheSet('c1', 'x');
    await cacheSet('c2', 'y');
    cacheClear();
    expect(await cacheGet('c1')).toBeNull();
    expect(await cacheGet('c2')).toBeNull();
  });
});

// ── Phase 1: TTL expiration ────────────────────────────────────────────────────

describe('cache — TTL expiration (clock mocking)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns value before TTL expires', async () => {
    const { cacheSet, cacheGet } = await freshCache();
    await cacheSet('ttl1', 'alive', 5); // 5s TTL
    vi.advanceTimersByTime(4_000);
    expect(await cacheGet('ttl1')).toBe('alive');
  });

  it('returns null after TTL expires', async () => {
    const { cacheSet, cacheGet } = await freshCache();
    await cacheSet('ttl2', 'dead', 2); // 2s TTL
    vi.advanceTimersByTime(3_000);
    expect(await cacheGet('ttl2')).toBeNull();
  });

  it('null TTL means no expiry', async () => {
    const { cacheSet, cacheGet } = await freshCache();
    await cacheSet('forever', 'here', null);
    vi.advanceTimersByTime(999_999_000);
    expect(await cacheGet('forever')).toBe('here');
  });

  it('zero TTL is treated as no expiry', async () => {
    const { cacheSet, cacheGet } = await freshCache();
    await cacheSet('zero-ttl', 'persists', 0);
    vi.advanceTimersByTime(60_000);
    expect(await cacheGet('zero-ttl')).toBe('persists');
  });

  it('expired key is cleaned up on next get', async () => {
    const { cacheSet, cacheGet } = await freshCache();
    await cacheSet('clean', 'val', 1);
    vi.advanceTimersByTime(2_000);
    await cacheGet('clean'); // triggers eviction
    // Re-reading should still return null
    expect(await cacheGet('clean')).toBeNull();
  });
});

// ── Phase 3: Concurrency / Race Conditions ─────────────────────────────────────

describe('cache — concurrent operations', () => {
  it('concurrent sets to the same key all resolve without error', async () => {
    const { cacheSet, cacheGet } = await freshCache();
    await Promise.all(Array.from({ length: 20 }, (_, i) => cacheSet('race', i)));
    const val = await cacheGet<number>('race');
    expect(typeof val).toBe('number');
  });

  it('concurrent sets to different keys are independent', async () => {
    const { cacheSet, cacheGet } = await freshCache();
    const keys = Array.from({ length: 10 }, (_, i) => `k${i}`);
    await Promise.all(keys.map((k) => cacheSet(k, k)));
    for (const k of keys) {
      expect(await cacheGet(k)).toBe(k);
    }
  });

  it('concurrent get+set does not throw', async () => {
    const { cacheSet, cacheGet } = await freshCache();
    await cacheSet('shared', 'initial');
    await expect(
      Promise.all([
        cacheGet('shared'),
        cacheSet('shared', 'updated'),
        cacheGet('shared'),
      ]),
    ).resolves.not.toThrow();
  });
});

// ── Phase 2: Redis fallback simulation ────────────────────────────────────────

describe('cache — Redis error handling (simulated)', () => {
  it('falls back to in-memory when Redis connection fails', async () => {
    vi.resetModules();
    // Mock the redis module to simulate connection failure
    vi.mock('redis', () => ({
      createClient: () => ({
        on: vi.fn(),
        connect: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
        get: vi.fn(),
        set: vi.fn(),
        del: vi.fn(),
        quit: vi.fn(),
        disconnect: vi.fn(),
      }),
    }));

    // Override cache URL to trigger Redis path
    vi.stubEnv('TESTNET_CACHE_URL', 'redis://localhost:6379');

    const mod = await import('../src/cache');
    mod.cacheClear();

    // Should still work via in-memory fallback
    await mod.cacheSet('fallback-key', 'fallback-val');
    expect(await mod.cacheGet('fallback-key')).toBe('fallback-val');

    vi.unmock('redis');
    vi.stubEnv('TESTNET_CACHE_URL', 'memory://');
  });
});

// ── Phase 1: cacheConnect / cacheClose lifecycle ──────────────────────────────

describe('cache — lifecycle (memory mode)', () => {
  it('cacheConnect resolves without error in memory mode', async () => {
    const { cacheConnect } = await freshCache();
    await expect(cacheConnect()).resolves.not.toThrow();
  });

  it('cacheClose resolves without error when no Redis client exists', async () => {
    const { cacheClose } = await freshCache();
    await expect(cacheClose()).resolves.not.toThrow();
  });

  it('cacheClose is idempotent', async () => {
    const { cacheClose } = await freshCache();
    await cacheClose();
    await expect(cacheClose()).resolves.not.toThrow();
  });
});

// ── Phase 4: Performance (sanity check, not strict benchmarks) ────────────────

describe('cache — throughput sanity', () => {
  it('completes 1000 set+get operations without error', async () => {
    const { cacheSet, cacheGet } = await freshCache();
    const ops = Array.from({ length: 1000 }, (_, i) =>
      cacheSet(`perf:${i}`, i).then(() => cacheGet<number>(`perf:${i}`)),
    );
    const results = await Promise.all(ops);
    // All should have resolved
    expect(results.filter((r) => r === null).length).toBe(0);
  });
});
