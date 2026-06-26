import { describe, it, expect } from 'vitest';
import { xdr, nativeToScVal, Address, Keypair } from '@stellar/stellar-sdk';
import { decodeScVal, decodeTypedArgs, formatAmount } from '../../src/indexer/args-decoder';
import type { AbiParam } from '../../src/indexer/registry';

// Stable valid Stellar address for tests
const VALID_ADDR = Keypair.random().publicKey();

// ── formatAmount ─────────────────────────────────────────────────────────────

describe('formatAmount', () => {
  it('formats with 7 decimals (Stellar default)', () => {
    expect(formatAmount(100_000_000n)).toBe('10.0000000');
    expect(formatAmount(1n)).toBe('0.0000001');
    expect(formatAmount(0n)).toBe('0.0000000');
  });

  it('formats with custom decimals', () => {
    expect(formatAmount(1_000_000n, 6)).toBe('1.000000');
    expect(formatAmount(1n, 2)).toBe('0.01');
  });

  it('returns plain string when decimals=0', () => {
    expect(formatAmount(42n, 0)).toBe('42');
  });
});

// ── decodeScVal ───────────────────────────────────────────────────────────────

describe('decodeScVal — integers', () => {
  it('decodes i128 with decimals', () => {
    const val = nativeToScVal(100_000_000n, { type: 'i128' });
    const result = decodeScVal(val, { name: 'amount', type: 'i128' }, 7);
    expect(result.raw).toBe(100_000_000n);
    expect(result.formatted).toBe('10.0000000');
  });

  it('decodes u128 without decimals', () => {
    const val = nativeToScVal(999n, { type: 'u128' });
    const result = decodeScVal(val, { name: 'amount', type: 'u128' });
    expect(result.formatted).toBe('0.0000999'); // default 7 decimals
  });

  it('decodes u32', () => {
    const val = nativeToScVal(42, { type: 'u32' });
    const result = decodeScVal(val, { name: 'ledger', type: 'u32' });
    expect(result.raw).toBe(42);
    expect(result.formatted).toBe('42');
  });

  it('decodes i64', () => {
    const val = nativeToScVal(BigInt(-9999), { type: 'i64' });
    const result = decodeScVal(val, { name: 'ts', type: 'i64' });
    expect(result.raw).toBe(-9999n);
    expect(result.formatted).toBe('-9999');
  });
});

describe('decodeScVal — address', () => {
  it('decodes a Stellar address', () => {
    const val = new Address(VALID_ADDR).toScVal();
    const result = decodeScVal(val, { name: 'from', type: 'address' });
    expect(result.raw).toBe(VALID_ADDR);
    expect(result.formatted).toBe(VALID_ADDR);
  });
});

describe('decodeScVal — bool', () => {
  it('decodes true/false', () => {
    expect(decodeScVal(nativeToScVal(true), { name: 'flag', type: 'bool' }).formatted).toBe('true');
    expect(decodeScVal(nativeToScVal(false), { name: 'flag', type: 'bool' }).formatted).toBe(
      'false',
    );
  });
});

describe('decodeScVal — string & symbol', () => {
  it('decodes string', () => {
    const val = nativeToScVal('hello', { type: 'string' });
    const result = decodeScVal(val, { name: 'msg', type: 'string' });
    expect(result.formatted).toBe('hello');
  });

  it('decodes symbol', () => {
    const val = nativeToScVal('swap', { type: 'symbol' });
    const result = decodeScVal(val, { name: 'action', type: 'symbol' });
    expect(result.formatted).toBe('swap');
  });
});

describe('decodeScVal — bytes', () => {
  it('decodes bytes as hex', () => {
    const val = nativeToScVal(Buffer.from('deadbeef', 'hex'), { type: 'bytes' });
    const result = decodeScVal(val, { name: 'hash', type: 'bytes' });
    expect(result.formatted).toBe('0xdeadbeef');
  });
});

describe('decodeScVal — struct', () => {
  it('decodes a scvMap as struct', () => {
    // Build a proper scvMap with symbol keys (as Soroban structs are encoded)
    const val = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol('x'),
        val: nativeToScVal(1n, { type: 'i128' }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol('y'),
        val: nativeToScVal(2n, { type: 'i128' }),
      }),
    ]);
    const result = decodeScVal(val, { name: 'point', type: 'struct' });
    expect(result.raw).toMatchObject({ x: 1n, y: 2n });
  });
});

describe('decodeScVal — map', () => {
  it('decodes a generic map', () => {
    const val = nativeToScVal({ key1: 'val1', key2: 'val2' }, { type: 'map' });
    const result = decodeScVal(val, { name: 'data', type: 'map' });
    expect(result.raw).toMatchObject({ key1: 'val1', key2: 'val2' });
  });
});

describe('decodeScVal — vec', () => {
  it('decodes a vec', () => {
    // Build scvVec manually — nativeToScVal doesn't accept 'vec' as a type hint
    const val = xdr.ScVal.scvVec([
      nativeToScVal(1n, { type: 'i128' }),
      nativeToScVal(2n, { type: 'i128' }),
      nativeToScVal(3n, { type: 'i128' }),
    ]);
    const result = decodeScVal(val, { name: 'items', type: 'vec' });
    expect(result.formatted).toBe('[1, 2, 3]');
  });
});

describe('decodeScVal — option', () => {
  it('returns None for scvVoid', () => {
    const val = xdr.ScVal.scvVoid();
    const result = decodeScVal(val, { name: 'opt', type: 'option<u32>' });
    expect(result.raw).toBeNull();
    expect(result.formatted).toBe('None');
  });

  it('unwraps Some(u32)', () => {
    const val = nativeToScVal(7, { type: 'u32' });
    const result = decodeScVal(val, { name: 'opt', type: 'option<u32>' });
    expect(result.formatted).toBe('7');
  });
});

describe('decodeScVal — enum', () => {
  it('decodes a unit enum variant', () => {
    // Soroban unit enum: scvVec([scvSymbol("Active")])
    const inner = xdr.ScVal.scvSymbol('Active');
    const val = xdr.ScVal.scvVec([inner]);
    const result = decodeScVal(val, { name: 'status', type: 'enum' });
    expect((result.raw as { variant: string }).variant).toBe('Active');
  });

  it('decodes an enum variant with value', () => {
    const inner = xdr.ScVal.scvSymbol('Amount');
    const amount = nativeToScVal(500n, { type: 'i128' });
    const val = xdr.ScVal.scvVec([inner, amount]);
    const result = decodeScVal(val, { name: 'action', type: 'enum' });
    expect((result.raw as { variant: string; value: unknown }).variant).toBe('Amount');
  });
});

describe('decodeScVal — fallback on bad XDR', () => {
  it('returns base64 XDR on decode error', () => {
    // Pass a void val for an address type — Address.fromScVal will throw
    const val = xdr.ScVal.scvVoid();
    const result = decodeScVal(val, { name: 'addr', type: 'address' });
    expect(typeof result.formatted).toBe('string');
    expect(result.formatted.length).toBeGreaterThan(0);
  });
});

// ── decodeTypedArgs ───────────────────────────────────────────────────────────

describe('decodeTypedArgs', () => {
  it('pairs params with ScVals and returns DecodedArg map', () => {
    const params: AbiParam[] = [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'i128' },
    ];
    const addrScVal = new Address(VALID_ADDR).toScVal();
    const rawArgs = [addrScVal, addrScVal, nativeToScVal(10_000_000n, { type: 'i128' })];

    const result = decodeTypedArgs(params, rawArgs, 7);

    expect(result.from.formatted).toBe(VALID_ADDR);
    expect(result.to.formatted).toBe(VALID_ADDR);
    expect(result.amount.formatted).toBe('1.0000000');
  });

  it('skips missing args gracefully', () => {
    const params: AbiParam[] = [
      { name: 'a', type: 'u32' },
      { name: 'b', type: 'u32' },
    ];
    const result = decodeTypedArgs(params, [nativeToScVal(1, { type: 'u32' })]);
    expect(result.a.formatted).toBe('1');
    expect(result.b).toBeUndefined();
  });
});
