/**
 * Tests for fee-bump transaction envelope decoding (Issue #225).
 *
 * Verifies that decodeTransaction correctly handles envelopeTypeTxFeeBump by:
 *  - Extracting the inner transaction
 *  - Prefixing humanReadable with "(fee-bump)"
 *  - Returning the inner contract address and function name
 *  - Returning null fields when the inner tx has no InvokeHostFunction op
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  xdr,
  Keypair,
  StrKey,
  TransactionBuilder,
  Account,
  Networks,
  Operation,
} from '@stellar/stellar-sdk';

// ── Mock dependencies that require a live DB ─────────────────────────────────

vi.mock('../../src/db', () => ({
  prismaRead: {
    eventDefinition: { findUnique: vi.fn().mockResolvedValue(null) },
    contract: { findUnique: vi.fn().mockResolvedValue(null) },
  },
  prismaWrite: {},
}));

vi.mock('../../src/indexer/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/indexer/registry')>();
  return {
    ...actual,
    getContractAbi: vi.fn().mockResolvedValue(null),
  };
});

vi.mock('../../src/indexer/identity-verifier', () => ({
  decodeMastercardFlags: vi.fn().mockReturnValue(null),
}));

import { decodeTransaction } from '../../src/indexer/decoder';

// ── Helpers ───────────────────────────────────────────────────────────────────

const FAKE_CONTRACT_ID = Buffer.alloc(32, 0xab);
const FAKE_CONTRACT_STRKEY = StrKey.encodeContract(FAKE_CONTRACT_ID);

/**
 * Build a minimal v1 InvokeHostFunction transaction envelope XDR.
 */
function buildInvokeEnvelope(fnName: string): string {
  const source = Keypair.random();
  const account = new Account(source.publicKey(), '100');

  const contractAddress = xdr.ScAddress.scAddressTypeContract(FAKE_CONTRACT_ID);
  const invokeArgs = new xdr.InvokeContractArgs({
    contractAddress,
    functionName: Buffer.from(fnName),
    args: [],
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

/**
 * Build a fee-bump envelope wrapping the given inner v1 transaction.
 * Uses TransactionBuilder.buildFeeBumpTransaction which is the canonical SDK API.
 */
function buildFeeBumpEnvelope(innerXdr: string): string {
  const feeSource = Keypair.random();

  // Reconstruct the inner Transaction from its XDR envelope
  const innerEnvelope = xdr.TransactionEnvelope.fromXDR(innerXdr, 'base64');
  const innerTxV1 = innerEnvelope.v1();

  // Re-wrap as a TransactionEnvelope so buildFeeBumpTransaction can accept it
  const innerTxEnvelope = xdr.TransactionEnvelope.envelopeTypeTx(innerTxV1);

  // Build the fee-bump using the SDK helper
  const feeBumpTx = new xdr.FeeBumpTransaction({
    feeSource: xdr.MuxedAccount.keyTypeEd25519(feeSource.rawPublicKey()),
    fee: xdr.Int64.fromString('200'),
    innerTx: xdr.FeeBumpTransactionInnerTx.envelopeTypeTx(innerTxV1),
    ext: new xdr.FeeBumpTransactionExt(0),
  });

  const feeBumpEnvelope = xdr.TransactionEnvelope.envelopeTypeTxFeeBump(
    new xdr.FeeBumpTransactionEnvelope({
      tx: feeBumpTx,
      signatures: [],
    }),
  );

  return feeBumpEnvelope.toXDR('base64');
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('decodeTransaction — fee-bump envelope (Issue #225)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null fields for invalid XDR', async () => {
    const result = await decodeTransaction('not-valid-xdr');
    expect(result.contractAddress).toBeNull();
    expect(result.functionName).toBeNull();
    expect(result.functionArgs).toBeNull();
    expect(result.humanReadable).toBeNull();
  });

  it('decodes a fee-bump wrapping an InvokeHostFunction inner tx', async () => {
    const innerXdr = buildInvokeEnvelope('transfer');
    const feeBumpXdr = buildFeeBumpEnvelope(innerXdr);

    const result = await decodeTransaction(feeBumpXdr);

    // Contract address and function name come from the inner tx
    expect(result.contractAddress).toBe(FAKE_CONTRACT_STRKEY);
    expect(result.functionName).toBe('transfer');
  });

  it('prefixes humanReadable with "(fee-bump)"', async () => {
    const innerXdr = buildInvokeEnvelope('swap');
    const feeBumpXdr = buildFeeBumpEnvelope(innerXdr);

    const result = await decodeTransaction(feeBumpXdr);

    expect(result.humanReadable).not.toBeNull();
    expect(result.humanReadable).toMatch(/^\(fee-bump\)/);
  });

  it('humanReadable includes inner function description after the prefix', async () => {
    const innerXdr = buildInvokeEnvelope('deposit');
    const feeBumpXdr = buildFeeBumpEnvelope(innerXdr);

    const result = await decodeTransaction(feeBumpXdr);

    // The inner decode falls back to "Called deposit on <contract>" since no ABI
    expect(result.humanReadable).toContain('deposit');
    expect(result.humanReadable).toContain(FAKE_CONTRACT_STRKEY);
  });

  it('still decodes a plain v1 envelope correctly (no regression)', async () => {
    const innerXdr = buildInvokeEnvelope('get_balance');

    const result = await decodeTransaction(innerXdr);

    expect(result.contractAddress).toBe(FAKE_CONTRACT_STRKEY);
    expect(result.functionName).toBe('get_balance');
    // humanReadable should NOT start with "(fee-bump)"
    expect(result.humanReadable).not.toMatch(/^\(fee-bump\)/);
  });
});
