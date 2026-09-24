/**
 * src/__tests__/cacheFallback.test.ts
 *
 * Issue #909 — Redis Cache Fallback Monitoring
 *
 * Validates that:
 * 1. `cache_backend_status` transitions to 0 when Redis is unavailable.
 * 2. `cache_backend_status` is set to 1 when Redis connects successfully.
 * 3. A structured warning log is emitted on initial Redis connection failure.
 * 4. Cache operations remain functional via in-memory fallback.
 * 5. The /health endpoint exposes `cacheBackend` and `inMemoryFallback` fields.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Read the current value of a prom-client Gauge (no-label variant).
 * Works with prom-client v14 and v15 (both ship hashMap on the instance).
 */
async function getGaugeValue(gauge: { get: () => Promise<{ values: { value: number }[] }> }) {
  const data = await gauge.get();
  return data.values[0]?.value ?? null;
}

// ─── Suite 1: cache_backend_status reflects Redis availability ───────────────

describe('cacheFallback — cache_backend_status metric', () => {
  afterEach(() => {
    vi.unmock('redis');
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('sets cache_backend_status to 0 when Redis connection is refused', async () => {
    vi.stubEnv('CACHE_URL', 'redis://localhost:6379');

    vi.mock('redis', () => ({
      createClient: () => ({
        on: vi.fn(),
        connect: vi.fn().mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:6379')),
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue('OK'),
        del: vi.fn().mockResolvedValue(1),
        quit: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn(),
      }),
    }));

    vi.resetModules();
    const metrics = await import('../../src/metrics');
    const cache = await import('../../src/cache');
    cache.cacheClear();

    await cache.cacheConnect();

    const value = await getGaugeValue(metrics.cacheBackendStatus);
    expect(value).toBe(0);
  });

  it('sets cache_backend_status to 1 when Redis connects successfully', async () => {
    vi.stubEnv('CACHE_URL', 'redis://localhost:6379');

    vi.mock('redis', () => ({
      createClient: () => ({
        on: vi.fn(),
        connect: vi.fn().mockResolvedValue(undefined),
        subscribe: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue('OK'),
        pTTL: vi.fn().mockResolvedValue(-1),
        del: vi.fn().mockResolvedValue(1),
        quit: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn(),
        multi: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnThis(),
          exec: vi.fn().mockResolvedValue([]),
        }),
        publish: vi.fn().mockResolvedValue(1),
      }),
    }));

    vi.resetModules();
    const metrics = await import('../../src/metrics');
    const cache = await import('../../src/cache');
    cache.cacheClear();

    await cache.cacheConnect();

    const value = await getGaugeValue(metrics.cacheBackendStatus);
    expect(value).toBe(1);
  });

  it('sets cache_backend_status to 0 in pure memory mode (memory:// URL)', async () => {
    vi.stubEnv('CACHE_URL', 'memory://');

    vi.resetModules();
    const metrics = await import('../../src/metrics');
    const cache = await import('../../src/cache');
    cache.cacheClear();

    await cache.cacheConnect();

    // In pure memory mode the metric is 0 to reflect that Redis is not in use.
    const value = await getGaugeValue(metrics.cacheBackendStatus);
    expect(value).toBe(0);
  });

  it('sets cache_backend_status to 0 via error event handler when Redis drops mid-session', async () => {
    vi.stubEnv('CACHE_URL', 'redis://localhost:6379');

    let capturedErrorHandler: ((err: Error) => void) | null = null;

    vi.mock('redis', () => ({
      createClient: () => ({
        on: vi.fn((event: string, handler: (err: Error) => void) => {
          if (event === 'error') capturedErrorHandler = handler;
        }),
        connect: vi.fn().mockResolvedValue(undefined),
        subscribe: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue('OK'),
        pTTL: vi.fn().mockResolvedValue(-1),
        del: vi.fn().mockResolvedValue(1),
        quit: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn(),
        multi: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnThis(),
          exec: vi.fn().mockResolvedValue([]),
        }),
        publish: vi.fn().mockResolvedValue(1),
      }),
    }));

    vi.resetModules();
    const metrics = await import('../../src/metrics');
    const cache = await import('../../src/cache');
    cache.cacheClear();

    await cache.cacheConnect();

    // After successful connect, status should be 1
    const valueBefore = await getGaugeValue(metrics.cacheBackendStatus);
    expect(valueBefore).toBe(1);

    // Simulate a Redis error event (connection drop)
    expect(capturedErrorHandler).not.toBeNull();
    capturedErrorHandler!(new Error('ECONNRESET'));

    // After error event, status should drop to 0
    const valueAfter = await getGaugeValue(metrics.cacheBackendStatus);
    expect(valueAfter).toBe(0);
  });
});

// ─── Suite 2: Structured warning logs on fallback ────────────────────────────

describe('cacheFallback — structured warning log on connection failure', () => {
  afterEach(() => {
    vi.unmock('redis');
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('emits a structured warn log with alert:CACHE_FALLBACK and cacheBackend:memory', async () => {
    vi.stubEnv('CACHE_URL', 'redis://localhost:6379');

    const mockLogger = {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    vi.mock('redis', () => ({
      createClient: () => ({
        on: vi.fn(),
        connect: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
        quit: vi.fn(),
        disconnect: vi.fn(),
      }),
    }));

    vi.resetModules();

    // Mock logger before importing cache so the module picks up the mock
    vi.doMock('../../src/logger', () => ({ logger: mockLogger }));
    vi.doMock('../../src/metrics', () => ({
      cacheBackendStatus: { set: vi.fn() },
    }));

    const cache = await import('../../src/cache');
    cache.cacheClear();

    await cache.cacheConnect();

    // Check for the fallback warning with expected structured fields
    const warnCalls = mockLogger.warn.mock.calls;
    const fallbackCall = warnCalls.find(
      (call) =>
        typeof call[0] === 'string' &&
        call[0].includes('Could not connect to Redis') &&
        call[1]?.alert === 'CACHE_FALLBACK' &&
        call[1]?.cacheBackend === 'memory',
    );

    expect(fallbackCall).toBeDefined();
  });
});

// ─── Suite 3: In-memory fallback correctness ─────────────────────────────────

describe('cacheFallback — in-memory fallback operations', () => {
  beforeEach(() => {
    vi.stubEnv('CACHE_URL', 'redis://localhost:6379');
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
  });

  afterEach(() => {
    vi.unmock('redis');
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('falls back to in-memory and set/get still work', async () => {
    vi.resetModules();
    const cache = await import('../../src/cache');
    cache.cacheClear();

    await cache.cacheConnect();

    await cache.cacheSet('test:fallback', { value: 42 });
    const result = await cache.cacheGet<{ value: number }>('test:fallback');

    expect(result).toEqual({ value: 42 });
  });

  it('cacheBackendType returns "memory" when Redis is unavailable', async () => {
    vi.resetModules();
    const cache = await import('../../src/cache');
    cache.cacheClear();

    await cache.cacheConnect();

    expect(cache.cacheBackendType()).toBe('memory');
  });

  it('isCacheReady returns false when Redis was expected but unavailable', async () => {
    vi.resetModules();
    const cache = await import('../../src/cache');
    cache.cacheClear();

    await cache.cacheConnect();

    // Redis URL was configured but connection failed — not truly ready
    expect(cache.isCacheReady()).toBe(false);
  });

  it('delete is a no-op (does not throw) in fallback mode', async () => {
    vi.resetModules();
    const cache = await import('../../src/cache');
    cache.cacheClear();

    await cache.cacheConnect();
    await cache.cacheSet('del-test', 'value');
    await expect(cache.cacheDelete('del-test')).resolves.not.toThrow();
  });
});

// ─── Suite 4: Health endpoint cacheBackend field ─────────────────────────────

describe('cacheFallback — /health response cacheBackend field (#909)', () => {
  afterEach(() => {
    vi.unmock('redis');
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('exposes cacheBackend:"in-memory" and inMemoryFallback:true when Redis is down', async () => {
    vi.stubEnv('CACHE_URL', 'redis://localhost:6379');
    vi.stubEnv('TESTNET_CACHE_URL', 'redis://localhost:6379');

    vi.mock('redis', () => ({
      createClient: () => ({
        on: vi.fn(),
        connect: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
        quit: vi.fn(),
        disconnect: vi.fn(),
      }),
    }));

    vi.resetModules();

    // Stub heavy dependencies that health.ts imports to avoid real network calls
    vi.doMock('../../src/db', () => ({
      prismaRead: { $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]) },
      prismaWrite: { $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]) },
    }));
    vi.doMock('../../src/indexer-state', () => ({
      getIndexerStatus: () => ({ healthy: true, failureReason: undefined }),
    }));
    vi.doMock('../../src/readiness', () => ({
      getReadinessState: () => ({ cache: false }),
    }));
    vi.doMock('../../src/p2p', () => ({
      getConnectedPeerCount: () => 0,
      isP2pEnabled: () => false,
    }));
    vi.doMock('../../src/db/replicaGateway', () => ({
      measureReplicaLag: vi.fn().mockResolvedValue(0),
    }));
    vi.doMock('../../src/indexer/rpc', () => ({
      getLatestLedger: vi.fn().mockResolvedValue(1000000),
    }));
    vi.doMock('../../src/indexer/indexer', () => ({
      getLastIndexedLedger: vi.fn().mockResolvedValue(999990),
    }));
    vi.doMock('../../src/metrics', () => ({
      cacheBackendStatus: { set: vi.fn() },
      dbConnectionStatus: { set: vi.fn() },
      http5xxSurge: { set: vi.fn() },
      indexerIngestionLag: { set: vi.fn() },
      replicaLagCheckErrors: { inc: vi.fn() },
    }));

    const cache = await import('../../src/cache');
    cache.cacheClear();
    await cache.cacheConnect();

    const healthModule = await import('../../src/health');
    const status = await healthModule.getHealthStatus();

    const cacheDetails = status.dependencies.cache.details;
    expect(cacheDetails?.cacheBackend).toBe('in-memory');
    expect(cacheDetails?.inMemoryFallback).toBe(true);
  });
});
