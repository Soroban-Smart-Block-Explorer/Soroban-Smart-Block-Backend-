/**
 * WASM Diff Engine — Contract Governance Intelligence (Phase 3).
 *
 * Produces an instruction-level diff between two contract WASM versions and
 * classifies the change as minor / moderate / major / critical, plus a
 * natural-language summary. The engine is split into pure functions that
 * operate on already-extracted features (opcode indexes + function specs) so
 * the classification logic is fully unit-testable without crafting binary
 * WASM, and a `diffWasm` composer that wires the on-chain parsers in for the
 * live indexing path.
 */

import { buildOpcodeIndex, type OpcodeIndex } from './wasm-decompiler';
import { parseWasmSpec } from './wasm-spec';

export type ChangeSeverity = 'minor' | 'moderate' | 'major' | 'critical';

/**
 * Functions whose addition, removal, or signature change carries
 * access-control or value-movement risk. Changes touching these are always
 * escalated to at least "major" and surfaced to the suspicious-activity layer.
 */
export const CRITICAL_FUNCTIONS = new Set<string>([
  'upgrade',
  'set_admin',
  'set_administrator',
  'transfer_admin',
  'transfer_ownership',
  'set_owner',
  'set_authority',
  'renounce_ownership',
  'add_signer',
  'remove_signer',
  'set_threshold',
  'mint',
  'burn',
  'clawback',
  'pause',
  'unpause',
  'freeze',
  'unfreeze',
  'set_pause',
  'withdraw',
  'set_fee',
  'migrate',
  'initialize',
  'init',
]);

/** A single contract function extracted from the WASM `contractspecv0` spec. */
export interface ContractFn {
  name: string;
  /** Number of declared inputs — used to detect signature changes. */
  inputCount: number;
}

export interface OpcodeDiff {
  /** Opcodes present in the new version but not the old one. */
  addedOpcodes: string[];
  /** Opcodes present in the old version but gone from the new one. */
  removedOpcodes: string[];
  /** Total opcode count of the previous version. */
  previousTotal: number;
  /** Total opcode count of the new version. */
  newTotal: number;
  /**
   * Fraction of instructions that changed (added/removed by frequency),
   * 0 (identical) → 1 (completely rewritten).
   */
  churn: number;
}

export interface FunctionDiff {
  added: string[];
  removed: string[];
  /** Functions whose input arity changed between versions. */
  signatureChanged: string[];
  /** Subset of the above touching access-control / value-movement functions. */
  criticalChanges: string[];
}

export interface WasmDiff {
  severity: ChangeSeverity;
  summary: string;
  opcodes: OpcodeDiff;
  functions: FunctionDiff;
  /** True when previousWasm was absent (initial deployment, not an upgrade). */
  isInitial: boolean;
}

// ── Opcode diffing ────────────────────────────────────────────────────────────

/**
 * Diff two opcode indexes by frequency. Churn is the symmetric difference of
 * opcode counts normalised by the larger program, so re-ordering identical
 * instructions registers as no change while rewrites approach 1.
 */
export function diffOpcodes(previous: OpcodeIndex | null, next: OpcodeIndex): OpcodeDiff {
  const prevFreq = previous?.frequency ?? {};
  const nextFreq = next.frequency;

  const prevOps = new Set(Object.keys(prevFreq));
  const nextOps = new Set(Object.keys(nextFreq));

  const addedOpcodes = [...nextOps].filter((op) => !prevOps.has(op)).sort();
  const removedOpcodes = [...prevOps].filter((op) => !nextOps.has(op)).sort();

  const allOps = new Set([...prevOps, ...nextOps]);
  let changedBytes = 0;
  for (const op of allOps) {
    changedBytes += Math.abs((nextFreq[op] ?? 0) - (prevFreq[op] ?? 0));
  }

  const previousTotal = previous?.totalOpcodes ?? 0;
  const newTotal = next.totalOpcodes;
  const denom = Math.max(previousTotal, newTotal, 1);
  const churn = Math.min(1, changedBytes / denom);

  return { addedOpcodes, removedOpcodes, previousTotal, newTotal, churn };
}

// ── Function (spec) diffing ───────────────────────────────────────────────────

/**
 * Diff two contract function sets, flagging added/removed functions and
 * signature (arity) changes, then isolating changes to critical functions.
 */
export function diffFunctions(previous: ContractFn[] | null, next: ContractFn[]): FunctionDiff {
  const prevMap = new Map((previous ?? []).map((f) => [f.name, f]));
  const nextMap = new Map(next.map((f) => [f.name, f]));

  const added: string[] = [];
  const removed: string[] = [];
  const signatureChanged: string[] = [];

  for (const [name, fn] of nextMap) {
    const before = prevMap.get(name);
    if (!before) added.push(name);
    else if (before.inputCount !== fn.inputCount) signatureChanged.push(name);
  }
  for (const name of prevMap.keys()) {
    if (!nextMap.has(name)) removed.push(name);
  }

  const criticalChanges = [...added, ...removed, ...signatureChanged]
    .filter((name) => CRITICAL_FUNCTIONS.has(name))
    .sort();

  return {
    added: added.sort(),
    removed: removed.sort(),
    signatureChanged: signatureChanged.sort(),
    criticalChanges: [...new Set(criticalChanges)],
  };
}

// ── Classification ────────────────────────────────────────────────────────────

/**
 * Classify the overall severity of a diff. Critical-function changes dominate;
 * otherwise severity scales with opcode churn and function-set changes.
 */
export function classifyChange(opcodes: OpcodeDiff, functions: FunctionDiff): ChangeSeverity {
  if (functions.criticalChanges.length > 0) return 'critical';

  const fnChanges =
    functions.added.length + functions.removed.length + functions.signatureChanged.length;

  // Removing public functions or large rewrites are major even without
  // touching the critical set — they can break callers or hide new logic.
  if (functions.removed.length > 0 || opcodes.churn >= 0.5 || fnChanges >= 5) return 'major';

  if (opcodes.churn >= 0.15 || fnChanges >= 1 || opcodes.addedOpcodes.length > 0) return 'moderate';

  return 'minor';
}

// ── Natural-language summary ──────────────────────────────────────────────────

function joinList(items: string[], max = 5): string {
  if (items.length <= max) return items.join(', ');
  return `${items.slice(0, max).join(', ')} (+${items.length - max} more)`;
}

/** Render a human-readable summary of a diff for explorers and alerts. */
export function summarizeChange(
  severity: ChangeSeverity,
  opcodes: OpcodeDiff,
  functions: FunctionDiff,
  isInitial: boolean,
): string {
  if (isInitial) {
    return `Initial deployment — ${functions.added.length} function(s), ${opcodes.newTotal} instructions. No prior version to diff.`;
  }

  const parts: string[] = [];
  const churnPct = Math.round(opcodes.churn * 100);
  parts.push(`${severity.toUpperCase()} change: ~${churnPct}% of instructions modified`);

  if (functions.criticalChanges.length) {
    parts.push(`changes to critical function(s) ${joinList(functions.criticalChanges)}`);
  }
  if (functions.added.length) parts.push(`added ${joinList(functions.added)}`);
  if (functions.removed.length) parts.push(`removed ${joinList(functions.removed)}`);
  if (functions.signatureChanged.length) {
    parts.push(`changed signature of ${joinList(functions.signatureChanged)}`);
  }
  if (opcodes.addedOpcodes.length) {
    parts.push(`new instruction types ${joinList(opcodes.addedOpcodes)}`);
  }
  if (parts.length === 1) parts.push('no function-level or instruction-type changes detected');

  return `${parts.join('; ')}.`;
}

// ── Composers ─────────────────────────────────────────────────────────────────

/** Extract contract functions from a WASM binary's `contractspecv0` section. */
export function extractFunctions(wasm: Buffer): ContractFn[] {
  let entries;
  try {
    entries = parseWasmSpec(wasm);
  } catch {
    return [];
  }

  const fns: ContractFn[] = [];
  for (const entry of entries) {
    try {
      if (entry.switch().name !== 'scSpecEntryFunctionV0') continue;
      const fn = entry.functionV0();
      const name = fn.name().toString();
      const inputCount = fn.inputs().length;
      if (name) fns.push({ name, inputCount });
    } catch {
      // Skip entries we cannot decode rather than failing the whole diff.
    }
  }
  return fns;
}

/** Build an opcode index, tolerating malformed binaries. */
function safeOpcodeIndex(wasm: Buffer | null): OpcodeIndex | null {
  if (!wasm) return null;
  try {
    return buildOpcodeIndex(wasm);
  } catch {
    return null;
  }
}

/**
 * Full diff between two contract WASM versions. `previousWasm` is null on the
 * initial deployment. Returns a classified, summarised diff ready to persist.
 */
export function diffWasm(previousWasm: Buffer | null, newWasm: Buffer): WasmDiff {
  const isInitial = previousWasm === null;

  const prevIndex = safeOpcodeIndex(previousWasm);
  const nextIndex = safeOpcodeIndex(newWasm) ?? {
    distinctOpcodes: [],
    totalOpcodes: 0,
    frequency: {},
    sequence: [],
  };

  const opcodes = diffOpcodes(prevIndex, nextIndex);
  const functions = diffFunctions(
    previousWasm ? extractFunctions(previousWasm) : null,
    extractFunctions(newWasm),
  );

  const severity = isInitial ? 'major' : classifyChange(opcodes, functions);
  const summary = summarizeChange(severity, opcodes, functions, isInitial);

  return { severity, summary, opcodes, functions, isInitial };
}
