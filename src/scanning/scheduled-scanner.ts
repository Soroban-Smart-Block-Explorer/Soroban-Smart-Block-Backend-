/**
 * Scheduled reentrancy / overflow / privileged-call scanning (VE03).
 *
 * Periodically sweeps discovered contracts with a static analysis of their
 * recorded function signatures, keeps the latest result per contract in a risk
 * store and emits a change feed whenever a contract's findings change.
 * Incremental policy: a contract is re-scanned only when its wasm hash changed
 * or its last scan is older than the re-scan interval.
 */
import { prismaRead } from '../db';
import { logger } from '../logger';
import { scheduler } from '../scheduler/cron-scheduler';

export type RiskCategory = 'reentrancy' | 'overflow' | 'privileged_call';
export type RiskSeverity = 'low' | 'medium' | 'high';

export interface RiskFinding {
  category: RiskCategory;
  severity: RiskSeverity;
  function: string;
  detail: string;
}

export interface ScanRecord {
  contractAddress: string;
  wasmHash: string | null;
  scannedAt: string;
  riskScore: number;
  findings: RiskFinding[];
}

export interface ScanChange {
  seq: number;
  contractAddress: string;
  at: string;
  kind: 'new' | 'changed';
  previousScore: number | null;
  riskScore: number;
}

const REENTRANCY_RE = /(withdraw|redeem|claim|flash|callback|invoke|call_contract|swap|transfer_from)/i;
const OVERFLOW_RE = /(add|sub|mul|pow|shl|scale|multiply|accrue|compound|mint|burn)/i;
const PRIVILEGED_RE = /(upgrade|set_admin|transfer_ownership|pause|unpause|freeze|set_fee|mint|clawback|migrate|update_wasm)/i;

const SEVERITY_WEIGHT: Record<RiskSeverity, number> = { low: 5, medium: 15, high: 30 };
const MAX_FEED = 1000;

export function extractFunctionNames(signatures: unknown): string[] {
  if (!signatures) return [];
  if (Array.isArray(signatures)) {
    return signatures
      .map((s) => (typeof s === 'string' ? s : (s as { name?: string })?.name))
      .filter((n): n is string => typeof n === 'string' && n.length > 0);
  }
  if (typeof signatures === 'object') return Object.keys(signatures as Record<string, unknown>);
  return [];
}

export function analyzeFunctions(functionNames: string[]): RiskFinding[] {
  const findings: RiskFinding[] = [];
  for (const fn of functionNames) {
    if (PRIVILEGED_RE.test(fn)) {
      findings.push({
        category: 'privileged_call',
        severity: /upgrade|update_wasm|transfer_ownership|set_admin/i.test(fn) ? 'high' : 'medium',
        function: fn,
        detail: 'Privileged entrypoint that can alter contract state or control',
      });
    }
    if (REENTRANCY_RE.test(fn)) {
      findings.push({
        category: 'reentrancy',
        severity: /flash|callback|call_contract/i.test(fn) ? 'high' : 'medium',
        function: fn,
        detail: 'Entrypoint likely performs external calls; verify checks-effects-interactions',
      });
    }
    if (OVERFLOW_RE.test(fn)) {
      findings.push({
        category: 'overflow',
        severity: 'low',
        function: fn,
        detail: 'Arithmetic-heavy entrypoint; verify checked arithmetic is used',
      });
    }
  }
  return findings;
}

export function scoreFindings(findings: RiskFinding[]): number {
  return Math.min(100, findings.reduce((sum, f) => sum + SEVERITY_WEIGHT[f.severity], 0));
}

export class RiskStore {
  private records = new Map<string, ScanRecord>();
  private feed: ScanChange[] = [];
  private seq = 0;

  get(address: string): ScanRecord | undefined {
    return this.records.get(address);
  }

  list(opts: { minScore?: number; category?: RiskCategory; limit?: number } = {}): ScanRecord[] {
    return [...this.records.values()]
      .filter((r) => (opts.minScore === undefined ? true : r.riskScore >= opts.minScore))
      .filter((r) => (opts.category ? r.findings.some((f) => f.category === opts.category) : true))
      .sort((a, b) => b.riskScore - a.riskScore)
      .slice(0, opts.limit ?? 50);
  }

  put(record: ScanRecord): ScanChange | null {
    const prev = this.records.get(record.contractAddress);
    this.records.set(record.contractAddress, record);
    const sameFindings =
      prev && JSON.stringify(prev.findings) === JSON.stringify(record.findings);
    if (sameFindings) return null;
    const change: ScanChange = {
      seq: ++this.seq,
      contractAddress: record.contractAddress,
      at: record.scannedAt,
      kind: prev ? 'changed' : 'new',
      previousScore: prev ? prev.riskScore : null,
      riskScore: record.riskScore,
    };
    this.feed.push(change);
    if (this.feed.length > MAX_FEED) this.feed.shift();
    return change;
  }

  changesSince(seq: number, limit = 100): ScanChange[] {
    return this.feed.filter((c) => c.seq > seq).slice(0, limit);
  }

  get size(): number {
    return this.records.size;
  }
}

export const riskStore = new RiskStore();

export function needsRescan(
  existing: ScanRecord | undefined,
  wasmHash: string | null,
  rescanIntervalMs: number,
  now = Date.now(),
): boolean {
  if (!existing) return true;
  if (existing.wasmHash !== wasmHash) return true;
  return now - new Date(existing.scannedAt).getTime() >= rescanIntervalMs;
}

export async function runScanCycle(
  opts: { batchSize?: number; rescanIntervalMs?: number } = {},
): Promise<{ scanned: number; skipped: number; changed: number }> {
  const batchSize = opts.batchSize ?? 200;
  const rescanIntervalMs = opts.rescanIntervalMs ?? 24 * 60 * 60 * 1000;
  const contracts = await prismaRead.contract.findMany({
    select: { address: true, wasmHash: true, functionSignatures: true },
    orderBy: { updatedAt: 'desc' },
    take: batchSize,
  });
  let scanned = 0;
  let skipped = 0;
  let changed = 0;
  for (const c of contracts) {
    if (!needsRescan(riskStore.get(c.address), c.wasmHash, rescanIntervalMs)) {
      skipped++;
      continue;
    }
    try {
      const findings = analyzeFunctions(extractFunctionNames(c.functionSignatures));
      const change = riskStore.put({
        contractAddress: c.address,
        wasmHash: c.wasmHash,
        scannedAt: new Date().toISOString(),
        riskScore: scoreFindings(findings),
        findings,
      });
      scanned++;
      if (change) changed++;
    } catch (err) {
      logger.error('[scheduled-scanner] contract scan failed', { address: c.address, err });
    }
  }
  logger.info('[scheduled-scanner] cycle complete', { scanned, skipped, changed });
  return { scanned, skipped, changed };
}

export function registerScheduledScanner(): void {
  if (process.env.SCHEDULED_RISK_SCAN_ENABLED === 'false') return;
  scheduler.register({
    id: 'scheduled-risk-scan',
    cronExpression: process.env.SCHEDULED_RISK_SCAN_CRON ?? '0 */15 * * * *',
    taskName: 'Scheduled reentrancy/overflow risk scan',
    execute: async () => {
      await runScanCycle();
    },
    maxDuration: 5 * 60 * 1000,
    expectedIntervalMs: 15 * 60 * 1000,
  });
}
