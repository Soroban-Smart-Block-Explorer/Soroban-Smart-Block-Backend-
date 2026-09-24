/**
 * Feature flags — public API
 *
 * Layered, DB-backed feature flags with per-environment and per-developer
 * toggles plus gradual rollout. Resolution order:
 *
 *   developer override > environment override > env var > rollout > default
 *
 * Backward compatible: the legacy ENABLE_* env vars keep working unchanged
 * (they are the per-environment bootstrap layer), and a feature is only ever
 * started when its required tables exist (schema availability), now reported
 * explicitly instead of silently crashing.
 *
 * Usage:
 *   boot:        await featureFlags.bootstrap();            // warm cache
 *   boot gate:   featureFlags.isEnabledSync('poolMonitor')
 *                featureFlags.isAvailableSync('poolMonitor')
 *   request:     featureFlags.isEnabled('betaEndpoint', { developerId })
 */

import { config } from '../config';
import { logger } from '../logger';
import { prismaRead, prismaWrite } from '../db';
import { findFlagDefinition, envVarFor, listFlagDefinitions, type FlagScopeType } from './registry';
import { evaluateFlag, type FlagSnapshot, type FlagOverrides } from './evaluate';
import { FeatureFlagStore, type FlagUpdate } from './store';
import { loadExistingTables, tablesExistSync, invalidateSchemaCache } from './schema';

export { FEATURE_FLAG_DEFINITIONS, listFlagDefinitions, findFlagDefinition } from './registry';
export type { FlagScopeType } from './registry';
export type { EvaluationReason } from './evaluate';
export { inRollout, stableHash } from './evaluate';

export interface FlagContext {
  developerId?: string;
  /** Defaults to the active Stellar network (per-environment scope). */
  environment?: string;
}

export interface ResolvedFlag {
  key: string;
  description: string;
  defaultEnabled: boolean;
  rolloutPercent: number;
  requiredTables: string[];
  envVar?: string;
  enabled: boolean;
  available: boolean;
  reason: string;
  overrides: {
    environment: Record<string, boolean>;
    developer: Record<string, boolean>;
  };
}

export class FeatureFlags {
  private readonly store = new FeatureFlagStore(prismaRead, prismaWrite);

  get environment(): string {
    return config.stellarNetwork;
  }

  /** Warm the cache + schema availability before serving. Best-effort. */
  async bootstrap(): Promise<void> {
    try {
      await this.store.ensureRegisteredFlags();
      await this.store.load();
      await loadExistingTables();
    } catch (err) {
      logger.warn('[feature-flags] bootstrap failed; falling back to env vars + defaults', {
        error: String(err),
      });
    }
  }

  /** Reload flag state from the DB (e.g. after a manual change). */
  async refresh(): Promise<void> {
    this.store.invalidate();
    invalidateSchemaCache();
    await this.store.load();
    await loadExistingTables();
  }

  /**
   * Evaluate a flag synchronously from the cache. Safe on the boot path after
   * `bootstrap()`; also safe before (falls back to env var + registry default,
   * matching the pre-feature-flag behavior).
   */
  isEnabledSync(key: string, ctx: FlagContext = {}): boolean {
    return this.evaluate(key, ctx).enabled;
  }

  /** Evaluate a flag, ensuring the cache is loaded first. */
  async isEnabled(key: string, ctx: FlagContext = {}): Promise<boolean> {
    await this.store.load();
    return this.isEnabledSync(key, ctx);
  }

  /** Per-account evaluation for request-scoped features. */
  isEnabledForDeveloper(
    key: string,
    developerId: string,
    ctx: Omit<FlagContext, 'developerId'> = {},
  ): boolean {
    return this.isEnabledSync(key, { ...ctx, developerId });
  }

  /**
   * Whether the feature's required tables exist. A feature that is enabled but
   * not available must not be started.
   */
  isAvailableSync(key: string): boolean {
    const def = findFlagDefinition(key);
    if (!def?.requiredTables?.length) return true;
    return tablesExistSync(def.requiredTables);
  }

  async isAvailable(key: string): Promise<boolean> {
    const def = findFlagDefinition(key);
    if (!def?.requiredTables?.length) return true;
    await loadExistingTables();
    return tablesExistSync(def.requiredTables);
  }

  /** Start the feature iff the toggle is on AND the schema prerequisite exists. */
  shouldStartSync(key: string, ctx: FlagContext = {}): boolean {
    return this.isEnabledSync(key, ctx) && this.isAvailableSync(key);
  }

  /** List all registered flags with resolved state (admin API / diagnostics). */
  async list(): Promise<ResolvedFlag[]> {
    await this.store.load();
    await loadExistingTables();
    return listFlagDefinitions().map((def) => this.resolve(def.key));
  }

  async updateFlag(key: string, patch: FlagUpdate): Promise<ResolvedFlag> {
    await this.store.updateFlag(key, patch);
    return this.resolve(key);
  }

  async setOverride(
    key: string,
    scopeType: FlagScopeType,
    scopeValue: string,
    enabled: boolean,
  ): Promise<ResolvedFlag> {
    await this.store.setOverride(key, scopeType, scopeValue, enabled);
    return this.resolve(key);
  }

  async clearOverride(key: string, scopeType: FlagScopeType, scopeValue: string): Promise<void> {
    await this.store.clearOverride(key, scopeType, scopeValue);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private resolve(key: string): ResolvedFlag {
    const def = findFlagDefinition(key);
    const result = this.evaluate(key);
    const cached = this.store.getCachedSync(key);
    return {
      key,
      description: def?.description ?? '',
      defaultEnabled: cached?.defaultEnabled ?? def?.defaultEnabled ?? false,
      rolloutPercent: cached?.rolloutPercent ?? def?.rolloutPercent ?? 0,
      requiredTables: def?.requiredTables ?? [],
      envVar: def ? envVarFor(def) : undefined,
      enabled: result.enabled,
      available: this.isAvailableSync(key),
      reason: result.reason,
      overrides: {
        environment: Object.fromEntries(cached?.environmentOverrides ?? new Map()),
        developer: Object.fromEntries(cached?.developerOverrides ?? new Map()),
      },
    };
  }

  private evaluate(key: string, ctx: FlagContext = {}): { enabled: boolean; reason: string } {
    const def = findFlagDefinition(key);
    const snapshot: FlagSnapshot = this.store.getCachedSync(key) ?? {
      key,
      defaultEnabled: def?.defaultEnabled ?? false,
      rolloutPercent: def?.rolloutPercent ?? 0,
      environmentOverrides: new Map(),
      developerOverrides: new Map(),
    };

    const overrides: FlagOverrides = {
      environment: snapshot.environmentOverrides,
      developer: snapshot.developerOverrides,
    };

    const envVarValue = def ? process.env[envVarFor(def)] : undefined;
    const result = evaluateFlag({
      snapshot,
      overrides,
      environment: ctx.environment ?? this.environment,
      developerId: ctx.developerId,
      envVarValue,
    });
    return { enabled: result.enabled, reason: result.reason };
  }
}

/** Process-wide singleton. */
export const featureFlags = new FeatureFlags();
