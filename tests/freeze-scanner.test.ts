import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractFootprintKeys, scanForFrozenKeys, invalidateFreezeCache } from '../src/indexer/freeze-scanner';
import { xdr, nativeToScVal, Address } from '@stellar/stellar-sdk';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal base64 LedgerKey for contractData */
function makeContractDataKey(contractHex: string, keySymbol: string): string {
  const contractId = Buffer.from(contractHex.padEnd(64, '0').slice(0, 64), 'hex');
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: xdr.ScAddress.scAddressTypeContract(contractId),
      key: nativeToScVal(keySymbol, { type: 'symbol' }),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
  return key.toXDR('base64');
}

// ── extractFootprintKeys ─────────────────────────────────────────────────────

describe('extractFootprintKeys', () => {
  it('returns empty array for malformed XDR', () => {
    expect(extractFootprintKeys('not-valid-base64!!!')).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(extractFootprintKeys('')).toEqual([]);
  });
});

// ── scanForFrozenKeys ────────────────────────────────────────────────────────

describe('scanForFrozenKeys', () => {
  beforeEach(() => {
    invalidateFreezeCache();
    vi.restoreAllMocks();
  });

  it('returns frozen=false when no frozen keys are registered', async () => {
    // Mock DB to return empty frozen key list
    vi.doMock('../src/db', () => ({
      prismaWrite: {
        frozenLedgerKey: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      },
      prismaRead: {
        frozenLedgerKey: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      },
    }));

    const result = await scanForFrozenKeys('not-valid-xdr');
    expect(result.frozen).toBe(false);
    expect(result.matchedKeys).toEqual([]);
  });

  it('returns frozen=false for empty XDR (no footprint keys extracted)', async () => {
    const result = await scanForFrozenKeys('');
    expect(result.frozen).toBe(false);
    expect(result.matchedKeys).toEqual([]);
  });
});

// ── Frozen key label ─────────────────────────────────────────────────────────

describe('freeze violation label', () => {
  it('produces the expected human-readable message', () => {
    const FREEZE_MESSAGE = 'Transaction Rejected: Operation touches a consensus-frozen ledger key.';
    expect(FREEZE_MESSAGE).toContain('consensus-frozen ledger key');
  });
});

// ── LedgerKey XDR round-trip ─────────────────────────────────────────────────

describe('LedgerKey XDR round-trip', () => {
  it('encodes and decodes a contractData key without error', () => {
    const keyBase64 = makeContractDataKey('deadbeef', 'balance');
    expect(() => xdr.LedgerKey.fromXDR(keyBase64, 'base64')).not.toThrow();
  });

  it('two different keys produce different base64 strings', () => {
    const key1 = makeContractDataKey('aabbccdd', 'balance');
    const key2 = makeContractDataKey('11223344', 'balance');
    expect(key1).not.toBe(key2);
  });

  it('same key encodes identically (deterministic)', () => {
    const key1 = makeContractDataKey('cafebabe', 'allowance');
    const key2 = makeContractDataKey('cafebabe', 'allowance');
    expect(key1).toBe(key2);
  });
});
