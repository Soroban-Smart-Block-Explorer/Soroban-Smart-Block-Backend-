/**
 * Revert Analyzer — detailed error analysis for failed Soroban simulations.
 *
 * Classifies error type, reconstructs call stack, and suggests fixes.
 */
import { SorobanRpc, StrKey, xdr } from '@stellar/stellar-sdk';
import { parseFailureReasonFromString } from './failure-parser';

// ── Types ─────────────────────────────────────────────────────────────────────

export type RevertErrorType =
  | 'panic'
  | 'contract_error'
  | 'resource_limit'
  | 'auth_error'
  | 'wasm_error'
  | 'storage_error'
  | 'unknown';

export interface CallStackFrame {
  depth: number;
  contractId: string;
  function: string;
}

export interface RevertAnalysis {
  errorType: RevertErrorType;
  message: string;
  detail: string | null;
  callStack: CallStackFrame[];
  suggestedFixes: string[];
}

// ── Error classification ──────────────────────────────────────────────────────

const AUTH_PATTERNS = [/auth/i, /unauthorized/i, /require_auth/i, /missing signature/i];
const RESOURCE_PATTERNS = [
  /budget/i,
  /resource limit/i,
  /exceeded limit/i,
  /cpu/i,
  /memory/i,
  /ExceededLimit/,
];
const PANIC_PATTERNS = [/panic/i, /trapped/i, /unreachable/i, /wasm trap/i];
const WASM_PATTERNS = [/wasm/i, /WasmVm/i, /vm error/i];
const STORAGE_PATTERNS = [/storage/i, /ledger entry/i, /archived/i, /footprint/i];

function classifyError(errorStr: string): RevertErrorType {
  if (AUTH_PATTERNS.some((p) => p.test(errorStr))) return 'auth_error';
  if (RESOURCE_PATTERNS.some((p) => p.test(errorStr))) return 'resource_limit';
  if (PANIC_PATTERNS.some((p) => p.test(errorStr))) return 'panic';
  if (WASM_PATTERNS.some((p) => p.test(errorStr))) return 'wasm_error';
  if (STORAGE_PATTERNS.some((p) => p.test(errorStr))) return 'storage_error';
  if (/contract error|Contract,/i.test(errorStr)) return 'contract_error';
  return 'unknown';
}

// ── Suggested fixes ───────────────────────────────────────────────────────────

const FIX_MAP: Record<RevertErrorType, string[]> = {
  auth_error: [
    'Ensure the transaction is signed by the required account.',
    'Add the missing authorization entry to the transaction.',
    'Check require_auth() calls and ensure all signers are included.',
  ],
  contract_error: [
    'Review the contract error code in the ABI to understand the specific failure.',
    'Check input values (balances, allowances, amounts) meet contract preconditions.',
  ],
  resource_limit: [
    'Increase the resource limits in the transaction (CPU instructions, memory bytes).',
    'Use simulateTransaction to get recommended resource limits before submitting.',
    'Split the operation into smaller transactions if possible.',
  ],
  panic: [
    'The contract hit an unexpected code path. Check contract logic for unreachable branches.',
    'Verify inputs do not trigger overflow or division by zero.',
  ],
  wasm_error: [
    'The WASM module encountered an internal error. Check contract compilation.',
    'Ensure the contract WASM is correctly deployed and not corrupted.',
  ],
  storage_error: [
    'A required ledger entry may be archived — restore it with a RestoreFootprint operation.',
    'Verify all ledger keys referenced by the contract exist and are in the footprint.',
  ],
  unknown: [
    'Review the full error message from the RPC node.',
    'Enable diagnostic events on your RPC node for more detail.',
  ],
};

// ── Call stack extraction ─────────────────────────────────────────────────────

/**
 * Reconstruct the call stack at the point of failure from diagnostic events.
 * Tracks fn_call / fn_return events to maintain depth.
 */
function extractCallStack(events: xdr.DiagnosticEvent[]): CallStackFrame[] {
  const stack: CallStackFrame[] = [];
  const open: CallStackFrame[] = [];

  for (const de of events) {
    const ev = de.event();
    const body = ev.body().value() as {
      topics: () => xdr.ScVal[];
      data: () => xdr.ScVal;
    };
    const rawTopics: xdr.ScVal[] = body?.topics?.() ?? [];

    let topic = '';
    let fnName = '';
    try {
      const first = rawTopics[0];
      if (first) topic = String((first as any).sym?.() ?? (first as any).str?.() ?? '');
      const second = rawTopics[1];
      if (second) fnName = String((second as any).sym?.() ?? (second as any).str?.() ?? '');
    } catch {
      /* ignore */
    }

    const contractRaw = ev.contractId();
    let contractId = 'system';
    try {
      if (contractRaw) {
        contractId = StrKey.encodeContract(contractRaw as unknown as Buffer);
      }
    } catch {
      /* ignore */
    }

    if (topic === 'fn_call') {
      const frame: CallStackFrame = { depth: open.length, contractId, function: fnName };
      open.push(frame);
      stack.push(frame);
    } else if (topic === 'fn_return') {
      open.pop();
    }
  }

  // Return the frames still open (i.e. the stack at the error point)
  return open.length > 0 ? open : stack;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Analyze a failed simulation response and return structured revert information.
 */
export function analyzeRevert(
  errorMsg: string,
  diagnosticEvents: xdr.DiagnosticEvent[],
): RevertAnalysis {
  const errorType = classifyError(errorMsg);
  const humanMessage = parseFailureReasonFromString(errorMsg);
  const callStack = extractCallStack(diagnosticEvents);
  const suggestedFixes = FIX_MAP[errorType] ?? FIX_MAP.unknown;

  return {
    errorType,
    message: humanMessage,
    detail: errorMsg !== humanMessage ? errorMsg : null,
    callStack,
    suggestedFixes,
  };
}

/**
 * Analyze a failed simulation response object directly.
 */
export function analyzeSimulationFailure(
  result: SorobanRpc.Api.SimulateTransactionErrorResponse,
  diagnosticEvents: xdr.DiagnosticEvent[] | undefined,
): RevertAnalysis {
  return analyzeRevert(result.error ?? 'Unknown simulation error', diagnosticEvents ?? []);
}
