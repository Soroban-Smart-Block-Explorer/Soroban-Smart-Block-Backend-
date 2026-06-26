import { describe, it, expect } from 'vitest';
import { encodeScVal, decodeScVal, ScValValidationError } from '../src/playground/scval-codec';
import { Address, Keypair, StrKey } from '@stellar/stellar-sdk';

describe('encodeScVal', () => {
  it('encodes void', () => {
    const val = encodeScVal({ type: 'void' });
    expect(val.switch().name).toBe('scvVoid');
  });

  it('encodes bool true', () => {
    const val = encodeScVal({ type: 'bool', value: true });
    expect(val.switch().name).toBe('scvBool');
    expect(val.b()).toBe(true);
  });

  it('encodes bool false', () => {
    const val = encodeScVal({ type: 'bool', value: false });
    expect(val.b()).toBe(false);
  });

  it('encodes u32', () => {
    const val = encodeScVal({ type: 'u32', value: 42 });
    expect(val.switch().name).toBe('scvU32');
    expect(val.u32()).toBe(42);
  });

  it('throws on u32 out of range', () => {
    expect(() => encodeScVal({ type: 'u32', value: -1 })).toThrow(ScValValidationError);
    expect(() => encodeScVal({ type: 'u32', value: 0x100000000 })).toThrow(ScValValidationError);
  });

  it('encodes i32', () => {
    const val = encodeScVal({ type: 'i32', value: -100 });
    expect(val.switch().name).toBe('scvI32');
    expect(val.i32()).toBe(-100);
  });

  it('encodes u64 from string', () => {
    const val = encodeScVal({ type: 'u64', value: '1000000000000' });
    expect(val.switch().name).toBe('scvU64');
  });

  it('encodes i128', () => {
    const val = encodeScVal({ type: 'i128', value: '0' });
    expect(val.switch().name).toBe('scvI128');
  });

  it('encodes i128 negative', () => {
    const val = encodeScVal({ type: 'i128', value: '-1' });
    expect(val.switch().name).toBe('scvI128');
  });

  it('encodes string', () => {
    const val = encodeScVal({ type: 'string', value: 'hello' });
    expect(val.switch().name).toBe('scvString');
    expect(val.str().toString('utf8')).toBe('hello');
  });

  it('encodes symbol', () => {
    const val = encodeScVal({ type: 'symbol', value: 'transfer' });
    expect(val.switch().name).toBe('scvSymbol');
    expect(val.sym().toString()).toBe('transfer');
  });

  it('encodes address (G-prefix)', () => {
    const addr = Keypair.random().publicKey();
    const val = encodeScVal({ type: 'address', value: addr });
    expect(val.switch().name).toBe('scvAddress');
    expect(Address.fromScVal(val).toString()).toBe(addr);
  });

  it('encodes address (C-prefix contract)', () => {
    const raw = Buffer.alloc(32, 1);
    const addr = StrKey.encodeContract(raw);
    const val = encodeScVal({ type: 'address', value: addr });
    expect(val.switch().name).toBe('scvAddress');
    expect(Address.fromScVal(val).toString()).toBe(addr);
  });

  it('throws on invalid address prefix', () => {
    expect(() => encodeScVal({ type: 'address', value: 'INVALID123' })).toThrow(ScValValidationError);
  });

  it('encodes bytes from hex', () => {
    const val = encodeScVal({ type: 'bytes', value: '0xdeadbeef' });
    expect(val.switch().name).toBe('scvBytes');
    expect(val.bytes().toString('hex')).toBe('deadbeef');
  });

  it('throws on invalid hex bytes', () => {
    expect(() => encodeScVal({ type: 'bytes', value: 'zzzz' })).toThrow(ScValValidationError);
  });

  it('encodes vec', () => {
    const val = encodeScVal({ type: 'vec', items: [{ type: 'u32', value: 1 }, { type: 'u32', value: 2 }] });
    expect(val.switch().name).toBe('scvVec');
    expect(val.vec()?.length).toBe(2);
  });

  it('encodes map', () => {
    const val = encodeScVal({
      type: 'map',
      entries: [{ key: { type: 'symbol', value: 'key' }, value: { type: 'u32', value: 99 } }],
    });
    expect(val.switch().name).toBe('scvMap');
    expect(val.map()?.length).toBe(1);
  });

  it('encodes option with value', () => {
    const val = encodeScVal({ type: 'option', inner: { type: 'u32', value: 5 } });
    expect(val.switch().name).toBe('scvU32');
  });

  it('encodes option null as void', () => {
    const val = encodeScVal({ type: 'option', inner: null });
    expect(val.switch().name).toBe('scvVoid');
  });
});

describe('decodeScVal roundtrip', () => {
  it('roundtrips bool', () => {
    const encoded = encodeScVal({ type: 'bool', value: true });
    expect(decodeScVal(encoded)).toBe(true);
  });

  it('roundtrips u32', () => {
    const encoded = encodeScVal({ type: 'u32', value: 1234 });
    expect(decodeScVal(encoded)).toBe(1234);
  });

  it('roundtrips string', () => {
    const encoded = encodeScVal({ type: 'string', value: 'world' });
    expect(decodeScVal(encoded)).toBe('world');
  });

  it('roundtrips address', () => {
    const addr = Keypair.random().publicKey();
    const encoded = encodeScVal({ type: 'address', value: addr });
    expect(decodeScVal(encoded)).toBe(addr);
  });

  it('roundtrips bytes', () => {
    const encoded = encodeScVal({ type: 'bytes', value: 'deadbeef' });
    expect(decodeScVal(encoded)).toBe('0xdeadbeef');
  });
});
