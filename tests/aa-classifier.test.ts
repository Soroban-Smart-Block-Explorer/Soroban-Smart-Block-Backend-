/**
 * Tests for Account Abstraction classifier and AA indexer logic.
 */

import { describe, it, expect } from 'vitest';
import {
  isContractAddress,
  classifyWallet,
  extractSponsorInfo,
  extractWasmAaIndicators,
  buildAuthDecomposition,
  renderAuthTree,
  refineBehaviorClassification,
  extractSessionKeysFromAuth,
} from '../src/indexer/aa-classifier';
import type { ParsedAuth } from '../src/indexer/xdr-parser';

// ── helpers ───────────────────────────────────────────────────────────────────

const G_ACCOUNT = 'GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEF';
// A valid-length C-address for testing (32 bytes of contract ID → base32 encode)
// We use a real StrKey-encoded contract address format check by mocking the SDK.
// For unit tests without real XDR we just use the string shape.
const C_ACCOUNT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

const noAuth: ParsedAuth[] = [];

const multiSigAuth: ParsedAuth[] = [
  { type: 'account', address: 'GAAA', nonce: '1', subInvocations: [] },
  { type: 'account', address: 'GBBB', nonce: '2', subInvocations: [] },
  { type: 'account', address: 'GCCC', nonce: '3', subInvocations: [] },
];

const contractAuth: ParsedAuth[] = [
  { type: 'contract', address: C_ACCOUNT, nonce: null, subInvocations: [] },
];

const subCallAuth: ParsedAuth[] = [
  {
    type: 'contract',
    address: C_ACCOUNT,
    nonce: null,
    subInvocations: [{ contractId: 'CBBBB', functionName: '__check_auth', args: [] }],
  },
];

// ── isContractAddress ─────────────────────────────────────────────────────────

describe('isContractAddress', () => {
  it('returns false for a G-account', () => {
    // G-accounts are not valid contract addresses
    expect(isContractAddress('GABC1234')).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(isContractAddress('')).toBe(false);
  });

  it('handles invalid input without throwing', () => {
    expect(() => isContractAddress('not-an-address')).not.toThrow();
    expect(isContractAddress('not-an-address')).toBe(false);
  });
});

// ── classifyWallet ────────────────────────────────────────────────────────────

describe('classifyWallet', () => {
  it('returns custom + isSmartWallet=true for contract source with no auth', () => {
    const result = classifyWallet(C_ACCOUNT, noAuth, null);
    expect(result.isSmartWallet).toBe(true);
    expect(result.walletType).toBe('custom');
  });

  it('detects multi_sig from multiple auth signers', () => {
    const result = classifyWallet(G_ACCOUNT, multiSigAuth, null);
    expect(result.walletType).toBe('multi_sig');
    expect(result.authMethods).toContain('multi_sig');
    expect(result.signerCount).toBe(3);
  });

  it('detects multi_sig from __check_auth function name', () => {
    const result = classifyWallet(C_ACCOUNT, contractAuth, '__check_auth');
    expect(result.authMethods).toContain('multi_sig');
    expect(result.walletType).toBe('multi_sig');
  });

  it('detects session_key from add_session_key function', () => {
    const result = classifyWallet(C_ACCOUNT, noAuth, 'add_session_key');
    expect(result.authMethods).toContain('session_key');
    expect(result.walletType).toBe('session_key');
  });

  it('detects social_recovery from add_guardian function', () => {
    const result = classifyWallet(C_ACCOUNT, noAuth, 'add_guardian');
    expect(result.authMethods).toContain('social_recovery');
    expect(result.walletType).toBe('social_recovery');
  });

  it('detects passkey from WASM indicators', () => {
    const wasmIndicators = { exportedFunctions: ['verify_passkey'], hasPasskeyIndicators: true };
    const result = classifyWallet(C_ACCOUNT, noAuth, null, wasmIndicators);
    expect(result.authMethods).toContain('passkey');
    expect(result.walletType).toBe('passkey');
  });

  it('returns hybrid when multiple auth methods detected', () => {
    const wasmIndicators = {
      exportedFunctions: ['add_signer', 'add_session_key'],
      hasPasskeyIndicators: false,
    };
    const result = classifyWallet(C_ACCOUNT, noAuth, null, wasmIndicators);
    expect(result.walletType).toBe('hybrid');
    expect(result.authMethods.length).toBeGreaterThan(1);
  });

  it('classifies pure G-account with no auth signals as sponsored (non-smart)', () => {
    const result = classifyWallet(G_ACCOUNT, noAuth, 'transfer');
    expect(result.isSmartWallet).toBe(false);
    expect(result.walletType).toBe('sponsored');
  });

  it('marks contract auth source as isSmartWallet=true', () => {
    const result = classifyWallet(G_ACCOUNT, contractAuth, null);
    expect(result.isSmartWallet).toBe(true);
  });
});

// ── extractWasmAaIndicators ───────────────────────────────────────────────────

describe('extractWasmAaIndicators', () => {
  it('detects __check_auth in WASM bytes', () => {
    const wasm = Buffer.from('some bytes __check_auth more bytes');
    const result = extractWasmAaIndicators(wasm);
    expect(result.exportedFunctions).toContain('__check_auth');
    expect(result.hasPasskeyIndicators).toBe(false);
  });

  it('detects passkey indicators', () => {
    const wasm = Buffer.from('verify_passkey webauthn_verify some code');
    const result = extractWasmAaIndicators(wasm);
    expect(result.hasPasskeyIndicators).toBe(true);
    expect(result.exportedFunctions).toContain('verify_passkey');
  });

  it('returns empty arrays for irrelevant WASM', () => {
    const wasm = Buffer.from('totally unrelated bytecode');
    const result = extractWasmAaIndicators(wasm);
    expect(result.exportedFunctions).toHaveLength(0);
    expect(result.hasPasskeyIndicators).toBe(false);
  });
});

// ── extractSponsorInfo ────────────────────────────────────────────────────────

describe('extractSponsorInfo', () => {
  it('returns isFeeSponsored=false for invalid XDR', () => {
    const result = extractSponsorInfo('not-valid-xdr');
    expect(result.isFeeSponsored).toBe(false);
    expect(result.sponsorAccount).toBeNull();
  });

  it('returns isFeeSponsored=false for empty string', () => {
    const result = extractSponsorInfo('');
    expect(result.isFeeSponsored).toBe(false);
  });
});

// ── buildAuthDecomposition ────────────────────────────────────────────────────

describe('buildAuthDecomposition', () => {
  it('builds correct decomposition record', () => {
    const classification = classifyWallet(C_ACCOUNT, subCallAuth, '__check_auth');
    const record = buildAuthDecomposition(
      'txhash123',
      C_ACCOUNT,
      subCallAuth,
      classification,
      1000,
      '__check_auth',
      C_ACCOUNT,
    );

    expect(record.transactionHash).toBe('txhash123');
    expect(record.walletAddress).toBe(C_ACCOUNT);
    expect(record.hasSubCalls).toBe(true);
    expect(record.ledgerSequence).toBe(1000);
    expect(record.authMethods).toContain('multi_sig');
    expect(record.humanReadable).toBeTruthy();
  });

  it('sets walletAddress=null for G-account sources', () => {
    const classification = classifyWallet(G_ACCOUNT, multiSigAuth, null);
    const record = buildAuthDecomposition('tx2', G_ACCOUNT, multiSigAuth, classification, 2000);
    expect(record.walletAddress).toBeNull();
  });
});

// ── renderAuthTree ────────────────────────────────────────────────────────────

describe('renderAuthTree', () => {
  it('renders multi-sig description', () => {
    const classification = classifyWallet(G_ACCOUNT, multiSigAuth, null);
    const result = renderAuthTree(multiSigAuth, classification, 'execute', C_ACCOUNT);
    expect(result).toMatch(/multi-sig/);
    expect(result).toMatch(/execute/);
  });

  it('renders session key description', () => {
    const sessionAuth: ParsedAuth[] = [
      { type: 'contract', address: C_ACCOUNT, nonce: null, subInvocations: [] },
    ];
    const classification = classifyWallet(C_ACCOUNT, noAuth, 'add_session_key');
    classification.sessionKeys = [{ address: 'GSESSIONKEY', expiryLedger: 5000 }];
    const result = renderAuthTree(sessionAuth, classification, 'transfer', C_ACCOUNT);
    expect(result).toMatch(/session key/);
    expect(result).toMatch(/5000/);
  });

  it('renders passkey description', () => {
    const wasmIndicators = { exportedFunctions: ['verify_passkey'], hasPasskeyIndicators: true };
    const classification = classifyWallet(C_ACCOUNT, contractAuth, null, wasmIndicators);
    const result = renderAuthTree(contractAuth, classification, 'swap', C_ACCOUNT);
    expect(result).toMatch(/passkey|WebAuthn/i);
  });

  it('renders fallback for empty auth', () => {
    const classification = classifyWallet(G_ACCOUNT, noAuth, 'transfer');
    const result = renderAuthTree([], classification, 'transfer', null);
    expect(result).toBeTruthy();
    expect(typeof result).toBe('string');
  });
});

// ── refineBehaviorClassification ──────────────────────────────────────────────

describe('refineBehaviorClassification', () => {
  it('returns current classification unchanged when no calls', () => {
    const base = classifyWallet(C_ACCOUNT, noAuth, null);
    const refined = refineBehaviorClassification(base, { callCounts: {}, observedSignerCount: 1 });
    expect(refined).toEqual(base);
  });

  it('upgrades to social_recovery when recovery calls ≥ 10 %', () => {
    const base = classifyWallet(C_ACCOUNT, noAuth, null);
    const profile = {
      callCounts: { execute: 8, initiate_recovery: 1, complete_recovery: 1 },
      observedSignerCount: 1,
    };
    const refined = refineBehaviorClassification(base, profile);
    expect(refined.authMethods).toContain('social_recovery');
  });

  it('upgrades to session_key when session calls ≥ 20 %', () => {
    const base = classifyWallet(C_ACCOUNT, noAuth, null);
    const profile = {
      callCounts: { execute: 3, add_session_key: 1 },
      observedSignerCount: 1,
    };
    const refined = refineBehaviorClassification(base, profile);
    expect(refined.authMethods).toContain('session_key');
  });

  it('upgrades to multi_sig when observedSignerCount > 1', () => {
    const base = classifyWallet(C_ACCOUNT, noAuth, null);
    const profile = { callCounts: { execute: 10 }, observedSignerCount: 3 };
    const refined = refineBehaviorClassification(base, profile);
    expect(refined.authMethods).toContain('multi_sig');
  });

  it('returns hybrid when multiple methods detected from behavior', () => {
    const base = classifyWallet(C_ACCOUNT, noAuth, null);
    const profile = {
      callCounts: {
        execute: 5,
        add_session_key: 2,
        initiate_recovery: 1,
        complete_recovery: 1,
        unused: 1,
      },
      observedSignerCount: 2,
    };
    const refined = refineBehaviorClassification(base, profile);
    expect(refined.walletType).toBe('hybrid');
    expect(refined.authMethods.length).toBeGreaterThan(1);
  });
});

// ── extractSessionKeysFromAuth ────────────────────────────────────────────────

describe('extractSessionKeysFromAuth', () => {
  it('returns empty array for G-account source', () => {
    const result = extractSessionKeysFromAuth(G_ACCOUNT, multiSigAuth);
    expect(result).toHaveLength(0);
  });

  it('extracts G-account auth entries as session keys for contract source', () => {
    const auth: ParsedAuth[] = [
      { type: 'account', address: 'GSESSIONKEY1', nonce: '1', subInvocations: [] },
      { type: 'account', address: 'GSESSIONKEY2', nonce: '2', subInvocations: [] },
    ];
    const result = extractSessionKeysFromAuth(C_ACCOUNT, auth);
    expect(result).toHaveLength(2);
    expect(result.map((s) => s.address)).toContain('GSESSIONKEY1');
    expect(result.every((s) => s.expiryLedger === null)).toBe(true);
  });

  it('excludes the source address itself from session keys', () => {
    const auth: ParsedAuth[] = [
      { type: 'account', address: C_ACCOUNT, nonce: null, subInvocations: [] },
      { type: 'account', address: 'GOTHER', nonce: '1', subInvocations: [] },
    ];
    const result = extractSessionKeysFromAuth(C_ACCOUNT, auth);
    expect(result.map((s) => s.address)).not.toContain(C_ACCOUNT);
    expect(result.map((s) => s.address)).toContain('GOTHER');
  });

  it('returns empty for contract-type auth entries', () => {
    const result = extractSessionKeysFromAuth(C_ACCOUNT, contractAuth);
    expect(result).toHaveLength(0);
  });
});
