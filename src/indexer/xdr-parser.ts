import { xdr, scValToNative, Address, StrKey } from '@stellar/stellar-sdk';
import { translateAddress } from './strkey-translator';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ParsedInvokeHostFunction {
  contractId: string;
  functionName: string;
  args: ParsedArg[];
  auth: ParsedAuth[];
}

export interface ParsedArg {
  index: number;
  type: string;
  value: unknown;
}

export interface ParsedAuth {
  type: 'account' | 'contract';
  address: string;
  nonce: string | null;
  subInvocations: ParsedSubInvocation[];
}

export interface ParsedSubInvocation {
  contractId: string;
  functionName: string;
  args: ParsedArg[];
}

export interface ParsedResult {
  type: string;
  value: unknown;
}

// ── ScVal → JSON ─────────────────────────────────────────────────────────────

/**
 * Convert an ScVal to a structured JSON-serialisable object, preserving the
 * XDR type name alongside the native value so callers can distinguish e.g.
 * i128 from u64 without re-parsing.
 */
export function scValToJson(val: xdr.ScVal): { type: string; value: unknown } {
  const typeName = val.switch().name;

  switch (typeName) {
    case 'scvAddress': {
      const addr = val.address();
      const type = addr.switch().name;
      if (type === 'scAddressTypeAccount') {
        const gAddress = StrKey.encodeEd25519PublicKey(addr.accountId().ed25519());
        // Translate in case the address was stored as a muxed key elsewhere;
        // for ScAddress the SDK always gives us the G-key directly.
        return { type: 'address', value: gAddress };
      }
      if (type === 'scAddressTypeContract') {
        return { type: 'address', value: StrKey.encodeContract(addr.contractId()) };
      }
      return { type: 'address', value: scValToNative(val) };
    }

    case 'scvMap': {
      const entries = val.map() ?? [];
      const obj: Record<string, unknown> = {};
      for (const entry of entries) {
        const k = scValToNative(entry.key());
        obj[String(k)] = scValToJson(entry.val()).value;
      }
      return { type: 'map', value: obj };
    }

    case 'scvVec': {
      const items = val.vec() ?? [];
      return { type: 'vec', value: items.map((v) => scValToJson(v)) };
    }

    case 'scvI128': {
      const parts = val.i128();
      const hi = BigInt(parts.hi().toString());
      const lo = BigInt(parts.lo().toString());
      const result = (hi << 64n) | lo;
      return { type: 'i128', value: result.toString() };
    }

    case 'scvU128': {
      const parts = val.u128();
      const hi = BigInt(parts.hi().toString());
      const lo = BigInt(parts.lo().toString());
      const result = (hi << 64n) | lo;
      return { type: 'u128', value: result.toString() };
    }

    case 'scvI256': {
      const parts = val.i256();
      const hiHi = BigInt(parts.hiHi().toString());
      const hiLo = BigInt(parts.hiLo().toString());
      const loHi = BigInt(parts.loHi().toString());
      const loLo = BigInt(parts.loLo().toString());
      const result = (hiHi << 192n) | (hiLo << 128n) | (loHi << 64n) | loLo;
      return { type: 'i256', value: result.toString() };
    }

    case 'scvU256': {
      const parts = val.u256();
      const hiHi = BigInt(parts.hiHi().toString());
      const hiLo = BigInt(parts.hiLo().toString());
      const loHi = BigInt(parts.loHi().toString());
      const loLo = BigInt(parts.loLo().toString());
      const result = (hiHi << 192n) | (hiLo << 128n) | (loHi << 64n) | loLo;
      return { type: 'u256', value: result.toString() };
    }

    case 'scvBytes':
      return { type: 'bytes', value: Buffer.from(val.bytes()).toString('hex') };

    case 'scvString':
      return { type: 'string', value: val.str().toString() };

    case 'scvSymbol':
      return { type: 'symbol', value: val.sym().toString() };

    case 'scvBool':
      return { type: 'bool', value: val.b() };

    case 'scvVoid':
      return { type: 'void', value: null };

    default:
      // Fallback: use the SDK's native conversion
      return { type: typeName, value: scValToNative(val) };
  }
}

// ── Auth entries ─────────────────────────────────────────────────────────────

function scAddressToString(addr: xdr.ScAddress): string {
  if (addr.switch().name === 'scAddressTypeAccount') {
    return StrKey.encodeEd25519PublicKey(addr.accountId().ed25519());
  }
  return StrKey.encodeContract(addr.contractId());
}

function parseSubInvocation(invocation: xdr.SorobanAuthorizedInvocation): ParsedSubInvocation {
  const fn = invocation.function();
  const contractFn = fn.contractFn();
  return {
    contractId: StrKey.encodeContract(contractFn.contractAddress().contractId()),
    functionName: contractFn.functionName().toString(),
    args: contractFn.args().map((a: xdr.ScVal, i: number) => ({ index: i, ...scValToJson(a) })),
  };
}

function parseAuthEntry(entry: xdr.SorobanAuthorizationEntry): ParsedAuth {
  const credentials = entry.credentials();
  const switchName = credentials.switch().name;

  let type: 'account' | 'contract' = 'account';
  let address = 'source';
  let nonce: string | null = null;

  if (switchName === 'sorobanCredentialsAddress') {
    const addrCreds = credentials.address();
    const scAddr = addrCreds.address();
    address = scAddressToString(scAddr);
    nonce = addrCreds.nonce().toString();
    type = scAddr.switch().name === 'scAddressTypeContract' ? 'contract' : 'account';
  }

  const rootInvocation = entry.rootInvocation();
  const rootFn = rootInvocation.function();

  if (rootFn.switch().name === 'sorobanAuthorizedFunctionTypeContractFn') {
    const contractFn = rootFn.contractFn();
    type = 'contract';
    address = StrKey.encodeContract(contractFn.contractAddress().contractId());
  }

  const subInvocations = rootInvocation.subInvocations().map(parseSubInvocation);

  return { type, address, nonce, subInvocations };
}

// ── Main parse functions ──────────────────────────────────────────────────────

/**
 * Parse a base64 XDR transaction envelope and extract the first
 * InvokeHostFunction operation as structured JSON.
 */
export function parseInvokeHostFunction(envelopeXdr: string): ParsedInvokeHostFunction | null {
  let envelope: xdr.TransactionEnvelope;
  try {
    envelope = xdr.TransactionEnvelope.fromXDR(envelopeXdr, 'base64');
  } catch {
    return null;
  }

  let ops: xdr.Operation[];
  const switchName = envelope.switch().name;
  if (switchName === 'envelopeTypeTx') {
    ops = envelope.v1().tx().operations();
  } else if (switchName === 'envelopeTypeTxV0') {
    ops = envelope.v0().tx().operations();
  } else {
    return null;
  }

  const invokeOp = ops.find((op) => op.body().switch().name === 'invokeHostFunction');
  if (!invokeOp) return null;

  const opBody = invokeOp.body().invokeHostFunctionOp();
  const hostFn = opBody.hostFunction();
  if (hostFn.switch().name !== 'hostFunctionTypeInvokeContract') return null;

  const invokeArgs = hostFn.invokeContract();
  const contractId = StrKey.encodeContract(invokeArgs.contractAddress().contractId());
  const functionName = invokeArgs.functionName().toString();
  const args: ParsedArg[] = invokeArgs.args().map((a: xdr.ScVal, i: number) => ({ index: i, ...scValToJson(a) }));
  const auth: ParsedAuth[] = opBody.auth().map(parseAuthEntry);

  return { contractId, functionName, args, auth };
}

/**
 * Parse a base64 XDR transaction result to extract the return value of an
 * InvokeHostFunction operation.
 */
export function parseInvokeResult(resultXdr: string): ParsedResult | null {
  let txResult: xdr.TransactionResult;
  try {
    txResult = xdr.TransactionResult.fromXDR(resultXdr, 'base64');
  } catch {
    return null;
  }

  const results: xdr.OperationResult[] = txResult.result().results() ?? [];
  const invokeResult = results.find(
    (r: xdr.OperationResult) => r.tr?.()?.switch().name === 'invokeHostFunction',
  );
  if (!invokeResult) return null;

  const invokeHostFnResult = invokeResult.tr().invokeHostFunctionResult();
  if (invokeHostFnResult.switch().name !== 'invokeHostFunctionSuccess') return null;

  const scVal = xdr.ScVal.fromXDR(invokeHostFnResult.success());
  return scValToJson(scVal);
}

// ── CAP-0079 address translation re-export ────────────────────────────────────

/**
 * Re-export the strkey translator so consumers of xdr-parser have a single
 * import point for all address normalisation utilities.
 */
export { translateAddress, resolveRoutingIdentity, normalizeAddresses, isValidAnyAddress } from './strkey-translator';
