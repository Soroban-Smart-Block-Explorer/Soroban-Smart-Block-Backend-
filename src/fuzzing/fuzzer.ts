import { buildCorpusFromHistory, CorpusEntry, getBoundaryValues } from './corpus';
import { generateMutations } from './mutator';
import { rpc } from '../indexer/rpc';
import {
  TransactionBuilder,
  SorobanRpc,
  Contract,
  Account,
  xdr,
  BASE_FEE,
} from '@stellar/stellar-sdk';
import { config } from '../config';
import { getCachedAbi } from '../indexer/abi-cache';
import { prismaWrite, prismaRead } from '../db';
import { logger } from '../logger';

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface FuzzFinding {
  functionName: string;
  args: unknown[];
  mutation: string;
  result: string;
  error?: string;
  severity: FindingSeverity;
  exploitable: boolean;
  regressionTest?: string;
}

export interface FuzzReport {
  contractAddress: string;
  totalCases: number;
  executed: number;
  findings: FuzzFinding[];
  coverage: number;
  durationMs: number;
  startedAt: string;
  completedAt: string;
}

const DUMMY_ACCOUNT = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';

async function getOrMakeAccount(): Promise<Account> {
  try {
    return await rpc.getAccount(DUMMY_ACCOUNT);
  } catch {
    return new Account(DUMMY_ACCOUNT, '0');
  }
}

function argsToScVal(args: unknown[]): xdr.ScVal[] {
  return args.map((a) => {
    if (a === null || a === undefined) return xdr.ScVal.scvVoid();
    if (typeof a === 'boolean') return xdr.ScVal.scvBool(a);
    if (typeof a === 'number') {
      if (Number.isInteger(a) && a >= 0 && a <= 0xffffffff) return xdr.ScVal.scvU32(a);
      return xdr.ScVal.scvI32(Math.trunc(a));
    }
    if (typeof a === 'string') {
      if (/^-?\d+$/.test(a)) {
        const n = BigInt(a);
        const lo = n < 0n ? n + 2n ** 128n : n;
        return xdr.ScVal.scvI128(
          new xdr.Int128Parts({
            hi: new xdr.Int64(lo >> 64n),
            lo: new xdr.Uint64(lo & 0xffffffffffffffffn),
          }),
        );
      }
      return xdr.ScVal.scvString(Buffer.from(a, 'utf8'));
    }
    return xdr.ScVal.scvVoid();
  });
}

function classifyError(error: string | undefined): {
  severity: FindingSeverity;
  exploitable: boolean;
} {
  if (!error) return { severity: 'low', exploitable: false };
  const lower = error.toLowerCase();
  if (lower.includes('panic') || lower.includes('overflow') || lower.includes('underflow')) {
    return { severity: 'critical', exploitable: true };
  }
  if (lower.includes('auth') || lower.includes('permission') || lower.includes('unauthorized')) {
    return { severity: 'high', exploitable: true };
  }
  if (lower.includes('wasm') || lower.includes('host') || lower.includes('trap')) {
    return { severity: 'high', exploitable: true };
  }
  if (lower.includes('contract') && lower.includes('error')) {
    return { severity: 'medium', exploitable: false };
  }
  return { severity: 'low', exploitable: false };
}

function generateRegressionTest(finding: FuzzFinding): string {
  const argsJson = JSON.stringify(finding.args, null, 2);
  return `// Regression test for ${finding.severity} severity finding in ${finding.functionName}
// Mutation: ${finding.mutation}
// Expected: ${finding.result}
describe('${finding.functionName} fuzz regression', () => {
  it('handles boundary args without panic', async () => {
    const args = ${argsJson};
    // TODO: Set up contract and simulate call
    // expect(result).not.toContain('panic');
  });
});`;
}

async function simulateCall(
  contractAddress: string,
  functionName: string,
  args: unknown[],
  account: Account,
): Promise<{ result: string; error?: string }> {
  try {
    const scArgs = argsToScVal(args);
    const c = new Contract(contractAddress);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: config.networkPassphrase,
    })
      .addOperation(c.call(functionName, ...scArgs))
      .setTimeout(30)
      .build();

    const sim = await rpc.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(sim)) {
      return { result: 'simulation_error', error: sim.error };
    }
    return { result: 'success' };
  } catch (e) {
    const msg = String(e);
    return { result: 'exception', error: msg };
  }
}

async function getContractFunctions(contractAddress: string): Promise<string[]> {
  const abi = await getCachedAbi(contractAddress);
  if (abi) return abi.functions.map((f) => f.name);
  return ['transfer', 'balance', 'approve', 'mint', 'burn'];
}

export async function fuzzContract(
  contractAddress: string,
  options: { maxCases?: number; targetFunctions?: string[] } = {},
): Promise<FuzzReport> {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const maxCases = options.maxCases ?? 50;

  const corpus = await buildCorpusFromHistory(contractAddress);
  const account = await getOrMakeAccount();
  const functions = options.targetFunctions ?? (await getContractFunctions(contractAddress));

  const findings: FuzzFinding[] = [];
  let executed = 0;
  const seenPaths = new Set<string>();

  for (const fn of functions) {
    if (executed >= maxCases) break;
    const entries: CorpusEntry[] = corpus.byFunction.get(fn) ?? [{ functionName: fn, args: [] }];

    for (const entry of entries.slice(0, 5)) {
      if (executed >= maxCases) break;
      const mutations = generateMutations(entry.args);

      for (const { args: mutatedArgs, mutations: muts } of mutations.slice(
        0,
        Math.ceil(maxCases / functions.length),
      )) {
        if (executed >= maxCases) break;
        const pathKey = `${fn}:${JSON.stringify(mutatedArgs)}`;
        if (seenPaths.has(pathKey)) continue;
        seenPaths.add(pathKey);

        const { result, error } = await simulateCall(contractAddress, fn, mutatedArgs, account);
        executed++;

        const { severity, exploitable } = classifyError(error);
        if (exploitable || (error && !error.includes('account'))) {
          const finding: FuzzFinding = {
            functionName: fn,
            args: mutatedArgs,
            mutation: muts[0]?.strategy ?? 'unknown',
            result,
            error,
            severity,
            exploitable,
          };
          finding.regressionTest = generateRegressionTest(finding);
          findings.push(finding);
        }
      }
    }

    // Also try boundary values directly
    const boundaryArgs = functions.map(() => getBoundaryValues('u128')[2]);
    if (executed < maxCases) {
      const { result, error } = await simulateCall(contractAddress, fn, boundaryArgs, account);
      executed++;
      const { severity, exploitable } = classifyError(error);
      if (exploitable) {
        const finding: FuzzFinding = {
          functionName: fn,
          args: boundaryArgs,
          mutation: 'boundary_value',
          result,
          error,
          severity,
          exploitable,
        };
        finding.regressionTest = generateRegressionTest(finding);
        findings.push(finding);
      }
    }
  }

  const totalCases = executed;
  const coverage = Math.min(100, Math.round((seenPaths.size / Math.max(1, totalCases * 2)) * 100));

  return {
    contractAddress,
    totalCases,
    executed,
    findings,
    coverage,
    durationMs: Date.now() - startMs,
    startedAt,
    completedAt: new Date().toISOString(),
  };
}

// Store for async fuzz jobs
export interface FuzzJob {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  report?: FuzzReport;
  error?: string;
  startedAt: string;
  completedAt?: string;
}

export function startFuzzJob(
  contractAddress: string,
  options: { maxCases?: number; targetFunctions?: string[] } = {},
): string {
  const id = `fuzz_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  prismaWrite.fuzzJob
    .create({
      data: {
        id,
        contractAddress,
        status: 'running',
        startedAt: new Date(),
      },
    })
    .then(() => {
      fuzzContract(contractAddress, options)
        .then(async (report) => {
          await prismaWrite.fuzzJob
            .update({
              where: { id },
              data: {
                status: 'completed',
                report: report as any,
                completedAt: new Date(),
              },
            })
            .catch((err) => {
              logger.error(`[fuzzer] Failed to update completed job ${id} in DB:`, err);
            });
        })
        .catch(async (e) => {
          await prismaWrite.fuzzJob
            .update({
              where: { id },
              data: {
                status: 'failed',
                error: String(e),
                completedAt: new Date(),
              },
            })
            .catch((err) => {
              logger.error(`[fuzzer] Failed to update failed job ${id} in DB:`, err);
            });
        });
    })
    .catch((err) => {
      logger.error(`[fuzzer] Failed to create fuzz job ${id} in DB:`, err);
    });

  return id;
}

export async function getFuzzJob(id: string): Promise<FuzzJob | null> {
  const dbJob = await prismaRead.fuzzJob.findUnique({
    where: { id },
  });
  if (!dbJob) return null;
  return {
    id: dbJob.id,
    status: dbJob.status as 'running' | 'completed' | 'failed' | 'interrupted',
    report: dbJob.report ? (dbJob.report as unknown as FuzzReport) : undefined,
    error: dbJob.error || undefined,
    startedAt: dbJob.startedAt.toISOString(),
    completedAt: dbJob.completedAt?.toISOString() || undefined,
  };
}

export async function reconcileOrphanedFuzzJobs(): Promise<void> {
  try {
    const result = await prismaWrite.fuzzJob.updateMany({
      where: { status: 'running' },
      data: {
        status: 'interrupted',
        error: 'Job was interrupted due to application restart',
        completedAt: new Date(),
      },
    });
    if (result.count > 0) {
      logger.warn(`[fuzzer] Reconciled ${result.count} orphaned fuzzing jobs as interrupted.`);
    }
  } catch (error) {
    logger.error('[fuzzer] Error reconciling orphaned fuzz jobs:', error);
  }
}

export const fuzzerModule = { startFuzzJob, getFuzzJob, fuzzContract };
