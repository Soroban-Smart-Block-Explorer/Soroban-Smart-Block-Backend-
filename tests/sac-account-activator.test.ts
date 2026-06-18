/**
 * Tests for Issue #168 — SAC Account Activator
 *
 * Unit tests for the parseAmountToStroops helper and the core activation
 * logic. DB-dependent functions (evaluateAccountActivation,
 * maybeActivateFromTransferEvent) are tested via their pure logic paths.
 */

import { describe, it, expect } from 'vitest';
import {
  parseAmountToStroops,
  MIN_ACTIVATION_STROOPS,
  ACCOUNT_STATUS,
} from '../src/indexer/sac-account-activator';

// ── parseAmountToStroops ──────────────────────────────────────────────────────

describe('parseAmountToStroops', () => {
  it('parses a raw stroop integer string', () => {
    expect(parseAmountToStroops('10000000')).toBe(10_000_000n);
  });

  it('parses a decimal XLM string (1.0000000)', () => {
    expect(parseAmountToStroops('1.0000000')).toBe(10_000_000n);
  });

  it('parses a decimal XLM string with fewer decimals (1.5)', () => {
    // 1.5 XLM = 15_000_000 stroops
    expect(parseAmountToStroops('1.5')).toBe(15_000_000n);
  });

  it('parses a decimal string with trailing token symbol', () => {
    expect(parseAmountToStroops('2.0000000 XLM')).toBe(20_000_000n);
  });

  it('parses zero', () => {
    expect(parseAmountToStroops('0')).toBe(0n);
    expect(parseAmountToStroops('0.0000000')).toBe(0n);
  });

  it('parses a bigint directly', () => {
    expect(parseAmountToStroops(5_000_000n)).toBe(5_000_000n);
  });

  it('parses a number', () => {
    expect(parseAmountToStroops(10_000_000)).toBe(10_000_000n);
  });

  it('throws for unsupported types', () => {
    expect(() => parseAmountToStroops(null as any)).toThrow(TypeError);
    expect(() => parseAmountToStroops({} as any)).toThrow(TypeError);
  });
});

// ── Reserve threshold ─────────────────────────────────────────────────────────

describe('MIN_ACTIVATION_STROOPS', () => {
  it('equals 1 XLM (10_000_000 stroops)', () => {
    expect(MIN_ACTIVATION_STROOPS).toBe(10_000_000n);
  });

  it('correctly classifies amounts below the reserve', () => {
    const below = parseAmountToStroops('0.9999999');
    expect(below < MIN_ACTIVATION_STROOPS).toBe(true);
  });

  it('correctly classifies amounts at exactly the reserve', () => {
    const exact = parseAmountToStroops('1.0000000');
    expect(exact >= MIN_ACTIVATION_STROOPS).toBe(true);
  });

  it('correctly classifies amounts above the reserve', () => {
    const above = parseAmountToStroops('100.0000000');
    expect(above >= MIN_ACTIVATION_STROOPS).toBe(true);
  });
});

// ── ACCOUNT_STATUS labels ─────────────────────────────────────────────────────

describe('ACCOUNT_STATUS', () => {
  it('has the correct unfunded label', () => {
    expect(ACCOUNT_STATUS.UNFUNDED).toBe('Unfunded Key');
  });

  it('has the correct active label', () => {
    expect(ACCOUNT_STATUS.ACTIVE).toBe('Active Base Wallet Natively Initialized');
  });
});
