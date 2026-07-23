import crypto from 'crypto';
import { prismaWrite, prismaRead } from '../db';
import { agentEngine } from './engine';
import { logger } from '../logger';

interface VerificationResult {
  executionId: string;
  verifierNode: string;
  status: 'verified' | 'flagged';
  discrepancy?: string;
  signature: string;
}

class AgentVerificationNetwork {
  private static instance: AgentVerificationNetwork;
  private verifierNodes: Map<string, { name: string; publicKey: string; isActive: boolean }> =
    new Map();
  private verifierThreshold = 3; // Number of verifiers needed for consensus

  static getInstance(): AgentVerificationNetwork {
    if (!AgentVerificationNetwork.instance) {
      AgentVerificationNetwork.instance = new AgentVerificationNetwork();
    }
    return AgentVerificationNetwork.instance;
  }

  registerVerifierNode(nodeId: string, name: string, publicKey: string): void {
    this.verifierNodes.set(nodeId, { name, publicKey, isActive: true });
    logger.info(`Verifier node registered: ${name} (${nodeId})`);
  }

  async submitVerification(params: VerificationResult): Promise<void> {
    // Verify the verifier's signature
    if (!this.verifyVerifierSignature(params)) {
      throw new Error(`Invalid verifier signature from ${params.verifierNode}`);
    }

    await prismaWrite.agentVerification.create({
      data: {
        executionId: params.executionId,
        verifierNode: params.verifierNode,
        status: params.status,
        discrepancy: params.discrepancy ? { message: params.discrepancy } : (null as any),
        signature: params.signature,
        verifiedAt: new Date(),
      },
    });

    // Check if we have enough verifications
    await this.checkVerificationThreshold(params.executionId);
  }

  async verifyExecutionTrace(
    executionId: string,
    verifierNode: string,
  ): Promise<VerificationResult> {
    const execution = await prismaRead.agentExecution.findUnique({
      where: { id: executionId },
      include: { agent: true },
    });

    if (!execution) throw new Error(`Execution ${executionId} not found`);
    if (!execution.trace) throw new Error(`Execution ${executionId} has no trace`);

    // Replay the execution from the captured input state
    const result = await this.replayExecution(execution);

    const storedHash = execution.traceHash as string;
    const expectedHash = result.expectedHash;

    const isMatch = storedHash === expectedHash;
    const status = isMatch ? 'verified' : 'flagged';
    const discrepancy = isMatch
      ? undefined
      : `Trace hash mismatch: expected ${expectedHash}, got ${storedHash}`;

    const verificationResult: VerificationResult = {
      executionId,
      verifierNode,
      status,
      discrepancy,
      signature: this.signVerification(executionId, verifierNode, status),
    };

    await this.submitVerification(verificationResult);

    if (!isMatch) {
      logger.warn(`Execution ${executionId} flagged by ${verifierNode}: hash mismatch`);
    }

    return verificationResult;
  }

  private async replayExecution(
    execution: Record<string, unknown>,
  ): Promise<{ expectedHash: string }> {
    const trace = (execution.trace as Record<string, unknown>) || {};
    const inputState = (execution.inputState as Record<string, unknown>) || {};
    const steps = (trace.steps as Array<Record<string, unknown>>) || [];
    const outputAction = (trace.outputAction as Record<string, unknown>) || null;

    // Recompute the final state hash exactly as executeAgent did:
    // crypto.createHash('sha256').update(JSON.stringify({ ...inputState, outputAction, steps })).digest('hex')
    const replayHash = crypto
      .createHash('sha256')
      .update(JSON.stringify({ ...this.sortObject(inputState), outputAction, steps }))
      .digest('hex');

    return { expectedHash: replayHash };
  }

  private async checkVerificationThreshold(executionId: string): Promise<void> {
    const verifications = await prismaRead.agentVerification.findMany({
      where: { executionId },
    });

    if (verifications.length >= this.verifierThreshold) {
      const flagged = verifications.filter((v) => v.status === 'flagged').length;
      const verified = verifications.filter((v) => v.status === 'verified').length;

      const isVerified = verified > flagged;

      await prismaWrite.agentExecution.update({
        where: { id: executionId },
        data: {
          isVerified,
          verifiedBy: verifications.length,
          verifiedCount: verified,
          flaggedCount: flagged,
        },
      });

      if (flagged > 0) {
        const agentId = (
          await prismaRead.agentExecution.findUnique({
            where: { id: executionId },
            select: { agentId: true },
          })
        )?.agentId;
        if (agentId) {
          await agentEngine.createAlert(
            agentId,
            'verification_failure',
            'critical',
            `Execution ${executionId} flagged by ${flagged}/${verifications.length} verification nodes`,
          );
        }
      }
    }
  }

  async getVerificationStatus(executionId: string) {
    const execution = await prismaRead.agentExecution.findUnique({
      where: { id: executionId },
      select: {
        id: true,
        traceHash: true,
        isVerified: true,
        verifiedBy: true,
        verifiedCount: true,
        flaggedCount: true,
        signature: true,
      },
    });

    const verifications = await prismaRead.agentVerification.findMany({
      where: { executionId },
      orderBy: { createdAt: 'desc' },
    });

    return {
      execution: execution || null,
      verifications,
      totalVerifiers: verifications.length,
      consensusReached: (execution?.verifiedBy || 0) >= this.verifierThreshold,
    };
  }

  async getVerificationSummary(agentId: string) {
    const executions = await prismaRead.agentExecution.findMany({
      where: { agentId },
      select: {
        id: true,
        traceHash: true,
        isVerified: true,
        verifiedBy: true,
        verifiedCount: true,
        flaggedCount: true,
        createdAt: true,
      },
    });

    const totalExecutions = executions.length;
    const verifiedExecutions = executions.filter((e) => e.isVerified).length;
    const flaggedExecutions = executions.filter((e) => !e.isVerified && e.verifiedBy > 0).length;
    const pendingVerification = executions.filter((e) => e.verifiedBy === 0).length;

    return {
      totalExecutions,
      verifiedExecutions,
      flaggedExecutions,
      pendingVerification,
      verificationRate:
        totalExecutions > 0 ? Math.round((verifiedExecutions / totalExecutions) * 10000) / 100 : 0,
      executions: executions.slice(0, 10),
    };
  }

  private signVerification(executionId: string, verifierNode: string, status: string): string {
    const content = `${executionId}:${verifierNode}:${status}:${Date.now()}`;
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  private verifyVerifierSignature(result: VerificationResult): boolean {
    const verifier = this.verifierNodes.get(result.verifierNode);
    if (!verifier || !verifier.isActive) return false;

    // In production: verify Ed25519 signature
    // For now: simplified check
    const expectedSig = this.signVerification(
      result.executionId,
      result.verifierNode,
      result.status,
    );
    return result.signature === expectedSig;
  }

  private sortObject(obj: Record<string, unknown>): Record<string, unknown> {
    if (typeof obj !== 'object' || obj === null) return obj;
    if (Array.isArray(obj)) {
      return obj.map((item) =>
        typeof item === 'object' && item !== null
          ? this.sortObject(item as Record<string, unknown>)
          : item,
      ) as unknown as Record<string, unknown>;
    }
    const sorted: Record<string, unknown> = {};
    Object.keys(obj)
      .sort()
      .forEach((key) => {
        sorted[key] =
          typeof obj[key] === 'object' && obj[key] !== null
            ? this.sortObject(obj[key] as Record<string, unknown>)
            : obj[key];
      });
    return sorted;
  }
}

export const verificationNetwork = AgentVerificationNetwork.getInstance();
