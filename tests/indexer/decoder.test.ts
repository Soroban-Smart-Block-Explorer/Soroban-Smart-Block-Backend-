import { describe, it, expect } from 'vitest';
import { decodeEvent } from '../../src/indexer/decoder';
import { renderHuman, SEP41_ABI } from '../../src/indexer/registry';
import { xdr, Address, Keypair, nativeToScVal } from '@stellar/stellar-sdk';

function toBase64(val: xdr.ScVal): string {
  return val.toXDR('base64');
}
function addrXdr(addr: string): string {
  return new Address(addr).toScVal().toXDR('base64');
}

const ADDR_A = Keypair.random().publicKey();
const ADDR_B = Keypair.random().publicKey();
const ADDR_C = Keypair.random().publicKey();

describe('decodeEvent', () => {
  it('decodes a SEP-41 transfer event', () => {
    const topics = [
      toBase64(nativeToScVal('transfer', { type: 'symbol' })),
      addrXdr(ADDR_A),
      addrXdr(ADDR_B),
    ];
    const data = toBase64(nativeToScVal(1000n, { type: 'i128' }));

    const result = decodeEvent(topics, data);

    expect(result.eventType).toBe('transfer');
    expect(result.decoded.from).toBe(ADDR_A);
    expect(result.decoded.to).toBe(ADDR_B);
    expect(result.decoded.amount).toBe('0.0001000');
  });

  it('decodes a SEP-41 mint event', () => {
    const topics = [
      toBase64(nativeToScVal('mint', { type: 'symbol' })),
      addrXdr(ADDR_C), // admin
      addrXdr(ADDR_A), // to
    ];
    const data = toBase64(nativeToScVal(500n, { type: 'i128' }));

    const result = decodeEvent(topics, data);

    expect(result.eventType).toBe('mint');
    expect(result.decoded.to).toBe(ADDR_A);
    expect(result.decoded.amount).toBe('0.0000500');
  });

  it('falls back gracefully on unknown event type', () => {
    const topics = [toBase64(nativeToScVal('custom_event', { type: 'symbol' }))];
    const data = toBase64(nativeToScVal('some_data', { type: 'string' }));

    const result = decodeEvent(topics, data);

    expect(result.eventType).toBe('custom');
    expect(result.decoded).toHaveProperty('topics');
  });

  it('handles malformed XDR without throwing', () => {
    const result = decodeEvent(['not-valid-base64!!!'], 'also-bad');
    expect(result.eventType).toBe('unknown');
  });
});

describe('renderHuman', () => {
  it('renders a transfer template', () => {
    const args = { from: 'GABC...', to: 'GXYZ...', amount: 1000n };
    const result = renderHuman('transfer', args as Record<string, unknown>, SEP41_ABI, 'MyToken');
    expect(result).toContain('GABC...');
    expect(result).toContain('GXYZ...');
    expect(result).toContain('MyToken');
  });

  it('falls back when function not in ABI', () => {
    const result = renderHuman('unknown_fn', {}, SEP41_ABI, 'MyContract');
    expect(result).toContain('unknown_fn');
  });
});
