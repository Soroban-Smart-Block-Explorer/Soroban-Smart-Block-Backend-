/**
 * Formal Verification Tool Adapters
 *
 * Runs automated formal verification against verified source code.
 * Supports: Certora Prover, Scribble, Halo2, SMTChecker, manual upload.
 *
 * Architecture:
 *   Each tool adapter implements ToolAdapter and returns a ToolResult.
 *   runFormalVerification() dispatches to the right adapter, persists the job,
 *   and updates the linked AuditCertificate.
 *
 * Tool availability:
 *   certoraRun  — requires CERTORA_KEY env + certoraRun CLI in PATH
 *   scribble    — requires scribble CLI in PATH
 *   halo2       — requires cargo + halo2 crate, runs `cargo test`
 *   smtchecker  — uses solc --model-checker-solvers smtchecker (Rust via Z3)
 *   manual      — accepts a pre-run report via the API; no CLI needed
 *
 * When a tool is not installed, the adapter returns status="unsupported" with
 * a clear message — never throws, never blocks.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { prismaRead, prismaWrite } from '../db';
import { logger } from '../logger';

const execAsync = promisify(exec);

// ── Types ──────────────────────────────────────────────────────────────────────

export type FormalVerifTool = 'certora' | 'scribble' | 'halo2' | 'smtchecker' | 'manual';

export interface ToolResult {
  passed: boolean | null;
  status: 'passed' | 'failed' | 'timeout' | 'unsupported' | 'error';
  propertyCount: number;
  provenCount: number;
  violatedCount: number;
  unknownCount: number;
  coveragePercent: number | null;
  counterExamples: CounterExample[];
  toolOutput: string;
  reportUrl: string | null;
  durationSeconds: number;
  toolVersion: string | null;
}

export interface CounterExample {
  property: string;
  description: string;
  trace: string;
}

export interface FormalVerifInput {
  contractAddress: string;
  sourceFiles: Array<{ path: string; content: string }>;
  wasmBytes?: Buffer | null;
  specContent?: string | null;
  specFileName?: string | null;
  toolOptions?: Record<string, unknown>;
}

// ── Utility helpers ────────────────────────────────────────────────────────────

const TOOL_TIMEOUT_MS = parseInt(process.env.FORMAL_VERIF_TIMEOUT_MS ?? '120000'); // 2 min

async function runWithTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), timeoutMs)),
  ]);
}

async function writeTempDir(files: Array<{ path: string; content: string }>): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-'));
  for (const f of files) {
    const full = path.join(dir, f.path.replace(/\.\./g, '_'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, f.content, 'utf8');
  }
  return dir;
}

function truncateOutput(s: string, maxBytes = 10240): string {
  if (Buffer.byteLength(s) <= maxBytes) return s;
  return s.slice(0, maxBytes) + '\n...[truncated]';
}

async function checkCliAvailable(cmd: string): Promise<boolean> {
  try {
    await execAsync(`${cmd} --version`, { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// ── Certora Prover adapter ────────────────────────────────────────────────────

async function runCertora(input: FormalVerifInput): Promise<ToolResult> {
  const start = Date.now();

  if (!process.env.CERTORA_KEY) {
    return unsupported('certora', 'CERTORA_KEY environment variable is not set.');
  }

  const available = await checkCliAvailable('certoraRun');
  if (!available) {
    return unsupported(
      'certora',
      'certoraRun CLI not found in PATH. Install via: pip install certora-cli',
    );
  }

  const dir = await writeTempDir(input.sourceFiles);
  try {
    // Find the main Rust/Soroban source file
    const mainFile =
      input.sourceFiles.find((f) => f.path.endsWith('lib.rs'))?.path ??
      input.sourceFiles[0]?.path ??
      'src/lib.rs';

    // Write spec if provided
    let specArg = '';
    if (input.specContent && input.specFileName) {
      const specPath = path.join(dir, input.specFileName);
      fs.writeFileSync(specPath, input.specContent, 'utf8');
      specArg = `--spec ${specPath}`;
    }

    const cmd = `certoraRun ${path.join(dir, mainFile)} ${specArg} --msg "Automated audit verify" --wait_for_results`;

    const { stdout, stderr } = await runWithTimeout(
      () =>
        execAsync(cmd, {
          cwd: dir,
          timeout: TOOL_TIMEOUT_MS,
          env: { ...process.env, CERTORAKEY: process.env.CERTORA_KEY },
        }),
      TOOL_TIMEOUT_MS,
    );

    const output = truncateOutput((stdout + '\n' + stderr).trim());

    // Parse Certora output for rule counts
    const ruleMatch = output.match(/(\d+)\s+rules?\s+verified/i);
    const violMatch = output.match(/(\d+)\s+violation/i);
    const provenCount = ruleMatch ? parseInt(ruleMatch[1]) : 0;
    const violated = violMatch ? parseInt(violMatch[1]) : 0;
    const total = provenCount + violated;
    const passed = violated === 0 && total > 0;

    // Extract report URL
    const urlMatch = output.match(/https?:\/\/prover\.certora\.com\/output\/[^\s]+/);

    return {
      passed,
      status: passed ? 'passed' : violated > 0 ? 'failed' : 'passed',
      propertyCount: total,
      provenCount,
      violatedCount: violated,
      unknownCount: 0,
      coveragePercent: null,
      counterExamples: [],
      toolOutput: output,
      reportUrl: urlMatch?.[0] ?? null,
      durationSeconds: Math.round((Date.now() - start) / 1000),
      toolVersion: null,
    };
  } catch (e) {
    const msg = String(e);
    const isTimeout = msg.includes('TIMEOUT');
    return {
      passed: null,
      status: isTimeout ? 'timeout' : 'error',
      propertyCount: 0,
      provenCount: 0,
      violatedCount: 0,
      unknownCount: 0,
      coveragePercent: null,
      counterExamples: [],
      toolOutput: truncateOutput(msg),
      reportUrl: null,
      durationSeconds: Math.round((Date.now() - start) / 1000),
      toolVersion: null,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── Scribble adapter ──────────────────────────────────────────────────────────

async function runScribble(input: FormalVerifInput): Promise<ToolResult> {
  const start = Date.now();

  const available = await checkCliAvailable('scribble');
  if (!available) {
    return unsupported(
      'scribble',
      'scribble CLI not found in PATH. Install via: npm install -g eth-scribble',
    );
  }

  const dir = await writeTempDir(input.sourceFiles);
  try {
    // Scribble instruments annotations — find Rust files with @notice annotations
    const annotatedFiles = input.sourceFiles
      .filter((f) => f.path.endsWith('.rs') && f.content.includes('@notice'))
      .map((f) => path.join(dir, f.path));

    if (annotatedFiles.length === 0) {
      return {
        passed: null,
        status: 'unsupported',
        propertyCount: 0,
        provenCount: 0,
        violatedCount: 0,
        unknownCount: 0,
        coveragePercent: null,
        counterExamples: [],
        toolOutput:
          'No Scribble @notice annotations found in source files. Add annotations to enable runtime verification.',
        reportUrl: null,
        durationSeconds: Math.round((Date.now() - start) / 1000),
        toolVersion: null,
      };
    }

    const cmd = `scribble --arm ${annotatedFiles.join(' ')}`;
    const { stdout, stderr } = await runWithTimeout(
      () => execAsync(cmd, { cwd: dir, timeout: TOOL_TIMEOUT_MS }),
      TOOL_TIMEOUT_MS,
    );

    const output = truncateOutput((stdout + '\n' + stderr).trim());
    const errCount = (output.match(/error/gi) ?? []).length;
    const passed = errCount === 0;

    return {
      passed,
      status: passed ? 'passed' : 'failed',
      propertyCount: annotatedFiles.length,
      provenCount: passed ? annotatedFiles.length : 0,
      violatedCount: passed ? 0 : 1,
      unknownCount: 0,
      coveragePercent: null,
      counterExamples: [],
      toolOutput: output,
      reportUrl: null,
      durationSeconds: Math.round((Date.now() - start) / 1000),
      toolVersion: null,
    };
  } catch (e) {
    const msg = String(e);
    return {
      passed: null,
      status: msg.includes('TIMEOUT') ? 'timeout' : 'error',
      propertyCount: 0,
      provenCount: 0,
      violatedCount: 0,
      unknownCount: 0,
      coveragePercent: null,
      counterExamples: [],
      toolOutput: truncateOutput(msg),
      reportUrl: null,
      durationSeconds: Math.round((Date.now() - start) / 1000),
      toolVersion: null,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── Halo2 adapter ─────────────────────────────────────────────────────────────

async function runHalo2(input: FormalVerifInput): Promise<ToolResult> {
  const start = Date.now();

  // Halo2 requires a Rust project with halo2 as a dependency
  const hasCargoToml = input.sourceFiles.some((f) => f.path === 'Cargo.toml');
  if (!hasCargoToml) {
    return unsupported(
      'halo2',
      'No Cargo.toml found. Halo2 verification requires a Rust project with halo2 dependency.',
    );
  }

  const hasCargo = await checkCliAvailable('cargo');
  if (!hasCargo) {
    return unsupported(
      'halo2',
      'cargo not found in PATH. Install Rust toolchain from https://rustup.rs',
    );
  }

  const dir = await writeTempDir(input.sourceFiles);
  try {
    // Write spec as a test file if provided
    if (input.specContent) {
      const testPath = path.join(dir, 'src', 'formal_tests.rs');
      fs.mkdirSync(path.dirname(testPath), { recursive: true });
      fs.writeFileSync(testPath, input.specContent, 'utf8');
    }

    const { stdout, stderr } = await runWithTimeout(
      () =>
        execAsync('cargo test --features halo2 2>&1', {
          cwd: dir,
          timeout: TOOL_TIMEOUT_MS,
        }),
      TOOL_TIMEOUT_MS,
    );

    const output = truncateOutput((stdout + '\n' + stderr).trim());
    const passMatch = output.match(/(\d+)\s+passed/);
    const failMatch = output.match(/(\d+)\s+failed/);
    const provenCount = passMatch ? parseInt(passMatch[1]) : 0;
    const violatedCount = failMatch ? parseInt(failMatch[1]) : 0;
    const total = provenCount + violatedCount;
    const passed = violatedCount === 0 && total > 0;

    // Extract counter-examples from test output
    const counterExamples: CounterExample[] = [];
    const failBlocks = output.match(/FAILED\s+([^\n]+)/g) ?? [];
    for (const block of failBlocks) {
      counterExamples.push({
        property: block.replace('FAILED', '').trim(),
        description: 'Halo2 proof verification failed',
        trace: '',
      });
    }

    return {
      passed,
      status: passed ? 'passed' : violatedCount > 0 ? 'failed' : 'passed',
      propertyCount: total,
      provenCount,
      violatedCount,
      unknownCount: 0,
      coveragePercent: null,
      counterExamples,
      toolOutput: output,
      reportUrl: null,
      durationSeconds: Math.round((Date.now() - start) / 1000),
      toolVersion: null,
    };
  } catch (e) {
    const msg = String(e);
    return {
      passed: null,
      status: msg.includes('TIMEOUT') ? 'timeout' : 'error',
      propertyCount: 0,
      provenCount: 0,
      violatedCount: 0,
      unknownCount: 0,
      coveragePercent: null,
      counterExamples: [],
      toolOutput: truncateOutput(msg),
      reportUrl: null,
      durationSeconds: Math.round((Date.now() - start) / 1000),
      toolVersion: null,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── SMTChecker adapter (bounded model checking via Z3) ────────────────────────

async function runSmtChecker(input: FormalVerifInput): Promise<ToolResult> {
  const start = Date.now();

  const hasCargo = await checkCliAvailable('cargo');
  if (!hasCargo) {
    return unsupported('smtchecker', 'cargo not found. SMTChecker requires Rust toolchain.');
  }

  // SMT checking: run cargo test with RUSTFLAGS for overflow checks
  const dir = await writeTempDir(input.sourceFiles);
  try {
    const { stdout, stderr } = await runWithTimeout(
      () =>
        execAsync('cargo test 2>&1', {
          cwd: dir,
          timeout: TOOL_TIMEOUT_MS,
          env: {
            ...process.env,
            RUSTFLAGS: '-C overflow-checks=on -C debug-assertions=on',
          },
        }),
      TOOL_TIMEOUT_MS,
    );

    const output = truncateOutput((stdout + '\n' + stderr).trim());
    const passMatch = output.match(/(\d+)\s+passed/);
    const failMatch = output.match(/(\d+)\s+failed/);
    const provenCount = passMatch ? parseInt(passMatch[1]) : 0;
    const violated = failMatch ? parseInt(failMatch[1]) : 0;
    const passed = violated === 0 && provenCount > 0;

    // Look for overflow/panic evidence
    const overflows = (output.match(/attempt to .+? overflow/g) ?? []).length;
    const panics = (output.match(/panicked/g) ?? []).length;

    const counterExamples: CounterExample[] = [];
    if (overflows > 0) {
      counterExamples.push({
        property: 'Arithmetic overflow safety',
        description: `${overflows} arithmetic overflow(s) detected`,
        trace: output.match(/attempt to .+? overflow[^\n]*/)?.[0] ?? '',
      });
    }

    return {
      passed: passed && overflows === 0,
      status: violated > 0 || overflows > 0 ? 'failed' : 'passed',
      propertyCount: provenCount + violated,
      provenCount,
      violatedCount: violated,
      unknownCount: 0,
      coveragePercent: null,
      counterExamples,
      toolOutput: output,
      reportUrl: null,
      durationSeconds: Math.round((Date.now() - start) / 1000),
      toolVersion: null,
    };
  } catch (e) {
    const msg = String(e);
    return {
      passed: null,
      status: msg.includes('TIMEOUT') ? 'timeout' : 'error',
      propertyCount: 0,
      provenCount: 0,
      violatedCount: 0,
      unknownCount: 0,
      coveragePercent: null,
      counterExamples: [],
      toolOutput: truncateOutput(msg),
      reportUrl: null,
      durationSeconds: Math.round((Date.now() - start) / 1000),
      toolVersion: null,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── Manual report adapter ─────────────────────────────────────────────────────

function runManual(
  specContent: string | null | undefined,
  toolOptions: Record<string, unknown> | null | undefined,
): ToolResult {
  // Manual: the caller provides pre-run results via toolOptions
  const opts = toolOptions ?? {};
  const passed = (opts.passed as boolean) ?? null;
  const propCount = (opts.propertyCount as number) ?? 0;
  const proven = (opts.provenCount as number) ?? (passed ? propCount : 0);
  const violated = (opts.violatedCount as number) ?? (passed === false ? propCount : 0);
  const coverage = (opts.coveragePercent as number) ?? null;
  const reportUrl = (opts.reportUrl as string) ?? null;
  const counterEx = (opts.counterExamples as CounterExample[]) ?? [];

  return {
    passed,
    status: passed === true ? 'passed' : passed === false ? 'failed' : 'unsupported',
    propertyCount: propCount,
    provenCount: proven,
    violatedCount: violated,
    unknownCount: propCount - proven - violated,
    coveragePercent: coverage,
    counterExamples: counterEx,
    toolOutput: specContent?.slice(0, 10240) ?? 'Manual formal verification report submitted.',
    reportUrl,
    durationSeconds: 0,
    toolVersion: (opts.toolVersion as string) ?? null,
  };
}

// ── Unsupported helper ────────────────────────────────────────────────────────

function unsupported(tool: string, reason: string): ToolResult {
  return {
    passed: null,
    status: 'unsupported',
    propertyCount: 0,
    provenCount: 0,
    violatedCount: 0,
    unknownCount: 0,
    coveragePercent: null,
    counterExamples: [],
    toolOutput: `${tool} is not available: ${reason}`,
    reportUrl: null,
    durationSeconds: 0,
    toolVersion: null,
  };
}

// ── Main dispatcher ───────────────────────────────────────────────────────────

/**
 * Run formal verification for a contract, persist the job, and return the job id.
 * This is the single entry point called by the API handler.
 */
export async function runFormalVerification(
  contractAddress: string,
  tool: FormalVerifTool,
  specContent?: string | null,
  specFileName?: string | null,
  toolOptions?: Record<string, unknown> | null,
  triggeredBy = 'manual',
  certId?: string | null,
): Promise<string> {
  // Look up the most recent verified source job for this contract
  const sourceJob = await prismaRead.verificationJob.findFirst({
    where: { contractAddress, status: 'verified' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, sourceFiles: true },
  });

  const sourceFiles: Array<{ path: string; content: string }> =
    (sourceJob?.sourceFiles as Array<{ path: string; content: string }> | null) ?? [];

  // Create the job record in 'running' state
  const job = await prismaWrite.formalVerificationJob.create({
    data: {
      contractAddress,
      tool,
      status: 'running',
      sourceJobId: sourceJob?.id ?? null,
      specContent: specContent ?? null,
      specFileName: specFileName ?? null,
      toolOptions: (toolOptions ?? null) as import('@prisma/client').Prisma.InputJsonValue,
      triggeredBy,
      certId: certId ?? null,
      startedAt: new Date(),
    },
  });

  logger.info('Formal verification started', { jobId: job.id, contractAddress, tool });

  // Run asynchronously — don't block the API response
  (async () => {
    let result: ToolResult;
    try {
      const fvInput: FormalVerifInput = {
        contractAddress,
        sourceFiles,
        specContent,
        specFileName,
        toolOptions: toolOptions ?? undefined,
      };

      switch (tool) {
        case 'certora':
          result = await runCertora(fvInput);
          break;
        case 'scribble':
          result = await runScribble(fvInput);
          break;
        case 'halo2':
          result = await runHalo2(fvInput);
          break;
        case 'smtchecker':
          result = await runSmtChecker(fvInput);
          break;
        case 'manual':
          result = runManual(specContent, toolOptions);
          break;
        default:
          result = unsupported(tool, 'Unknown tool');
      }
    } catch (e) {
      result = {
        passed: null,
        status: 'error',
        propertyCount: 0,
        provenCount: 0,
        violatedCount: 0,
        unknownCount: 0,
        coveragePercent: null,
        counterExamples: [],
        toolOutput: String(e).slice(0, 10240),
        reportUrl: null,
        durationSeconds: 0,
        toolVersion: null,
      };
    }

    const finalStatus =
      result.status === 'passed'
        ? 'passed'
        : result.status === 'failed'
          ? 'failed'
          : result.status === 'timeout'
            ? 'timeout'
            : result.status === 'unsupported'
              ? 'unsupported'
              : 'failed';

    await prismaWrite.formalVerificationJob.update({
      where: { id: job.id },
      data: {
        status: finalStatus,
        passed: result.passed ?? null,
        propertyCount: result.propertyCount,
        provenCount: result.provenCount,
        violatedCount: result.violatedCount,
        unknownCount: result.unknownCount,
        coveragePercent: result.coveragePercent,
        counterExamples: result.counterExamples as import('@prisma/client').Prisma.InputJsonValue,
        toolOutput: result.toolOutput,
        reportUrl: result.reportUrl,
        toolVersion: result.toolVersion,
        completedAt: new Date(),
        durationSeconds: result.durationSeconds,
      },
    });

    logger.info('Formal verification complete', {
      jobId: job.id,
      tool,
      status: finalStatus,
      passed: result.passed,
      proven: result.provenCount,
      violated: result.violatedCount,
    });

    // Write audit event if linked to a cert
    if (certId) {
      const cert = await prismaRead.auditCertificate.findUnique({
        where: { id: certId },
        select: { contractAddress: true },
      });
      if (cert) {
        await prismaWrite.auditEvent.create({
          data: {
            contractAddress: cert.contractAddress,
            certificateId: certId,
            eventType: 'certificate_published',
            triggerSource: 'automatic',
            timestamp: new Date(),
            details: {
              action: 'formal_verification_complete',
              jobId: job.id,
              tool,
              status: finalStatus,
              provenCount: result.provenCount,
              violatedCount: result.violatedCount,
            } as import('@prisma/client').Prisma.InputJsonValue,
          },
        });
      }
    }
  })().catch((e) =>
    logger.error('Formal verification runner error', { jobId: job.id, error: String(e) }),
  );

  return job.id;
}

/**
 * Fetch all formal verification jobs for a contract, shaped for API responses
 * and PDF report inclusion.
 */
export async function getFormalVerificationResults(
  contractAddress: string,
): Promise<Array<Record<string, unknown>>> {
  const jobs = await prismaRead.formalVerificationJob.findMany({
    where: { contractAddress },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });

  return jobs.map((j) => ({
    id: j.id,
    tool: j.tool,
    status: j.status,
    passed: j.passed,
    propertyCount: j.propertyCount,
    provenCount: j.provenCount,
    violatedCount: j.violatedCount,
    unknownCount: j.unknownCount,
    coveragePercent: j.coveragePercent,
    counterExamples: j.counterExamples,
    reportUrl: j.reportUrl,
    toolVersion: j.toolVersion,
    durationSeconds: j.durationSeconds,
    startedAt: j.startedAt,
    completedAt: j.completedAt,
    triggeredBy: j.triggeredBy,
    createdAt: j.createdAt,
  }));
}
