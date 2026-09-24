/**
 * Service Container — centralized dependency injection registry.
 *
 * Replaces ad-hoc singleton exports with a managed container that:
 * - Lazily initializes services on first access
 * - Allows test overrides without module reloading
 * - Provides typed access to all services
 * - Supports graceful cleanup for testing
 *
 * USAGE:
 *   import { container } from './services/container';
 *
 *   // Access services (lazy-loaded)
 *   const db = container.getPrismaWrite();
 *   const cache = container.getCache();
 *
 *   // Override in tests
 *   container.override('prismaWrite', mockPrismaWrite);
 *   container.override('cache', mockCache);
 *
 *   // Cleanup
 *   await container.reset();
 */

import type { PrismaClient } from '@prisma/client';

// Import factory functions (defined below)
import { createPrismaClient, createCacheBackend, createLogger } from './factories';

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface CacheBackend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number | null): Promise<void>;
  del(key: string): Promise<void>;
  clear(): Promise<void>;
  has(key: string): Promise<boolean>;
}

export type ServiceName = 'prismaWrite' | 'prismaRead' | 'cache' | 'logger';

export interface ServiceRegistry {
  prismaWrite?: PrismaClient;
  prismaRead?: PrismaClient;
  cache?: CacheBackend;
  logger?: Logger;
}

class ServiceContainer {
  private services: ServiceRegistry = {};
  private factories: Record<ServiceName, () => any> = {
    prismaWrite: () => createPrismaClient('write'),
    prismaRead: () => createPrismaClient('read'),
    cache: () => createCacheBackend(),
    logger: () => createLogger(),
  };

  /**
   * Get or create a service instance.
   * Services are lazily initialized and cached.
   */
  private getOrCreate<T = any>(name: ServiceName): T {
    if (!this.services[name]) {
      const factory = this.factories[name];
      if (!factory) {
        throw new Error(`No factory registered for service "${name}"`);
      }
      this.services[name] = factory();
    }
    return this.services[name] as T;
  }

  /**
   * Get Prisma write client.
   */
  public getPrismaWrite(): PrismaClient {
    return this.getOrCreate<PrismaClient>('prismaWrite');
  }

  /**
   * Get Prisma read client (replica).
   */
  public getPrismaRead(): PrismaClient {
    return this.getOrCreate<PrismaClient>('prismaRead');
  }

  /**
   * Get cache backend.
   */
  public getCache(): CacheBackend {
    return this.getOrCreate<CacheBackend>('cache');
  }

  /**
   * Get logger.
   */
  public getLogger(): Logger {
    return this.getOrCreate<Logger>('logger');
  }

  /**
   * Override a service (useful for testing).
   * @param name Service name
   * @param instance Service instance to use
   */
  public override<T = any>(name: ServiceName, instance: T): void {
    this.services[name] = instance as any;
  }

  /**
   * Register a custom factory for a service.
   * Useful for tests that need to customize service creation.
   * @param name Service name
   * @param factory Factory function
   */
  public registerFactory(name: ServiceName, factory: () => any): void {
    this.factories[name] = factory;
  }

  /**
   * Check if a service has been initialized.
   */
  public isInitialized(name: ServiceName): boolean {
    return this.services[name] !== undefined;
  }

  /**
   * Get all initialized services.
   */
  public getInitialized(): ServiceRegistry {
    return { ...this.services };
  }

  /**
   * Gracefully shutdown all services.
   * Disconnects Prisma clients and closes Redis connections.
   */
  public async shutdown(): Promise<void> {
    const errors: Error[] = [];

    // Disconnect Prisma clients
    if (this.services.prismaWrite) {
      try {
        await (this.services.prismaWrite as PrismaClient).$disconnect();
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }

    if (this.services.prismaRead) {
      try {
        await (this.services.prismaRead as PrismaClient).$disconnect();
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }

    // Clear cache
    if (this.services.cache) {
      try {
        await this.services.cache.clear();
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }

    if (errors.length > 0) {
      const msg = errors.map((e) => e.message).join('; ');
      throw new Error(`Errors during container shutdown: ${msg}`);
    }
  }

  /**
   * Reset container to initial state (for testing).
   * Shuts down all services and clears the registry.
   */
  public async reset(): Promise<void> {
    await this.shutdown();
    this.services = {};
  }
}

// Export singleton container instance
export const container = new ServiceContainer();

// Re-export factories for direct use if needed
export { createPrismaClient, createCacheBackend, createLogger } from './factories';
