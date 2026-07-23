/**
 * Unit tests for the treasury service (issue #567, Phase 4).
 * Pure math over fixtures — stream vesting, flow analytics, runway,
 * reputation-weighted power blend.
 */
import { describe, it, expect } from 'vitest';
import {
  vestedAmount,
  claimableAmount,
  outstandingCommitment,
  bucketFlows,
  categoryBreakdown,
  runwayDays,
  blendReputationPower,
  isTreasuryAssetType,
  TREASURY_ASSET_TYPES,
  type StreamData,
  type FlowRow,
} from '../src/services/governance/treasury';

const DAY = 24 * 3600 * 1000;
const T0 = new Date('2026-07-01T00:00:00Z');

function stream(overrides: Partial<StreamData> = {}): StreamData {
  return {
    amountPerPeriod: '1000',
    periodSeconds: 7 * 24 * 3600, // weekly
    startAt: T0,
    endAt: null,
    claimed: '0',
    status: 'active',
    ...overrides,
  };
}

// ── Stream vesting ────────────────────────────────────────────────────────────

describe('payout stream vesting', () => {
  it('vests nothing before start and whole periods after', () => {
    expect(vestedAmount(stream(), new Date(T0.getTime() - DAY))).toBe(0n);
    // 6 days in: zero whole weeks elapsed.
    expect(vestedAmount(stream(), new Date(T0.getTime() + 6 * DAY))).toBe(0n);
    // Exactly 1 week: one period.
    expect(vestedAmount(stream(), new Date(T0.getTime() + 7 * DAY))).toBe(1_000n);
    // 3.5 weeks: three whole periods.
    expect(vestedAmount(stream(), new Date(T0.getTime() + 24.5 * DAY))).toBe(3_000n);
  });

  it('stops vesting at endAt', () => {
    const s = stream({ endAt: new Date(T0.getTime() + 14 * DAY) }); // 2 weeks
    expect(vestedAmount(s, new Date(T0.getTime() + 100 * DAY))).toBe(2_000n);
  });

  it('claimable = vested − claimed, floored at zero, only while active', () => {
    const s = stream({ claimed: '1500' });
    const at3Weeks = new Date(T0.getTime() + 21 * DAY);
    expect(claimableAmount(s, at3Weeks)).toBe(1_500n); // 3000 vested − 1500
    expect(claimableAmount(stream({ claimed: '5000' }), at3Weeks)).toBe(0n); // over-claimed guard
    expect(claimableAmount(stream({ status: 'paused' }), at3Weeks)).toBe(0n);
    expect(claimableAmount(stream({ status: 'cancelled' }), at3Weeks)).toBe(0n);
  });

  it('outstanding commitment = remaining periods for bounded streams', () => {
    const s = stream({ endAt: new Date(T0.getTime() + 70 * DAY) }); // 10 weeks total
    const at3Weeks = new Date(T0.getTime() + 21 * DAY);
    expect(outstandingCommitment(s, at3Weeks)).toBe(7_000n); // 10 − 3 weeks
    // Open-ended stream reports a year of forward commitments (52 weeks).
    expect(outstandingCommitment(stream(), at3Weeks)).toBe(52_000n);
    expect(outstandingCommitment(stream({ status: 'completed' }), at3Weeks)).toBe(0n);
  });
});

// ── Flow analytics ────────────────────────────────────────────────────────────

function flow(direction: string, amount: string, daysAgo: number, category?: string): FlowRow {
  return {
    direction,
    assetCode: 'XLM',
    amount,
    category,
    timestamp: new Date(NOW.getTime() - daysAgo * DAY),
  };
}
const NOW = new Date('2026-07-16T12:00:00Z');

describe('flow analytics', () => {
  it('buckets flows into UTC days with net totals, ignoring out-of-window rows', () => {
    const rows = [
      flow('inflow', '5000', 1),
      flow('outflow', '2000', 1),
      flow('outflow', '1000', 2),
      flow('inflow', '99999', 400), // outside window
    ];
    const buckets = bucketFlows(rows, 90, NOW);
    expect(buckets).toHaveLength(2);
    const day1 = buckets.find((b) => b.bucketStart === '2026-07-15');
    expect(day1).toEqual({
      bucketStart: '2026-07-15',
      inflow: '5000',
      outflow: '2000',
      net: '3000',
    });
    expect(buckets[0].bucketStart < buckets[1].bucketStart).toBe(true);
  });

  it('breaks down outflows by category, largest first', () => {
    const rows = [
      flow('outflow', '500', 1, 'ops'),
      flow('outflow', '3000', 2, 'grants'),
      flow('outflow', '700', 3, 'grants'),
      flow('outflow', '100', 4),
      flow('inflow', '9999', 1, 'grants'), // inflows never counted
    ];
    expect(categoryBreakdown(rows)).toEqual([
      { category: 'grants', outflow: '3700' },
      { category: 'ops', outflow: '500' },
      { category: 'uncategorized', outflow: '100' },
    ]);
  });

  it('computes runway from trailing net burn and returns null when growing', () => {
    // 90-day window: 9000 out, 0 in → 100/day burn; 10_000 liquid → 100 days.
    const burning = [flow('outflow', '9000', 10)];
    expect(
      runwayDays({ liquidBalance: 10_000n, rows: burning, windowDays: 90, now: NOW }),
    ).toBeCloseTo(100, 1);

    const growing = [flow('inflow', '9000', 10), flow('outflow', '100', 5)];
    expect(runwayDays({ liquidBalance: 10_000n, rows: growing, windowDays: 90, now: NOW })).toBe(
      null,
    );
  });
});

// ── Reputation blend ──────────────────────────────────────────────────────────

describe('blendReputationPower', () => {
  it('returns pure token power at weight 0 and clamps weight into [0,1]', () => {
    expect(
      blendReputationPower({
        tokenPower: 500n,
        reputationScore: 80,
        totalPower: 1_000n,
        weight: 0,
      }),
    ).toBe(500n);
    expect(
      blendReputationPower({
        tokenPower: 500n,
        reputationScore: 80,
        totalPower: 1_000n,
        weight: -3,
      }),
    ).toBe(500n);
  });

  it('blends linearly: 50/50 of token power and reputation share of total', () => {
    // token part: 500 × 0.5 = 250; reputation part: 1000 × 0.8 × 0.5 = 400.
    expect(
      blendReputationPower({
        tokenPower: 500n,
        reputationScore: 80,
        totalPower: 1_000n,
        weight: 0.5,
      }),
    ).toBe(650n);
  });

  it('full reputation weighting ignores token power entirely', () => {
    expect(
      blendReputationPower({
        tokenPower: 500n,
        reputationScore: 25,
        totalPower: 1_000n,
        weight: 1,
      }),
    ).toBe(250n);
  });

  it('clamps out-of-range reputation scores', () => {
    expect(
      blendReputationPower({
        tokenPower: 0n,
        reputationScore: 250,
        totalPower: 1_000n,
        weight: 1,
      }),
    ).toBe(1_000n);
  });
});

// ── Asset typing ──────────────────────────────────────────────────────────────

describe('treasury asset types', () => {
  it('supports the 5 required asset kinds', () => {
    expect(TREASURY_ASSET_TYPES).toHaveLength(5);
    for (const t of ['native', 'sep41', 'governance', 'lp', 'wrapped']) {
      expect(isTreasuryAssetType(t)).toBe(true);
    }
    expect(isTreasuryAssetType('nft')).toBe(false);
  });
});
