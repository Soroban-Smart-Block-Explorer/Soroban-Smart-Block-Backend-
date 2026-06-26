import { describe, it, expect } from 'vitest';
import {
  diffOpcodes,
  diffFunctions,
  classifyChange,
  summarizeChange,
  type ContractFn,
} from '../src/indexer/wasm-diff';
import type { OpcodeIndex } from '../src/indexer/wasm-decompiler';
import {
  analyzeGovernance,
  computeDecentralizationScore,
  detectSuspiciousActivity,
} from '../src/indexer/upgrade-governance';

// ── Helpers ────────────────────────────────────────────────────────────────
// Build a synthetic OpcodeIndex from a mnemonic→count map so diff/classify
// logic can be exercised without crafting binary WASM (the binary parsers are
// covered separately in wasm-decompiler.test.ts / wasm-spec.test.ts).
function index(frequency: Record<string, number>): OpcodeIndex {
  const total = Object.values(frequency).reduce((a, b) => a + b, 0);
  return {
    distinctOpcodes: Object.keys(frequency),
    totalOpcodes: total,
    frequency,
    sequence: [],
  };
}

function fns(spec: Array<[string, number]>): ContractFn[] {
  return spec.map(([name, inputCount]) => ({ name, inputCount }));
}

// ─────────────────────────────────────────────────────────────────────────────
// 5+ real-world upgrade scenarios, each asserting the WASM-diff classification,
// the governance/decentralisation methodology, and the suspicious-activity
// risk roll-up end to end.
// ─────────────────────────────────────────────────────────────────────────────

describe('Scenario 1: DAO-governed bug-fix patch (healthy upgrade)', () => {
  // A small, vote-gated, time-delayed patch touching no critical functions.
  const prev = index({ 'local.get': 40, 'i32.add': 20, call: 10 });
  const next = index({ 'local.get': 41, 'i32.add': 21, call: 10 });
  const fnDiff = diffFunctions(fns([['transfer', 3], ['balance', 1]]), fns([['transfer', 3], ['balance', 1]]));
  const opDiff = diffOpcodes(prev, next);

  it('classifies as a minor change', () => {
    expect(classifyChange(opDiff, fnDiff)).toBe('minor');
    expect(fnDiff.criticalChanges).toHaveLength(0);
  });

  it('scores high on decentralisation (DAO + timelock + multisig)', () => {
    const gov = analyzeGovernance({
      signerCount: 5,
      threshold: 3,
      timelockSeconds: 2 * 24 * 3600,
      daoProposalId: 'prop-42',
      daoVotes: 120,
    });
    expect(gov.governanceType).toBe('dao');
    expect(gov.isMultisig).toBe(true);
    expect(computeDecentralizationScore(gov)).toBeGreaterThanOrEqual(80);
  });

  it('raises no suspicious flags', () => {
    const res = detectSuspiciousActivity({
      upgradeTime: new Date('2026-03-10T14:00:00Z'),
      criticalFnChanges: [],
      governanceType: 'dao',
      upgraderAccountAgeLedgers: 5_000_000,
      recentVulnerability: null,
    });
    expect(res.isSuspicious).toBe(false);
    expect(res.riskLevel).toBe('none');
  });
});

describe('Scenario 2: single-key admin takeover via set_admin (critical)', () => {
  // A single EOA swaps the admin function and pushes it at 02:00 UTC.
  const fnDiff = diffFunctions(
    fns([['transfer', 3], ['set_admin', 1]]),
    fns([['transfer', 3], ['set_admin', 2]]), // signature changed
  );
  const opDiff = diffOpcodes(index({ call: 50 }), index({ call: 70, 'i64.store': 10 }));

  it('classifies as critical (touches access-control function)', () => {
    expect(fnDiff.criticalChanges).toContain('set_admin');
    expect(classifyChange(opDiff, fnDiff)).toBe('critical');
  });

  it('scores low on decentralisation (single key, no timelock/DAO)', () => {
    const gov = analyzeGovernance({ signerCount: 1, threshold: 1 });
    expect(gov.governanceType).toBe('single_key');
    expect(computeDecentralizationScore(gov)).toBeLessThanOrEqual(10);
  });

  it('flags single-key critical ACL change at midnight → high/critical risk', () => {
    const res = detectSuspiciousActivity({
      upgradeTime: new Date('2026-03-10T02:00:00Z'),
      criticalFnChanges: ['set_admin'],
      governanceType: 'single_key',
      upgraderAccountAgeLedgers: 9_000_000,
      recentVulnerability: null,
    });
    expect(res.flags).toEqual(
      expect.arrayContaining(['critical_acl_change', 'single_key_critical', 'midnight_upgrade']),
    );
    expect(res.isSuspicious).toBe(true);
    expect(['high', 'critical']).toContain(res.riskLevel);
  });
});

describe('Scenario 3: same-day upgrade right after a vulnerability disclosure', () => {
  // Moderate code change, but the timing relative to a fresh advisory is the
  // signal — even with a reasonable multisig.
  const fnDiff = diffFunctions(
    fns([['swap', 4], ['quote', 2]]),
    fns([['swap', 4], ['quote', 2], ['repair', 1]]),
  );
  const opDiff = diffOpcodes(index({ call: 100, 'local.get': 80 }), index({ call: 130, 'local.get': 90 }));

  it('classifies as moderate (new non-critical function, modest churn)', () => {
    expect(fnDiff.criticalChanges).toHaveLength(0);
    expect(classifyChange(opDiff, fnDiff)).toBe('moderate');
  });

  it('flags post-vulnerability timing as suspicious', () => {
    const res = detectSuspiciousActivity({
      upgradeTime: new Date('2026-04-01T15:00:00Z'),
      criticalFnChanges: [],
      governanceType: 'multisig',
      upgraderAccountAgeLedgers: 2_000_000,
      recentVulnerability: { id: 'adv-9', title: 'Reentrancy in swap', publishedAt: new Date('2026-04-01T09:00:00Z') },
    });
    expect(res.flags).toContain('post_vuln_upgrade');
    expect(res.isSuspicious).toBe(true);
    expect(['medium', 'high', 'critical']).toContain(res.riskLevel);
  });
});

describe('Scenario 4: brand-new account performs a full contract rewrite', () => {
  // High opcode churn + functions removed, executed by a <1-day-old account.
  const prev = index({ 'local.get': 100, 'i32.add': 100, call: 50 });
  const next = index({ 'f64.mul': 120, 'memory.grow': 60, call: 20 });
  const opDiff = diffOpcodes(prev, next);
  const fnDiff = diffFunctions(
    fns([['deposit', 2], ['withdraw', 2], ['legacy_claim', 1]]),
    fns([['deposit', 2], ['withdraw', 2]]), // legacy_claim removed
  );

  it('classifies as major (large rewrite, public function removed)', () => {
    expect(opDiff.churn).toBeGreaterThanOrEqual(0.5);
    expect(fnDiff.removed).toContain('legacy_claim');
    // withdraw is in the critical set but unchanged here; no critical change.
    expect(classifyChange(opDiff, fnDiff)).toBe('major');
  });

  it('flags newly-created upgrader account', () => {
    const res = detectSuspiciousActivity({
      upgradeTime: new Date('2026-04-05T13:00:00Z'),
      criticalFnChanges: [],
      governanceType: 'single_key',
      upgraderAccountAgeLedgers: 500, // ~40 min old, well under the 1-day threshold
      recentVulnerability: null,
    });
    expect(res.flags).toContain('new_account_upgrader');
    expect(res.isSuspicious).toBe(true);
  });
});

describe('Scenario 5: well-governed multisig timelocked upgrade adding a feature', () => {
  // Moderate change behind a 3-of-5 multisig with a 1-day timelock, no DAO.
  const opDiff = diffOpcodes(index({ call: 200, 'local.get': 150 }), index({ call: 230, 'local.get': 150, 'i32.eqz': 5 }));
  const fnDiff = diffFunctions(
    fns([['stake', 2], ['unstake', 1]]),
    fns([['stake', 2], ['unstake', 1], ['claim_rewards', 1]]),
  );

  it('classifies as moderate', () => {
    expect(classifyChange(opDiff, fnDiff)).toBe('moderate');
  });

  it('scores mid/high decentralisation (multisig + timelock, no DAO)', () => {
    const gov = analyzeGovernance({ signerCount: 5, threshold: 3, timelockSeconds: 24 * 3600 });
    expect(gov.governanceType).toBe('timelock');
    const score = computeDecentralizationScore(gov);
    expect(score).toBeGreaterThanOrEqual(45);
    expect(score).toBeLessThan(80); // no DAO component
  });

  it('raises no suspicious flags during business hours', () => {
    const res = detectSuspiciousActivity({
      upgradeTime: new Date('2026-04-10T16:30:00Z'),
      criticalFnChanges: [],
      governanceType: 'timelock',
      upgraderAccountAgeLedgers: 3_000_000,
      recentVulnerability: null,
    });
    expect(res.isSuspicious).toBe(false);
  });
});

describe('Scenario 6: initial deployment is summarised, not diffed', () => {
  // previous == null path: churn is measured against an empty baseline.
  const opDiff = diffOpcodes(null, index({ call: 10, 'local.get': 30 }));
  const fnDiff = diffFunctions(null, fns([['initialize', 1], ['transfer', 3]]));

  it('treats every opcode/function as added', () => {
    expect(opDiff.previousTotal).toBe(0);
    expect(opDiff.churn).toBe(1);
    expect(fnDiff.added).toEqual(['initialize', 'transfer']);
    expect(fnDiff.removed).toHaveLength(0);
  });

  it('renders an initial-deployment summary', () => {
    const summary = summarizeChange('major', opDiff, fnDiff, true);
    expect(summary).toMatch(/Initial deployment/);
    expect(summary).toMatch(/2 function/);
  });
});

// ── Methodology guardrails ──────────────────────────────────────────────────

describe('Decentralisation score methodology bounds', () => {
  it('clamps to 0..100 and orders postures correctly', () => {
    const single = computeDecentralizationScore(analyzeGovernance({ signerCount: 1, threshold: 1 }));
    const multisig = computeDecentralizationScore(analyzeGovernance({ signerCount: 5, threshold: 3 }));
    const timelocked = computeDecentralizationScore(
      analyzeGovernance({ signerCount: 5, threshold: 3, timelockSeconds: 3 * 24 * 3600 }),
    );
    const dao = computeDecentralizationScore(
      analyzeGovernance({ signerCount: 9, threshold: 6, timelockSeconds: 7 * 24 * 3600, daoProposalId: 'p', daoVotes: 300 }),
    );

    for (const s of [single, multisig, timelocked, dao]) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(100);
    }
    expect(single).toBeLessThan(multisig);
    expect(multisig).toBeLessThan(timelocked);
    expect(timelocked).toBeLessThan(dao);
  });

  it('treats an unknown authority (0 signers) as fully centralised-unknown', () => {
    const gov = analyzeGovernance({});
    expect(gov.governanceType).toBe('unknown');
    expect(computeDecentralizationScore(gov)).toBe(0);
  });
});
