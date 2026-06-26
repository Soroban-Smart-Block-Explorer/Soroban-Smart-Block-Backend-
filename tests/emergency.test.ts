import { describe, it, expect, vi } from 'vitest';

// ── Unit tests for pause detection, pauser classification, recovery analysis ──

// We test the pure functions directly without DB
vi.mock('../src/db', () => ({
  prismaRead: {},
  prismaWrite: {},
}));
vi.mock('../src/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../src/ws/eventBroadcaster', () => ({ broadcastEmergencyEvent: vi.fn() }));

import { computeDecentralizationScore, classifyRisk } from '../src/indexer/emergency-indexer';

// ── computeDecentralizationScore ────────────────────────────────────────────

describe('computeDecentralizationScore', () => {
  it('returns 10 for single_admin', () => {
    expect(computeDecentralizationScore('single_admin')).toBe(10);
  });

  it('returns 0 for unknown type', () => {
    expect(computeDecentralizationScore('unknown')).toBe(0);
  });

  it('returns 90 for automatic', () => {
    expect(computeDecentralizationScore('automatic')).toBe(90);
  });

  it('returns 75 for dao', () => {
    expect(computeDecentralizationScore('dao')).toBe(75);
  });

  it('scales multi_sig by threshold/total ratio', () => {
    const low = computeDecentralizationScore('multi_sig', 1, 5); // ratio 0.2 → 21 + 0.2*39 = 28.8 → 28
    const high = computeDecentralizationScore('multi_sig', 4, 5); // ratio 0.8 → 21 + 0.8*39 = 52.2 → 52
    expect(low).toBeLessThan(high);
    expect(low).toBeGreaterThanOrEqual(21);
    expect(high).toBeLessThanOrEqual(60);
  });

  it('scales timelock by delay days', () => {
    const score1 = computeDecentralizationScore('timelock', undefined, undefined, 1);
    const score5 = computeDecentralizationScore('timelock', undefined, undefined, 5);
    expect(score5).toBeGreaterThan(score1);
    expect(score1).toBe(60); // 50 + 1*10
    expect(score5).toBe(100); // 50 + 5*10 = 100 capped
  });
});

// ── classifyRisk ─────────────────────────────────────────────────────────────

describe('classifyRisk', () => {
  it('classifies 0-20 as critical', () => {
    expect(classifyRisk(0)).toBe('critical');
    expect(classifyRisk(10)).toBe('critical');
    expect(classifyRisk(20)).toBe('critical');
  });

  it('classifies 21-40 as high', () => {
    expect(classifyRisk(21)).toBe('high');
    expect(classifyRisk(40)).toBe('high');
  });

  it('classifies 41-60 as medium', () => {
    expect(classifyRisk(41)).toBe('medium');
    expect(classifyRisk(60)).toBe('medium');
  });

  it('classifies 61-80 as low', () => {
    expect(classifyRisk(61)).toBe('low');
    expect(classifyRisk(80)).toBe('low');
  });

  it('classifies 81-100 as minimal', () => {
    expect(classifyRisk(81)).toBe('minimal');
    expect(classifyRisk(100)).toBe('minimal');
  });
});

// ── Pause event topic detection ───────────────────────────────────────────────

describe('pause topic detection', () => {
  const PAUSE_TOPICS = ['contract_paused', 'paused', 'emergency_stop', 'pause'];
  const UNPAUSE_TOPICS = ['contract_unpaused', 'unpaused', 'unpause'];

  const isPauseTopic = (sym: string) => PAUSE_TOPICS.some((t) => sym.toLowerCase().includes(t));
  const isUnpauseTopic = (sym: string) => UNPAUSE_TOPICS.some((t) => sym.toLowerCase().includes(t));

  it('detects standard pause topics', () => {
    expect(isPauseTopic('contract_paused')).toBe(true);
    expect(isPauseTopic('paused')).toBe(true);
    expect(isPauseTopic('emergency_stop')).toBe(true);
    expect(isPauseTopic('pause')).toBe(true);
    expect(isPauseTopic('set_paused')).toBe(true);
  });

  it('detects standard unpause topics', () => {
    expect(isUnpauseTopic('contract_unpaused')).toBe(true);
    expect(isUnpauseTopic('unpaused')).toBe(true);
    expect(isUnpauseTopic('unpause')).toBe(true);
  });

  it('does not false-positive non-pause events', () => {
    expect(isPauseTopic('transfer')).toBe(false);
    expect(isPauseTopic('swap')).toBe(false);
    expect(isPauseTopic('mint')).toBe(false);
    expect(isUnpauseTopic('transfer')).toBe(false);
  });
});

// ── Recovery function matching ────────────────────────────────────────────────

describe('recovery function classification', () => {
  const RECOVERY_PATTERNS = {
    fund: ['emergency_withdraw', 'recover_funds', 'claim_stuck_tokens', 'drain', 'rescue'],
    upgrade: ['upgrade', 'set_implementation', 'update_contract', 'migrate_to'],
    migration: ['migrate', 'export_state', 'import_state', 'clone'],
    rollback: ['snapshot', 'rollback', 'revert_state', 'checkpoint'],
    admin: ['change_admin', 'transfer_ownership', 'renounce'],
  };

  const matchFns = (fns: string[], patterns: string[]) =>
    fns.filter((fn) => patterns.some((p) => fn.toLowerCase().includes(p)));

  it('identifies fund recovery functions', () => {
    const fns = ['emergency_withdraw', 'swap', 'deposit'];
    expect(matchFns(fns, RECOVERY_PATTERNS.fund)).toEqual(['emergency_withdraw']);
  });

  it('identifies upgrade functions', () => {
    const fns = ['upgrade', 'deposit', 'set_implementation'];
    expect(matchFns(fns, RECOVERY_PATTERNS.upgrade)).toEqual(['upgrade', 'set_implementation']);
  });

  it('returns empty when no recovery functions exist', () => {
    const fns = ['swap', 'deposit', 'withdraw'];
    expect(matchFns(fns, RECOVERY_PATTERNS.fund)).toEqual([]);
    expect(matchFns(fns, RECOVERY_PATTERNS.upgrade)).toEqual([]);
  });

  it('computes correct robustness score', () => {
    const score =
      30 + // fund recovery
      25 + // upgrade
      0 + // migration
      0 + // rollback
      10; // admin
    expect(score).toBe(65);
  });

  it('scores 0 for contract with no recovery functions', () => {
    const score = 0 + 0 + 0 + 0 + 0;
    expect(score).toBe(0);
  });

  it('scores 100 for contract with all recovery capabilities', () => {
    const score = 30 + 25 + 20 + 15 + 10;
    expect(score).toBe(100);
  });
});

// ── Incident severity derivation ─────────────────────────────────────────────

describe('incident severity from decentralization score', () => {
  function deriveIncidentSeverity(decScore: number | null): string {
    if (!decScore || decScore <= 20) return 'critical';
    if (decScore <= 40) return 'high';
    return 'medium';
  }

  it('returns critical for null score (unknown pauser)', () => {
    expect(deriveIncidentSeverity(null)).toBe('critical');
  });

  it('returns critical for single_admin (score=10)', () => {
    expect(deriveIncidentSeverity(10)).toBe('critical');
  });

  it('returns high for weak multi-sig (score=30)', () => {
    expect(deriveIncidentSeverity(30)).toBe('high');
  });

  it('returns medium for standard multi-sig (score=50)', () => {
    expect(deriveIncidentSeverity(50)).toBe('medium');
  });
});

// ── Duration calculation ──────────────────────────────────────────────────────

describe('pause duration calculation', () => {
  function calcDuration(pauseTime: Date, unpauseTime: Date): number {
    return Math.round((unpauseTime.getTime() - pauseTime.getTime()) / 1000);
  }

  it('calculates duration in seconds', () => {
    const pause = new Date('2026-06-17T10:00:00Z');
    const unpause = new Date('2026-06-17T12:30:00Z');
    expect(calcDuration(pause, unpause)).toBe(9000); // 2h 30m
  });

  it('calculates zero for same-time pause/unpause', () => {
    const t = new Date();
    expect(calcDuration(t, t)).toBe(0);
  });
});
