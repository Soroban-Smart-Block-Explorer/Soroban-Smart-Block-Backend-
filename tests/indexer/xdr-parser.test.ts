import { describe, it, expect } from 'vitest';
import {
  xdr,
  nativeToScVal,
  Keypair,
  StrKey,
  TransactionBuilder,
  Account,
  Networks,
  Operation,
  Address,
} from '@stellar/stellar-sdk';
import { scValToJson, parseInvokeHostFunction } from '../../src/indexer/xdr-parser';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal InvokeHostFunction transaction envelope XDR. */
function buildInvokeEnvelope(contractId: Buffer, fnName: string, args: xdr.ScVal[]): string {
  const source = Keypair.random();
  const account = new Account(source.publicKey(), '100');

  const contractAddress = xdr.ScAddress.scAddressTypeContract(contractId);
  const invokeArgs = new xdr.InvokeContractArgs({
    contractAddress,
    functionName: Buffer.from(fnName),
    args,
  });

  const hostFn = xdr.HostFunction.hostFunctionTypeInvokeContract(invokeArgs);
  const op = Operation.invokeHostFunction({ func: hostFn, auth: [] });

  const tx = new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();

  return tx.toEnvelope().toXDR('base64');
}

/** A deterministic fake contract ID (32 bytes). */
const FAKE_CONTRACT_ID = Buffer.alloc(32, 0xab);
const FAKE_CONTRACT_STRKEY = StrKey.encodeContract(FAKE_CONTRACT_ID);

// ── scValToJson ───────────────────────────────────────────────────────────────

describe('scValToJson', () => {
  it('converts a symbol', () => {
    const val = nativeToScVal('swap', { type: 'symbol' });
    expect(scValToJson(val)).toEqual({ type: 'symbol', value: 'swap' });
  });

  it('converts a string', () => {
    const val = nativeToScVal('hello', { type: 'string' });
    expect(scValToJson(val)).toEqual({ type: 'string', value: 'hello' });
  });

  it('converts a bool', () => {
    expect(scValToJson(nativeToScVal(true))).toEqual({ type: 'bool', value: true });
  });

  it('converts void', () => {
    const val = xdr.ScVal.scvVoid();
    expect(scValToJson(val)).toEqual({ type: 'void', value: null });
  });

  it('converts i128 preserving full precision', () => {
    const big = 123456789012345678901234567890n;
    const val = nativeToScVal(big, { type: 'i128' });
    const result = scValToJson(val);
    expect(result.type).toBe('i128');
    expect(result.value).toBe(big.toString());
  });

  it('converts u128', () => {
    const val = nativeToScVal(999n, { type: 'u128' });
    const result = scValToJson(val);
    expect(result.type).toBe('u128');
    expect(result.value).toBe('999');
  });

  it('converts bytes to hex', () => {
    const val = xdr.ScVal.scvBytes(Buffer.from('deadbeef', 'hex'));
    expect(scValToJson(val)).toEqual({ type: 'bytes', value: 'deadbeef' });
  });

  it('converts a vec recursively', () => {
    const val = nativeToScVal([1n, 2n, 3n].map((n) => nativeToScVal(n, { type: 'i128' })));
    const result = scValToJson(val);
    expect(result.type).toBe('vec');
    expect(Array.isArray(result.value)).toBe(true);
    expect((result.value as any[]).map((v) => v.value)).toEqual(['1', '2', '3']);
  });

  it('converts a map to an object', () => {
    const val = nativeToScVal({ key: 'value' });
    const result = scValToJson(val);
    expect(result.type).toBe('map');
    expect((result.value as any).key).toBe('value');
  });

  it('converts a contract address', () => {
    const val = new Address(FAKE_CONTRACT_STRKEY).toScVal();
    const result = scValToJson(val);
    expect(result.type).toBe('address');
    expect(result.value).toBe(FAKE_CONTRACT_STRKEY);
  });
});

// ── parseInvokeHostFunction ───────────────────────────────────────────────────

describe('parseInvokeHostFunction', () => {
  it('returns null for invalid XDR', () => {
    expect(parseInvokeHostFunction('not-valid-xdr')).toBeNull();
  });

  it('extracts contractId, functionName, and args', () => {
    const args = [nativeToScVal(100n, { type: 'i128' }), nativeToScVal('GABC', { type: 'string' })];
    const envelope = buildInvokeEnvelope(FAKE_CONTRACT_ID, 'swap', args);
    const result = parseInvokeHostFunction(envelope);

    expect(result).not.toBeNull();
    expect(result!.contractId).toBe(FAKE_CONTRACT_STRKEY);
    expect(result!.functionName).toBe('swap');
    expect(result!.args).toHaveLength(2);
    expect(result!.args[0]).toMatchObject({ index: 0, type: 'i128', value: '100' });
    expect(result!.args[1]).toMatchObject({ index: 1, type: 'string', value: 'GABC' });
  });

  it('returns empty auth array when no auth entries', () => {
    const envelope = buildInvokeEnvelope(FAKE_CONTRACT_ID, 'get_balance', []);
    const result = parseInvokeHostFunction(envelope);
    expect(result!.auth).toEqual([]);
  });
});
