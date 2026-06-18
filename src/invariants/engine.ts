/**
 * Core Invariant Checking Engine
 * Executes invariant expressions against contract state snapshots
 * Handles state extraction, evaluation, result recording, and violation detection
 */

import { prismaWrite as prisma } from '../db';
import { logger } from '../logger';
import { ExpressionCompiler } from './parser';
import {
  InvariantDefinitionDTO,
  InvariantCheckResultDTO,
  InvariantCheckResultInput,
  InvariantViolationInput,
  ContractStateSnapshot,
  JsonValue,
  ExpressionContext,
} from './types';

// ============================================================================
// INVARIANT CHECKER
// ============================================================================

export class InvariantChecker {
  private compiler: ExpressionCompiler;

  constructor() {
    this.compiler = new ExpressionCompiler();
  }

  /**
   * Check a single invariant against contract state
   */
  async checkInvariant(
    invariantDef: InvariantDefinitionDTO,
    contractState: ContractStateSnapshot,
    txHash: string,
  ): Promise<{ passed: boolean; executionTimeMs: number; gasUsed?: string; error?: string }> {
    const startTime = Date.now();

    try {
      // Compile expression once
      const evaluator = this.compiler.compile(invariantDef.expression);

      // Prepare context with state variables
      const context: Partial<ExpressionContext> = {
        state: contractState.state,
        variables: new Map(Object.entries(contractState.state)),
      };

      // Set custom functions (contract-specific getters)
      if (context.variables) {
        context.variables.set('caller', null);
        context.variables.set('owner', contractState.state['owner'] || null);
        context.variables.set('timestamp', contractState.timestamp.getTime());
        context.variables.set('block_number', Number(contractState.blockNumber));
      }

      // Evaluate expression with timeout
      const result = await this.evaluateWithTimeout(evaluator, context, invariantDef.timeoutMs || 5000);

      const executionTimeMs = Date.now() - startTime;

      if (typeof result !== 'boolean') {
        throw new Error(`Invariant expression must evaluate to boolean, got ${typeof result}`);
      }

      return {
        passed: result,
        executionTimeMs,
      };
    } catch (error) {
      const executionTimeMs = Date.now() - startTime;
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.warn(`Error checking invariant ${invariantDef.id}: ${errorMsg}`, {
        invariantId: invariantDef.id,
        txHash,
        error: errorMsg,
      });

      return {
        passed: false,
        executionTimeMs,
        error: errorMsg,
      };
    }
  }

  /**
   * Check multiple invariants for a contract
   */
  async checkInvariants(
    invariants: InvariantDefinitionDTO[],
    contractState: ContractStateSnapshot,
    txHash: string,
  ): Promise<Map<string, InvariantCheckResultDTO>> {
    const results = new Map<string, InvariantCheckResultDTO>();

    for (const invariant of invariants) {
      const checkResult = await this.checkInvariant(invariant, contractState, txHash);

      // Record check result
      const dbResult = await prisma.invariantCheckResult.create({
        data: {
          invariantId: invariant.id,
          txHash,
          blockNumber: contractState.blockNumber,
          timestamp: contractState.timestamp,
          result: checkResult.passed,
          executionTimeMs: checkResult.executionTimeMs,
          errorMessage: checkResult.error,
          stateSnapshot: contractState.state as any,
        },
      });

      // Create violation record if check failed
      if (!checkResult.passed) {
        await this.recordViolation(invariant, dbResult, contractState, txHash);
      }

      results.set(invariant.id, dbResult as InvariantCheckResultDTO);
    }

    return results;
  }

  /**
   * Record a violation when an invariant fails
   */
  async recordViolation(
    invariant: InvariantDefinitionDTO,
    checkResult: any,
    contractState: ContractStateSnapshot,
    txHash: string,
  ): Promise<void> {
    try {
      const violationInput: InvariantViolationInput = {
        invariantId: invariant.id,
        checkResultId: checkResult.id,
        txHash,
        blockNumber: contractState.blockNumber,
        timestamp: contractState.timestamp,
        severity: invariant.severity as any,
        status: 'open' as any,
        stateBefore: contractState.state,
        stateAfter: contractState.state,
      };

      await prisma.invariantViolation.create({
        data: violationInput as any,
      });

      // Trigger alerts
      await this.triggerAlerts(invariant.id);

      logger.error(`Invariant violation detected: ${invariant.name}`, {
        invariantId: invariant.id,
        txHash,
        severity: invariant.severity,
      });
    } catch (error) {
      logger.error(`Failed to record violation: ${error}`, {
        invariantId: invariant.id,
        error,
      });
    }
  }

  /**
   * Trigger alerts for violated invariant
   */
  private async triggerAlerts(invariantId: string): Promise<void> {
    try {
      // Get all alert rules for this invariant
      const alertRules = await prisma.invariantAlertRule.findMany({
        where: { invariantId },
      });

      for (const alertRule of alertRules) {
        // Check if we should escalate based on recent violations
        const recentViolations = await prisma.invariantViolation.findMany({
          where: {
            invariantId,
            createdAt: {
              gte: new Date(Date.now() - alertRule.escalateWindowMinutes * 60 * 1000),
            },
          },
        });

        if (recentViolations.length >= alertRule.escalateAfterCount) {
          logger.warn(`Alert escalation triggered for invariant ${invariantId}`, {
            violationCount: recentViolations.length,
            threshold: alertRule.escalateAfterCount,
          });
        }
      }
    } catch (error) {
      logger.error(`Failed to trigger alerts: ${error}`);
    }
  }

  /**
   * Evaluate expression with timeout protection
   */
  private async evaluateWithTimeout(
    evaluator: (context: Partial<ExpressionContext>) => JsonValue,
    context: Partial<ExpressionContext>,
    timeoutMs: number,
  ): Promise<JsonValue> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Expression evaluation timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      try {
        const result = evaluator(context);
        clearTimeout(timeoutId);
        resolve(result);
      } catch (error) {
        clearTimeout(timeoutId);
        reject(error);
      }
    });
  }
}

// ============================================================================
// STATE EXTRACTOR
// ============================================================================

export class StateExtractor {
  /**
   * Extract contract state from transaction event logs
   */
  async extractStateFromEvents(contractAddress: string, txHash: string, blockNumber: bigint): Promise<ContractStateSnapshot> {
    try {
      const transaction = await prisma.transaction.findUnique({
        where: { hash: txHash },
        include: {
          events: {
            where: { contractAddress },
          },
        },
      });

      if (!transaction) {
        throw new Error(`Transaction not found: ${txHash}`);
      }

      // Extract state from events
      const state: Record<string, JsonValue> = {
        contractAddress,
        blockNumber: Number(blockNumber),
        timestamp: transaction.ledgerCloseTime.getTime(),
        functionName: transaction.functionName || '',
        sourceAccount: transaction.sourceAccount,
      };

      // Parse events for state variables
      for (const event of transaction.events) {
        if (event.decoded && typeof event.decoded === 'object') {
          Object.assign(state, event.decoded);
        }
      }

      return {
        contractAddress,
        blockNumber,
        timestamp: transaction.ledgerCloseTime,
        state,
      };
    } catch (error) {
      logger.error(`Failed to extract state from events: ${error}`, {
        contractAddress,
        txHash,
        error,
      });

      // Return minimal state
      return {
        contractAddress,
        blockNumber,
        timestamp: new Date(),
        state: { contractAddress },
      };
    }
  }

  /**
   * Extract state from contract storage (if available)
   */
  async extractStateFromStorage(
    contractAddress: string,
    blockNumber: bigint,
  ): Promise<Record<string, JsonValue>> {
    // This would integrate with contract storage querying
    // For now, return empty state object
    return {
      contractAddress,
      blockNumber: Number(blockNumber),
      createdAt: new Date(),
    };
  }

  /**
   * Merge multiple state sources
   */
  mergeStates(...states: Record<string, JsonValue>[]): Record<string, JsonValue> {
    return states.reduce((merged, state) => ({ ...merged, ...state }), {});
  }
}

// ============================================================================
// BATCH CHECKER
// ============================================================================

export class BatchInvariantChecker {
  private checker: InvariantChecker;
  private extractor: StateExtractor;

  constructor() {
    this.checker = new InvariantChecker();
    this.extractor = new StateExtractor();
  }

  /**
   * Check all active invariants for a contract across multiple transactions
   */
  async checkContractInvariants(contractAddress: string, txHashes: string[]): Promise<void> {
    try {
      // Get all active invariants for contract
      const invariants = await prisma.invariantDefinition.findMany({
        where: {
          contractAddress,
          isActive: true,
        },
      });

      if (invariants.length === 0) {
        logger.debug(`No active invariants for contract ${contractAddress}`);
        return;
      }

      // Check each transaction
      for (const txHash of txHashes) {
        const tx = await prisma.transaction.findUnique({
          where: { hash: txHash },
        });

        if (!tx) continue;

        // Extract state
        const contractState = await this.extractor.extractStateFromEvents(
          contractAddress,
          txHash,
          BigInt(tx.ledgerSequence),
        );

        // Check invariants
        await this.checker.checkInvariants(invariants as InvariantDefinitionDTO[], contractState, txHash);
      }

      // Update monitoring statistics
      await this.updateMonitoringStats(contractAddress, invariants.length);
    } catch (error) {
      logger.error(`Batch checking failed: ${error}`, {
        contractAddress,
        error,
      });
    }
  }

  /**
   * Update monitoring statistics after checks
   */
  private async updateMonitoringStats(contractAddress: string, totalInvariants: number): Promise<void> {
    try {
      const results = await prisma.invariantCheckResult.groupBy({
        by: ['result'],
        where: {
          invariant: { contractAddress },
        },
        _count: {
          id: true,
        },
      });

      const totalChecks = results.reduce((sum, r) => sum + r._count.id, 0);
      const passedChecks = results.find(r => r.result === true)?._count.id || 0;
      const failedChecks = results.find(r => r.result === false)?._count.id || 0;

      // Calculate average execution time
      const avgTimeResult = await prisma.invariantCheckResult.aggregate({
        where: {
          invariant: { contractAddress },
        },
        _avg: {
          executionTimeMs: true,
        },
      });

      await prisma.monitoringStats.upsert({
        where: { contractAddress },
        update: {
          totalChecks: BigInt(totalChecks),
          passedChecks: BigInt(passedChecks),
          failedChecks: BigInt(failedChecks),
          avgCheckTimeMs: avgTimeResult._avg.executionTimeMs || undefined,
          lastCheckAt: new Date(),
        },
        create: {
          contractAddress,
          totalChecks: BigInt(totalChecks),
          passedChecks: BigInt(passedChecks),
          failedChecks: BigInt(failedChecks),
          avgCheckTimeMs: avgTimeResult._avg.executionTimeMs || undefined,
          lastCheckAt: new Date(),
        },
      });
    } catch (error) {
      logger.error(`Failed to update monitoring stats: ${error}`);
    }
  }
}

// ============================================================================
// VERIFICATION SERVICE (Singleton)
// ============================================================================

export const invariantChecker = new InvariantChecker();
export const stateExtractor = new StateExtractor();
export const batchChecker = new BatchInvariantChecker();
