/**
 * Service Factory Functions
 *
 * Encapsulates the creation logic for all services, allowing:
 * - Consistent initialization with logging
 * - Error handling and validation
 * - Easy mocking/stubbing in tests
 * - Environment-based configuration
 */

import { PrismaClient, Prisma } from '@prisma/client';
import type { Logger as ILogger, CacheBackend } from './container';
import { config } from '../config';

// ────────────────────────────────────────────────────────────────────────────
// Prisma Clients
// ────────────────────────────────────────────────────────────────────────────

/**
 * Create a Prisma client (write or read).
 * @param type 'write' for primary, 'read' for replica
 */
export function createPrismaClient(type: 'write' | 'read'): PrismaClient {
  const logLevel: Prisma.LogLevel[] =
    config.nodeEnv === 'development' ? ['error', 'warn'] : ['error'];

  const databaseUrl = type === 'write' ? config.databaseUrl : config.readReplicaUrl;

  if (!databaseUrl) {
    throw new Error(
      `Missing database URL for ${type} client: ${type === 'write' ? 'DATABASE_URL' : 'READ_REPLICA_URL'}`,
    );
  }

  const client = new PrismaClient({
    log: logLevel,
    datasources: { db: { url: databaseUrl } },
  });

  return client;
}

// ────────────────────────────────────────────────────────────────────────────
// Cache Backend
// ────────────────────────────────────────────────────────────────────────────

/**
 * In-memory cache implementation (fallback for testing).
 */
class MemoryCacheBackend implements CacheBackend {
  private store = new Map<string, { value: string; expiresAt: number | null }>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds?: number | null): Promise<void> {
    const expiresAt = ttlSeconds && ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : null;
    this.store.set(key, { value, expiresAt });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async clear(): Promise<void> {
    this.store.clear();
  }

  async has(key: string): Promise<boolean> {
    const val = await this.get(key);
    return val !== null;
  }
}

/**
 * Create a cache backend (Redis if configured, else in-memory).
 * Uses the existing cache.ts module which handles Redis/memory gracefully.
 */
export function createCacheBackend(): CacheBackend {
  // Import the existing cache module's interface functions
  // This ensures compatibility with the current caching strategy
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { cacheGet, cacheSet, cacheDel, cacheClear } = require('../cache');

  return {
    get: cacheGet,
    set: cacheSet,
    del: cacheDel,
    clear: cacheClear,
    has: async (key: string) => {
      const val = await cacheGet(key);
      return val !== null;
    },
  };
}

/**
 * Create an in-memory cache (useful for testing).
 */
export function createMemoryCacheBackend(): CacheBackend {
  return new MemoryCacheBackend();
}

// ────────────────────────────────────────────────────────────────────────────
// Logger
// ────────────────────────────────────────────────────────────────────────────

/**
 * Create a logger instance.
 * Currently returns the default logger, but allows for custom implementations.
 */
export function createLogger(): ILogger {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { logger: defaultLogger } = require('../logger');
  return defaultLogger;
}

/**
 * Create a mock/test logger that captures logs.
 */
export class MockLogger implements ILogger {
  public logs: Array<{
    level: 'debug' | 'info' | 'warn' | 'error';
    message: string;
    meta?: Record<string, unknown>;
  }> = [];

  debug(msg: string, meta?: Record<string, unknown>): void {
    this.logs.push({ level: 'debug', message: msg, meta });
  }

  info(msg: string, meta?: Record<string, unknown>): void {
    this.logs.push({ level: 'info', message: msg, meta });
  }

  warn(msg: string, meta?: Record<string, unknown>): void {
    this.logs.push({ level: 'warn', message: msg, meta });
  }

  error(msg: string, meta?: Record<string, unknown>): void {
    this.logs.push({ level: 'error', message: msg, meta });
  }

  /**
   * Get all logs of a specific level.
   */
  getByLevel(
    level: 'debug' | 'info' | 'warn' | 'error',
  ): Array<{ message: string; meta?: Record<string, unknown> }> {
    return this.logs
      .filter((l) => l.level === level)
      .map(({ message, meta }) => ({ message, meta }));
  }

  /**
   * Clear all captured logs.
   */
  clear(): void {
    this.logs = [];
  }

  /**
   * Get count of logs.
   */
  count(): number {
    return this.logs.length;
  }
}
