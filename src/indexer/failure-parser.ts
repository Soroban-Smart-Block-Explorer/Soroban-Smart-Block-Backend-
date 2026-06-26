/**
 * Issue #49 — Transaction Failure Reason Parser
 *
 * Inspects failed Soroban transactions and translates raw HostError codes
 * (e.g. "HostError: Error(Contract, #102)") into human-readable explanations.
 */
import { xdr } from '@stellar/stellar-sdk';

// ── Error code maps ──────────────────────────────────────────────────────────

/** Soroban host error types → readable category */
const HOST_ERROR_TYPES: Record<string, string> = {
  Value: 'Value Error',
  WasmVm: 'WASM VM Error',
  Context: 'Context Error',
  Storage: 'Storage Error',
  Object: 'Object Error',
  Crypto: 'Cryptography Error',
  Events: 'Events Error',
  Budget: 'Budget Exceeded',
  Value_: 'Value Error',
  Auth: 'Authorization Error',
  Contract: 'Custom Contract Error',
};

/** Common Soroban SDK error codes → readable message */
const SDK_ERROR_CODES: Record<string, string> = {
  // ScErrorCode
  ArithDomain: 'Arithmetic domain error (e.g. division by zero)',
  IndexBounds: 'Index out of bounds',
  InvalidInput: 'Invalid input provided',
  MissingValue: 'Required value is missing',
  ExistingValue: 'Value already exists',
  ExceededLimit: 'Limit exceeded',
  InvalidAction: 'Invalid action attempted',
  InternalError: 'Internal host error',
  UnexpectedType: 'Unexpected type encountered',
  UnexpectedSize: 'Unexpected size',
};

/** Well-known contract error codes (contract-defined, common patterns) */
const COMMON_CONTRACT_ERRORS: Record<number, string> = {
  1: 'Unauthorized',
  2: 'Already Initialized',
  3: 'Not Initialized',
  100: 'Insufficient Balance',
  101: 'Insufficient Allowance',
  102: 'Insufficient Liquidity',
  103: 'Slippage Exceeded',
  104: 'Deadline Expired',
  105: 'Zero Amount',
  106: 'Invalid Token',
  107: 'Pool Not Found',
  108: 'Overflow',
  200: 'Paused',
  201: 'Not Paused',
};

// ── Result code maps ─────────────────────────────────────────────────────────

const TX_RESULT_CODES: Record<string, string> = {
  txFailed: 'One or more operations failed',
  txTooEarly: 'Transaction submitted too early (before minTime)',
  txTooLate: 'Transaction submitted too late (after maxTime)',
  txMissingOperation: 'Transaction has no operations',
  txBadSeq: 'Sequence number mismatch',
  txBadAuth: 'Insufficient signatures or wrong network',
  txInsufficientBalance: 'Insufficient balance to pay fee',
  txNoAccount: 'Source account not found',
  txInsufficientFee: 'Fee is too low',
  txBadAuthExtra: 'Unused signatures attached',
  txInternalError: 'Internal Stellar error',
  txNotSupported: 'Operation not supported',
  txBadSponsorship: 'Sponsorship not confirmed',
  txBadMinSeqAgeOrGap: 'Minimum sequence age or gap not met',
  txMalformed: 'Transaction is malformed',
};

const INVOKE_HOST_FUNCTION_CODES: Record<string, string> = {
  invokeHostFunctionSuccess: 'Success',
  invokeHostFunctionMalformed: 'Host function call is malformed',
  invokeHostFunctionTrapped: 'Host function execution trapped (contract panic)',
  invokeHostFunctionResourceLimitExceeded:
    'Resource limit exceeded (CPU, memory, or ledger entries)',
  invokeHostFunctionEntryArchived: 'A required ledger entry has been archived',
  invokeHostFunctionInsufficientRefundableFee: 'Insufficient refundable fee for resource usage',
};

// ── Parser ───────────────────────────────────────────────────────────────────

export interface ParsedFailureReason {
  code: string;
  reason: string;
  detail: string | null;
}

/**
 * Parse a base64-encoded TransactionResult XDR and return a human-readable
 * failure reason. Returns null for successful transactions.
 */
export function parseFailureReason(resultXdr: string): ParsedFailureReason | null {
  let txResult: xdr.TransactionResult;
  try {
    txResult = xdr.TransactionResult.fromXDR(resultXdr, 'base64');
  } catch {
    return { code: 'parse_error', reason: 'Could not parse transaction result', detail: null };
  }

  const resultCode = txResult.result().switch();
  const codeName = resultCode.name;

  // txSuccess — not a failure
  if (codeName === 'txSuccess') return null;

  // Top-level transaction error
  const topLevel = TX_RESULT_CODES[codeName];
  if (topLevel && codeName !== 'txFailed') {
    return { code: codeName, reason: topLevel, detail: null };
  }

  // Dig into operation results for txFailed
  const opResults: xdr.OperationResult[] = txResult.result().results?.() ?? [];
  for (const opResult of opResults) {
    const tr = opResult.tr?.();
    if (!tr) continue;

    const opSwitch = tr.switch().name;
    if (opSwitch === 'invokeHostFunction') {
      const ihfResult = tr.invokeHostFunctionResult();
      const ihfCode = ihfResult.switch().name;

      if (ihfCode === 'invokeHostFunctionSuccess') continue;

      const ihfReason = INVOKE_HOST_FUNCTION_CODES[ihfCode] ?? ihfCode;

      // For trapped errors, try to extract the HostError detail
      if (ihfCode === 'invokeHostFunctionTrapped') {
        const detail = extractHostErrorDetail(ihfResult);
        return { code: ihfCode, reason: ihfReason, detail };
      }

      return { code: ihfCode, reason: ihfReason, detail: null };
    }
  }

  return { code: codeName, reason: topLevel ?? codeName, detail: null };
}

/**
 * Extract a human-readable detail string from a trapped InvokeHostFunction result.
 * Attempts to parse the embedded HostError.
 */
function extractHostErrorDetail(ihfResult: xdr.InvokeHostFunctionResult): string | null {
  try {
    // The error is embedded as an ScError in the result
    const errorVal = (ihfResult as any).code?.();
    if (!errorVal) return null;

    const scError = errorVal.error?.();
    if (!scError) return null;

    const errorType = scError.type?.().name ?? 'Unknown';
    const errorCode = scError.code?.().name ?? null;
    const contractCode = scError.code?.().value ?? null;

    const typeName = HOST_ERROR_TYPES[errorType] ?? errorType;

    if (errorType === 'Contract' && typeof contractCode === 'number') {
      const contractMsg = COMMON_CONTRACT_ERRORS[contractCode];
      return contractMsg
        ? `${typeName}: ${contractMsg} (code #${contractCode})`
        : `${typeName}: Custom error code #${contractCode}`;
    }

    if (errorCode) {
      const sdkMsg = SDK_ERROR_CODES[errorCode];
      return sdkMsg ? `${typeName}: ${sdkMsg}` : `${typeName}: ${errorCode}`;
    }

    return typeName;
  } catch {
    return null;
  }
}

/**
 * Parse a failure reason from a raw error string (e.g. from RPC response).
 * Handles patterns like "HostError: Error(Contract, #102)".
 */
export function parseFailureReasonFromString(errorStr: string): string {
  if (!errorStr) return 'Unknown error';

  // Pattern: HostError: Error(Type, #code)
  const hostErrorMatch = errorStr.match(/HostError:\s*Error\((\w+),\s*#(\d+)\)/);
  if (hostErrorMatch) {
    const [, errorType, codeStr] = hostErrorMatch;
    const code = parseInt(codeStr, 10);
    const typeName = HOST_ERROR_TYPES[errorType] ?? errorType;

    if (errorType === 'Contract') {
      const msg = COMMON_CONTRACT_ERRORS[code];
      return msg
        ? `${typeName}: ${msg} (code #${code})`
        : `${typeName}: Custom error code #${code}`;
    }
    return `${typeName} (code #${code})`;
  }

  // Pattern: HostError: Error(Type, Code)
  const hostErrorNameMatch = errorStr.match(/HostError:\s*Error\((\w+),\s*(\w+)\)/);
  if (hostErrorNameMatch) {
    const [, errorType, errorCode] = hostErrorNameMatch;
    const typeName = HOST_ERROR_TYPES[errorType] ?? errorType;
    const sdkMsg = SDK_ERROR_CODES[errorCode];
    return sdkMsg ? `${typeName}: ${sdkMsg}` : `${typeName}: ${errorCode}`;
  }

  // Transaction result codes
  for (const [code, msg] of Object.entries(TX_RESULT_CODES)) {
    if (errorStr.includes(code)) return msg;
  }

  return errorStr.length > 200 ? errorStr.slice(0, 200) + '…' : errorStr;
}
