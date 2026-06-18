import { prismaWrite as prisma } from '../db';
import { type CallTrace } from './call-trace';

// Topic symbols that indicate value withdrawal / drain operations
const WITHDRAW_TOPICS = new Set(['withdraw', 'transfer', 'burn', 'redeem', 'claim', 'payout']);

// Thresholds
const REPEATED_CALL_THRESHOLD = 2; // same withdraw target seen ≥ this many times
const DEPTH_THRESHOLD = 4;         // call chain depth ≥ this is suspicious
const HIGH_SEVERITY_REPEATS = 4;   // repeated calls ≥ this → high severity

/** Warning label applied to every detected drain/re-entrancy signal. */
export const DRAIN_EXPLOIT_WARNING =
  'Potential Smart Contract Drain Exploit Pattern Detected';

export interface ReentrancySignal {
  transactionHash: string;
  contractAddress: string;
  ledgerSequence: number;
  repeatedWithdrawCalls: number;
  maxCallDepth: number;
  cyclicCallPairs: [string, string][];
  severity: 'low' | 'medium' | 'high';
  signals: string[];
  /** Human-readable warning label surfaced to API consumers. */
  warningLabel: string;
}

/**
 * Analyse a parsed call trace for re-entrancy / drain patterns:
 *
 * 1. Repeated withdraw-class calls targeting the same contract within one tx.
 * 2. Deep cross-contract call chains (depth ≥ DEPTH_THRESHOLD).
 * 3. Cyclic call pairs: A→B→A (caller re-enters the same contract).
 */
export function analyseCallTrace(
  txHash: string,
  contractAddress: string,
  ledgerSequence: number,
  trace: CallTrace,
): ReentrancySignal | null {
  const signals: string[] = [];

  // ── 1. Repeated withdraw calls to the same contract ──────────────────────
  const withdrawCounts = new Map<string, number>(); // contractId → count
  for (const ev of trace.events) {
    if (WITHDRAW_TOPICS.has(ev.topic)) {
      withdrawCounts.set(ev.contractId, (withdrawCounts.get(ev.contractId) ?? 0) + 1);
    }
  }
  const maxRepeats = Math.max(0, ...[...withdrawCounts.values()]);
  if (maxRepeats >= REPEATED_CALL_THRESHOLD) {
    const targets = [...withdrawCounts.entries()]
      .filter(([, c]) => c >= REPEATED_CALL_THRESHOLD)
      .map(([addr, c]) => `${addr.slice(0, 8)}… ×${c}`)
      .join(', ');
    signals.push(`Repeated withdraw-class calls: ${targets}`);
  }

  // ── 2. Deep call chain ───────────────────────────────────────────────────
  if (trace.maxDepth >= DEPTH_THRESHOLD) {
    signals.push(`Deep cross-contract call chain: depth ${trace.maxDepth}`);
  }

  // ── 3. Cyclic call pairs (A→B→A) ─────────────────────────────────────────
  // Build a sequence of (caller, callee) from consecutive fn_call events
  const callPairs: [string, string][] = [];
  const callStack: string[] = [];
  for (const ev of trace.events) {
    if (ev.topic === 'fn_call') {
      if (callStack.length > 0) {
        callPairs.push([callStack[callStack.length - 1], ev.contractId]);
      }
      callStack.push(ev.contractId);
    } else if (ev.topic === 'fn_return' && callStack.length > 0) {
      callStack.pop();
    }
  }

  // A cycle exists when distinct contracts call each other (A→B→A, not A→A)
  const cyclicPairs: [string, string][] = [];
  const seen = new Set<string>();
  for (const [caller, callee] of callPairs) {
    if (caller === callee) continue; // self-call is not a re-entrancy cycle
    const key = `${caller}→${callee}`;
    if (!seen.has(key) && callPairs.some(([c, d]) => c === callee && d === caller)) {
      cyclicPairs.push([caller, callee]);
      seen.add(key);
    }
  }
  if (cyclicPairs.length > 0) {
    const pairs = cyclicPairs.map(([a, b]) => `${a.slice(0, 8)}…↔${b.slice(0, 8)}…`).join(', ');
    signals.push(`Cyclic cross-contract calls detected: ${pairs}`);
  }

  if (signals.length === 0) return null;

  const severity: 'low' | 'medium' | 'high' =
    maxRepeats >= HIGH_SEVERITY_REPEATS || cyclicPairs.length > 0
      ? 'high'
      : trace.maxDepth >= DEPTH_THRESHOLD && maxRepeats >= REPEATED_CALL_THRESHOLD
        ? 'medium'
        : 'low';

  return {
    transactionHash: txHash,
    contractAddress,
    ledgerSequence,
    repeatedWithdrawCalls: maxRepeats,
    maxCallDepth: trace.maxDepth,
    cyclicCallPairs: cyclicPairs,
    severity,
    signals,
    warningLabel: DRAIN_EXPLOIT_WARNING,
  };
}

/**
 * Persist a detected signal and mark the transaction.
 * The `warningLabel` is appended to `signals` so it is visible in stored records.
 */
export async function storeReentrancyAlert(signal: ReentrancySignal): Promise<void> {
  // Ensure the warning label is always the last entry in the stored signals list
  const storedSignals = signal.signals.includes(signal.warningLabel)
    ? signal.signals
    : [...signal.signals, signal.warningLabel];

  await prisma.$transaction([
    prisma.reentrancyAlert.upsert({
      where: { transactionHash: signal.transactionHash },
      update: {
        repeatedWithdrawCalls: signal.repeatedWithdrawCalls,
        maxCallDepth: signal.maxCallDepth,
        cyclicCallPairs: signal.cyclicCallPairs as object[],
        severity: signal.severity,
        signals: storedSignals,
      },
      create: {
        transactionHash: signal.transactionHash,
        contractAddress: signal.contractAddress,
        ledgerSequence: signal.ledgerSequence,
        repeatedWithdrawCalls: signal.repeatedWithdrawCalls,
        maxCallDepth: signal.maxCallDepth,
        cyclicCallPairs: signal.cyclicCallPairs as object[],
        severity: signal.severity,
        signals: storedSignals,
      },
    }),
    prisma.transaction.update({
      where: { hash: signal.transactionHash },
      data: { reentrantAlert: true },
    }),
  ]);
}
