import { describe, it, expect } from 'vitest';
import { nextCronDate, isValidCronExpression } from '../src/indexer/cron-engine';
import { detectTimerType, detectTimerTypeFromAbi } from '../src/indexer/temporal-scanner';

// ── Cron engine — nextCronDate ────────────────────────────────────────────────

describe('nextCronDate', () => {
  it('returns a date in the future', () => {
    const now = new Date();
    const next = nextCronDate('* * * * *', now);
    expect(next.getTime()).toBeGreaterThan(now.getTime());
  });

  it('resolves @daily alias to 00:00', () => {
    const base = new Date('2025-01-01T10:00:00Z');
    const next = nextCronDate('@daily', base);
    expect(next.getUTCHours()).toBe(0);
    expect(next.getUTCMinutes()).toBe(0);
  });

  it('resolves @hourly to the next hour boundary', () => {
    const base = new Date('2025-06-01T10:30:00Z');
    const next = nextCronDate('@hourly', base);
    expect(next.getUTCMinutes()).toBe(0);
    expect(next.getUTCHours()).toBe(11);
  });

  it('respects specific minute', () => {
    const base = new Date('2025-06-01T10:00:00Z');
    // Run at minute 15 of every hour
    const next = nextCronDate('15 * * * *', base);
    expect(next.getUTCMinutes()).toBe(15);
  });

  it('respects specific hour and minute', () => {
    const base = new Date('2025-06-01T08:00:00Z');
    // Run daily at 14:30
    const next = nextCronDate('30 14 * * *', base);
    expect(next.getUTCHours()).toBe(14);
    expect(next.getUTCMinutes()).toBe(30);
  });

  it('handles step expressions */15', () => {
    const base = new Date('2025-06-01T10:00:00Z');
    const next = nextCronDate('*/15 * * * *', base);
    expect(next.getUTCMinutes() % 15).toBe(0);
  });

  it('handles comma-separated values', () => {
    const base = new Date('2025-06-01T10:00:00Z');
    const next = nextCronDate('0,30 * * * *', base);
    expect([0, 30]).toContain(next.getUTCMinutes());
  });

  it('handles range expressions', () => {
    const base = new Date('2025-06-01T10:00:00Z');
    const next = nextCronDate('0 9-17 * * *', base);
    expect(next.getUTCHours()).toBeGreaterThanOrEqual(9);
    expect(next.getUTCHours()).toBeLessThanOrEqual(17);
  });

  it('resolves @weekly to Sunday at midnight', () => {
    const base = new Date('2025-06-02T10:00:00Z'); // Monday
    const next = nextCronDate('@weekly', base);
    expect(next.getUTCDay()).toBe(0); // Sunday
    expect(next.getUTCHours()).toBe(0);
  });

  it('resolves @monthly to 1st of month at midnight', () => {
    const base = new Date('2025-06-15T10:00:00Z');
    const next = nextCronDate('@monthly', base);
    expect(next.getUTCDate()).toBe(1);
    expect(next.getUTCHours()).toBe(0);
  });
});

// ── Cron engine — isValidCronExpression ──────────────────────────────────────

describe('isValidCronExpression', () => {
  it('accepts standard 5-field expressions', () => {
    expect(isValidCronExpression('* * * * *')).toBe(true);
    expect(isValidCronExpression('0 0 * * *')).toBe(true);
    expect(isValidCronExpression('30 14 * * 1')).toBe(true);
    expect(isValidCronExpression('*/15 * * * *')).toBe(true);
  });

  it('accepts alias expressions', () => {
    expect(isValidCronExpression('@daily')).toBe(true);
    expect(isValidCronExpression('@hourly')).toBe(true);
    expect(isValidCronExpression('@weekly')).toBe(true);
    expect(isValidCronExpression('@monthly')).toBe(true);
    expect(isValidCronExpression('@yearly')).toBe(true);
  });

  it('rejects invalid expressions', () => {
    expect(isValidCronExpression('')).toBe(false);
    expect(isValidCronExpression('not a cron')).toBe(false);
    expect(isValidCronExpression('* *')).toBe(false);
  });
});

// ── Timer detection — detectTimerType ────────────────────────────────────────

describe('detectTimerType', () => {
  it('detects TIMELOCK from function name', () => {
    expect(detectTimerType('execute_proposal')).toBe('TIMELOCK');
    expect(detectTimerType('queue_action')).toBe('TIMELOCK');
    expect(detectTimerType('cancel_timelock')).toBe('TIMELOCK');
  });

  it('detects VESTING from function name', () => {
    expect(detectTimerType('claim_vested')).toBe('VESTING');
    expect(detectTimerType('unlock_tokens')).toBe('VESTING');
    expect(detectTimerType('release_funds')).toBe('VESTING');
  });

  it('detects DEADLINE from function name', () => {
    expect(detectTimerType('close_auction')).toBe('DEADLINE');
    expect(detectTimerType('settle_order')).toBe('DEADLINE');
    expect(detectTimerType('expire_bid')).toBe('DEADLINE');
  });

  it('detects COOLDOWN from function name', () => {
    expect(detectTimerType('withdraw_funds')).toBe('COOLDOWN');
    expect(detectTimerType('unstake_tokens')).toBe('COOLDOWN');
  });

  it('detects RECURRING from function name', () => {
    expect(detectTimerType('distribute_rewards')).toBe('RECURRING');
    expect(detectTimerType('rebase')).toBe('RECURRING');
    expect(detectTimerType('harvest')).toBe('RECURRING');
  });

  it('returns null for unknown function names', () => {
    expect(detectTimerType('swap')).toBeNull();
    expect(detectTimerType('transfer')).toBeNull();
    expect(detectTimerType('deposit')).toBeNull();
  });
});

// ── Timer detection — detectTimerTypeFromAbi ──────────────────────────────────

describe('detectTimerTypeFromAbi', () => {
  it('detects ABSOLUTE from Timestamp type', () => {
    const result = detectTimerTypeFromAbi([{ name: 'amount', type: 'i128' }, { name: 'expire', type: 'Timestamp' }]);
    expect(result).toBe('ABSOLUTE');
  });

  it('detects VESTING from cliff parameter name', () => {
    const result = detectTimerTypeFromAbi([{ name: 'cliff_time', type: 'u64' }]);
    expect(result).toBe('VESTING');
  });

  it('detects TIMELOCK from delay parameter name', () => {
    const result = detectTimerTypeFromAbi([{ name: 'min_delay', type: 'u64' }]);
    expect(result).toBe('TIMELOCK');
  });

  it('detects DEADLINE from deadline parameter name', () => {
    const result = detectTimerTypeFromAbi([{ name: 'deadline', type: 'u64' }]);
    expect(result).toBe('DEADLINE');
  });

  it('returns null for non-temporal params', () => {
    const result = detectTimerTypeFromAbi([{ name: 'amount', type: 'i128' }, { name: 'recipient', type: 'address' }]);
    expect(result).toBeNull();
  });

  it('returns null for empty params', () => {
    expect(detectTimerTypeFromAbi([])).toBeNull();
  });
});
