/**
 * DB-backed feature flag store
 *
 * Loads FeatureFlag rows (with their overrides) into an in-memory cache so
 * per-request evaluation is synchronous and cheap. Writes (admin API) go
 * through this store and invalidate the cache immediately; other instances
 * pick changes up after the TTL, which is the standard multi-instance tradeoff
 * for a cache this size.
 *
 * The store degrades gracefully: if the DB is unreachable at load time it
 * returns an empty snapshot map, so evaluation falls back to env vars and the
 * registry defaults — the same behavior as before this system existed.
 */

import type { PrismaClient } from '@prisma/client';
import { prismaRead, prismaWrite } from '../db';
import { findFlagDefinition, listFlagDefinitions, type FlagScopeType } from './registry';
import type { FlagSnapshot } from './evaluate';

export const FLAG_CACHE_TTL_MS = 30_000;

interface CacheEntry {
  flags: Map<string, FlagSnapshot>;
  loadedAt: number;
}

export interface FlagUpdate {
  defaultEnabled?: boolean;
  rolloutPercent?: number;
  description?: string;
}

export class FeatureFlagStore {
  private cache: CacheEntry | null = null;

  constructor(
    private readonly read: PrismaClient = prismaRead,
    private readonly write: PrismaClient = prismaWrite,
  ) {}

  invalidate(): void {
    this.cache = null;
  }

  private isFresh(): boolean {
    return this.cache !== null && Date.now() - this.cache.loadedAt < FLAG_CACHE_TTL_MS;
  }

  /** Sync access to the cached snapshot (undefined if cache is cold/empty). */
  getCachedSync(key: string): FlagSnapshot | undefined {
    return this.cache?.flags.get(key);
  }

  /** Warm the cache (or refresh it if stale). Never throws. */
  async load(): Promise<Map<string, FlagSnapshot>> {
    if (this.isFresh()) return this.cache!.flags;
    try {
      const rows = await this.read.featureFlag.findMany({ include: { overrides: true } });
      const flags = new Map<string, FlagSnapshot>();
      for (const row of rows) {
        const environmentOverrides = new Map<string, boolean>();
        const developerOverrides = new Map<string, boolean>();
        for (const o of row.overrides) {
          if (o.scopeType === 'environment') environmentOverrides.set(o.scopeValue, o.enabled);
          else if (o.scopeType === 'developer') developerOverrides.set(o.scopeValue, o.enabled);
        }
        flags.set(row.key, {
          key: row.key,
          defaultEnabled: row.defaultEnabled,
          rolloutPercent: row.rolloutPercent,
          environmentOverrides,
          developerOverrides,
        });
      }
      this.cache = { flags, loadedAt: Date.now() };
      return flags;
    } catch (err) {
      // DB unavailable → empty snapshot map; env vars + registry defaults apply.
      this.cache = { flags: new Map(), loadedAt: Date.now() };
      return this.cache.flags;
    }
  }

  /**
   * Ensure a DB row exists for every registered flag (seeded with the registry
   * defaults) so operators can manage all known flags from the admin API even
   * before any flag has been touched. Existing rows are left intact.
   */
  async ensureRegisteredFlags(): Promise<void> {
    for (const def of listFlagDefinitions()) {
      await this.write.featureFlag.upsert({
        where: { key: def.key },
        create: {
          key: def.key,
          description: def.description,
          defaultEnabled: def.defaultEnabled,
          rolloutPercent: def.rolloutPercent ?? 0,
        },
        update: { description: def.description },
      });
    }
    this.invalidate();
  }

  async updateFlag(key: string, patch: FlagUpdate): Promise<FlagSnapshot> {
    const row = await this.write.featureFlag.upsert({
      where: { key },
      create: {
        key,
        description: patch.description ?? findFlagDefinition(key)?.description ?? '',
        defaultEnabled: patch.defaultEnabled ?? false,
        rolloutPercent: patch.rolloutPercent ?? 0,
      },
      update: {
        ...(patch.defaultEnabled !== undefined ? { defaultEnabled: patch.defaultEnabled } : {}),
        ...(patch.rolloutPercent !== undefined ? { rolloutPercent: patch.rolloutPercent } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
      },
      include: { overrides: true },
    });
    this.invalidate();
    return this.toSnapshot(row);
  }

  async setOverride(
    flagKey: string,
    scopeType: FlagScopeType,
    scopeValue: string,
    enabled: boolean,
  ): Promise<FlagSnapshot> {
    await this.write.featureFlagOverride.upsert({
      where: { flagKey_scopeType_scopeValue: { flagKey, scopeType, scopeValue } },
      create: { flagKey, scopeType, scopeValue, enabled },
      update: { enabled },
    });
    this.invalidate();
    return this.load().then((flags) => this.withFallback(flags.get(flagKey), flagKey));
  }

  async clearOverride(
    flagKey: string,
    scopeType: FlagScopeType,
    scopeValue: string,
  ): Promise<void> {
    await this.write.featureFlagOverride
      .deleteMany({ where: { flagKey, scopeType, scopeValue } })
      .catch(() => {});
    this.invalidate();
  }

  /** Snapshot for a key, synthesizing from the registry when no DB row exists. */
  private withFallback(snapshot: FlagSnapshot | undefined, key: string): FlagSnapshot {
    if (snapshot) return snapshot;
    const def = findFlagDefinition(key);
    return {
      key,
      defaultEnabled: def?.defaultEnabled ?? false,
      rolloutPercent: def?.rolloutPercent ?? 0,
      environmentOverrides: new Map(),
      developerOverrides: new Map(),
    };
  }

  private toSnapshot(row: {
    key: string;
    defaultEnabled: boolean;
    rolloutPercent: number;
    overrides: Array<{ scopeType: string; scopeValue: string; enabled: boolean }>;
  }): FlagSnapshot {
    const environmentOverrides = new Map<string, boolean>();
    const developerOverrides = new Map<string, boolean>();
    for (const o of row.overrides) {
      if (o.scopeType === 'environment') environmentOverrides.set(o.scopeValue, o.enabled);
      else if (o.scopeType === 'developer') developerOverrides.set(o.scopeValue, o.enabled);
    }
    return {
      key: row.key,
      defaultEnabled: row.defaultEnabled,
      rolloutPercent: row.rolloutPercent,
      environmentOverrides,
      developerOverrides,
    };
  }
}
