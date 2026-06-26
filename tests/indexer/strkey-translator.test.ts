/**
 * Tests for Issue #169 — Muxed & Contract Strkey Dynamic Translator (CAP-0079)
 */

import { describe, it, expect } from 'vitest';
import { Account, Keypair, MuxedAccount, StrKey } from '@stellar/stellar-sdk';
import {
  translateAddress,
  resolveRoutingIdentity,
  normalizeAddresses,
  isValidAnyAddress,
} from '../../src/indexer/strkey-translator';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const KEYPAIR = Keypair.random();
const G_ADDRESS = KEYPAIR.publicKey();

function buildMuxedAddress(gAddress: string, muxId: string): string {
  const account = new Account(gAddress, '0');
  const muxed = new MuxedAccount(account, muxId);
  return muxed.accountId();
}

const MUX_ID = '12345678';
const VALID_M_ADDRESS = buildMuxedAddress(G_ADDRESS, MUX_ID);

const FAKE_CONTRACT_ID = Buffer.alloc(32, 0xcd);
const C_ADDRESS = StrKey.encodeContract(FAKE_CONTRACT_ID);

// ── translateAddress ──────────────────────────────────────────────────────────

describe('translateAddress', () => {
  it('handles a G-address (Ed25519 public key)', () => {
    const result = translateAddress(G_ADDRESS);
    expect(result.kind).toBe('ed25519');
    expect(result.masterKey).toBe(G_ADDRESS);
    expect(result.muxId).toBeNull();
    expect(result.contractAddress).toBeNull();
    expect(result.original).toBe(G_ADDRESS);
  });

  it('handles a C-address (contract strkey)', () => {
    const result = translateAddress(C_ADDRESS);
    expect(result.kind).toBe('contract');
    expect(result.masterKey).toBeNull();
    expect(result.muxId).toBeNull();
    expect(result.contractAddress).toBe(C_ADDRESS);
  });

  it('handles an M-address (muxed account) and resolves master key', () => {
    const result = translateAddress(VALID_M_ADDRESS);
    expect(result.kind).toBe('muxed');
    expect(result.masterKey).toBe(G_ADDRESS);
    expect(result.muxId).toBe(MUX_ID);
    expect(result.contractAddress).toBeNull();
  });

  it('returns unknown for an invalid address', () => {
    const result = translateAddress('XNOTVALID');
    expect(result.kind).toBe('unknown');
    expect(result.masterKey).toBeNull();
    expect(result.muxId).toBeNull();
    expect(result.contractAddress).toBeNull();
  });

  it('returns unknown for an empty string', () => {
    const result = translateAddress('');
    expect(result.kind).toBe('unknown');
  });
});

// ── resolveRoutingIdentity ────────────────────────────────────────────────────

describe('resolveRoutingIdentity', () => {
  it('returns G-address unchanged', () => {
    expect(resolveRoutingIdentity(G_ADDRESS)).toBe(G_ADDRESS);
  });

  it('resolves M-address to underlying G-address', () => {
    expect(resolveRoutingIdentity(VALID_M_ADDRESS)).toBe(G_ADDRESS);
  });

  it('returns C-address unchanged (contracts route to themselves)', () => {
    expect(resolveRoutingIdentity(C_ADDRESS)).toBe(C_ADDRESS);
  });

  it('returns unknown address unchanged', () => {
    expect(resolveRoutingIdentity('GARBAGE')).toBe('GARBAGE');
  });
});

// ── normalizeAddresses ────────────────────────────────────────────────────────

describe('normalizeAddresses', () => {
  it('resolves a mixed list of addresses', () => {
    const input = [G_ADDRESS, VALID_M_ADDRESS, C_ADDRESS];
    const result = normalizeAddresses(input);
    expect(result[0]).toBe(G_ADDRESS);
    expect(result[1]).toBe(G_ADDRESS); // M resolved to G
    expect(result[2]).toBe(C_ADDRESS);
  });

  it('handles an empty array', () => {
    expect(normalizeAddresses([])).toEqual([]);
  });
});

// ── isValidAnyAddress ─────────────────────────────────────────────────────────

describe('isValidAnyAddress', () => {
  it('accepts G-addresses', () => {
    expect(isValidAnyAddress(G_ADDRESS)).toBe(true);
  });

  it('accepts M-addresses', () => {
    expect(isValidAnyAddress(VALID_M_ADDRESS)).toBe(true);
  });

  it('accepts C-addresses', () => {
    expect(isValidAnyAddress(C_ADDRESS)).toBe(true);
  });

  it('rejects invalid addresses', () => {
    expect(isValidAnyAddress('NOTANADDRESS')).toBe(false);
    expect(isValidAnyAddress('')).toBe(false);
  });
});
