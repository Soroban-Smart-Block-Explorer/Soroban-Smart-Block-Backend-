import { describe, it, expect } from 'vitest';
import { computeIndexHash, computeIndexHashFromRaw } from '../../src/p2p/index-hash';

describe('computeIndexHash', () => {
  it('is stable across repeated calls with the same input', () => {
    const input = {
      ledgerHash: 'abc123',
      txHashesSorted: ['tx1', 'tx2'],
      eventIdsSorted: ['ev1'],
      eventPayloadHashesSorted: ['p1'],
    };
    expect(computeIndexHash(input)).toBe(computeIndexHash(input));
  });

  it('changes when the ledger hash differs', () => {
    const base = {
      ledgerHash: 'abc123',
      txHashesSorted: [] as string[],
      eventIdsSorted: [] as string[],
      eventPayloadHashesSorted: [] as string[],
    };
    const other = { ...base, ledgerHash: 'def456' };
    expect(computeIndexHash(base)).not.toBe(computeIndexHash(other));
  });

  it('computeIndexHashFromRaw sorts inputs before hashing, so order does not matter', () => {
    const hashA = computeIndexHashFromRaw('L1', ['tx2', 'tx1'], ['ev2', 'ev1'], ['p2', 'p1']);
    const hashB = computeIndexHashFromRaw('L1', ['tx1', 'tx2'], ['ev1', 'ev2'], ['p1', 'p2']);
    expect(hashA).toBe(hashB);
  });

  it('detects a single differing element (simulates the malicious-node chaos test)', () => {
    const honest = computeIndexHashFromRaw('L1', ['tx1', 'tx2'], ['ev1'], ['p1']);
    const corrupted = computeIndexHashFromRaw('L1', ['tx1', 'tx2-corrupted'], ['ev1'], ['p1']);
    expect(honest).not.toBe(corrupted);
  });

  it('produces a 64-char hex sha256 digest', () => {
    const hash = computeIndexHashFromRaw('L1', [], [], []);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
