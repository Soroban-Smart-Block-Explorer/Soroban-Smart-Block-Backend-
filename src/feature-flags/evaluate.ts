/**
 * Pure feature-flag evaluation
 *
 * Resolution order (most specific wins):
 *   1. Developer override   (per-account, DB)
 *   2. Environment override (per-environment, DB)
 *   3. Env var              (per-environment bootstrap config, e.g. ENABLE_*)
 *   4. Gradual rollout      (deterministic per-account bucket when 0 < pct < 100)
 *   5. DB default           (FeatureFlag.defaultEnabled)
 *
 * Kept free of I/O so it can be unit-tested exhaustively; the store in
 * store.ts loads state, this module decides.
 */

export interface FlagSnapshot {
  key: string;
  defaultEnabled: boolean;
  /** Gradual rollout target (0-100). */
  rolloutPercent: number;
  environmentOverrides: Map<string, boolean>;
  developerOverrides: Map<string, boolean>;
}

export interface FlagOverrides {
  environment: Map<string, boolean>;
  developer: Map<string, boolean>;
}

export interface EvaluateInput {
  snapshot: FlagSnapshot;
  overrides: FlagOverrides;
  environment: string;
  developerId?: string;
  /** Raw env var string; undefined means unset. */
  envVarValue?: string;
}

export type EvaluationReason =
  'developer_override' | 'environment_override' | 'env_var' | 'rollout' | 'default';

export interface EvaluationResult {
  enabled: boolean;
  reason: EvaluationReason;
}

/**
 * FNV-1a 32-bit hash — stable across runs and processes, so a given
 * (flag, account) pair always lands in the same rollout bucket.
 */
export function stableHash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Whether `developerId` falls inside the rollout for `key` at `percent` (0-100).
 * Buckets are 1..100 and the bucket is derived from the stable hash, so an
 * account that is "in" at 10% is also in at 20% — increasing the percentage
 * only ever adds accounts (monotonic rollout).
 */
export function inRollout(key: string, developerId: string, percent: number): boolean {
  if (percent >= 100) return true;
  if (percent <= 0) return false;
  const bucket = (stableHash(`${key}:${developerId}`) % 100) + 1;
  return bucket <= percent;
}

export function evaluateFlag(input: EvaluateInput): EvaluationResult {
  const { snapshot, overrides, environment, developerId, envVarValue } = input;

  // 1. Per-account override — most specific.
  if (developerId && overrides.developer.has(developerId)) {
    return { enabled: overrides.developer.get(developerId)!, reason: 'developer_override' };
  }

  // 2. Per-environment override.
  if (overrides.environment.has(environment)) {
    return { enabled: overrides.environment.get(environment)!, reason: 'environment_override' };
  }

  // 3. Env var — legacy ENABLE_* / generic FF_* per-environment bootstrap.
  if (envVarValue !== undefined) {
    const v = envVarValue.trim().toLowerCase();
    return { enabled: v === 'true' || v === '1', reason: 'env_var' };
  }

  // 4. Gradual rollout — stable per-account bucket. Without a developerId there
  //    is no stable bucket, so anonymous callers fall through to the default.
  const { rolloutPercent } = snapshot;
  if (rolloutPercent > 0 && rolloutPercent < 100) {
    if (developerId) {
      return { enabled: inRollout(snapshot.key, developerId, rolloutPercent), reason: 'rollout' };
    }
  } else if (rolloutPercent >= 100) {
    return { enabled: true, reason: 'rollout' };
  }

  // 5. DB default.
  return { enabled: snapshot.defaultEnabled, reason: 'default' };
}
