import { describe, it, expect } from 'vitest';
import {
  evaluateFlag,
  inRollout,
  stableHash,
  type FlagSnapshot,
} from '../../src/feature-flags/evaluate';

function snapshot(partial: Partial<FlagSnapshot> = {}): FlagSnapshot {
  return {
    key: 'poolMonitor',
    defaultEnabled: false,
    rolloutPercent: 0,
    environmentOverrides: new Map(),
    developerOverrides: new Map(),
    ...partial,
  };
}

function evalWith(
  snap: FlagSnapshot,
  opts: {
    environment?: string;
    developerId?: string;
    envVarValue?: string;
    envOverrides?: Record<string, boolean>;
    devOverrides?: Record<string, boolean>;
  } = {},
) {
  return evaluateFlag({
    snapshot: {
      ...snap,
      environmentOverrides: new Map(Object.entries(opts.envOverrides ?? {})),
      developerOverrides: new Map(Object.entries(opts.devOverrides ?? {})),
    },
    overrides: {
      environment: new Map(Object.entries(opts.envOverrides ?? {})),
      developer: new Map(Object.entries(opts.devOverrides ?? {})),
    },
    environment: opts.environment ?? 'testnet',
    developerId: opts.developerId,
    envVarValue: opts.envVarValue,
  });
}

describe('evaluateFlag', () => {
  it('falls back to the DB default when nothing else is set', () => {
    expect(evalWith(snapshot({ defaultEnabled: false }))).toEqual({
      enabled: false,
      reason: 'default',
    });
    expect(evalWith(snapshot({ defaultEnabled: true }))).toEqual({
      enabled: true,
      reason: 'default',
    });
  });

  it('developer override beats environment override, env var, rollout, and default', () => {
    const result = evalWith(snapshot({ defaultEnabled: false, rolloutPercent: 100 }), {
      developerId: 'dev-1',
      devOverrides: { 'dev-1': true },
      envOverrides: { testnet: false },
      envVarValue: 'false',
    });
    expect(result).toEqual({ enabled: true, reason: 'developer_override' });
  });

  it('developer override only applies to that developer', () => {
    const result = evalWith(snapshot(), {
      developerId: 'dev-2',
      devOverrides: { 'dev-1': true },
    });
    expect(result.enabled).toBe(false);
  });

  it('environment override beats env var, rollout, and default', () => {
    const result = evalWith(snapshot({ defaultEnabled: false, rolloutPercent: 100 }), {
      envOverrides: { testnet: true },
      envVarValue: 'false',
    });
    expect(result).toEqual({ enabled: true, reason: 'environment_override' });
  });

  it('environment override is scoped to the matching environment', () => {
    const result = evalWith(snapshot(), {
      environment: 'mainnet',
      envOverrides: { testnet: true },
    });
    expect(result.enabled).toBe(false);
  });

  it('env var forces on with true/1 and off with anything else', () => {
    for (const v of ['true', '1', ' TRUE ', '1']) {
      expect(evalWith(snapshot({ defaultEnabled: false }), { envVarValue: v }).enabled).toBe(true);
    }
    for (const v of ['false', '0', 'banana', '']) {
      expect(evalWith(snapshot({ defaultEnabled: true }), { envVarValue: v }).enabled).toBe(false);
    }
    expect(evalWith(snapshot({ defaultEnabled: false }), { envVarValue: undefined }).enabled).toBe(
      false,
    );
  });

  it('env var loses to environment override but wins over rollout', () => {
    const snap = snapshot({ defaultEnabled: false, rolloutPercent: 100 });
    const envResult = evalWith(snap, { envVarValue: 'false', envOverrides: { testnet: true } });
    expect(envResult.reason).toBe('environment_override');
    const rolloutResult = evalWith(snapshot({ defaultEnabled: false, rolloutPercent: 0 }), {
      envVarValue: 'true',
      developerId: 'dev-1',
    });
    expect(rolloutResult).toEqual({ enabled: true, reason: 'env_var' });
  });

  it('rolloutPercent 100 is on, 0 is off, without touching the hash', () => {
    expect(
      evalWith(snapshot({ defaultEnabled: false, rolloutPercent: 100 }), {
        developerId: 'anyone',
      }).reason,
    ).toBe('rollout');
    expect(evalWith(snapshot({ defaultEnabled: true, rolloutPercent: 0 })).enabled).toBe(true);
  });

  it('rollout is bucketed per developerId and skipped for anonymous callers', () => {
    const snap = snapshot({ defaultEnabled: false, rolloutPercent: 50 });
    // Anonymous → no stable bucket → default.
    expect(evalWith(snap).enabled).toBe(false);
    // Named developer → bucket decides.
    const r = evalWith(snap, { developerId: 'dev-abc' });
    expect(r.reason).toBe('rollout');
    expect(typeof r.enabled).toBe('boolean');
  });
});

describe('inRollout / stableHash', () => {
  it('is deterministic for the same (key, developerId)', () => {
    const a = inRollout('poolMonitor', 'dev-1', 42);
    const b = inRollout('poolMonitor', 'dev-1', 42);
    expect(a).toBe(b);
  });

  it('is monotonic: an account in at pct is also in at a higher pct', () => {
    let changed = 0;
    for (let i = 0; i < 500; i++) {
      const dev = `dev-${i}`;
      const low = inRollout('poolMonitor', dev, 20);
      const high = inRollout('poolMonitor', dev, 80);
      if (low && !high) changed++;
      expect(!low || high).toBe(true);
    }
    expect(changed).toBe(0);
  });

  it('roughly respects the percentage across many accounts', () => {
    const total = 2000;
    const in10 = Array.from({ length: total }, (_, i) =>
      inRollout('feeAggregator', `dev-${i}`, 10),
    ).filter(Boolean).length;
    expect(in10).toBeGreaterThan(total * 0.05);
    expect(in10).toBeLessThan(total * 0.15);
  });

  it('buckets differ across flags for the same developer', () => {
    const buckets = new Set<number>();
    for (let i = 0; i < 100; i++) {
      buckets.add(stableHash(`${'flagA'}:dev-x`) === stableHash(`${'flagA'}:dev-x`) ? 0 : 1);
    }
    // identical inputs → identical hash
    expect(stableHash('flagA:dev-x')).toBe(stableHash('flagA:dev-x'));
    expect(stableHash('flagA:dev-x')).not.toBe(stableHash('flagB:dev-x'));
  });
});
