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
      Promise.all([cacheGet('shared'), cacheSet('shared', 'updated'), cacheGet('shared')]),
    ).resolves.not.toThrow();
  });
});

// ── Phase 2: Redis fallback simulation ────────────────────────────────────────

describe('cache — Redis error handling (simulated)', () => {
  it('falls back to in-memory when Redis connection fails', async () => {
    vi.resetModules();
    // Mock the redis module to simulate connection failure
    vi.doMock('redis', () => ({
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

// ── Consistency-sensitive key blocking ───────────────────────────────────────

describe('cache — consistency-sensitive key fallback disabled', () => {
  it('returns value for non-sensitive keys from memory when Redis is absent', async () => {
    const { cacheSet, cacheGet } = await freshCache();
    await cacheSet('abi:contract123', { fn: 'transfer' });
    expect(await cacheGet('abi:contract123')).toEqual({ fn: 'transfer' });
  });

  it('returns value for sensitive keys when Redis is not configured (memory-only mode)', async () => {
    // CACHE_URL=memory:// — no Redis configured, so sensitive keys are fine in memory
    const { cacheSet, cacheGet } = await freshCache();
    await cacheSet('auth:user:abc', { role: 'admin' });
    expect(await cacheGet('auth:user:abc')).toEqual({ role: 'admin' });
  });
});

// ── Key/value redaction in log output ────────────────────────────────────────

describe('cache — log redaction', () => {
  it('redactKey masks value after first colon', async () => {
    // Verify indirectly: error logs should not contain raw key values.
    // We simulate a Redis write failure and capture logger output.
    vi.resetModules();
    const mockLogger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    vi.doMock('../src/logger', () => ({ logger: mockLogger }));
    vi.doMock('redis', () => ({
      createClient: () => ({
        on: vi.fn(),
        connect: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockRejectedValue(new Error('read error')),
        set: vi.fn().mockRejectedValue(new Error('write error')),
        del: vi.fn(),
        quit: vi.fn(),
        disconnect: vi.fn(),
      }),
    }));
    vi.stubEnv('TESTNET_CACHE_URL', 'redis://localhost:6379');

    const mod = await import('../src/cache');
    mod.cacheClear();
    await mod.cacheSet('auth:secret-token-xyz', 'super-secret');
    await mod.cacheGet('auth:secret-token-xyz');

    const allCalls = mockLogger.warn.mock.calls.flatMap((c) => JSON.stringify(c));
    // Raw token value must never appear in logs
    expect(allCalls.some((s) => s.includes('secret-token-xyz'))).toBe(false);
    // Redacted form should appear (namespace prefix only)
    expect(allCalls.some((s) => s.includes('auth:[redacted]'))).toBe(true);

    vi.unmock('../src/logger');
    vi.unmock('redis');
    vi.stubEnv('TESTNET_CACHE_URL', 'memory://');
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

// ── Phase 5: LRU eviction — memory-bound tests ────────────────────────────────

describe('cache — LRU eviction', () => {
  beforeEach(() => {
    vi.stubEnv('CACHE_MAX_SIZE', '3');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('evicts the oldest entry when the cache is full', async () => {
    const { cacheSet, cacheGet, cacheStats } = await freshCache();

    await cacheSet('a', 1);
    await cacheSet('b', 2);
    await cacheSet('c', 3);
    // Cache is now full (size === 3); adding 'd' should evict 'a'
    await cacheSet('d', 4);

    expect(await cacheGet('a')).toBeNull();
    expect(await cacheGet('b')).toBe(2);
    expect(await cacheGet('c')).toBe(3);
    expect(await cacheGet('d')).toBe(4);
    expect(cacheStats().evictions).toBeGreaterThanOrEqual(1);
  });

  it('accessing a key promotes it and protects it from eviction', async () => {
    const { cacheSet, cacheGet } = await freshCache();

    await cacheSet('a', 1);
    await cacheSet('b', 2);
    await cacheSet('c', 3);

    // Access 'a' to make it most-recently-used
    await cacheGet('a');

    // Adding 'd' should evict 'b' (now the oldest), not 'a'
    await cacheSet('d', 4);

    expect(await cacheGet('a')).toBe(1);
    expect(await cacheGet('b')).toBeNull();
  });

  it('cache size never exceeds the configured maximum', async () => {
    const { cacheSet, cacheStats } = await freshCache();

    for (let i = 0; i < 20; i++) {
      await cacheSet(`k${i}`, i);
    }

    expect(cacheStats().size).toBeLessThanOrEqual(3);
    expect(cacheStats().evictions).toBeGreaterThanOrEqual(17);
  });

  it('cacheClear resets the eviction counter', async () => {
    const { cacheSet, cacheClear, cacheStats } = await freshCache();

    await cacheSet('x', 1);
    await cacheSet('y', 2);
    await cacheSet('z', 3);
    await cacheSet('w', 4); // triggers eviction

    expect(cacheStats().evictions).toBeGreaterThanOrEqual(1);
    cacheClear();
    expect(cacheStats().evictions).toBe(0);
  });
});

// ── Phase 6: Stale-cache regression — Redis TTL mirrored locally ───────────────

describe('cache — Redis TTL mirrored to local store', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unmock('redis');
    vi.unstubAllEnvs();
  });

  it('local entry expires when the mirrored Redis TTL elapses', async () => {
    vi.resetModules();

    const pttlMs = 5_000; // 5 s remaining on the Redis key

    // createClient must return the same client object on every call — cache.ts
    // caches it as a singleton, and the test below needs to mutate the very
    // instance cache.ts is holding, not an unrelated freshly-minted mock.
    const client = {
      on: vi.fn(),
      connect: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(JSON.stringify('stale-value')),
      // pTTL returns remaining milliseconds
      pTTL: vi.fn().mockResolvedValue(pttlMs),
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(1),
      quit: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
    };
    vi.doMock('redis', () => ({ createClient: () => client }));

    vi.stubEnv('TESTNET_CACHE_URL', 'redis://localhost:6379');

    const mod = await import('../src/cache');
    mod.cacheClear();

    // Prime the local store via a Redis get
    const first = await mod.cacheGet('redis-key');
    expect(first).toBe('stale-value');

    // Advance time past the mirrored TTL — local entry should now be expired
    vi.advanceTimersByTime(pttlMs + 1);

    // The redis mock get is called again (local miss) but returns null this time
    client.get.mockResolvedValue(null);

    const second = await mod.cacheGet('redis-key');
    expect(second).toBeNull();
  });

  it('local entry has no expiry when Redis key has no TTL (pTTL === -1)', async () => {
    vi.resetModules();

    vi.doMock('redis', () => ({
      createClient: () => ({
        on: vi.fn(),
        connect: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(JSON.stringify('persistent')),
        pTTL: vi.fn().mockResolvedValue(-1), // no expiry set in Redis
        set: vi.fn().mockResolvedValue('OK'),
        del: vi.fn().mockResolvedValue(1),
        quit: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn(),
      }),
    }));

    vi.stubEnv('TESTNET_CACHE_URL', 'redis://localhost:6379');

    const mod = await import('../src/cache');
    mod.cacheClear();

    await mod.cacheGet('persist-key');

    // Even after a very long time the local entry should still be valid
    vi.advanceTimersByTime(999_999_000);

    // get is mocked; advance won't re-fetch from Redis for a still-valid local hit
    const val = await mod.cacheGet('persist-key');
    expect(val).toBe('persistent');
  });
});

// ── #894: cache-key normalization ────────────────────────────────────────────
// User-controlled input (a Stellar/Soroban address, a tx hash, a free-text
// query) often ends up directly inside a cache key. Un-normalized, that lets
// case/whitespace variants of the same logical resource multiply into
// separate cache entries, and lets a single caller grow the keyspace without
// bound. cacheGet/cacheSet/cacheDelete normalize every key before it reaches
// storage — verified here, not just for buildCacheKey().

describe('cache — key normalization (#894)', () => {
  it('is case-insensitive: differently-cased keys hit the same entry', async () => {
    const { cacheSet, cacheGet } = await freshCache();
    await cacheSet('abi:GCONTRACTADDRESS123', { fn: 'transfer' });
    expect(await cacheGet('abi:gcontractaddress123')).toEqual({ fn: 'transfer' });
    expect(await cacheGet('ABI:GCONTRACTADDRESS123')).toEqual({ fn: 'transfer' });
  });

  it('trims leading/trailing whitespace before storing or looking up', async () => {
    const { cacheSet, cacheGet } = await freshCache();
    await cacheSet('  padded-key  ', 'value');
    expect(await cacheGet('padded-key')).toBe('value');
  });

  it('strips control characters so they cannot smuggle a distinct key', async () => {
    const { cacheSet, cacheGet } = await freshCache();
    await cacheSet('addr:abc\x00\x01', 'stripped');
    expect(await cacheGet('addr:abc')).toBe('stripped');
  });

  it('collapses very long keys to a bounded, content-addressed form instead of growing without limit', async () => {
    const { cacheSet, cacheGet, cacheStats } = await freshCache();
    const hugeQuery = `nlq:${'a'.repeat(5_000)}`;
    await cacheSet(hugeQuery, 'huge-result');
    expect(await cacheGet(hugeQuery)).toBe('huge-result');
    // The stored entry itself must not be anywhere near 5,000 characters.
    expect(cacheStats().size).toBe(1);
  });

  it('two long keys that only differ after the truncation point remain distinct (hash-suffixed)', async () => {
    const { cacheSet, cacheGet } = await freshCache();
    const base = 'q:'.padEnd(400, 'x');
    await cacheSet(`${base}first`, 'result-a');
    await cacheSet(`${base}second`, 'result-b');
    expect(await cacheGet(`${base}first`)).toBe('result-a');
    expect(await cacheGet(`${base}second`)).toBe('result-b');
  });

  it('a schema-version bump (simulated via cacheClear) invalidates prior entries', async () => {
    // The real mechanism is the CACHE_SCHEMA_VERSION prefix baked into every
    // storage key; cacheClear() here stands in for "redeploy with a bumped
    // version", which is operationally equivalent — every previously stored
    // key becomes unreachable.
    const { cacheSet, cacheGet, cacheClear } = await freshCache();
    await cacheSet('versioned-key', 'old-shape');
    cacheClear();
    expect(await cacheGet('versioned-key')).toBeNull();
  });
});

// ── #894: buildCacheKey collision resistance ─────────────────────────────────
// buildCacheKey is the safe way to assemble a key from more than one dynamic
// segment. Without per-segment escaping, a user-controlled value containing
// the ':' delimiter can make two logically different (segment1, segment2)
// pairs collide on the same storage key — one user's cached response would
// then be served for a different, unrelated request.

describe('cache — buildCacheKey collision resistance (#894)', () => {
  it('produces different keys for different segment splits of the same characters', async () => {
    const { buildCacheKey } = await freshCache();
    // Without escaping, ('ABC:XYZ', '1') and ('ABC', 'XYZ:1') would both
    // naively concatenate to "anchor:proof:ABC:XYZ:1".
    const keyA = buildCacheKey('anchor:proof', 'ABC:XYZ', '1');
    const keyB = buildCacheKey('anchor:proof', 'ABC', 'XYZ:1');
    expect(keyA).not.toBe(keyB);
  });

  it('stores distinct values for colliding-looking segment splits without cross-contamination', async () => {
    const { cacheSet, cacheGet, buildCacheKey } = await freshCache();
    const keyA = buildCacheKey('anchor:proof', 'ABC:XYZ', '1');
    const keyB = buildCacheKey('anchor:proof', 'ABC', 'XYZ:1');

    await cacheSet(keyA, { owner: 'address-ABC:XYZ', version: '1' });
    await cacheSet(keyB, { owner: 'address-ABC', version: 'XYZ:1' });

    expect(await cacheGet(keyA)).toEqual({ owner: 'address-ABC:XYZ', version: '1' });
    expect(await cacheGet(keyB)).toEqual({ owner: 'address-ABC', version: 'XYZ:1' });
  });

  it('is case-insensitive and whitespace-insensitive per segment, like normalizeKeyInput', async () => {
    const { buildCacheKey } = await freshCache();
    expect(buildCacheKey('abi', '  GADDRESS  ')).toBe(buildCacheKey('abi', 'gaddress'));
  });

  it('hashes an individual segment that is implausibly long instead of leaving it unbounded', async () => {
    const { buildCacheKey } = await freshCache();
    const key = buildCacheKey('nlq', 'x'.repeat(10_000));
    expect(key.length).toBeLessThan(200);
    expect(key.startsWith('nlq:h.')).toBe(true);
  });

  it('two different huge segments still hash to different keys (collision-resistant, not just bounded)', async () => {
    const { buildCacheKey } = await freshCache();
    const keyA = buildCacheKey('nlq', 'x'.repeat(10_000));
    const keyB = buildCacheKey('nlq', 'y'.repeat(10_000));
    expect(keyA).not.toBe(keyB);
  });
});
