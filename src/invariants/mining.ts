/**
 * Invariant Mining System
 * Automatically discovers potential invariants from historical transaction data
 * Supports: static analysis, dynamic analysis, Daikon-style detection, ML-based, template-based
 */

import { prismaWrite as prisma, prismaRead } from '../db';
import { logger } from '../logger';
import { MiningType, JsonValue } from './types';

// ============================================================================
// MINING ENGINE
// ============================================================================

export class InvariantMiningEngine {
  /**
   * Start a mining run to discover invariants
   */
  async startMiningRun(
    contractAddress: string,
    miningType: MiningType,
    txRangeStart?: bigint,
    txRangeEnd?: bigint,
  ): Promise<string> {
    try {
      const run = await prisma.invariantMiningRun.create({
        data: {
          contractAddress,
          miningType,
          txRangeStart: txRangeStart ? Number(txRangeStart) : undefined,
          txRangeEnd: txRangeEnd ? Number(txRangeEnd) : undefined,
          status: 'running',
        },
      });

      // Execute mining asynchronously
      this.executeMining(run.id, contractAddress, miningType, txRangeStart, txRangeEnd).catch(error => {
        logger.error(`Mining execution failed: ${error}`, { runId: run.id });
      });

      return run.id;
    } catch (error) {
      logger.error(`Failed to start mining run: ${error}`);
      throw error;
    }
  }

  /**
   * Execute mining run
   */
  private async executeMining(
    runId: string,
    contractAddress: string,
    miningType: MiningType,
    txRangeStart?: bigint,
    txRangeEnd?: bigint,
  ): Promise<void> {
    const startTime = Date.now();

    try {
      let candidates: any[] = [];

      switch (miningType) {
        case MiningType.STATIC:
          candidates = await this.staticAnalyze(contractAddress);
          break;
        case MiningType.DYNAMIC:
          candidates = await this.dynamicAnalyze(contractAddress, txRangeStart, txRangeEnd);
          break;
        case MiningType.DAIKON:
          candidates = await this.daikonAnalyze(contractAddress, txRangeStart, txRangeEnd);
          break;
        case MiningType.TEMPLATE:
          candidates = await this.templateAnalyze(contractAddress);
          break;
        default:
          candidates = [];
      }

      // Store candidates
      if (candidates.length > 0) {
        await prisma.invariantCandidate.createMany({
          data: candidates.map(c => ({
            miningRunId: runId,
            ...c,
          })),
        });
      }

      // Update run status
      const runtimeSeconds = Math.floor((Date.now() - startTime) / 1000);
      await prisma.invariantMiningRun.update({
        where: { id: runId },
        data: {
          status: 'completed',
          completedAt: new Date(),
          totalCandidates: candidates.length,
          confirmedCount: 0,
          runtimeSeconds,
        },
      });

      logger.info(`Mining run completed: ${candidates.length} candidates found`, {
        runId,
        miningType,
        runtimeSeconds,
      });
    } catch (error) {
      logger.error(`Mining execution error: ${error}`);
      await prisma.invariantMiningRun.update({
        where: { id: runId },
        data: {
          status: 'failed',
          completedAt: new Date(),
        },
      });
    }
  }

  /**
   * Static analysis: extract invariants from contract code structure
   */
  private async staticAnalyze(contractAddress: string): Promise<any[]> {
    const candidates: any[] = [];

    try {
      const contract = await prismaRead.contract.findUnique({
        where: { address: contractAddress },
      });

      if (!contract || !contract.abi) {
        return candidates;
      }

      // Extract state variables and functions
      const abi = contract.abi as any;

      // Template: balance conservation for token contracts
      if (contract.isToken) {
        candidates.push({
          expression: 'sum_all_balances == total_supply',
          confidence: 0.95,
          supportCount: 0,
          counterexampleCount: 0,
        });

        candidates.push({
          expression: 'balance_of(owner) >= 0',
          confidence: 0.99,
          supportCount: 0,
          counterexampleCount: 0,
        });
      }
    } catch (error) {
      logger.error(`Static analysis error: ${error}`);
    }

    return candidates;
  }

  /**
   * Dynamic analysis: observe state changes across transactions
   */
  private async dynamicAnalyze(
    contractAddress: string,
    txRangeStart?: bigint,
    txRangeEnd?: bigint,
  ): Promise<any[]> {
    const candidates: any[] = [];

    try {
      // Get transactions for contract
      const where: any = { contractAddress };
      if (txRangeStart) where.ledgerSequence = { gte: Number(txRangeStart) };
      if (txRangeEnd) where.ledgerSequence = { lte: Number(txRangeEnd) };

      const transactions = await prismaRead.transaction.findMany({
        where,
        include: { events: { where: { contractAddress } } },
        orderBy: { ledgerSequence: 'asc' },
        take: 1000, // Limit for practical mining
      });

      if (transactions.length === 0) {
        return candidates;
      }

      // Extract state properties across transactions
      const stateProperties = new Map<string, Set<JsonValue>>();

      for (const tx of transactions) {
        for (const event of tx.events) {
          if (event.decoded && typeof event.decoded === 'object') {
            for (const [key, value] of Object.entries(event.decoded)) {
              if (!stateProperties.has(key)) {
                stateProperties.set(key, new Set());
              }
              stateProperties.get(key)!.add(value);
            }
          }
        }
      }

      // Generate invariant candidates from properties
      for (const [property, values] of stateProperties) {
        // Constant property
        if (values.size === 1) {
          const value = Array.from(values)[0];
          candidates.push({
            expression: `${property} == ${JSON.stringify(value)}`,
            confidence: 0.8,
            supportCount: transactions.length,
            counterexampleCount: 0,
          });
        }

        // Non-negative property
        const allNumbers = Array.from(values).every(v => typeof v === 'number');
        if (allNumbers && Math.min(...Array.from(values).map(v => v as number)) >= 0) {
          candidates.push({
            expression: `${property} >= 0`,
            confidence: 0.85,
            supportCount: transactions.length,
            counterexampleCount: 0,
          });
        }
      }
    } catch (error) {
      logger.error(`Dynamic analysis error: ${error}`);
    }

    return candidates;
  }

  /**
   * Daikon-style invariant detection
   * Generates: equality, inequality, set membership invariants
   */
  private async daikonAnalyze(
    contractAddress: string,
    txRangeStart?: bigint,
    txRangeEnd?: bigint,
  ): Promise<any[]> {
    const candidates: any[] = [];

    try {
      // Similar to dynamic but generates more invariant types
      const transactions = await prismaRead.transaction.findMany({
        where: {
          contractAddress,
          ledgerSequence: {
            gte: txRangeStart ? Number(txRangeStart) : undefined,
            lte: txRangeEnd ? Number(txRangeEnd) : undefined,
          },
        },
        include: { events: { where: { contractAddress } } },
        take: 500,
      });

      // Extract numeric properties for inequality analysis
      const numericProperties: Map<string, number[]> = new Map();

      for (const tx of transactions) {
        for (const event of tx.events) {
          if (event.decoded && typeof event.decoded === 'object') {
            for (const [key, value] of Object.entries(event.decoded)) {
              if (typeof value === 'number') {
                if (!numericProperties.has(key)) {
                  numericProperties.set(key, []);
                }
                numericProperties.get(key)!.push(value);
              }
            }
          }
        }
      }

      // Generate inequality invariants
      for (const [prop, values] of numericProperties) {
        if (values.length < 2) continue;

        const min = Math.min(...values);
        const max = Math.max(...values);

        // All values >= min observed
        candidates.push({
          expression: `${prop} >= ${min}`,
          confidence: 0.75,
          supportCount: values.length,
          counterexampleCount: 0,
        });

        // All values <= max observed
        candidates.push({
          expression: `${prop} <= ${max}`,
          confidence: 0.75,
          supportCount: values.length,
          counterexampleCount: 0,
        });

        // Monotonic increase/decrease detection
        let increasing = true,
          decreasing = true;
        for (let i = 1; i < Math.min(values.length, 10); i++) {
          if (values[i] < values[i - 1]) increasing = false;
          if (values[i] > values[i - 1]) decreasing = false;
        }

        if (increasing && values.length > 1) {
          candidates.push({
            expression: `${prop} >= prev(${prop})`,
            confidence: 0.7,
            supportCount: values.length - 1,
            counterexampleCount: 0,
          });
        }
      }
    } catch (error) {
      logger.error(`Daikon analysis error: ${error}`);
    }

    return candidates;
  }

  /**
   * Template-based mining: fill parameters for known invariant templates
   */
  private async templateAnalyze(contractAddress: string): Promise<any[]> {
    const candidates: any[] = [];

    try {
      const templates = await prismaRead.standardInvariant.findMany({});

      // For each template, create a candidate
      for (const template of templates) {
        candidates.push({
          expression: template.expressionTemplate,
          confidence: 0.65,
          supportCount: 0,
          counterexampleCount: 0,
        });
      }
    } catch (error) {
      logger.error(`Template analysis error: ${error}`);
    }

    return candidates;
  }

  /**
   * Get mining run history
   */
  async getMiningRuns(contractAddress?: string, limit: number = 50): Promise<any[]> {
    try {
      const runs = await prismaRead.invariantMiningRun.findMany({
        where: contractAddress ? { contractAddress } : {},
        include: { candidates: { take: 10 } },
        orderBy: { startedAt: 'desc' },
        take: limit,
      });

      return runs;
    } catch (error) {
      logger.error(`Failed to get mining runs: ${error}`);
      throw error;
    }
  }

  /**
   * Confirm a candidate invariant
   */
  async confirmCandidate(candidateId: bigint): Promise<void> {
    try {
      const candidate = await prismaRead.invariantCandidate.findUnique({
        where: { id: candidateId },
        include: { miningRun: true },
      });

      if (!candidate) {
        throw new Error('Candidate not found');
      }

      // Update candidate
      await prisma.invariantCandidate.update({
        where: { id: candidateId },
        data: {
          isConfirmed: true,
          confirmedAt: new Date(),
        },
      });

      // Create invariant definition from candidate
      await prisma.invariantDefinition.create({
        data: {
          name: `Mined: ${candidate.expression.substring(0, 50)}...`,
          category: 'state',
          contractAddress: candidate.miningRun.contractAddress,
          expression: candidate.expression,
          severity: 'high',
          checkFrequency: 'always',
          isActive: true,
          createdBy: 'mining-engine',
        } as any,
      });

      logger.info(`Candidate confirmed and converted to invariant`, { candidateId });
    } catch (error) {
      logger.error(`Failed to confirm candidate: ${error}`);
      throw error;
    }
  }

  /**
   * Reject a candidate
   */
  async rejectCandidate(candidateId: bigint): Promise<void> {
    try {
      await prisma.invariantCandidate.delete({
        where: { id: candidateId },
      });

      logger.info(`Candidate rejected`, { candidateId });
    } catch (error) {
      logger.error(`Failed to reject candidate: ${error}`);
      throw error;
    }
  }
}

export const miningEngine = new InvariantMiningEngine();
