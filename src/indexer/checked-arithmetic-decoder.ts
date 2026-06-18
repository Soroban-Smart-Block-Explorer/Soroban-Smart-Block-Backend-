/**
 * Checked Arithmetic Decoder
 *
 * Handles Protocol 26's native checked variants of 256-bit mathematical host functions:
 * - checked_add_i256 / checked_add_u256
 * - checked_sub_i256 / checked_sub_u256
 * - checked_mul_i256 / checked_mul_u256
 * - checked_pow_i256 / checked_pow_u256
 *
 * When these functions detect an overflow boundary, they return a structural Void
 * instead of trapping the transaction. This decoder transforms that into a safe,
 * human-readable notice: "Operation checked for arithmetic overflow safely."
 *
 * Technical Details:
 * - Checked variants are host functions that perform arithmetic with overflow detection
 * - On overflow: returns Void (scvVoid) instead of panicking
 * - On success: returns the computed result (i256/u256)
 * - This allows contracts to safely handle arithmetic boundaries
 */

import { xdr, scValToNative } from '@stellar/stellar-sdk';
import type { DecodedArg } from './args-decoder';

// ── Type Definitions ──────────────────────────────────────────────────────────

export interface CheckedArithmeticOperation {
  type: 'checked_add' | 'checked_sub' | 'checked_mul' | 'checked_pow';
  operandType: 'i256' | 'u256';
  operands: bigint[];
  result: CheckedArithmeticResult;
}

export type CheckedArithmeticResult =
  | { status: 'success'; value: bigint }
  | { status: 'overflow'; value: null };

export interface CheckedArithmeticAnalysis {
  isCheckedOperation: boolean;
  operation?: CheckedArithmeticOperation;
  humanReadable: string;
}

// ── Checked Operation Detection ──────────────────────────────────────────────

/**
 * List of all checked arithmetic function names.
 */
const CHECKED_ARITHMETIC_FUNCTIONS = new Set([
  'checked_add_i256',
  'checked_add_u256',
  'checked_sub_i256',
  'checked_sub_u256',
  'checked_mul_i256',
  'checked_mul_u256',
  'checked_pow_i256',
  'checked_pow_u256',
]);

/**
 * Determine if a function name is a checked arithmetic operation.
 */
export function isCheckedArithmeticFunction(functionName: string): boolean {
  return CHECKED_ARITHMETIC_FUNCTIONS.has(functionName);
}

/**
 * Parse the operation type and operand type from function name.
 * e.g. "checked_add_i256" → { type: 'checked_add', operandType: 'i256' }
 */
function parseCheckedFunctionName(
  functionName: string
): { type: 'checked_add' | 'checked_sub' | 'checked_mul' | 'checked_pow'; operandType: 'i256' | 'u256' } | null {
  const match = functionName.match(/^checked_(add|sub|mul|pow)_(i256|u256)$/);
  if (!match) return null;

  const [, opType, operandType] = match;
  return {
    type: opType as 'checked_add' | 'checked_sub' | 'checked_mul' | 'checked_pow',
    operandType: operandType as 'i256' | 'u256',
  };
}

// ── 256-bit Integer Extraction ───────────────────────────────────────────────

/**
 * Extract a 256-bit integer from an ScVal.
 * Handles both i256 and u256 types.
 */
function extract256BitInteger(val: xdr.ScVal): bigint | null {
  const typeName = val.switch().name;

  if (typeName === 'scvI256') {
    const parts = val.i256();
    const hiHi = BigInt(parts.hiHi().toString());
    const hiLo = BigInt(parts.hiLo().toString());
    const loHi = BigInt(parts.loHi().toString());
    const loLo = BigInt(parts.loLo().toString());
    return (hiHi << 192n) | (hiLo << 128n) | (loHi << 64n) | loLo;
  }

  if (typeName === 'scvU256') {
    const parts = val.u256();
    const hiHi = BigInt(parts.hiHi().toString());
    const hiLo = BigInt(parts.hiLo().toString());
    const loHi = BigInt(parts.loHi().toString());
    const loLo = BigInt(parts.loLo().toString());
    return (hiHi << 192n) | (hiLo << 128n) | (loHi << 64n) | loLo;
  }

  return null;
}

/**
 * Check if an ScVal is a Void (empty result).
 * Used to detect overflow in checked arithmetic operations.
 */
function isVoidResult(val: xdr.ScVal): boolean {
  return val.switch().name === 'scvVoid';
}

// ── Operand Extraction ───────────────────────────────────────────────────────

/**
 * Extract operands from function arguments.
 * Checked arithmetic functions take 2 operands (for add/sub/mul) or 2 operands (for pow).
 */
function extractOperands(rawArgs: xdr.ScVal[]): bigint[] | null {
  if (rawArgs.length < 2) return null;

  const operands: bigint[] = [];

  for (let i = 0; i < 2; i++) {
    const val = rawArgs[i];
    if (!val) return null;

    const operand = extract256BitInteger(val);
    if (operand === null) {
      // Try to extract as regular integer
      try {
        const native = scValToNative(val);
        if (typeof native === 'bigint' || typeof native === 'number') {
          operands.push(BigInt(native));
        } else {
          return null;
        }
      } catch {
        return null;
      }
    } else {
      operands.push(operand);
    }
  }

  return operands.length === 2 ? operands : null;
}

// ── Result Analysis ─────────────────────────────────────────────────────────

/**
 * Analyze the result of a checked arithmetic operation.
 * Returns either the computed value or indicates overflow.
 */
function analyzeCheckedResult(resultVal: xdr.ScVal): CheckedArithmeticResult {
  // Void result = overflow detected
  if (isVoidResult(resultVal)) {
    return { status: 'overflow', value: null };
  }

  // Extract the computed result
  const value = extract256BitInteger(resultVal);
  if (value !== null) {
    return { status: 'success', value };
  }

  // Fallback: try native conversion
  try {
    const native = scValToNative(resultVal);
    if (typeof native === 'bigint') {
      return { status: 'success', value: native };
    }
  } catch {
    // Ignore
  }

  // Unknown result type
  return { status: 'overflow', value: null };
}

// ── Human-Readable Formatting ───────────────────────────────────────────────

/**
 * Generate a human-readable description of a checked arithmetic operation.
 */
function formatCheckedOperation(op: CheckedArithmeticOperation): string {
  const { type, operandType, operands, result } = op;

  const operandStr = operands.map((n) => n.toString()).join(', ');
  const typeStr = operandType === 'i256' ? 'signed 256-bit' : 'unsigned 256-bit';

  if (result.status === 'overflow') {
    return `Checked ${type.replace('checked_', '')} (${typeStr}): Operation checked for arithmetic overflow safely. Operands: [${operandStr}]`;
  }

  const resultStr = result.value?.toString() ?? 'unknown';
  return `Checked ${type.replace('checked_', '')} (${typeStr}): ${resultStr}. Operands: [${operandStr}]`;
}

/**
 * Generate a concise human-readable notice for the result.
 */
function formatCheckedResult(result: CheckedArithmeticResult): string {
  if (result.status === 'overflow') {
    return 'Operation checked for arithmetic overflow safely.';
  }
  return `Result: ${result.value?.toString() ?? 'unknown'}`;
}

// ── Main Analysis Function ───────────────────────────────────────────────────

/**
 * Analyze a function call to determine if it's a checked arithmetic operation
 * and decode the result appropriately.
 */
export function analyzeCheckedArithmetic(
  functionName: string,
  rawArgs: xdr.ScVal[],
  resultVal: xdr.ScVal | null
): CheckedArithmeticAnalysis {
  // Check if this is a checked arithmetic function
  if (!isCheckedArithmeticFunction(functionName)) {
    return {
      isCheckedOperation: false,
      humanReadable: '',
    };
  }

  // Parse the function name
  const parsed = parseCheckedFunctionName(functionName);
  if (!parsed) {
    return {
      isCheckedOperation: false,
      humanReadable: '',
    };
  }

  // Extract operands
  const operands = extractOperands(rawArgs);
  if (!operands) {
    return {
      isCheckedOperation: true,
      humanReadable: `Checked arithmetic operation (${functionName}): Could not extract operands`,
    };
  }

  // Analyze result
  let result: CheckedArithmeticResult;
  if (resultVal) {
    result = analyzeCheckedResult(resultVal);
  } else {
    // No result provided, assume overflow
    result = { status: 'overflow', value: null };
  }

  const operation: CheckedArithmeticOperation = {
    type: parsed.type,
    operandType: parsed.operandType,
    operands,
    result,
  };

  return {
    isCheckedOperation: true,
    operation,
    humanReadable: formatCheckedOperation(operation),
  };
}

// ── Integration with DecodedArg ──────────────────────────────────────────────

/**
 * Convert a checked arithmetic result into a DecodedArg format.
 * This allows seamless integration with the existing decoding layer.
 */
export function checkedArithmeticToDecodedArg(
  analysis: CheckedArithmeticAnalysis
): DecodedArg | null {
  if (!analysis.isCheckedOperation || !analysis.operation) {
    return null;
  }

  const { operation } = analysis;
  const { result } = operation;

  return {
    raw: result.status === 'overflow' ? null : result.value,
    formatted: formatCheckedResult(result),
  };
}

// ── Batch Analysis ───────────────────────────────────────────────────────────

/**
 * Analyze multiple checked arithmetic operations in a transaction.
 * Useful for transactions that perform multiple arithmetic operations.
 */
export function analyzeCheckedArithmeticBatch(
  functionCalls: Array<{
    functionName: string;
    args: xdr.ScVal[];
    result?: xdr.ScVal;
  }>
): CheckedArithmeticAnalysis[] {
  return functionCalls.map((call) =>
    analyzeCheckedArithmetic(call.functionName, call.args, call.result ?? null)
  );
}

// ── Overflow Detection Utilities ─────────────────────────────────────────────

/**
 * Detect if a checked arithmetic operation resulted in an overflow.
 */
export function didOverflow(analysis: CheckedArithmeticAnalysis): boolean {
  return analysis.isCheckedOperation && analysis.operation?.result.status === 'overflow';
}

/**
 * Get all overflowed operations from a batch.
 */
export function getOverflowedOperations(
  analyses: CheckedArithmeticAnalysis[]
): CheckedArithmeticOperation[] {
  return analyses
    .filter((a) => a.isCheckedOperation && a.operation?.result.status === 'overflow')
    .map((a) => a.operation!)
    .filter((op): op is CheckedArithmeticOperation => op !== undefined);
}

/**
 * Count successful vs overflowed operations.
 */
export function countOperationResults(
  analyses: CheckedArithmeticAnalysis[]
): { successful: number; overflowed: number } {
  let successful = 0;
  let overflowed = 0;

  for (const analysis of analyses) {
    if (!analysis.isCheckedOperation || !analysis.operation) continue;

    if (analysis.operation.result.status === 'overflow') {
      overflowed++;
    } else {
      successful++;
    }
  }

  return { successful, overflowed };
}

// ── Bounds Checking ──────────────────────────────────────────────────────────

/**
 * Check if a value is within the bounds of a 256-bit signed integer.
 * i256 range: -(2^255) to (2^255 - 1)
 */
export function isValidI256(value: bigint): boolean {
  const min = -(BigInt(2) ** BigInt(255));
  const max = BigInt(2) ** BigInt(255) - BigInt(1);
  return value >= min && value <= max;
}

/**
 * Check if a value is within the bounds of a 256-bit unsigned integer.
 * u256 range: 0 to (2^256 - 1)
 */
export function isValidU256(value: bigint): boolean {
  const max = BigInt(2) ** BigInt(256) - BigInt(1);
  return value >= BigInt(0) && value <= max;
}

/**
 * Validate operands before arithmetic operation.
 * Returns true if operands are valid for the operation type.
 */
export function validateOperands(
  operands: bigint[],
  operationType: 'i256' | 'u256'
): boolean {
  if (operands.length < 2) return false;

  const validator = operationType === 'i256' ? isValidI256 : isValidU256;
  return operands.every(validator);
}

// ── Diagnostic Utilities ─────────────────────────────────────────────────────

/**
 * Generate a detailed diagnostic report for a checked arithmetic operation.
 * Useful for debugging and analysis.
 */
export function generateDiagnosticReport(
  analysis: CheckedArithmeticAnalysis
): Record<string, unknown> {
  if (!analysis.isCheckedOperation || !analysis.operation) {
    return { isCheckedOperation: false };
  }

  const { operation } = analysis;
  const { type, operandType, operands, result } = operation;

  return {
    isCheckedOperation: true,
    operationType: type,
    operandType,
    operands: operands.map((n) => n.toString()),
    result: {
      status: result.status,
      value: result.value?.toString() ?? null,
    },
    humanReadable: analysis.humanReadable,
    bounds: {
      operandType,
      isValid: validateOperands(operands, operandType),
      min: operandType === 'i256'
        ? (-(BigInt(2) ** BigInt(255))).toString()
        : '0',
      max: operandType === 'i256'
        ? (BigInt(2) ** BigInt(255) - BigInt(1)).toString()
        : (BigInt(2) ** BigInt(256) - BigInt(1)).toString(),
    },
  };
}
