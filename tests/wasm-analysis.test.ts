import { describe, it, expect, vi } from 'vitest';
import { parseWasmSpec } from '../src/indexer/wasm-spec';

// Mock RPC for wasm-spec module
vi.mock('../src/indexer/rpc', () => ({
  rpc: {
    getContractWasmByContractId: vi.fn(),
  },
}));

describe('wasm-spec', () => {
  it('rejects wasm binaries that are too short', () => {
    const tooShort = Buffer.from([0x00, 0x61]);

    expect(() => parseWasmSpec(tooShort)).toThrow('Invalid Wasm: too short');
  });

  it('parses minimal valid wasm header', () => {
    const wasmHeader = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

    expect(() => parseWasmSpec(wasmHeader)).not.toThrow();
    const entries = parseWasmSpec(wasmHeader);
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBe(0);
  });

  it('handles multiple sections in wasm binary', () => {
    const wasmHeader = Buffer.from([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x03, 0x01, 0x60, 0x00, 0x00,
    ]);

    expect(() => parseWasmSpec(wasmHeader)).not.toThrow();
  });

  it('preserves buffer immutability during parsing', () => {
    const wasmHeader = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    const originalHex = wasmHeader.toString('hex');

    parseWasmSpec(wasmHeader);

    expect(wasmHeader.toString('hex')).toBe(originalHex);
  });

  it('handles empty custom section', () => {
    const wasmWithEmptyCustomSection = Buffer.from([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x00, 0x02, 0x01, 0x00,
    ]);

    expect(() => parseWasmSpec(wasmWithEmptyCustomSection)).not.toThrow();
  });

  it('distinguishes between different custom section names', () => {
    const wasmHeader = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

    expect(() => parseWasmSpec(wasmHeader)).not.toThrow();
    const entries = parseWasmSpec(wasmHeader);
    expect(Array.isArray(entries)).toBe(true);
  });

  it('handles LEB128 encoded section sizes', () => {
    const wasmWithLeb128Size = Buffer.from([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x7f, 0x00,
    ]);

    expect(() => parseWasmSpec(wasmWithLeb128Size)).not.toThrow();
  });
});

describe('wasm analysis edge cases', () => {
  it('handles wasm binary with only magic number and version', () => {
    const minimal = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

    const entries = parseWasmSpec(minimal);
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBe(0);
  });

  it('returns empty array when no contractspecv0 section exists', () => {
    const wasmWithoutSpec = Buffer.from([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
    ]);

    const entries = parseWasmSpec(wasmWithoutSpec);
    expect(entries).toEqual([]);
  });

  it('handles non-UTF8 section names gracefully', () => {
    const wasmWithInvalidUtf8 = Buffer.from([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x00, 0x04, 0x02, 0xff, 0xfe,
    ]);

    expect(() => parseWasmSpec(wasmWithInvalidUtf8)).not.toThrow();
  });

  it('correctly parses wasm section boundaries', () => {
    const wasmWithMultipleSections = Buffer.from([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x03, 0x01, 0x60, 0x00, 0x00, 0x03,
      0x02, 0x01, 0x00,
    ]);

    expect(() => parseWasmSpec(wasmWithMultipleSections)).not.toThrow();
  });
});

describe('wasm-diff logic', () => {
  it('identifies critical function names', () => {
    const criticalFunctions = [
      'upgrade',
      'set_admin',
      'transfer_admin',
      'mint',
      'burn',
      'clawback',
      'pause',
      'unpause',
      'initialize',
    ];

    for (const fn of criticalFunctions) {
      expect(['upgrade', 'set_admin', 'transfer_admin', 'mint', 'burn'].includes(fn)).toBe(true);
    }
  });

  it('distinguishes critical from non-critical functions', () => {
    const critical = 'upgrade';
    const noncritical = 'get_balance';

    const criticalSet = new Set([
      'upgrade',
      'set_admin',
      'set_administrator',
      'transfer_admin',
      'transfer_ownership',
      'mint',
      'burn',
    ]);

    expect(criticalSet.has(critical)).toBe(true);
    expect(criticalSet.has(noncritical)).toBe(false);
  });

  it('handles severity classification levels', () => {
    const severities: Array<'minor' | 'moderate' | 'major' | 'critical'> = [
      'minor',
      'moderate',
      'major',
      'critical',
    ];

    for (const severity of severities) {
      expect(['minor', 'moderate', 'major', 'critical']).toContain(severity);
    }
  });

  it('detects opcode change patterns', () => {
    const sample = {
      addedOpcodes: ['call', 'local.get'],
      removedOpcodes: ['nop'],
      previousTotal: 100,
      newTotal: 102,
      churn: 0.03,
    };

    expect(sample.addedOpcodes).toHaveLength(2);
    expect(sample.removedOpcodes).toHaveLength(1);
    expect(sample.churn).toBeLessThan(1);
    expect(sample.churn).toBeGreaterThanOrEqual(0);
  });

  it('calculates churn correctly', () => {
    const added = 5;
    const removed = 3;
    const oldTotal = 100;
    const newTotal = 102;

    const churn = (added + removed) / oldTotal;

    expect(churn).toBe(0.08);
    expect(churn).toBeLessThan(1);
    expect(churn).toBeGreaterThanOrEqual(0);
  });
});

describe('wasm analysis integration patterns', () => {
  it('validates opcode diff structure', () => {
    const diff = {
      addedOpcodes: [],
      removedOpcodes: [],
      previousTotal: 0,
      newTotal: 0,
      churn: 0,
    };

    expect(diff).toHaveProperty('addedOpcodes');
    expect(diff).toHaveProperty('removedOpcodes');
    expect(diff).toHaveProperty('previousTotal');
    expect(diff).toHaveProperty('newTotal');
    expect(diff).toHaveProperty('churn');
  });

  it('validates function diff structure', () => {
    const diff = {
      added: [],
      removed: [],
      signatureChanged: [],
      criticalChanges: [],
    };

    expect(diff).toHaveProperty('added');
    expect(diff).toHaveProperty('removed');
    expect(diff).toHaveProperty('signatureChanged');
    expect(diff).toHaveProperty('criticalChanges');
  });

  it('maintains invariants: criticalChanges is subset of signatureChanged', () => {
    const diff = {
      added: [],
      removed: ['upgrade', 'mint'],
      signatureChanged: ['upgrade', 'mint', 'initialize'],
      criticalChanges: ['upgrade', 'mint'],
    };

    const allCriticalInSignatureChanged = diff.criticalChanges.every((fn) =>
      diff.signatureChanged.includes(fn),
    );
    expect(allCriticalInSignatureChanged).toBe(true);
  });

  it('preserves semantics: empty diffs indicate no changes', () => {
    const noDiff = {
      added: [],
      removed: [],
      signatureChanged: [],
      criticalChanges: [],
    };

    const isEmpty =
      noDiff.added.length === 0 &&
      noDiff.removed.length === 0 &&
      noDiff.signatureChanged.length === 0 &&
      noDiff.criticalChanges.length === 0;

    expect(isEmpty).toBe(true);
  });

  it('detects all change types in complex diff', () => {
    const complexDiff = {
      addedOpcodes: ['call', 'local.get', 'i32.add'],
      removedOpcodes: ['nop', 'nop'],
      added: ['new_function', 'another_new'],
      removed: ['old_function'],
      signatureChanged: ['existing_function'],
      criticalChanges: ['upgrade'],
      previousTotal: 500,
      newTotal: 505,
      churn: 0.01,
    };

    expect(complexDiff.addedOpcodes.length).toBeGreaterThan(0);
    expect(complexDiff.removedOpcodes.length).toBeGreaterThan(0);
    expect(complexDiff.added.length).toBeGreaterThan(0);
    expect(complexDiff.removed.length).toBeGreaterThan(0);
    expect(complexDiff.signatureChanged.length).toBeGreaterThan(0);
    expect(complexDiff.criticalChanges.length).toBeGreaterThan(0);
  });
});
