import { prismaRead } from '../db';
import { SandboxEngine } from './runtime';

export interface ReplayComparison {
  equal: boolean;
  reason: string;
  txHash: string;
  eventsMatch: boolean;
  stateMatch: boolean;
  gasMatch: boolean;
  eventDiff?: unknown;
  stateDiff?: unknown;
  gasDiff?: unknown;
}

export interface ReplayStep {
  opIndex: number;
  hostFunction: string;
  args: unknown;
  result: unknown;
  gasUsed: number;
}

export interface ReplayResult {
  txHash: string;
  comparison: ReplayComparison;
  steps: ReplayStep[];
  sandboxSessionId?: string;
}

export const UNSUPPORTED_HOST_FUNCTIONS = new Set([
  'get_contract_code',
  'upload_contract_wasm',
  'create_contract',
  'invoke_host_function',
  'verify_ed25519_sig',
  'verify_soroban_auth',
  'crypto_sha256',
  'crypto_ed25519_verify',
  'crypto_ecdsa_secp256r1_verify',
  'require_auth',
  'require_auth_for_args',
  'get_auth_context',
]);

export async function replayMainnet(txHash: string): Promise<ReplayResult> {
  const tx = await prismaRead.transaction.findUnique({
    where: { hash: txHash },
    include: {
      operations: {
        orderBy: { index: 'asc' },
      },
    },
  });

  if (!tx) {
    return {
      txHash,
      comparison: {
        equal: false,
        reason: 'transaction not found in indexer',
        eventsMatch: false,
        stateMatch: false,
        gasMatch: false,
      },
      steps: [],
    };
  }

  const steps: ReplayStep[] = [];
  let totalGasUsed = 0;

  for (const op of tx.operations) {
    if (op.type !== 'invoke_host_function') {
      steps.push({
        opIndex: op.index,
        hostFunction: op.type,
        args: op.args,
        result: null,
        gasUsed: 0,
      });
      continue;
    }

    const hostFn = (op.args as any)?.hostFunction as string;
    if (UNSUPPORTED_HOST_FUNCTIONS.has(hostFn)) {
      steps.push({
        opIndex: op.index,
        hostFunction,
        args: op.args,
        result: null,
        gasUsed: 0,
      });
      continue;
    }

    steps.push({
      opIndex: op.index,
      hostFunction,
      args: op.args,
      result: { simulated: true },
      gasUsed: 100,
    });
    totalGasUsed += 100;
  }

  const hasUnsupported = steps.some((s) => UNSUPPORTED_HOST_FUNCTIONS.has(s.hostFunction));

  return {
    txHash,
    comparison: {
      equal: false,
      reason: hasUnsupported
        ? 'host function not implemented in sandbox substrate'
        : 'sandbox substrate is not a WASM runtime; replay is simulated against JS template engine',
      eventsMatch: false,
      stateMatch: false,
      gasMatch: false,
    },
    steps,
  };
}

export async function replayAgainstSandbox(
  txHash: string,
  sandboxEngine: SandboxEngine,
  sessionId: string,
): Promise<ReplayResult> {
  const baseResult = await replayMainnet(txHash);
  return {
    ...baseResult,
    sandboxSessionId: sessionId,
  };
}
