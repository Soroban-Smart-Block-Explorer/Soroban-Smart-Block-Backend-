/**
 * Test Examples — Demonstrating dependency injection patterns
 *
 * This file shows real-world testing patterns using the DI container.
 * Copy these patterns into your test files.
 */

import {
  createTestContainer,
  injectServices,
  createSpy,
  assertLogContains,
  assertNoErrors,
  MockLogger,
  InstrumentedCacheBackend,
} from './test-helpers';
import { container } from './container';

// ────────────────────────────────────────────────────────────────────────────
// Example 1: Basic Service Testing with Mocks
// ────────────────────────────────────────────────────────────────────────────

describe('Example 1: Basic Service Testing', () => {
  // Simulated service
  class UserService {
    constructor(
      private db: any, // PrismaClient
      private logger: any, // Logger
    ) {}

    async getUser(id: string) {
      this.logger.info(`Fetching user ${id}`);
      const user = await this.db.user.findUnique({ where: { id } });
      if (!user) {
        this.logger.error(`User ${id} not found`);
        return null;
      }
      return user;
    }
  }

  it('should fetch user successfully', async () => {
    const test = createTestContainer({
      useMockDb: true,
      useMockLogger: true,
    });

    const service = new UserService(test.container.getPrismaRead(), test.logger);

    // Mock the database response
    const mockDb = test.container.getPrismaRead() as any;
    mockDb.user = {
      findUnique: async () => ({ id: '1', name: 'John' }),
    };

    const user = await service.getUser('1');
    expect(user).toEqual({ id: '1', name: 'John' });
    assertLogContains(test.logger, 'info', 'Fetching user');

    await test.cleanup();
  });

  it('should handle user not found', async () => {
    const test = createTestContainer({
      useMockDb: true,
      useMockLogger: true,
    });

    const service = new UserService(test.container.getPrismaRead(), test.logger);

    const mockDb = test.container.getPrismaRead() as any;
    mockDb.user = {
      findUnique: async () => null,
    };

    const user = await service.getUser('999');
    expect(user).toBeNull();
    assertLogContains(test.logger, 'error', 'not found');

    await test.cleanup();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Example 2: Using injectServices Helper
// ────────────────────────────────────────────────────────────────────────────

describe('Example 2: Using injectServices Helper', () => {
  class DataProcessor {
    constructor(
      private db: any,
      private logger: any,
    ) {}

    async process() {
      this.logger.info('Processing data');
      const data = await this.db.data.findMany({});
      this.logger.info(`Processed ${data.length} records`);
      return data.length;
    }
  }

  it('should process data with auto-injection', async () => {
    const test = createTestContainer();

    // Automatically wires dependencies from container
    const processor = injectServices(DataProcessor, test.container, {
      db: 'prismaRead',
      logger: 'logger',
    });

    const mockDb = test.container.getPrismaRead() as any;
    mockDb.data = {
      findMany: async () => [{ id: 1 }, { id: 2 }, { id: 3 }],
    };

    const count = await processor.process();
    expect(count).toBe(3);

    await test.cleanup();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Example 3: Spying on Functions
// ────────────────────────────────────────────────────────────────────────────

describe('Example 3: Function Spying', () => {
  class AnalyticsService {
    constructor(
      private db: any,
      private cache: any,
    ) {}

    async analyze(dataId: string) {
      // Check cache first
      const cached = await this.cache.get(`analysis:${dataId}`);
      if (cached) return JSON.parse(cached);

      // Compute analysis
      const result = await this.db.data.findUnique({ where: { id: dataId } });
      const analysis = { id: dataId, score: Math.random() * 100 };

      // Store in cache
      await this.cache.set(`analysis:${dataId}`, JSON.stringify(analysis));
      return analysis;
    }
  }

  it('should use cache when available', async () => {
    const test = createTestContainer({
      useMemoryCache: true,
    });

    const cache = test.container.getCache();
    const dbSpy = createSpy(async () => ({ id: '1', value: 100 }));

    const service = new AnalyticsService({ data: { findUnique: dbSpy } }, cache);

    // First call computes
    await service.analyze('1');
    expect(dbSpy.callCount).toBe(1);

    // Second call uses cache
    await service.analyze('1');
    expect(dbSpy.callCount).toBe(1); // Not called again

    await test.cleanup();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Example 4: Testing Cache Operations
// ────────────────────────────────────────────────────────────────────────────

describe('Example 4: Instrumented Cache Testing', () => {
  class CachedService {
    constructor(private cache: any) {}

    async getCachedData(key: string) {
      const cached = await this.cache.get(key);
      if (!cached) {
        const data = `data_for_${key}`;
        await this.cache.set(key, data, 3600);
        return data;
      }
      return cached;
    }
  }

  it('should track cache operations', async () => {
    const instrumentedCache = new InstrumentedCacheBackend();

    const service = new CachedService(instrumentedCache);

    // First call misses and sets
    const data1 = await service.getCachedData('key1');
    expect(data1).toBe('data_for_key1');

    // Second call hits
    const data2 = await service.getCachedData('key1');
    expect(data2).toBe('data_for_key1');

    // Verify operation log
    const log = instrumentedCache.getOperationLog();
    expect(log).toContain('get(key1)');
    expect(log).toContain('set(key1)');

    // Check operation count
    expect(instrumentedCache.operations.length).toBe(3); // get, set, get
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Example 5: Logging Assertions
// ────────────────────────────────────────────────────────────────────────────

describe('Example 5: Logging Assertions', () => {
  class ErrorHandler {
    constructor(private logger: any) {}

    async handleRequest() {
      try {
        throw new Error('Simulated error');
      } catch (err) {
        this.logger.error('Request failed', { error: (err as Error).message });
        return false;
      }
    }
  }

  it('should log errors correctly', async () => {
    const test = createTestContainer({ useMockLogger: true });

    const handler = new ErrorHandler(test.logger);
    const result = await handler.handleRequest();

    expect(result).toBe(false);
    assertLogContains(test.logger, 'error', 'Request failed');

    const errors = test.logger.getByLevel('error');
    expect(errors.length).toBe(1);
    expect(errors[0].meta?.error).toBe('Simulated error');

    await test.cleanup();
  });

  it('should have no errors when successful', async () => {
    const test = createTestContainer({ useMockLogger: true });

    class SuccessHandler {
      constructor(private logger: any) {}
      async handle() {
        this.logger.info('Request succeeded');
        return true;
      }
    }

    const handler = new SuccessHandler(test.logger);
    await handler.handle();

    assertNoErrors(test.logger);

    await test.cleanup();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Example 6: Integration Testing (with real container)
// ────────────────────────────────────────────────────────────────────────────

describe('Example 6: Integration Testing', () => {
  it('should work with real container services', async () => {
    // Use real services from container (production code path)
    const db = container.getPrismaWrite();
    const logger = container.getLogger();
    const cache = container.getCache();

    // Can test with real services
    expect(db).toBeDefined();
    expect(logger).toBeDefined();
    expect(cache).toBeDefined();

    // These are singleton instances
    const db2 = container.getPrismaWrite();
    expect(db2).toBe(db); // Same instance
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Example 7: Custom Service Overrides
// ────────────────────────────────────────────────────────────────────────────

describe('Example 7: Custom Service Overrides', () => {
  it('should allow custom overrides', async () => {
    const test = createTestContainer();

    // Create custom implementations
    const customLogger = new MockLogger();
    const customCache = new InstrumentedCacheBackend();

    // Override services
    test.container.override('logger', customLogger);
    test.container.override('cache', customCache);

    // Get overridden services
    const logger = test.container.getLogger();
    const cache = test.container.getCache();

    expect(logger).toBe(customLogger);
    expect(cache).toBe(customCache);

    await test.cleanup();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Example 8: Class-Based Service Testing (Real Pattern)
// ────────────────────────────────────────────────────────────────────────────

describe('Example 8: Real GasAnalyticsProcessor Pattern', () => {
  // This mirrors the actual GasAnalyticsProcessor from gasAnalytics.ts
  class TestGasAnalyticsProcessor {
    constructor(
      private prismaRead: any,
      private prismaWrite: any,
      private logger: any,
    ) {}

    async run(): Promise<void> {
      this.logger.info('Running gas analytics');
      const transactions = await this.prismaRead.transaction.findMany({});
      this.logger.info(`Found ${transactions.length} transactions`);

      if (transactions.length > 0) {
        await this.prismaWrite.gasAnalyticsSnapshot.create({
          data: {
            bucket: 'hour',
            bucketStart: new Date(),
            avgFee: 100,
          },
        });
      }
    }
  }

  it('should process gas analytics with mocks', async () => {
    const test = createTestContainer({
      useMockDb: true,
      useMockLogger: true,
    });

    const processor = new TestGasAnalyticsProcessor(
      test.container.getPrismaRead(),
      test.container.getPrismaWrite(),
      test.logger,
    );

    // Mock Prisma responses
    const mockDb = test.container.getPrismaRead() as any;
    mockDb.transaction = {
      findMany: async () => [{ id: '1' }, { id: '2' }],
    };

    const mockWrite = test.container.getPrismaWrite() as any;
    mockWrite.gasAnalyticsSnapshot = {
      create: async (data: any) => {
        test.logger.info('Snapshot created');
      },
    };

    await processor.run();

    assertLogContains(test.logger, 'info', 'Running gas analytics');
    assertLogContains(test.logger, 'info', 'Found 2 transactions');
    assertLogContains(test.logger, 'info', 'Snapshot created');
    assertNoErrors(test.logger);

    await test.cleanup();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Example 9: Error Handling and Retry Logic
// ────────────────────────────────────────────────────────────────────────────

describe('Example 9: Error Handling', () => {
  class RetryableService {
    private attempts = 0;

    constructor(
      private db: any,
      private logger: any,
    ) {}

    async callWithRetry() {
      this.attempts++;
      try {
        if (this.attempts < 2) {
          throw new Error('Connection timeout');
        }
        return await this.db.status.get();
      } catch (err) {
        this.logger.error(`Attempt ${this.attempts} failed`, {
          error: (err as Error).message,
        });
        if (this.attempts < 2) {
          this.logger.info('Retrying...');
          return this.callWithRetry();
        }
        throw err;
      }
    }
  }

  it('should handle retries', async () => {
    const test = createTestContainer({
      useMockDb: true,
      useMockLogger: true,
    });

    const mockDb = test.container.getPrismaRead() as any;
    mockDb.status = {
      get: async () => ({ healthy: true }),
    };

    const service = new RetryableService(mockDb, test.logger);
    const result = await service.callWithRetry();

    expect(result).toEqual({ healthy: true });

    const errors = test.logger.getByLevel('error');
    expect(errors.length).toBe(1); // One error before success

    const infos = test.logger.getByLevel('info');
    expect(infos.some((i) => i.message === 'Retrying...')).toBe(true);

    await test.cleanup();
  });
});

export {};
