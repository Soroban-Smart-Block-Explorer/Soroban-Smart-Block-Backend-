import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SpecCompiler } from './spec-compiler';
import type { SolverResult } from './spec-compiler';

export type SolverBackend = 'z3' | 'cvc5' | 'bitwuzla';

export interface SolverConfig {
  backend: SolverBackend;
  timeoutMs: number;
  memoryMb?: number;
  workers?: number;
  binaryPath?: string;
  extraArgs?: string[];
}

export interface SolverStats {
  backend: SolverBackend;
  sat: boolean | null;
  timeMs: number;
  memoryKb: number;
  proofAvailable: boolean;
  unsatCoreAvailable: boolean;
}

export class SmtSolver {
  private config: SolverConfig;
  private compiler: SpecCompiler;

  constructor(config?: Partial<SolverConfig>) {
    this.config = {
      backend: config?.backend ?? 'z3',
      timeoutMs: config?.timeoutMs ?? 30000,
      memoryMb: config?.memoryMb ?? 4096,
      workers: config?.workers ?? 4,
      binaryPath: config?.binaryPath,
      extraArgs: config?.extraArgs ?? [],
    };
    this.compiler = new SpecCompiler({
      produceProofs: true,
      produceUnsatCores: true,
      incremental: true,
    });
  }

  getCompiler(): SpecCompiler {
    return this.compiler;
  }

  async solve(smtLib2: string, timeoutMs?: number): Promise<SolverResult> {
    const actualTimeout = timeoutMs ?? this.config.timeoutMs;
    const tmpFile = path.join(
      os.tmpdir(),
      `smt_input_${Date.now()}_${Math.random().toString(36).slice(2)}.smt2`,
    );
    const tmpOut = path.join(
      os.tmpdir(),
      `smt_output_${Date.now()}_${Math.random().toString(36).slice(2)}.out`,
    );

    try {
      await fs.promises.writeFile(tmpFile, smtLib2, 'utf-8');
      const startTime = Date.now();
      const backend = this.resolveBinary();

      const args = this.buildArgs(backend, tmpFile, tmpOut, actualTimeout);

      const result = await this.runSolver(backend, args, actualTimeout);

      const elapsed = Date.now() - startTime;

      const parsed = this.parseOutput(result.stdout, result.stderr);

      return {
        sat: parsed.sat,
        model: parsed.model,
        unsatCore: parsed.unsatCore,
        proof: parsed.proof,
        timeMs: elapsed,
      };
    } finally {
      fs.promises.unlink(tmpFile).catch(() => {});
      fs.promises.unlink(tmpOut).catch(() => {});
    }
  }

  async solveParallel(smtQueries: string[], timeoutMs?: number): Promise<SolverResult[]> {
    const actualTimeout = timeoutMs ?? this.config.timeoutMs;
    const workers = Math.min(this.config.workers ?? 4, smtQueries.length);

    const results: SolverResult[] = new Array(smtQueries.length);
    const workerPool = new Set<Promise<void>>();

    const submitWork = async (index: number) => {
      try {
        results[index] = await this.solve(smtQueries[index], actualTimeout);
      } catch (e: any) {
        results[index] = { sat: null, timeMs: 0, error: e.message } as SolverResult;
      }
    };

    for (let i = 0; i < smtQueries.length; i += workers) {
      const batch: Promise<void>[] = [];
      for (let j = i; j < Math.min(i + workers, smtQueries.length); j++) {
        const p = submitWork(j);
        workerPool.add(p);
        batch.push(p);
      }
      await Promise.all(batch);
    }

    return results;
  }

  async solveDistributed(smtQueries: string[], timeoutMs?: number): Promise<SolverResult[]> {
    const actualTimeout = timeoutMs ?? this.config.timeoutMs;
    const numWorkers = this.config.workers ?? 4;
    const results: SolverResult[] = [];

    const workerPromises: Promise<SolverResult[]>[] = [];
    const queriesPerWorker = Math.ceil(smtQueries.length / numWorkers);

    for (let w = 0; w < numWorkers; w++) {
      const start = w * queriesPerWorker;
      const end = Math.min(start + queriesPerWorker, smtQueries.length);
      if (start >= smtQueries.length) break;

      const workerQueries = smtQueries.slice(start, end);
      const workerSolver = new SmtSolver({ ...this.config });
      workerPromises.push(
        Promise.all(
          workerQueries.map((q) =>
            workerSolver
              .solve(q, actualTimeout)
              .catch((e) => ({ sat: null, timeMs: 0, error: e.message }) as SolverResult),
          ),
        ),
      );
    }

    const workerResults = await Promise.all(workerPromises);
    for (const wr of workerResults) {
      results.push(...wr);
    }

    return results;
  }

  async solveIncremental(
    smtQueryBase: string,
    assumptions: string[],
    timeoutMs?: number,
  ): Promise<SolverResult> {
    const actualTimeout = timeoutMs ?? this.config.timeoutMs;
    const incrementalQuery = [
      smtQueryBase,
      ...assumptions.map((a) => `(assert ${a})`),
      '(check-sat)',
      '(get-model)',
    ].join('\n');

    return this.solve(incrementalQuery, actualTimeout);
  }

  async checkSatWithAssumptions(
    smtLib2: string,
    assumptions: string[],
    timeoutMs?: number,
  ): Promise<SolverResult> {
    const actualTimeout = timeoutMs ?? this.config.timeoutMs;
    const query = [
      smtLib2.replace('(check-sat)', '').replace('(get-model)', ''),
      ...assumptions.map((a) => `(assert ${a})`),
      '(check-sat)',
      '(get-model)',
    ].join('\n');

    return this.solve(query, actualTimeout);
  }

  async getUnsatCore(smtLib2: string, timeoutMs?: number): Promise<string[]> {
    const result = await this.solve(smtLib2, timeoutMs);
    return result.unsatCore ?? [];
  }

  async getModel(smtLib2: string, timeoutMs?: number): Promise<Record<string, string> | null> {
    const result = await this.solve(smtLib2, timeoutMs);
    if (result.sat !== true || !result.model) return null;

    const model: Record<string, string> = {};
    for (const [k, v] of Object.entries(result.model as any)) {
      model[k] = (v as any).value;
    }
    return model;
  }

  private resolveBinary(): string {
    if (this.config.binaryPath) return this.config.binaryPath;

    switch (this.config.backend) {
      case 'z3':
        return 'z3';
      case 'cvc5':
        return 'cvc5';
      default:
        return 'z3';
    }
  }

  private buildArgs(
    binary: string,
    inputFile: string,
    outputFile: string,
    timeoutMs: number,
  ): string[] {
    const timeoutSec = Math.ceil(timeoutMs / 1000);

    switch (this.config.backend) {
      case 'z3':
        return [`-T:${timeoutSec}`, `-st`, `file:${inputFile}`, ...(this.config.extraArgs ?? [])];
      case 'cvc5':
        return [
          `--tlimit=${timeoutMs}`,
          `--produce-models`,
          `--produce-unsat-cores`,
          `--dump-proofs`,
          inputFile,
          ...(this.config.extraArgs ?? []),
        ];
      default:
        return [inputFile];
    }
  }

  private runSolver(
    binary: string,
    args: string[],
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child: ChildProcess = spawn(binary, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutMs + 5000,
      } as any);

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      child.on('error', (err: Error) => {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(
            new Error(
              `Solver binary "${binary}" not found. Install ${this.config.backend}:\n` +
                `  $ brew install ${this.config.backend}\n` +
                `  $ apt-get install ${this.config.backend}\n` +
                `  Or download from https://github.com/Z3Prover/z3/releases`,
            ),
          );
        } else {
          reject(err);
        }
      });

      child.on('close', (code: number | null) => {
        resolve({ stdout, stderr });
      });

      if (child.exitCode === null) {
        setTimeout(() => {
          if (child.exitCode === null) {
            child.kill('SIGTERM');
            setTimeout(() => {
              if (child.exitCode === null) child.kill('SIGKILL');
            }, 2000);
          }
        }, timeoutMs);
      }
    });
  }

  private parseOutput(
    stdout: string,
    stderr: string,
  ): {
    sat: boolean | null;
    model?: any;
    unsatCore?: string[];
    proof?: string;
  } {
    const lines = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    let sat: boolean | null = null;
    const proofStart = false;
    const proofLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith('sat') || line === 'sat') {
        sat = true;
        break;
      }
      if (line.startsWith('unsat') || line === 'unsat') {
        sat = false;
        break;
      }
      if (line.startsWith('unknown') || line === 'unknown') {
        sat = null;
        break;
      }
    }

    if (sat === null && stderr.includes('timeout')) {
      return { sat: null };
    }

    const unsatCoreMatch = stdout.match(/\(unsat-core\s+\(([^)]*)\)\)/);
    let unsatCore: string[] | undefined;
    if (unsatCoreMatch) {
      unsatCore = unsatCoreMatch[1]
        .split(/\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
    }

    const proofMatch = stdout.match(/\(proof\s+([\s\S]*?)\)\s*$/);
    let proof: string | undefined;
    if (proofMatch) {
      proof = proofMatch[0];
    } else if (stdout.includes('(proof')) {
      const idx = stdout.indexOf('(proof');
      proof = stdout.slice(idx).trim();
    }

    let model: any;
    if (sat === true) {
      model = this.extractModel(stdout);
    }

    return { sat, model, unsatCore, proof };
  }

  private extractModel(stdout: string): any | undefined {
    const model: any = {};
    const defineFunRegex = /\(define-fun\s+([^\s(]+)\s*\([^)]*\)\s+([^\s(]+)\s+([^)]+)\)/g;
    let match;

    while ((match = defineFunRegex.exec(stdout)) !== null) {
      let val = match[3].trim();
      val = val.replace(/^\(\)$/, 'true');
      model[match[1]] = {
        name: match[1],
        sort: match[2],
        value: val,
      };
    }

    return Object.keys(model).length > 0 ? model : undefined;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const result = await this.solve(
        '(set-logic QF_BV)(declare-const x (_ BitVec 32))(assert (= x #x00000000))(check-sat)',
        5000,
      );
      return result.sat === true;
    } catch {
      return false;
    }
  }

  static async detectAvailableSolvers(): Promise<SolverBackend[]> {
    const available: SolverBackend[] = [];
    const checks: Array<{ name: SolverBackend; cmd: string; args: string[] }> = [
      { name: 'z3', cmd: 'z3', args: ['--version'] },
      { name: 'cvc5', cmd: 'cvc5', args: ['--version'] },
    ];

    for (const check of checks) {
      try {
        const child = spawn(check.cmd, check.args, { stdio: 'pipe' });
        await new Promise<void>((resolve, reject) => {
          child.on('error', reject);
          child.on('close', (code) => {
            if (code === 0) {
              available.push(check.name);
              resolve();
            } else {
              reject(new Error(`exit code ${code}`));
            }
          });
        });
      } catch {
        // not available
      }
    }

    return available;
  }
}

export function createSolver(config?: Partial<SolverConfig>): SmtSolver {
  return new SmtSolver(config);
}
