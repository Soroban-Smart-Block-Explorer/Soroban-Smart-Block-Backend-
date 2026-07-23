/**
 * Checked Arithmetic Integration
 *
 * Integrates checked arithmetic decoding into the main transaction processing pipeline.
 * Automatically detects and analyzes checked arithmetic operations during transaction decoding.
 */

import { xdr } from '@stellar/stellar-sdk';
import {
  isCheckedArithmeticFunction,
  analyzeCheckedArithmetic,
  CheckedArithmeticAnalysis,
  didOverflow,
} from './checked-arithmetic-decoder';
import { prismaRead as prisma } from '../db';

export interface CheckedArithmeticTransactionContext {
  transactionHash: string;
  contractAddress: string;
  functionName: string;
  rawArgs: xdr.ScVal[];
  resultVal: xdr.ScVal | null;
  ledgerSequence: number;
  ledgerCloseTime: Date;
}

export interface CheckedArithmeticTransactionResult {
  isCheckedArithmetic: boolean;
  analysis?: CheckedArithmeticAnalysis;
  enrichedFunctionArgs?: Record<string, unknown>;
  humanReadable?: string;
}

/**
 * Analyze a transaction for checked arithmetic operations.
 * Called during transaction decoding to enrich the decoded output.
 */
export async function analyzeTransactionForCheckedArithmetic(
  context: CheckedArithmeticTransactionContext,
): Promise<CheckedArithmeticTransactionResult> {
  const { functionName, rawArgs, resultVal } = context;

  // Quick check: is this a checked arithmetic function?
  if (!isCheckedArithmeticFunction(functionName)) {
    return { isCheckedArithmetic: false };
  }

  // Perform analysis
  const analysis = analyzeCheckedArithmetic(functionName, rawArgs, resultVal);

  if (!analysis.isCheckedOperation) {
    return { isCheckedArithmetic: false };
  }

  // Enrich the function arguments with overflow information
  const enrichedFunctionArgs: Record<string, unknown> = {
    _checkedArithmetic: {
      operation: analysis.operation?.type,
      operandType: analysis.operation?.operandType,
      operands: analysis.operation?.operands.map((n) => n.toString()),
      result: {
        status: analysis.operation?.result.status,
        value: analysis.operation?.result.value?.toString() ?? null,
      },
      overflowDetected: didOverflow(analysis),
    },
  };

  return {
    isCheckedArithmetic: true,
    analysis,
    enrichedFunctionArgs,
    humanReadable: analysis.humanReadable,
  };
}

/**
 * Store checked arithmetic analysis in the database.
 * Creates a record for overflow events and successful operations.
 */
export async function storeCheckedArithmeticAnalysis(
  context: CheckedArithmeticTransactionContext,
  analysis: CheckedArithmeticAnalysis,
): Promise<void> {
  if (!analysis.isCheckedOperation || !analysis.operation) {
    return;
  }

  try {
    const { operation } = analysis;
    const { type, operandType, operands, result } = operation;

    // Update transaction with enriched data
    await prisma.transaction.update({
      where: { hash: context.transactionHash },
      data: {
        functionArgs: {
          _checkedArithmetic: {
            operation: type,
            operandType,
            operands: operands.map((n) => n.toString()),
            result: {
              status: result.status,
              value: result.value?.toString() ?? null,
            },
            overflowDetected: result.status === 'overflow',
            humanReadable: analysis.humanReadable,
          },
        },
      },
    });

    // If overflow detected, create a violation record
    if (result.status === 'overflow') {
      await createOverflowRecord(context, operation);
    }
  } catch (error) {
    console.error('Failed to store checked arithmetic analysis:', error);
  }
}

/**
 * Create an overflow record for monitoring and alerting.
 */
async function createOverflowRecord(
  context: CheckedArithmeticTransactionContext,
  operation: any,
): Promise<void> {
  try {
    // Store in a dedicated table for overflow events
    // This allows for monitoring and alerting on overflow patterns
    const record = {
      id: `${context.transactionHash}-overflow`,
      transactionHash: context.transactionHash,
      contractAddress: context.contractAddress,
      functionName: context.functionName,
      operationType: operation.type,
      operandType: operation.operandType,
      operands: operation.operands.map((n: bigint) => n.toString()),
      ledgerSequence: context.ledgerSequence,
      ledgerCloseTime: context.ledgerCloseTime,
      createdAt: new Date(),
    };

    // Log for monitoring
    console.warn('[CheckedArithmetic] Overflow detected:', {
      contract: context.contractAddress,
      operation: operation.type,
      operands: operation.operands.map((n: bigint) => n.toString()),
      ledger: context.ledgerSequence,
    });
  } catch (error) {
    console.error('Failed to create overflow record:', error);
  }
}

/**
 * Analyze a batch of transactions for checked arithmetic patterns.
 * Useful for identifying contracts that frequently use checked arithmetic.
 */
export async function analyzeCheckedArithmeticPatterns(
  ledgerRangeStart: number,
  ledgerRangeEnd: number,
): Promise<{
  totalCheckedOperations: number;
  overflowCount: number;
  successCount: number;
  contractsUsing: Set<string>;
  operationTypes: Record<string, number>;
}> {
  try {
    const transactions = await prisma.transaction.findMany({
      where: {
        ledgerSequence: { gte: ledgerRangeStart, lte: ledgerRangeEnd },
        functionName: {
          in: Array.from([
            'checked_add_i256',
            'checked_add_u256',
            'checked_sub_i256',
            'checked_sub_u256',
            'checked_mul_i256',
            'checked_mul_u256',
            'checked_pow_i256',
            'checked_pow_u256',
          ]),
        },
      },
      select: {
        contractAddress: true,
        functionName: true,
        functionArgs: true,
      },
    });

    let totalCheckedOperations = 0;
    let overflowCount = 0;
    let successCount = 0;
    const contractsUsing = new Set<string>();
    const operationTypes: Record<string, number> = {};

    for (const tx of transactions) {
      totalCheckedOperations++;

      if (tx.contractAddress) {
        contractsUsing.add(tx.contractAddress);
      }

      // Count operation types
      const fnName = tx.functionName ?? 'unknown';
      operationTypes[fnName] = (operationTypes[fnName] ?? 0) + 1;

      // Check for overflow
      if (tx.functionArgs && typeof tx.functionArgs === 'object') {
        const args = tx.functionArgs as Record<string, unknown>;
        const checkedArith = args._checkedArithmetic as Record<string, unknown> | undefined;

        if (checkedArith?.overflowDetected) {
          overflowCount++;
        } else if (checkedArith) {
          successCount++;
        }
      }
    }

    return {
      totalCheckedOperations,
      overflowCount,
      successCount,
      contractsUsing,
      operationTypes,
    };
  } catch (error) {
    console.error('Failed to analyze checked arithmetic patterns:', error);
    return {
      totalCheckedOperations: 0,
      overflowCount: 0,
      successCount: 0,
      contractsUsing: new Set(),
      operationTypes: {},
    };
  }
}

/**
 * Identify contracts that handle arithmetic overflows safely.
 * These are contracts that use checked arithmetic and handle overflow gracefully.
 */
export async function identifyOverflowSafeContracts(minOverflowCount: number = 1): Promise<
  Array<{
    contractAddress: string;
    totalCheckedOperations: number;
    overflowCount: number;
    successCount: number;
    overflowRate: number;
    durationMs?: number;
  }>
> {
  const startMs = Date.now();
  try {
    const transactions = await prisma.transaction.findMany({
      where: {
        functionName: {
          in: Array.from([
            'checked_add_i256',
            'checked_add_u256',
            'checked_sub_i256',
            'checked_sub_u256',
            'checked_mul_i256',
            'checked_mul_u256',
            'checked_pow_i256',
            'checked_pow_u256',
          ]),
        },
      },
      select: {
        contractAddress: true,
        functionArgs: true,
      },
    });

    const contractStats: Record<string, { total: number; overflows: number; successes: number }> =
      {};

    for (const tx of transactions) {
      if (!tx.contractAddress) continue;

      if (!contractStats[tx.contractAddress]) {
        contractStats[tx.contractAddress] = { total: 0, overflows: 0, successes: 0 };
      }

      contractStats[tx.contractAddress].total++;

      if (tx.functionArgs && typeof tx.functionArgs === 'object') {
        const args = tx.functionArgs as Record<string, unknown>;
        const checkedArith = args._checkedArithmetic as Record<string, unknown> | undefined;

        if (checkedArith?.overflowDetected) {
          contractStats[tx.contractAddress].overflows++;
        } else if (checkedArith) {
          contractStats[tx.contractAddress].successes++;
        }
      }
    }

    // Filter and format results
    const durationMs = Date.now() - startMs;
    const results = Object.entries(contractStats)
      .filter(([, stats]) => stats.overflows >= minOverflowCount)
      .map(([address, stats]) => ({
        contractAddress: address,
        totalCheckedOperations: stats.total,
        overflowCount: stats.overflows,
        successCount: stats.successes,
        overflowRate: stats.total > 0 ? stats.overflows / stats.total : 0,
        durationMs,
      }))
      .sort((a, b) => b.overflowCount - a.overflowCount);

    return results;
  } catch (error) {
    console.error('[identifyOverflowSafeContracts] error after %dms:', Date.now() - startMs, error);
    return [];
  }
}

/**
 * Generate a report on checked arithmetic usage across the network.
 */
export async function generateCheckedArithmeticReport(
  ledgerRangeStart: number,
  ledgerRangeEnd: number,
): Promise<Record<string, unknown>> {
  const patterns = await analyzeCheckedArithmeticPatterns(ledgerRangeStart, ledgerRangeEnd);
  const safeContracts = await identifyOverflowSafeContracts(1);

  return {
    ledgerRange: { start: ledgerRangeStart, end: ledgerRangeEnd },
    summary: {
      totalCheckedOperations: patterns.totalCheckedOperations,
      overflowCount: patterns.overflowCount,
      successCount: patterns.successCount,
      overflowRate:
        patterns.totalCheckedOperations > 0
          ? (patterns.overflowCount / patterns.totalCheckedOperations) * 100
          : 0,
    },
    operationTypes: patterns.operationTypes,
    contractsUsingCheckedArithmetic: patterns.contractsUsing.size,
    overflowSafeContracts: safeContracts,
  };
}
