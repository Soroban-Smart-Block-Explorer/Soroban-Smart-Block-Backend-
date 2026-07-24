/**
 * tests/regions/hlc.test.ts
 * Issue #556 — Hybrid Logical Clock ordering guarantees.
 */
import { describe, it, expect } from 'vitest';
import { HybridLogicalClock, compareHlc, encodeHlc, decodeHlc } from '../../src/regions/hlc';

describe('HybridLogicalClock', () => {
  it('produces monotonically increasing timestamps for local ticks', () => {
    let t = 1000;
    const clock = new HybridLogicalClock('us-east', () => t);
    const a = clock.tick();
    const b = clock.tick(); // physical clock hasn't advanced -> logical bumps
    expect(compareHlc(b, a)).toBeGreaterThan(0);

    t += 10;
    const c = clock.tick();
    expect(compareHlc(c, b)).toBeGreaterThan(0);
    expect(c.logical).toBe(0);
  });

  it('receive() advances local clock past a remote timestamp from the future', () => {
    const local = new HybridLogicalClock('eu-west', () => 1000);
    const remote = { physical: 5000, logical: 3, nodeId: 'us-east' };
    const merged = local.receive(remote);
    expect(compareHlc(merged, remote)).toBeGreaterThan(0);
    expect(merged.physical).toBe(5000);
    expect(merged.logical).toBe(4);
  });

  it('receive() still advances logically when local physical time is ahead', () => {
    const local = new HybridLogicalClock('eu-west', () => 9000);
    const remote = { physical: 1000, logical: 0, nodeId: 'us-east' };
    const merged = local.receive(remote);
    expect(merged.physical).toBe(9000);
    expect(compareHlc(merged, remote)).toBeGreaterThan(0);
  });

  it('round-trips through encode/decode', () => {
    const ts = { physical: 1737, logical: 4, nodeId: 'ap-southeast' };
    expect(decodeHlc(encodeHlc(ts))).toEqual(ts);
  });

  it('lexicographic string order matches HLC order', () => {
    const clock = new HybridLogicalClock('sa-east', () => 100);
    const a = encodeHlc(clock.tick());
    const b = encodeHlc(clock.tick());
    expect(a < b).toBe(true);
  });
});
