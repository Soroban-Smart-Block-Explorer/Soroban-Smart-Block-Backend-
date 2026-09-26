/**
 * Recurring security-scan orchestrator (VE10).
 *
 * discover contracts -> run registered analyzers -> store findings ->
 * diff against the previous run (new / resolved / unchanged).
 * Analyzers (reentrancy, arithmetic, freezes, trust) and contract discovery
 * are injected so each existing point analysis can be plugged in.
 */
import { createHash } from 'crypto';
import { logger } from '../logger';
import { scheduler } from './cron-scheduler';

export interface ScanFinding {
  fingerprint: string;
  contractId: string;
  analyzer: string;
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  title: string;
}

export type FindingInput = Omit<ScanFinding, 'fingerprint' | 'contractId' | 'analyzer'>;

export interface Analyzer {
  name: string;
  analyze(contractId: string): Promise<FindingInput[]>;
}

export interface ScanDiff {
  new: ScanFinding[];
  resolved: ScanFinding[];
  unchanged: number;
}

export interface ScanRun {
  id: number;
  startedAt: string;
  finishedAt: string;
  contractsScanned: number;
  analyzerErrors: Array<{ contractId: string; analyzer: string; error: string }>;
  findings: ScanFinding[];
  diff: ScanDiff;
}

const MAX_RUNS = 50;
const runs: ScanRun[] = [];
const analyzers: Analyzer[] = [];
let discover: () => Promise<string[]> = async () => [];
let running = false;
let nextId = 1;

export function registerAnalyzer(a: Analyzer): void {
  if (analyzers.some((x) => x.name === a.name)) throw new Error(`Analyzer "${a.name}" already registered`);
  analyzers.push(a);
}

export function setContractDiscovery(fn: () => Promise<string[]>): void {
  discover = fn;
}

export function fingerprint(contractId: string, analyzer: string, f: FindingInput): string {
  return createHash('sha256').update([contractId, analyzer, f.severity, f.title].join('\0')).digest('hex').slice(0, 32);
}

export function diffFindings(prev: ScanFinding[], curr: ScanFinding[]): ScanDiff {
  const prevSet = new Set(prev.map((f) => f.fingerprint));
  const currSet = new Set(curr.map((f) => f.fingerprint));
  return {
    new: curr.filter((f) => !prevSet.has(f.fingerprint)),
    resolved: prev.filter((f) => !currSet.has(f.fingerprint)),
    unchanged: curr.filter((f) => prevSet.has(f.fingerprint)).length,
  };
}

/** Run one full scan. Analyzer failures are recorded and do not abort the run. */
export async function runSecurityScan(): Promise<ScanRun | null> {
  if (running) return null;
  running = true;
  const startedAt = new Date().toISOString();
  try {
    const contracts = [...new Set(await discover())];
    const findings: ScanFinding[] = [];
    const analyzerErrors: ScanRun['analyzerErrors'] = [];
    for (const contractId of contracts) {
      for (const a of analyzers) {
        try {
          for (const f of await a.analyze(contractId)) {
            findings.push({ ...f, contractId, analyzer: a.name, fingerprint: fingerprint(contractId, a.name, f) });
          }
        } catch (err) {
          analyzerErrors.push({ contractId, analyzer: a.name, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    const prev = runs[runs.length - 1];
    const run: ScanRun = {
      id: nextId++,
      startedAt,
      finishedAt: new Date().toISOString(),
      contractsScanned: contracts.length,
      analyzerErrors,
      findings,
      diff: diffFindings(prev?.findings ?? [], findings),
    };
    runs.push(run);
    if (runs.length > MAX_RUNS) runs.shift();
    logger.info(
      `[security-scan] run ${run.id}: ${contracts.length} contracts, ${findings.length} findings, ${run.diff.new.length} new, ${run.diff.resolved.length} resolved`,
    );
    return run;
  } finally {
    running = false;
  }
}

export function listScanRuns(): ScanRun[] {
  return [...runs].reverse();
}

export function getScanRun(id: number): ScanRun | undefined {
  return runs.find((r) => r.id === id);
}

/** Register the recurring job (default: daily at 03:00). Safe to call repeatedly. */
export function startSecurityScanJob(cronExpression = '0 3 * * *'): void {
  try {
    scheduler.register({
      id: 'security-scan',
      taskName: 'Recurring Security Scan',
      cronExpression,
      execute: async () => {
        await runSecurityScan();
      },
      maxDuration: 30 * 60_000,
      expectedIntervalMs: 24 * 60 * 60_000,
    });
  } catch (error) {
    if (!(error instanceof Error && error.message.includes('already registered'))) throw error;
  }
}
