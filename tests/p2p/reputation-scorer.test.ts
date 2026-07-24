import { describe, it, expect } from 'vitest';
import { blendReportedScore, computeReputationScore } from '../../src/p2p/reputation-scorer';

describe('computeReputationScore', () => {
  it('gives a perfect score to a peer with 100% pass rate, full uptime, and low latency', () => {
    const score = computeReputationScore({
      challengesPassed: 10,
      challengesFailed: 0,
      uptimeRatio: 1,
      latencyMsEwma: 10,
    });
    expect(score).toBeCloseTo(100, 0);
  });

  it('penalizes a peer that fails most challenges', () => {
    const good = computeReputationScore({
      challengesPassed: 9,
      challengesFailed: 1,
      uptimeRatio: 1,
      latencyMsEwma: 10,
    });
    const bad = computeReputationScore({
      challengesPassed: 1,
      challengesFailed: 9,
      uptimeRatio: 1,
      latencyMsEwma: 10,
    });
    expect(bad).toBeLessThan(good);
  });

  it('treats a peer with no challenge history as innocent-until-proven (passRate=1)', () => {
    const score = computeReputationScore({
      challengesPassed: 0,
      challengesFailed: 0,
      uptimeRatio: 1,
      latencyMsEwma: null,
    });
    // passRate contributes its full 0.5 weight; latency is neutral (0.5); uptime full.
    expect(score).toBeCloseTo(100 * (0.5 * 1 + 0.3 * 1 + 0.2 * 0.5), 5);
  });

  it('clamps uptimeRatio outside [0,1]', () => {
    const over = computeReputationScore({
      challengesPassed: 1,
      challengesFailed: 0,
      uptimeRatio: 5,
      latencyMsEwma: 10,
    });
    const capped = computeReputationScore({
      challengesPassed: 1,
      challengesFailed: 0,
      uptimeRatio: 1,
      latencyMsEwma: 10,
    });
    expect(over).toBeCloseTo(capped, 5);
  });

  it('stays within [0, 100] for extreme inputs', () => {
    const score = computeReputationScore({
      challengesPassed: 0,
      challengesFailed: 1000,
      uptimeRatio: -5,
      latencyMsEwma: 999_999,
    });
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });
});

describe('blendReportedScore', () => {
  it('a single gossiped report only nudges the local score slightly', () => {
    const blended = blendReportedScore(80, 0, 0.1);
    expect(blended).toBeCloseTo(72, 5);
  });

  it('weight=1 fully trusts the report; weight=0 ignores it', () => {
    expect(blendReportedScore(80, 20, 1)).toBeCloseTo(20, 5);
    expect(blendReportedScore(80, 20, 0)).toBeCloseTo(80, 5);
  });

  it('clamps weight outside [0,1]', () => {
    expect(blendReportedScore(80, 20, 5)).toBeCloseTo(20, 5);
    expect(blendReportedScore(80, 20, -5)).toBeCloseTo(80, 5);
  });
});
