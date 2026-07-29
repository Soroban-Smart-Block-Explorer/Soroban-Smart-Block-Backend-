/**
 * Test Helpers — utilities for setting up isolated test environments.
 *
 * Provides:
 * - Mock service creation
 * - Container isolation (per-test cleanup)
 * - Fixture builders
 * - Common test assertions
 *
 * USAGE (in tests):
 *   import { createTestContainer, MockLogger } from '../services/test-helpers';
 *
 *   describe('MyService', () => {
 *     let testContainer;
 *
 *     beforeEach(() => {
 *       testContainer = createTestContainer();
 *     });
 *
 *     afterEach(async () => {
 *       await testContainer.cleanup();
 *     });
 *
 *     it('should work with mocks', async () => {
 *       const service = new MyService(testContainer.container);
 *       expect(await service.process()).toBe(true);
 *     });
 *   });
 */

import type { PrismaClient } from '@prisma/client';
import { container as globalContainer, type ServiceRegistry } from './container';
import { MockLogger, createMemoryCacheBackend } from './factories';
import type { CacheBackend } from './container';

// ────────────────────────────────────────────────────────────────────────────
// Mock Prisma Client
// ────────────────────────────────────────────────────────────────────────────

/**
 * Create a mock Prisma client for testing.
 * Returns an object with common Prisma operations stubbed.
 */
export function createMockPrismaClient(): Partial<PrismaClient> {
  return {
    $connect: async () => {},
    $disconnect: async () => {},
    $transaction: async (fn: any) => {
      if (typeof fn === 'function') {
        return fn(this);
      }
      return fn;
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Test Container
// ────────────────────────────────────────────────────────────────────────────

export interface TestContainerOptions {
  /** Use mock Prisma clients instead of real ones */
  useMockDb?: boolean;
  /** Use memory cache instead of Redis */
  useMemoryCache?: boolean;
  /** Use mock logger that captures logs */
  useMockLogger?: boolean;
  /** Custom service overrides */
  overrides?: Partial<ServiceRegistry>;
}

export interface TestContainer {
  /** The service container for this test */
  container: typeof globalContainer;
  /** Mock logger (if enabled) */
  logger?: MockLogger;
  /** Cleanup function (must be called after test) */
  cleanup: () => Promise<void>;
}

/**
 * Create an isolated test container with optional mocks.
 *
 * @example
 * ```typescript
 * const test = createTestContainer({ useMockDb: true, useMockLogger: true });
 * const db = test.container.getPrismaRead();
 * const logs = test.logger!.getByLevel('error');
 * await test.cleanup();
 * ```
 */
export function createTestContainer(options: TestContainerOptions = {}): TestContainer {
  const { useMockDb = true, useMemoryCache = true, useMockLogger = true, overrides = {} } = options;

  // Create a fresh container (using global for simplicity, but isolated via overrides)
  const testContainer = globalContainer;

  let mockLogger: MockLogger | undefined;

  // Apply mock overrides
  if (useMockDb) {
    const mockPrisma = createMockPrismaClient();
    testContainer.override('prismaWrite', mockPrisma);
    testContainer.override('prismaRead', mockPrisma);
  }

  if (useMemoryCache) {
    testContainer.override('cache', createMemoryCacheBackend());
  }

  if (useMockLogger) {
    mockLogger = new MockLogger();
    testContainer.override('logger', mockLogger);
  }

  // Apply custom overrides
  for (const [name, instance] of Object.entries(overrides)) {
    testContainer.override(name as any, instance);
  }

  return {
    container: testContainer,
    logger: mockLogger,
    cleanup: async () => {
      // Reset container to default state
      await testContainer.reset();
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Test Assertions
// ────────────────────────────────────────────────────────────────────────────

/**
 * Assert that a logger captured a specific log message.
 */
export function assertLogContains(
  logger: MockLogger,
  level: 'debug' | 'info' | 'warn' | 'error',
  substring: string,
): void {
  const logs = logger.getByLevel(level);
  const found = logs.some((log) => log.message.includes(substring));
  if (!found) {
    const available = logs.map((l) => l.message).join('; ');
    throw new Error(`Expected ${level} log containing "${substring}", but got: ${available}`);
  }
}

/**
 * Assert that a logger captured no errors.
 */
export function assertNoErrors(logger: MockLogger): void {
  const errors = logger.getByLevel('error');
  if (errors.length > 0) {
    const messages = errors.map((e) => e.message).join('; ');
    throw new Error(`Expected no errors, but got: ${messages}`);
  }
}

/**
 * Assert that a logger captured at least one error.
 */
export function assertHasErrors(logger: MockLogger, count: number = 1): void {
  const errors = logger.getByLevel('error');
  if (errors.length < count) {
    throw new Error(`Expected at least ${count} error(s), but got ${errors.length}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Fixture Builders
// ────────────────────────────────────────────────────────────────────────────

/**
 * Create a minimal test database configuration.
 * Useful for integration tests that need a real database.
 */
export function getTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error('TEST_DATABASE_URL not set. Set it to a test database connection string.');
  }
  return url;
}

/**
 * Build a service with dependencies injected from a test container.
 * Useful for testing services that expect constructor DI.
 *
 * @example
 * ```typescript
 * class UserService {
 *   constructor(private db: PrismaClient, private logger: Logger) {}
 * }
 *
 * const test = createTestContainer();
 * const service = injectServices(UserService, test.container, {
 *   db: 'prismaRead',
 *   logger: 'logger'
 * });
 * ```
 */
export function injectServices<T>(
  ServiceClass: new (...args: any[]) => T,
  container: typeof globalContainer,
  dependencies: Record<string, keyof ServiceRegistry>,
): T {
  const args = Object.values(dependencies).map((depName) => {
    const getter = `get${depName.charAt(0).toUpperCase()}${depName.slice(1)}`;
    const method = (container as any)[getter];
    if (!method) {
      throw new Error(`Container has no method: ${getter}`);
    }
    return method.call(container);
  });

  return new ServiceClass(...args);
}

// ────────────────────────────────────────────────────────────────────────────
// Mock Utilities
// ────────────────────────────────────────────────────────────────────────────

/**
 * Create a spy that tracks calls.
 *
 * @example
 * ```typescript
 * const spy = createSpy((x) => x * 2);
 * expect(spy(5)).toBe(10);
 * expect(spy.calls).toEqual([5]);
 * expect(spy.callCount).toBe(1);
 * ```
 */
export function createSpy<T extends (...args: any[]) => any>(
  fn: T,
): T & { calls: any[]; callCount: number; reset: () => void } {
  const calls: any[] = [];
  const wrapper = ((...args: any[]) => {
    calls.push(args);
    return fn(...args);
  }) as T & { calls: any[]; callCount: number; reset: () => void };

  Object.defineProperty(wrapper, 'calls', {
    get: () => calls.map((c) => c[0]), // Return first arg of each call
  });
  Object.defineProperty(wrapper, 'callCount', {
    get: () => calls.length,
  });
  wrapper.reset = () => {
    calls.length = 0;
  };

  return wrapper;
}

/**
 * Create a mock cache backend that tracks operations.
 */
export class InstrumentedCacheBackend implements CacheBackend {
  private cache = new Map<string, string>();
  public operations: Array<{ op: string; key: string; time: number }> = [];

  async get(key: string): Promise<string | null> {
    this.operations.push({ op: 'get', key, time: Date.now() });
    return this.cache.get(key) || null;
  }

  async set(key: string, value: string, ttlSeconds?: number | null): Promise<void> {
    this.operations.push({ op: 'set', key, time: Date.now() });
    this.cache.set(key, value);
  }

  async del(key: string): Promise<void> {
    this.operations.push({ op: 'del', key, time: Date.now() });
    this.cache.delete(key);
  }

  async clear(): Promise<void> {
    this.operations.push({ op: 'clear', key: '', time: Date.now() });
    this.cache.clear();
  }

  async has(key: string): Promise<boolean> {
    this.operations.push({ op: 'has', key, time: Date.now() });
    return this.cache.has(key);
  }

  reset(): void {
    this.operations = [];
    this.cache.clear();
  }

  getOperationLog(): string {
    return this.operations.map((op) => `${op.op}(${op.key})`).join(' -> ');
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Re-exports for convenience
// ────────────────────────────────────────────────────────────────────────────

export { MockLogger, createMemoryCacheBackend };
