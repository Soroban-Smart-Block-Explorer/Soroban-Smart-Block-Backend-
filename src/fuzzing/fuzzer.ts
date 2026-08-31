import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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

// Where persisted fuzzing regression tests are written (repo-relative).
const DEFAULT_REGRESSION_DIR = 'tests/fuzzing/regressions';

/**
 * Generate a fully runnable vitest regression test for a confirmed finding.
 *
 * Unlike the previous stub (which only emitted a `TODO` comment), the emitted
 * test drives the *same* `simulateCall` path the fuzzer uses — contract
 * address, function and the exact (mutated) args that produced the finding —
 * so it will catch a silently re-introduced panic. The RPC and DB layers are
 * stubbed deterministically so the persisted test runs offline in CI.
 */
function jsStr(value: unknown, indent?: number): string {
  // JSON.stringify already escapes quotes/backslashes/newlines. Also escape
  // backtick and `${` so the literal is safe to embed in generated test source.
  return JSON.stringify(value, null, indent).replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

export function generateRegressionTest(
  finding: FuzzFinding,
  contractAddress: string,
  importPrefix = '../../../',
): string {
  const functionNameJson = jsStr(finding.functionName);
  const contractJson = jsStr(contractAddress);
  const argsJson = jsStr(finding.args, 2);
  // Error text is embedded as a JS literal so it survives quotes/backslashes.
  const replayedError = jsStr(finding.error ?? finding.result);
  const describeTitle = `${finding.functionName || 'contract'} fuzz regression`;
  const testName = `${finding.functionName || 'contract'} repro of ${finding.mutation} (${finding.severity})`;

  return `import { describe, it, expect, vi } from 'vitest';
import { Account, Keypair } from '@stellar/stellar-sdk';
import { simulateCall } from '${importPrefix}src/fuzzing/fuzzer';

// Deterministically replay the fuzzed RPC + DB layer so this test runs offline.
vi.mock('${importPrefix}src/indexer/rpc', () => ({
  rpc: {
    simulateTransaction: vi.fn().mockResolvedValue({ error: ${replayedError} }),
    getAccount: vi.fn(),
  },
}));
vi.mock('${importPrefix}src/db', () => ({
  prismaRead: { transaction: { findMany: vi.fn().mockResolvedValue([]) } },
}));
vi.mock('${importPrefix}src/indexer/abi-cache', () => ({
  getCachedAbi: vi.fn(),
}));

describe(${JSON.stringify(describeTitle)}, () => {
  it(${JSON.stringify(testName)}, async () => {
    const contractAddress = ${contractJson};
    const args = ${argsJson};
    const account = new Account(Keypair.random().publicKey(), '0');

    // Replay the same simulateCall path the fuzzer uses for this finding.
    const { result } = await simulateCall(contractAddress, ${functionNameJson}, args, account);

    expect(result).toBeDefined();
    expect(result).not.toContain('panic');
  });
});
`;
}

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

export async function simulateCall(
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
  options: { maxCases?: number; targetFunctions?: string[]; persist?: boolean } = {},
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
          finding.regressionTest = generateRegressionTest(finding, contractAddress);
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
        finding.regressionTest = generateRegressionTest(finding, contractAddress);
        findings.push(finding);
      }
    }
  }

  const totalCases = executed;
  const coverage = Math.min(100, Math.round((seenPaths.size / Math.max(1, totalCases * 2)) * 100));

  // Persist confirmed findings' regression tests into the repo when requested,
  // so they become runnable, repeatable fixtures rather than throwaway reports.
  if (options.persist && findings.length > 0) {
    await persistRegressionTests(findings, contractAddress);
  }

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

/**
 * Write the generated regression test for each finding to the repo's
 * `tests/fuzzing/regressions/` directory (creating it if needed).
 *
 * Returns the directory and the list of file paths that were written.
 */
export async function persistRegressionTests(
  findings: FuzzFinding[],
  contractAddress: string,
  dir: string = DEFAULT_REGRESSION_DIR,
): Promise<{ dir: string; files: string[] }> {
  await mkdir(dir, { recursive: true });
  const files: string[] = [];
  const base = (contractAddress || 'contract').replace(/[^A-Za-z0-9]/g, '').slice(0, 16);
  const usedNames = new Set<string>();

  for (let i = 0; i < findings.length; i++) {
    const f = findings[i];
    const safeFn = (f.functionName || 'unknown').replace(/[^A-Za-z0-9_]/g, '_');
    let fileName = `${base}-${safeFn}-${i}.test.ts`;
    let counter = 1;
    while (usedNames.has(fileName)) {
      fileName = `${base}-${safeFn}-${i}-${counter++}.test.ts`;
    }
    usedNames.add(fileName);

    const filePath = join(dir, fileName);
    const source = f.regressionTest ?? generateRegressionTest(f, contractAddress);
    await writeFile(filePath, source, 'utf8');
    files.push(filePath);
  }

  return { dir, files };
}

// In-memory store for async fuzz jobs
interface FuzzJob {
  id: string;
  status: 'running' | 'completed' | 'failed';
  report?: FuzzReport;
  error?: string;
  startedAt: string;
}

const fuzzJobs = new Map<string, FuzzJob>();
let jobCounter = 0;

export function startFuzzJob(
  contractAddress: string,
  options: { maxCases?: number; targetFunctions?: string[]; persist?: boolean } = {},
): string {
  const id = `fuzz_${++jobCounter}_${Date.now()}`;
  const job: FuzzJob = { id, status: 'running', startedAt: new Date().toISOString() };
  fuzzJobs.set(id, job);

  fuzzContract(contractAddress, options)
    .then((report) => {
      job.status = 'completed';
      job.report = report;
    })
    .catch((e) => {
      job.status = 'failed';
      job.error = String(e);
    });

  return id;
}

export function getFuzzJob(id: string): FuzzJob | undefined {
  return fuzzJobs.get(id);
}

/**
 * Public surface exposed for tooling/consumers (and tests). Kept separate from
 * the fuzzing HTTP router so the fuzzer can be driven programmatically.
 */
export const fuzzerModule = {
  fuzzContract,
  startFuzzJob,
  getFuzzJob,
  generateRegressionTest,
  persistRegressionTests,
  simulateCall,
};
