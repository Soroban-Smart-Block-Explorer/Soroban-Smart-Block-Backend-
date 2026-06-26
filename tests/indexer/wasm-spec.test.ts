import { describe, it, expect, vi } from 'vitest';
import { parseWasmSpec, fetchContractSpec } from '../../src/indexer/wasm-spec';
import { contract } from '@stellar/stellar-sdk';

// Minimal Wasm binary containing a single `contractspecv0` custom section.
// The section encodes one ScSpecEntry: function hello(name: string) -> symbol
const TEST_WASM_BASE64 =
  'AGFzbQEAAAAAPw5jb250cmFjdHNwZWN2MAAAAAAAAAAAAAAABWhlbGxvAAAAAAAAAQAAAAAAAAAEbmFtZQAAABAAAAABAAAAEQ==';

describe('parseWasmSpec', () => {
  it('extracts ScSpecEntry values from a contractspecv0 custom section', () => {
    const wasm = Buffer.from(TEST_WASM_BASE64, 'base64');
    const entries = parseWasmSpec(wasm);

    expect(entries).toHaveLength(1);
    expect(entries[0].switch().name).toBe('scSpecEntryFunctionV0');

    const fn = entries[0].functionV0();
    expect(fn.name().toString()).toBe('hello');
    expect(fn.inputs()).toHaveLength(1);
    expect(fn.inputs()[0].name().toString()).toBe('name');
  });

  it('returns empty array when no contractspecv0 section exists', () => {
    // Minimal valid Wasm with no custom sections: magic + version only
    const wasm = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    const entries = parseWasmSpec(wasm);
    expect(entries).toHaveLength(0);
  });

  it('throws on invalid Wasm (too short)', () => {
    expect(() => parseWasmSpec(Buffer.from([0x00, 0x61]))).toThrow('Invalid Wasm');
  });

  it('produces a valid JSON schema via contract.Spec', () => {
    const wasm = Buffer.from(TEST_WASM_BASE64, 'base64');
    const entries = parseWasmSpec(wasm);
    const spec = new contract.Spec(entries);
    const schema = spec.jsonSchema();

    expect(schema).toHaveProperty('$schema');
    expect(schema).toHaveProperty('definitions');
  });
});

describe('fetchContractSpec', () => {
  it('returns null when RPC throws', async () => {
    vi.mock('../../src/indexer/rpc', () => ({
      rpc: { getContractWasmByContractId: vi.fn().mockRejectedValue(new Error('not found')) },
    }));

    const result = await fetchContractSpec(
      'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
    );
    expect(result).toBeNull();
  });
});
