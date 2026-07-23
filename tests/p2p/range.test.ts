import { describe, it, expect } from 'vitest';
import { rangeBoundsForLedger, rangeKey } from '../../src/p2p/range';

describe('rangeBoundsForLedger', () => {
  it('buckets a ledger sequence into its fixed-size range', () => {
    const bounds = rangeBoundsForLedger('testnet', 12345, 10_000);
    expect(bounds.startLedger).toBe(10_000);
    expect(bounds.endLedger).toBe(20_000);
    expect(bounds.rangeId).toBe('testnet:10000-20000');
  });

  it('places the exact boundary ledger in the range that starts there', () => {
    const bounds = rangeBoundsForLedger('testnet', 10_000, 10_000);
    expect(bounds.startLedger).toBe(10_000);
  });

  it('handles ledger 0', () => {
    const bounds = rangeBoundsForLedger('testnet', 0, 10_000);
    expect(bounds.startLedger).toBe(0);
    expect(bounds.endLedger).toBe(10_000);
  });

  it('throws on a non-positive rangeSize', () => {
    expect(() => rangeBoundsForLedger('testnet', 100, 0)).toThrow();
    expect(() => rangeBoundsForLedger('testnet', 100, -5)).toThrow();
  });

  it('rangeKey matches the rangeId produced by rangeBoundsForLedger', () => {
    const bounds = rangeBoundsForLedger('mainnet', 55555, 10_000);
    expect(rangeKey('mainnet', bounds.startLedger, bounds.endLedger)).toBe(bounds.rangeId);
  });
});
