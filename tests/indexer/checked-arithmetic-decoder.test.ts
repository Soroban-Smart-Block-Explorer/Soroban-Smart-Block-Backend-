import { describe, it, expect } from 'vitest';
import {
  isCheckedArithmeticFunction,
  analyzeCheckedArithmetic,
  analyzeCheckedArithmeticBatch,
  checkedArithmeticToDecodedArg,
  didOverflow,
  getOverflowedOperations,
  countOperationResults,
  isValidI256,
  isValidU256,
  validateOperands,
  generateDiagnosticReport,
} from '../../src/indexer/checked-arithmetic-decoder';

// These tests operate on the pure logic functions only — no XDR parsing
// since that requires live stellar-sdk ScVal construction

describe('isCheckedArithmeticFunction', () => {
  it('returns true for all checked arithmetic functions', () => {
    const fns = [
      'checked_add_i256',
      'checked_add_u256',
      'checked_sub_i256',
      'checked_sub_u256',
      'checked_mul_i256',
      'checked_mul_u256',
      'checked_pow_i256',
      'checked_pow_u256',
    ];
    fns.forEach((fn) => expect(isCheckedArithmeticFunction(fn)).toBe(true));
  });

  it('returns false for non-checked functions', () => {
    expect(isCheckedArithmeticFunction('transfer')).toBe(false);
    expect(isCheckedArithmeticFunction('add')).toBe(false);
    expect(isCheckedArithmeticFunction('checked_add')).toBe(false); // missing type suffix
    expect(isCheckedArithmeticFunction('')).toBe(false);
  });
});

describe('analyzeCheckedArithmetic', () => {
  it('returns isCheckedOperation false for unknown function', () => {
    const result = analyzeCheckedArithmetic('transfer', [], null);
    expect(result.isCheckedOperation).toBe(false);
    expect(result.humanReadable).toBe('');
  });

  it('returns isCheckedOperation true with no operands when args are empty', () => {
    const result = analyzeCheckedArithmetic('checked_add_i256', [], null);
    expect(result.isCheckedOperation).toBe(true);
    expect(result.humanReadable).toContain('checked_add_i256');
  });
});

describe('checkedArithmeticToDecodedArg', () => {
  it('returns null when not a checked operation', () => {
    const result = checkedArithmeticToDecodedArg({ isCheckedOperation: false, humanReadable: '' });
    expect(result).toBeNull();
  });

  it('returns null when operation is missing', () => {
    const result = checkedArithmeticToDecodedArg({
      isCheckedOperation: true,
      humanReadable: 'some op',
    });
    expect(result).toBeNull();
  });

  it('returns decoded arg with overflow status', () => {
    const analysis = {
      isCheckedOperation: true,
      humanReadable: 'Checked add: overflow',
      operation: {
        type: 'checked_add' as const,
        operandType: 'u256' as const,
        operands: [100n, 200n],
        result: { status: 'overflow' as const, value: null },
      },
    };
    const result = checkedArithmeticToDecodedArg(analysis);
    expect(result).not.toBeNull();
    expect(result!.raw).toBeNull();
    expect(result!.formatted).toContain('overflow');
  });

  it('returns decoded arg with success value', () => {
    const analysis = {
      isCheckedOperation: true,
      humanReadable: 'Checked add: 300',
      operation: {
        type: 'checked_add' as const,
        operandType: 'i256' as const,
        operands: [100n, 200n],
        result: { status: 'success' as const, value: 300n },
      },
    };
    const result = checkedArithmeticToDecodedArg(analysis);
    expect(result!.raw).toBe(300n);
    expect(result!.formatted).toContain('300');
  });
});

describe('didOverflow', () => {
  it('returns true when operation overflowed', () => {
    const analysis = {
      isCheckedOperation: true,
      humanReadable: '',
      operation: {
        type: 'checked_add' as const,
        operandType: 'u256' as const,
        operands: [],
        result: { status: 'overflow' as const, value: null },
      },
    };
    expect(didOverflow(analysis)).toBe(true);
  });

  it('returns false when operation succeeded', () => {
    const analysis = {
      isCheckedOperation: true,
      humanReadable: '',
      operation: {
        type: 'checked_add' as const,
        operandType: 'u256' as const,
        operands: [],
        result: { status: 'success' as const, value: 100n },
      },
    };
    expect(didOverflow(analysis)).toBe(false);
  });

  it('returns false when not a checked operation', () => {
    expect(didOverflow({ isCheckedOperation: false, humanReadable: '' })).toBe(false);
  });
});

describe('getOverflowedOperations', () => {
  it('returns only overflowed operations', () => {
    const analyses = [
      {
        isCheckedOperation: true,
        humanReadable: '',
        operation: {
          type: 'checked_add' as const,
          operandType: 'u256' as const,
          operands: [],
          result: { status: 'overflow' as const, value: null },
        },
      },
      {
        isCheckedOperation: true,
        humanReadable: '',
        operation: {
          type: 'checked_sub' as const,
          operandType: 'i256' as const,
          operands: [],
          result: { status: 'success' as const, value: 50n },
        },
      },
    ];

    const overflowed = getOverflowedOperations(analyses);
    expect(overflowed).toHaveLength(1);
    expect(overflowed[0].type).toBe('checked_add');
  });
});

describe('countOperationResults', () => {
  it('counts successful and overflowed operations', () => {
    const analyses = [
      {
        isCheckedOperation: true,
        humanReadable: '',
        operation: {
          type: 'checked_add' as const,
          operandType: 'u256' as const,
          operands: [],
          result: { status: 'success' as const, value: 100n },
        },
      },
      {
        isCheckedOperation: true,
        humanReadable: '',
        operation: {
          type: 'checked_mul' as const,
          operandType: 'u256' as const,
          operands: [],
          result: { status: 'overflow' as const, value: null },
        },
      },
      { isCheckedOperation: false, humanReadable: '' },
    ];

    const counts = countOperationResults(analyses);
    expect(counts.successful).toBe(1);
    expect(counts.overflowed).toBe(1);
  });

  it('returns zeros for empty array', () => {
    const counts = countOperationResults([]);
    expect(counts.successful).toBe(0);
    expect(counts.overflowed).toBe(0);
  });
});

describe('isValidI256', () => {
  it('returns true for zero', () => {
    expect(isValidI256(0n)).toBe(true);
  });

  it('returns true for positive value within range', () => {
    expect(isValidI256(1000n)).toBe(true);
  });

  it('returns true for negative value within range', () => {
    expect(isValidI256(-1000n)).toBe(true);
  });

  it('returns false for value exceeding max i256', () => {
    const overMax = BigInt(2) ** BigInt(255);
    expect(isValidI256(overMax)).toBe(false);
  });

  it('returns false for value below min i256', () => {
    const underMin = -(BigInt(2) ** BigInt(255)) - 1n;
    expect(isValidI256(underMin)).toBe(false);
  });
});

describe('isValidU256', () => {
  it('returns true for zero', () => {
    expect(isValidU256(0n)).toBe(true);
  });

  it('returns true for positive value within range', () => {
    expect(isValidU256(BigInt(2) ** BigInt(128))).toBe(true);
  });

  it('returns false for negative value', () => {
    expect(isValidU256(-1n)).toBe(false);
  });

  it('returns false for value exceeding max u256', () => {
    const overMax = BigInt(2) ** BigInt(256);
    expect(isValidU256(overMax)).toBe(false);
  });
});

describe('validateOperands', () => {
  it('returns false when fewer than 2 operands', () => {
    expect(validateOperands([100n], 'u256')).toBe(false);
    expect(validateOperands([], 'i256')).toBe(false);
  });

  it('returns true for valid u256 operands', () => {
    expect(validateOperands([100n, 200n], 'u256')).toBe(true);
  });

  it('returns true for valid i256 operands including negatives', () => {
    expect(validateOperands([-100n, 200n], 'i256')).toBe(true);
  });

  it('returns false when any operand is out of range', () => {
    const overMax = BigInt(2) ** BigInt(256);
    expect(validateOperands([100n, overMax], 'u256')).toBe(false);
  });
});

describe('analyzeCheckedArithmeticBatch', () => {
  it('returns analysis for each call', () => {
    const calls = [
      { functionName: 'transfer', args: [] },
      { functionName: 'checked_add_u256', args: [] },
    ];

    const results = analyzeCheckedArithmeticBatch(calls);
    expect(results).toHaveLength(2);
    expect(results[0].isCheckedOperation).toBe(false);
    expect(results[1].isCheckedOperation).toBe(true);
  });

  it('returns empty array for empty input', () => {
    expect(analyzeCheckedArithmeticBatch([])).toEqual([]);
  });
});

describe('generateDiagnosticReport', () => {
  it('returns isCheckedOperation false for non-checked analysis', () => {
    const report = generateDiagnosticReport({ isCheckedOperation: false, humanReadable: '' });
    expect(report.isCheckedOperation).toBe(false);
  });

  it('returns full report for checked operation', () => {
    const analysis = {
      isCheckedOperation: true,
      humanReadable: 'Checked add: 300',
      operation: {
        type: 'checked_add' as const,
        operandType: 'u256' as const,
        operands: [100n, 200n],
        result: { status: 'success' as const, value: 300n },
      },
    };
    const report = generateDiagnosticReport(analysis);
    expect(report.isCheckedOperation).toBe(true);
    expect(report.operationType).toBe('checked_add');
    expect(report.operandType).toBe('u256');
    expect(report.operands as string[]).toContain('100');
    expect((report.result as any).status).toBe('success');
    expect((report.bounds as any).isValid).toBe(true);
  });
});
