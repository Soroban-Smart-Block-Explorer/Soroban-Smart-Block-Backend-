/**
 * Tests for the SEP-41 token standard parser.
 *
 * Covers:
 *  - isSep41Function / isSep41Event guards
 *  - parseSep41Call for every standard function
 *  - parseSep41Event for every standard event
 *  - renderSep41Template (truncation, {token} placeholder)
 *  - getSep41Abi shape
 *  - Edge cases: unknown names, missing args, malformed XDR
 */

import { describe, it, expect } from 'vitest';
import { xdr, nativeToScVal, Address, Keypair } from '@stellar/stellar-sdk';
import {
  isSep41Function,
  isSep41Event,
  parseSep41Call,
  parseSep41Event,
  renderSep41Template,
  getSep41Abi,
  SEP41_FUNCTIONS,
  SEP41_EVENTS,
} from '../src/indexer/sep41-parser';
import { decodeEvent } from '../src/indexer/decoder';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ADDR_A = Keypair.random().publicKey();
const ADDR_B = Keypair.random().publicKey();
const ADDR_C = Keypair.random().publicKey();

/** Encode a Stellar address as a base64 XDR ScVal. */
function addrXdr(addr: string): string {
  return new Address(addr).toScVal().toXDR('base64');
}

/** Encode a symbol as a base64 XDR ScVal. */
function symXdr(sym: string): string {
  return xdr.ScVal.scvSymbol(sym).toXDR('base64');
}

/** Encode an i128 bigint as a base64 XDR ScVal. */
function i128Xdr(val: bigint): string {
  return nativeToScVal(val, { type: 'i128' }).toXDR('base64');
}

/** Encode a u32 number as a base64 XDR ScVal. */
function u32Xdr(val: number): string {
  return nativeToScVal(val, { type: 'u32' }).toXDR('base64');
}

// ─── isSep41Function ──────────────────────────────────────────────────────────

describe('isSep41Function', () => {
  it('returns true for all standard SEP-41 functions', () => {
    const expected = [
      'transfer', 'transfer_from', 'approve', 'balance_of', 'allowance',
      'decimals', 'name', 'symbol', 'mint', 'burn', 'burn_from',
      'clawback', 'set_admin', 'admin',
    ];
    for (const fn of expected) {
      expect(isSep41Function(fn), `expected ${fn} to be SEP-41`).toBe(true);
    }
  });

  it('returns false for non-SEP-41 names', () => {
    expect(isSep41Function('swap')).toBe(false);
    expect(isSep41Function('deposit')).toBe(false);
    expect(isSep41Function('')).toBe(false);
    expect(isSep41Function('TRANSFER')).toBe(false); // case-sensitive
  });
});

// ─── isSep41Event ─────────────────────────────────────────────────────────────

describe('isSep41Event', () => {
  it('returns true for all standard SEP-41 events', () => {
    for (const sym of ['transfer', 'mint', 'burn', 'approve', 'clawback', 'set_admin']) {
      expect(isSep41Event(sym), `expected ${sym} to be SEP-41 event`).toBe(true);
    }
  });

  it('returns false for unknown symbols', () => {
    expect(isSep41Event('swap')).toBe(false);
    expect(isSep41Event('Transfer')).toBe(false);
    expect(isSep41Event('')).toBe(false);
  });
});

// ─── parseSep41Call ───────────────────────────────────────────────────────────

describe('parseSep41Call — transfer', () => {
  it('decodes args and renders human-readable string', () => {
    const rawArgs = [
      new Address(ADDR_A).toScVal(),
      new Address(ADDR_B).toScVal(),
      nativeToScVal(10_000_000n, { type: 'i128' }),
    ];
    const result = parseSep41Call('transfer', rawArgs, 7, 'USDC');
    expect(result).not.toBeNull();
    expect(result!.functionName).toBe('transfer');
    expect(result!.args.from.formatted).toBe(ADDR_A);
    expect(result!.args.to.formatted).toBe(ADDR_B);
    expect(result!.args.amount.formatted).toBe('1.0000000');
    expect(result!.humanReadable).toContain('USDC');
    expect(result!.humanReadable).toContain('1.0000000');
  });
});

describe('parseSep41Call — transfer_from', () => {
  it('decodes spender, from, to, amount', () => {
    const rawArgs = [
      new Address(ADDR_C).toScVal(),
      new Address(ADDR_A).toScVal(),
      new Address(ADDR_B).toScVal(),
      nativeToScVal(5_000_000n, { type: 'i128' }),
    ];
    const result = parseSep41Call('transfer_from', rawArgs, 7, 'XLM');
    expect(result).not.toBeNull();
    expect(result!.args.spender.formatted).toBe(ADDR_C);
    expect(result!.args.from.formatted).toBe(ADDR_A);
    expect(result!.args.to.formatted).toBe(ADDR_B);
    expect(result!.args.amount.formatted).toBe('0.5000000');
    expect(result!.humanReadable).toContain('XLM');
  });
});

describe('parseSep41Call — approve', () => {
  it('decodes from, spender, amount, expiration_ledger', () => {
    const rawArgs = [
      new Address(ADDR_A).toScVal(),
      new Address(ADDR_B).toScVal(),
      nativeToScVal(100_000_000n, { type: 'i128' }),
      nativeToScVal(5000000, { type: 'u32' }),
    ];
    const result = parseSep41Call('approve', rawArgs, 7, 'USDC');
    expect(result).not.toBeNull();
    expect(result!.args.expiration_ledger.formatted).toBe('5000000');
    expect(result!.humanReadable).toContain('5000000');
    expect(result!.humanReadable).toContain('USDC');
  });
});

describe('parseSep41Call — balance_of', () => {
  it('decodes the id address', () => {
    const rawArgs = [new Address(ADDR_A).toScVal()];
    const result = parseSep41Call('balance_of', rawArgs);
    expect(result).not.toBeNull();
    expect(result!.args.id.formatted).toBe(ADDR_A);
    expect(result!.humanReadable).toContain('Balance query');
  });
});

describe('parseSep41Call — allowance', () => {
  it('decodes from and spender', () => {
    const rawArgs = [
      new Address(ADDR_A).toScVal(),
      new Address(ADDR_B).toScVal(),
    ];
    const result = parseSep41Call('allowance', rawArgs);
    expect(result).not.toBeNull();
    expect(result!.args.from.formatted).toBe(ADDR_A);
    expect(result!.args.spender.formatted).toBe(ADDR_B);
  });
});

describe('parseSep41Call — no-arg functions', () => {
  it.each(['decimals', 'name', 'symbol', 'admin'])('handles %s with no args', (fn) => {
    const result = parseSep41Call(fn, []);
    expect(result).not.toBeNull();
    expect(result!.functionName).toBe(fn);
    expect(result!.args).toEqual({});
  });
});

describe('parseSep41Call — mint', () => {
  it('decodes to and amount', () => {
    const rawArgs = [
      new Address(ADDR_A).toScVal(),
      nativeToScVal(1_000_000_000n, { type: 'i128' }),
    ];
    const result = parseSep41Call('mint', rawArgs, 7, 'TOKEN');
    expect(result).not.toBeNull();
    expect(result!.args.to.formatted).toBe(ADDR_A);
    expect(result!.args.amount.formatted).toBe('100.0000000');
    expect(result!.humanReadable).toContain('Minted');
    expect(result!.humanReadable).toContain('TOKEN');
  });
});

describe('parseSep41Call — burn', () => {
  it('decodes from and amount', () => {
    const rawArgs = [
      new Address(ADDR_A).toScVal(),
      nativeToScVal(7_000_000n, { type: 'i128' }),
    ];
    const result = parseSep41Call('burn', rawArgs, 7, 'USDC');
    expect(result).not.toBeNull();
    expect(result!.args.from.formatted).toBe(ADDR_A);
    expect(result!.humanReadable).toContain('burned');
  });
});

describe('parseSep41Call — burn_from', () => {
  it('decodes spender, from, amount', () => {
    const rawArgs = [
      new Address(ADDR_C).toScVal(),
      new Address(ADDR_A).toScVal(),
      nativeToScVal(3_000_000n, { type: 'i128' }),
    ];
    const result = parseSep41Call('burn_from', rawArgs, 7, 'USDC');
    expect(result).not.toBeNull();
    expect(result!.args.spender.formatted).toBe(ADDR_C);
    expect(result!.args.from.formatted).toBe(ADDR_A);
  });
});

describe('parseSep41Call — clawback', () => {
  it('decodes from and amount', () => {
    const rawArgs = [
      new Address(ADDR_A).toScVal(),
      nativeToScVal(2_000_000n, { type: 'i128' }),
    ];
    const result = parseSep41Call('clawback', rawArgs, 7, 'USDC');
    expect(result).not.toBeNull();
    expect(result!.humanReadable).toContain('clawed back');
  });
});

describe('parseSep41Call — set_admin', () => {
  it('decodes new_admin', () => {
    const rawArgs = [new Address(ADDR_B).toScVal()];
    const result = parseSep41Call('set_admin', rawArgs);
    expect(result).not.toBeNull();
    expect(result!.args.new_admin.formatted).toBe(ADDR_B);
    expect(result!.humanReadable).toContain('Admin changed');
  });
});

describe('parseSep41Call — unknown function', () => {
  it('returns null for non-SEP-41 function names', () => {
    expect(parseSep41Call('swap', [])).toBeNull();
    expect(parseSep41Call('', [])).toBeNull();
  });
});

describe('parseSep41Call — missing args', () => {
  it('skips missing args gracefully without throwing', () => {
    // transfer expects 3 args; pass only 1
    const rawArgs = [new Address(ADDR_A).toScVal()];
    const result = parseSep41Call('transfer', rawArgs, 7, 'USDC');
    expect(result).not.toBeNull();
    expect(result!.args.from.formatted).toBe(ADDR_A);
    expect(result!.args.to).toBeUndefined();
    expect(result!.args.amount).toBeUndefined();
  });
});

// ─── parseSep41Event ──────────────────────────────────────────────────────────

describe('parseSep41Event — transfer', () => {
  it('decodes from, to, amount from topics and data', () => {
    const topics = [symXdr('transfer'), addrXdr(ADDR_A), addrXdr(ADDR_B)];
    const data = i128Xdr(50_000_000n);
    const result = parseSep41Event(topics, data, 7, 'USDC');
    expect(result).not.toBeNull();
    expect(result!.symbol).toBe('transfer');
    expect(result!.fields.from.formatted).toBe(ADDR_A);
    expect(result!.fields.to.formatted).toBe(ADDR_B);
    expect(result!.fields.amount.formatted).toBe('5.0000000');
    expect(result!.humanReadable).toContain('USDC');
    expect(result!.humanReadable).toContain('5.0000000');
  });
});

describe('parseSep41Event — mint', () => {
  it('decodes admin, to, amount', () => {
    const topics = [symXdr('mint'), addrXdr(ADDR_C), addrXdr(ADDR_A)];
    const data = i128Xdr(100_000_000n);
    const result = parseSep41Event(topics, data, 7, 'TOKEN');
    expect(result).not.toBeNull();
    expect(result!.fields.admin.formatted).toBe(ADDR_C);
    expect(result!.fields.to.formatted).toBe(ADDR_A);
    expect(result!.fields.amount.formatted).toBe('10.0000000');
    expect(result!.humanReadable).toContain('Minted');
  });
});

describe('parseSep41Event — burn', () => {
  it('decodes from and amount', () => {
    const topics = [symXdr('burn'), addrXdr(ADDR_A)];
    const data = i128Xdr(20_000_000n);
    const result = parseSep41Event(topics, data, 7, 'USDC');
    expect(result).not.toBeNull();
    expect(result!.fields.from.formatted).toBe(ADDR_A);
    expect(result!.fields.amount.formatted).toBe('2.0000000');
    expect(result!.humanReadable).toContain('burned');
  });
});

describe('parseSep41Event — approve', () => {
  it('decodes from, spender, amount', () => {
    const topics = [symXdr('approve'), addrXdr(ADDR_A), addrXdr(ADDR_B)];
    const data = i128Xdr(500_000_000n);
    const result = parseSep41Event(topics, data, 7, 'USDC');
    expect(result).not.toBeNull();
    expect(result!.fields.from.formatted).toBe(ADDR_A);
    expect(result!.fields.spender.formatted).toBe(ADDR_B);
    expect(result!.fields.amount.formatted).toBe('50.0000000');
    expect(result!.humanReadable).toContain('approved');
  });
});

describe('parseSep41Event — clawback', () => {
  it('decodes admin, from, amount', () => {
    const topics = [symXdr('clawback'), addrXdr(ADDR_C), addrXdr(ADDR_A)];
    const data = i128Xdr(15_000_000n);
    const result = parseSep41Event(topics, data, 7, 'USDC');
    expect(result).not.toBeNull();
    expect(result!.fields.admin.formatted).toBe(ADDR_C);
    expect(result!.fields.from.formatted).toBe(ADDR_A);
    expect(result!.humanReadable).toContain('clawed back');
  });
});

describe('parseSep41Event — set_admin', () => {
  it('decodes new_admin from topics', () => {
    const topics = [symXdr('set_admin'), addrXdr(ADDR_B)];
    const data = addrXdr(ADDR_B); // data mirrors the new admin per SEP-41 spec
    const result = parseSep41Event(topics, data);
    expect(result).not.toBeNull();
    expect(result!.fields.new_admin.formatted).toBe(ADDR_B);
    expect(result!.humanReadable).toContain('admin changed');
  });
});

describe('parseSep41Event — unknown symbol', () => {
  it('returns null for non-SEP-41 event symbols', () => {
    const topics = [symXdr('swap'), addrXdr(ADDR_A)];
    const data = i128Xdr(1n);
    expect(parseSep41Event(topics, data)).toBeNull();
  });
});

describe('parseSep41Event — empty topics', () => {
  it('returns null when topics array is empty', () => {
    expect(parseSep41Event([], i128Xdr(1n))).toBeNull();
  });
});

describe('parseSep41Event — malformed XDR', () => {
  it('returns null when the symbol topic is not valid XDR', () => {
    expect(parseSep41Event(['not-valid-xdr'], i128Xdr(1n))).toBeNull();
  });

  it('falls back to raw XDR string when a topic arg is malformed', () => {
    // Valid symbol, but second topic is garbage
    const topics = [symXdr('transfer'), 'bad-xdr', addrXdr(ADDR_B)];
    const data = i128Xdr(1n);
    const result = parseSep41Event(topics, data, 7, 'USDC');
    // Should still return a result — from field falls back to raw string
    expect(result).not.toBeNull();
    expect(result!.fields.from.formatted).toBe('bad-xdr');
  });
});

// ─── renderSep41Template ──────────────────────────────────────────────────────

describe('renderSep41Template', () => {
  it('substitutes {key} placeholders', () => {
    const args = {
      from: { raw: ADDR_A, formatted: ADDR_A },
      amount: { raw: 10n, formatted: '1.0000000' },
    };
    const out = renderSep41Template('{from} sent {amount}', args);
    expect(out).toBe(`${ADDR_A} sent 1.0000000`);
  });

  it('truncates addresses with {key|truncate}', () => {
    const addr = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
    const args = { from: { raw: addr, formatted: addr } };
    const out = renderSep41Template('{from|truncate}', args);
    expect(out).toBe(`${addr.slice(0, 6)}…${addr.slice(-4)}`);
  });

  it('does not truncate short values', () => {
    const args = { from: { raw: 'short', formatted: 'short' } };
    const out = renderSep41Template('{from|truncate}', args);
    expect(out).toBe('short');
  });

  it('replaces {token} with tokenSymbol', () => {
    const args = { amount: { raw: 1n, formatted: '1.0000000' } };
    const out = renderSep41Template('{amount} {token}', args, 7, 'USDC');
    expect(out).toBe('1.0000000 USDC');
  });

  it('replaces {token} with empty string when no symbol provided', () => {
    const args = { amount: { raw: 1n, formatted: '1.0000000' } };
    const out = renderSep41Template('{amount} {token}', args);
    expect(out).toBe('1.0000000 ');
  });

  it('returns empty string for missing keys', () => {
    const out = renderSep41Template('{missing}', {});
    expect(out).toBe('');
  });
});

// ─── getSep41Abi ──────────────────────────────────────────────────────────────

describe('getSep41Abi', () => {
  it('returns an object with a functions array', () => {
    const abi = getSep41Abi();
    expect(Array.isArray(abi.functions)).toBe(true);
    expect(abi.functions.length).toBeGreaterThan(0);
  });

  it('includes all 14 standard SEP-41 functions', () => {
    const abi = getSep41Abi();
    const names = abi.functions.map((f) => f.name);
    const expected = [
      'transfer', 'transfer_from', 'approve', 'balance_of', 'allowance',
      'decimals', 'name', 'symbol', 'mint', 'burn', 'burn_from',
      'clawback', 'set_admin', 'admin',
    ];
    for (const fn of expected) {
      expect(names, `expected ${fn} in ABI`).toContain(fn);
    }
  });

  it('every function has name, inputs array, and humanTemplate', () => {
    const abi = getSep41Abi();
    for (const fn of abi.functions) {
      expect(typeof fn.name).toBe('string');
      expect(Array.isArray(fn.inputs)).toBe(true);
      expect(typeof fn.humanTemplate).toBe('string');
    }
  });

  it('transfer function has correct input types', () => {
    const abi = getSep41Abi();
    const transfer = abi.functions.find((f) => f.name === 'transfer')!;
    expect(transfer.inputs).toEqual([
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'i128' },
    ]);
  });
});

describe('SEP-41 event compatibility fallbacks', () => {
  it('decodes transfer events from string-typed topics', () => {
    const from = 'GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDE';
    const to = 'GXYZ1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDE';
    const topics = [
      xdr.ScVal.scvSymbol('transfer').toXDR('base64'),
      nativeToScVal(from, { type: 'string' }).toXDR('base64'),
      nativeToScVal(to, { type: 'string' }).toXDR('base64'),
    ];
    const data = nativeToScVal(1000n, { type: 'i128' }).toXDR('base64');

    const result = decodeEvent(topics, data);

    expect(result.eventType).toBe('transfer');
    expect(result.decoded.from).toBe(from);
    expect(result.decoded.to).toBe(to);
    expect(result.decoded.amount).toBe('0.0001000');
  });

  it('decodes mint events with a single recipient topic', () => {
    const to = 'GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDE';
    const topics = [
      xdr.ScVal.scvSymbol('mint').toXDR('base64'),
      nativeToScVal(to, { type: 'string' }).toXDR('base64'),
    ];
    const data = nativeToScVal(500n, { type: 'i128' }).toXDR('base64');

    const result = decodeEvent(topics, data);

    expect(result.eventType).toBe('mint');
    expect(result.decoded.to).toBe(to);
    expect(result.decoded.amount).toBe('0.0000500');
  });
});

// ─── SEP41_FUNCTIONS / SEP41_EVENTS completeness ─────────────────────────────

describe('SEP41_FUNCTIONS completeness', () => {
  it('every entry has name, inputs, and humanTemplate', () => {
    for (const [key, def] of Object.entries(SEP41_FUNCTIONS)) {
      expect(def.name).toBe(key);
      expect(Array.isArray(def.inputs)).toBe(true);
      expect(typeof def.humanTemplate).toBe('string');
      expect(def.humanTemplate.length).toBeGreaterThan(0);
    }
  });
});

describe('SEP41_EVENTS completeness', () => {
  it('every entry has symbol, topicParams, dataParam, and humanTemplate', () => {
    for (const [key, def] of Object.entries(SEP41_EVENTS)) {
      expect(def.symbol).toBe(key);
      expect(Array.isArray(def.topicParams)).toBe(true);
      expect(def.dataParam).toBeDefined();
      expect(typeof def.humanTemplate).toBe('string');
      expect(def.humanTemplate.length).toBeGreaterThan(0);
    }
  });
});
