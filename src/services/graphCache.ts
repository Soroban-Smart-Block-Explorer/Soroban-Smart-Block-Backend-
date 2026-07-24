import { cacheConnect, cacheClose, isCacheReady } from '../cache';
import { logger } from '../logger';
import crypto from 'crypto';

/**
 * Graph Query Caching Service
 * Redis-based caching with event-driven invalidation on new edge creation
 */

export interface CacheEntry {
  data: any;
  executionTime: number;
  nodeCount: number;
  edgeCount: number;
  cachedAt: Date;
  ttl: number;
}

export interface CacheMetrics {
  hits: number;
  misses: number;
  evictions: number;
  hitRate: number;
  totalQueries: number;
}

export class GraphQueryCache {
  private cache: any;
  private isConnected: boolean = false;
  private metrics: CacheMetrics = {
    hits: 0,
    misses: 0,
    evictions: 0,
    hitRate: 0,
    totalQueries: 0,
  };

  constructor() {
    this.initializeCache();
  }

  /**
   * Initialize Redis cache connection
   */
  private async initializeCache(): Promise<void> {
    try {
      await cacheConnect();
      this.isConnected = isCacheReady();
      if (this.isConnected) {
        logger.info('Graph query cache connected to Redis');
      }
    } catch (error) {
      logger.warn('Failed to connect to Redis cache, caching disabled', { error });
      this.isConnected = false;
    }
  }

  /**
   * Generate cache key from query and parameters
   */
  private generateCacheKey(query: string, parameters: Record<string, any>): string {
    const hash = crypto
      .createHash('sha256')
      .update(JSON.stringify({ query, parameters }))
      .digest('hex');
    return `graph:query:${hash}`;
  }

  /**
   * Get cached query result
   */
  async get(query: string, parameters: Record<string, any>): Promise<CacheEntry | null> {
    if (!this.isConnected) {
      return null;
    }

    try {
      const key = this.generateCacheKey(query, parameters);
      const cached = await this.cache.get(key);

      if (cached) {
        this.metrics.hits++;
        this.updateHitRate();
        logger.debug('Cache hit', { key });
        return JSON.parse(cached) as CacheEntry;
      }

      this.metrics.misses++;
      this.updateHitRate();
      return null;
    } catch (error) {
      logger.error('Cache get failed', { error });
      this.metrics.misses++;
      this.updateHitRate();
      return null;
    }
  }

  /**
   * Set cache entry
   */
  async set(
    query: string,
    parameters: Record<string, any>,
    data: any,
    executionTime: number,
    nodeCount: number,
    edgeCount: number,
    ttl: number = 300 // 5 minutes default
  ): Promise<void> {
    if (!this.isConnected) {
      return;
    }

    try {
      const key = this.generateCacheKey(query, parameters);
      const entry: CacheEntry = {
        data,
        executionTime,
        nodeCount,
        edgeCount,
        cachedAt: new Date(),
        ttl,
      };

      await this.cache.setex(key, ttl, JSON.stringify(entry));
      logger.debug('Cache set', { key, ttl });
    } catch (error) {
      logger.error('Cache set failed', { error });
    }
  }

  /**
   * Invalidate cache entries matching pattern
   */
  async invalidatePattern(pattern: string): Promise<void> {
    if (!this.isConnected) {
      return;
    }

    try {
      const keys = await this.cache.keys(`graph:query:*${pattern}*`);
      
      if (keys.length > 0) {
        await this.cache.del(...keys);
        this.metrics.evictions += keys.length;
        logger.info('Cache pattern invalidated', { pattern, count: keys.length });
      }
    } catch (error) {
      logger.error('Cache invalidation failed', { pattern, error });
    }
  }

  /**
   * Invalidate cache on new edge creation
   */
  async invalidateOnNewEdge(edgeType: string, fromNode: string, toNode: string): Promise<void> {
    // Invalidate all wallet-related queries
    if (edgeType === 'SENT' || edgeType === 'TRANSFERS') {
      await this.invalidatePattern('wallet');
    }

    // Invalidate all contract-related queries
    if (edgeType === 'CALLS') {
      await this.invalidatePattern('contract');
    }

    // Invalidate all token-related queries
    if (edgeType === 'TRANSFERS' || edgeType === 'HELD_BY') {
      await this.invalidatePattern('token');
    }

    // Invalidate all transaction-related queries
    if (edgeType === 'SENT' || edgeType === 'CALLS') {
      await this.invalidatePattern('transaction');
    }

    // Invalidate specific node queries
    await this.invalidatePattern(fromNode);
    await this.invalidatePattern(toNode);
  }

  /**
   * Clear all graph query cache
   */
  async clear(): Promise<void> {
    if (!this.isConnected) {
      return;
    }

    try {
      const keys = await this.cache.keys('graph:query:*');
      
      if (keys.length > 0) {
        await this.cache.del(...keys);
        this.metrics.evictions += keys.length;
        logger.info('Graph query cache cleared', { count: keys.length });
      }
    } catch (error) {
      logger.error('Cache clear failed', { error });
    }
  }

  /**
   * Get cache metrics
   */
  getMetrics(): CacheMetrics {
    return { ...this.metrics };
  }

  /**
   * Reset cache metrics
   */
  resetMetrics(): void {
    this.metrics = {
      hits: 0,
      misses: 0,
      evictions: 0,
      hitRate: 0,
      totalQueries: 0,
    };
  }

  /**
   * Update hit rate
   */
  private updateHitRate(): void {
    this.metrics.totalQueries = this.metrics.hits + this.metrics.misses;
    this.metrics.hitRate = this.metrics.totalQueries > 0
      ? this.metrics.hits / this.metrics.totalQueries
      : 0;
  }

  /**
   * Get cache size
   */
  async getSize(): Promise<number> {
    if (!this.isConnected) {
      return 0;
    }

    try {
      const keys = await this.cache.keys('graph:query:*');
      return keys.length;
    } catch (error) {
      logger.error('Failed to get cache size', { error });
      return 0;
    }
  }

  /**
   * Close cache connection
   */
  async close(): Promise<void> {
    if (this.isConnected) {
      await cacheClose();
      this.isConnected = false;
      logger.info('Graph query cache disconnected');
    }
  }
}

// Singleton instance
let graphCacheInstance: GraphQueryCache | null = null;

export function getGraphCache(): GraphQueryCache {
  if (!graphCacheInstance) {
    graphCacheInstance = new GraphQueryCache();
  }
  return graphCacheInstance;
}

export function resetGraphCache(): void {
  graphCacheInstance = null;
}
