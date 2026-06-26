/**
 * Wasm Payload Byte-Decompiler Verification Engine — Issue #171
 *
 * Parses compiled, unverified contract binaries into an analytical index of
 * distinct opcode strings, then matches those opcodes against known vulnerable
 * contract templates to warn users if an unverified deployment contains
 * malicious backdoors or admin-drain functions.
 */

// ── Wasm opcode table (MVP + tail-call + sign-extension + bulk-memory) ────────
// Maps opcode byte → mnemonic string.  Only the subset relevant to security
// analysis is listed; unknown bytes are rendered as "0x<hex>".
const OPCODE_NAMES: Record<number, string> = {
  0x00: 'unreachable',
  0x01: 'nop',
  0x02: 'block',
  0x03: 'loop',
  0x04: 'if',
  0x05: 'else',
  0x0b: 'end',
  0x0c: 'br',
  0x0d: 'br_if',
  0x0e: 'br_table',
  0x0f: 'return',
  0x10: 'call',
  0x11: 'call_indirect',
  0x12: 'return_call',
  0x13: 'return_call_indirect',
  0x1a: 'drop',
  0x1b: 'select',
  0x20: 'local.get',
  0x21: 'local.set',
  0x22: 'local.tee',
  0x23: 'global.get',
  0x24: 'global.set',
  0x25: 'table.get',
  0x26: 'table.set',
  0x28: 'i32.load',
  0x29: 'i64.load',
  0x2a: 'f32.load',
  0x2b: 'f64.load',
  0x2c: 'i32.load8_s',
  0x2d: 'i32.load8_u',
  0x2e: 'i32.load16_s',
  0x2f: 'i32.load16_u',
  0x30: 'i64.load8_s',
  0x31: 'i64.load8_u',
  0x32: 'i64.load16_s',
  0x33: 'i64.load16_u',
  0x34: 'i64.load32_s',
  0x35: 'i64.load32_u',
  0x36: 'i32.store',
  0x37: 'i64.store',
  0x38: 'f32.store',
  0x39: 'f64.store',
  0x3a: 'i32.store8',
  0x3b: 'i32.store16',
  0x3c: 'i64.store8',
  0x3d: 'i64.store16',
  0x3e: 'i64.store32',
  0x3f: 'memory.size',
  0x40: 'memory.grow',
  0x41: 'i32.const',
  0x42: 'i64.const',
  0x43: 'f32.const',
  0x44: 'f64.const',
  0x45: 'i32.eqz',
  0x46: 'i32.eq',
  0x47: 'i32.ne',
  0x48: 'i32.lt_s',
  0x49: 'i32.lt_u',
  0x4a: 'i32.gt_s',
  0x4b: 'i32.gt_u',
  0x4c: 'i32.le_s',
  0x4d: 'i32.le_u',
  0x4e: 'i32.ge_s',
  0x4f: 'i32.ge_u',
  0x50: 'i64.eqz',
  0x51: 'i64.eq',
  0x52: 'i64.ne',
  0x53: 'i64.lt_s',
  0x54: 'i64.lt_u',
  0x55: 'i64.gt_s',
  0x56: 'i64.gt_u',
  0x57: 'i64.le_s',
  0x58: 'i64.le_u',
  0x59: 'i64.ge_s',
  0x5a: 'i64.ge_u',
  0x67: 'i32.clz',
  0x68: 'i32.ctz',
  0x69: 'i32.popcnt',
  0x6a: 'i32.add',
  0x6b: 'i32.sub',
  0x6c: 'i32.mul',
  0x6d: 'i32.div_s',
  0x6e: 'i32.div_u',
  0x6f: 'i32.rem_s',
  0x70: 'i32.rem_u',
  0x71: 'i32.and',
  0x72: 'i32.or',
  0x73: 'i32.xor',
  0x74: 'i32.shl',
  0x75: 'i32.shr_s',
  0x76: 'i32.shr_u',
  0x77: 'i32.rotl',
  0x78: 'i32.rotr',
  0x79: 'i64.clz',
  0x7a: 'i64.ctz',
  0x7b: 'i64.popcnt',
  0x7c: 'i64.add',
  0x7d: 'i64.sub',
  0x7e: 'i64.mul',
  0x7f: 'i64.div_s',
  0x80: 'i64.div_u',
  0x81: 'i64.rem_s',
  0x82: 'i64.rem_u',
  0x83: 'i64.and',
  0x84: 'i64.or',
  0x85: 'i64.xor',
  0x86: 'i64.shl',
  0x87: 'i64.shr_s',
  0x88: 'i64.shr_u',
  0x89: 'i64.rotl',
  0x8a: 'i64.rotr',
  0xa7: 'i32.wrap_i64',
  0xa8: 'i32.trunc_f32_s',
  0xa9: 'i32.trunc_f32_u',
  0xaa: 'i32.trunc_f64_s',
  0xab: 'i32.trunc_f64_u',
  0xac: 'i64.extend_i32_s',
  0xad: 'i64.extend_i32_u',
  0xae: 'i64.trunc_f32_s',
  0xaf: 'i64.trunc_f32_u',
  0xb0: 'i64.trunc_f64_s',
  0xb1: 'i64.trunc_f64_u',
  0xfc: 'misc', // prefix for bulk-memory / saturating-trunc instructions
};

import { createHash } from 'crypto';

// ── Vulnerable pattern templates ──────────────────────────────────────────────

export interface VulnerableTemplate {
  /** Short identifier for the vulnerability class. */
  id: string;
  /** Human-readable description shown to users. */
  description: string;
  /**
   * Ordered opcode sequence that must appear consecutively (or within a
   * sliding window) in the decompiled opcode list to trigger this template.
   */
  opcodeSequence: string[];
  /**
   * Maximum gap (in opcodes) allowed between consecutive pattern elements.
   * Defaults to 0 (strict consecutive match).
   */
  maxGap?: number;
}

export interface WasmSectionSummary {
  id: number;
  name?: string;
  type: string;
  size: number;
  details?: Record<string, unknown>;
}

export interface WasmImportEntry {
  module: string;
  name: string;
  kind: 'func' | 'table' | 'memory' | 'global' | 'unknown';
  typeIndex?: number;
  type?: string;
  host?: boolean;
  metadata?: Record<string, unknown>;
  mutable?: boolean;
}

export interface WasmExportEntry {
  name: string;
  kind: 'func' | 'table' | 'memory' | 'global' | 'unknown';
  index: number;
}

export interface WasmGlobalEntry {
  index: number;
  type: string;
  mutable: boolean;
}

export interface WasmMemoryEntry {
  min: number;
  max?: number;
  shared?: boolean;
}

export interface WasmTypeEntry {
  params: string[];
  results: string[];
}

export interface WasmInstruction {
  offset: number;
  mnemonic: string;
  immediates: number[];
  raw: string;
}

export interface FunctionBasicBlock {
  id: string;
  instructions: string[];
  successors: string[];
}

export interface FunctionCFG {
  entryBlock: string;
  blocks: FunctionBasicBlock[];
  loops: string[];
}

export interface FunctionCallInfo {
  targetIndex: number;
  targetName: string;
  kind: 'internal' | 'imported' | 'indirect';
  instructionOffset: number;
}

export interface StorageOperation {
  type: 'read' | 'write';
  instruction: string;
  offset: number;
}

export interface HostCallInfo {
  module: string;
  name: string;
  instructionOffset: number;
}

export interface FunctionAnalysis {
  index: number;
  globalIndex: number;
  name: string;
  exportName?: string;
  selector?: string;
  signature: WasmTypeEntry;
  params: string[];
  returns: string[];
  localTypes: string[];
  bytecode: string[];
  instructions: WasmInstruction[];
  pseudoCode: string;
  cfg: FunctionCFG;
  complexity: 'low' | 'medium' | 'high';
  linesOfCode: number;
  cyclomaticComplexity: number;
  calls: FunctionCallInfo[];
  storageOperations: StorageOperation[];
  hostCalls: HostCallInfo[];
  sourceMap: unknown[];
}

export interface CallGraphEdge {
  from: string;
  to: string;
  type: 'call' | 'delegate' | 'import';
}

export interface ContractSourceAnalysis {
  sourceType: 'wasm';
  language: 'wasm';
  compilerVersion: string | null;
  wasmHash: string;
  bytecodeSize: number;
  sections: WasmSectionSummary[];
  imports: WasmImportEntry[];
  exports: WasmExportEntry[];
  memory: WasmMemoryEntry[];
  globals: WasmGlobalEntry[];
  functions: FunctionAnalysis[];
  callGraph: {
    nodes: string[];
    edges: CallGraphEdge[];
  };
  storageVariables: unknown[];
  events: unknown[];
  errors: unknown[];
  metadata: Record<string, unknown>;
  pseudoCode: string;
  decompiledAt: string;
  verifiedAt?: string | null;
  updatedAt: string;
}

/**
 * Known vulnerable contract templates.
 *
 * Each template encodes a characteristic opcode pattern observed in:
 *   - Admin-drain functions (unrestricted global.get → call → return)
 *   - Backdoor initialisation (call_indirect with no auth guard)
 *   - Reentrancy-enabling loops (loop → call → br_if)
 *   - Unchecked arithmetic (i64.div_s / i32.div_s without eqz guard)
 */
export const VULNERABLE_TEMPLATES: VulnerableTemplate[] = [
  {
    id: 'admin-drain',
    description:
      'Admin-drain function: unrestricted global state read followed by an unconditional transfer call',
    opcodeSequence: ['global.get', 'call', 'return'],
    maxGap: 3,
  },
  {
    id: 'backdoor-init',
    description: 'Backdoor initialisation: indirect call with no preceding auth/guard check',
    opcodeSequence: ['call_indirect'],
    maxGap: 0,
  },
  {
    id: 'reentrancy-loop',
    description:
      'Reentrancy-enabling loop: loop body contains an external call followed by a conditional branch back',
    opcodeSequence: ['loop', 'call', 'br_if'],
    maxGap: 5,
  },
  {
    id: 'unchecked-division',
    description:
      'Unchecked integer division: divisor is not guarded by an eqz/ne zero-check before division',
    opcodeSequence: ['i64.div_s'],
    maxGap: 0,
  },
  {
    id: 'unchecked-division-u',
    description: 'Unchecked unsigned integer division: divisor is not guarded before i64.div_u',
    opcodeSequence: ['i64.div_u'],
    maxGap: 0,
  },
  {
    id: 'unreachable-trap',
    description:
      'Deliberate unreachable trap: contract contains an unconditional unreachable instruction that can be triggered to lock funds',
    opcodeSequence: ['unreachable'],
    maxGap: 0,
  },
  {
    id: 'memory-grow-drain',
    description:
      'Unbounded memory growth: memory.grow called without a preceding size check, enabling resource exhaustion',
    opcodeSequence: ['memory.grow'],
    maxGap: 0,
  },
];

// ── Public types ──────────────────────────────────────────────────────────────

export interface OpcodeIndex {
  /** Deduplicated list of distinct opcode mnemonics found in the binary. */
  distinctOpcodes: string[];
  /** Total number of opcode bytes decoded from all code sections. */
  totalOpcodes: number;
  /** Frequency map: opcode mnemonic → count. */
  frequency: Record<string, number>;
  /** Full ordered opcode sequence (may be large for complex contracts). */
  sequence: string[];
}

export interface VulnerabilityMatch {
  templateId: string;
  description: string;
  /** Byte offset in the code section where the pattern was first matched. */
  matchOffset: number;
}

export interface DecompileResult {
  opcodeIndex: OpcodeIndex;
  vulnerabilities: VulnerabilityMatch[];
  /** True when at least one vulnerability template matched. */
  hasVulnerabilities: boolean;
  /**
   * Warning message shown to users when the binary matches a known
   * malicious template.  Null when no vulnerabilities are detected.
   */
  warningMessage: string | null;
}

// ── Core implementation ───────────────────────────────────────────────────────

/**
 * Decode a Wasm binary into an analytical opcode index.
 *
 * Only the Code section (section id 10) is parsed; other sections are skipped.
 * Each function body is walked byte-by-byte using the Wasm MVP opcode encoding.
 *
 * @throws {Error} if the buffer is not a valid Wasm binary (bad magic/version).
 */
export function buildOpcodeIndex(wasm: Buffer): OpcodeIndex {
  if (wasm.length < 8) throw new Error('Invalid Wasm: binary too short');

  const magic = wasm.readUInt32BE(0);
  if (magic !== 0x0061736d) throw new Error('Invalid Wasm: bad magic number');

  const version = wasm.readUInt32LE(4);
  if (version !== 1) throw new Error(`Invalid Wasm: unsupported version ${version}`);

  const sequence: string[] = [];
  const frequency: Record<string, number> = {};

  let offset = 8;

  while (offset < wasm.length) {
    const sectionId = wasm[offset++];
    const [sectionSize, sizeLen] = readUleb128(wasm, offset);
    offset += sizeLen;
    const sectionEnd = offset + sectionSize;

    if (sectionId === 10) {
      // Code section — contains function bodies
      const [funcCount, funcCountLen] = readUleb128(wasm, offset);
      let bodyOffset = offset + funcCountLen;

      for (let f = 0; f < funcCount && bodyOffset < sectionEnd; f++) {
        const [bodySize, bodySizeLen] = readUleb128(wasm, bodyOffset);
        bodyOffset += bodySizeLen;
        const bodyEnd = bodyOffset + bodySize;

        // Skip local declarations
        const [localCount, localCountLen] = readUleb128(wasm, bodyOffset);
        let codeOffset = bodyOffset + localCountLen;
        for (let l = 0; l < localCount && codeOffset < bodyEnd; l++) {
          const [, nLen] = readUleb128(wasm, codeOffset);
          codeOffset += nLen + 1; // count + valtype byte
        }

        // Walk opcodes
        while (codeOffset < bodyEnd) {
          const byte = wasm[codeOffset++];
          const mnemonic = OPCODE_NAMES[byte] ?? `0x${byte.toString(16).padStart(2, '0')}`;
          sequence.push(mnemonic);
          frequency[mnemonic] = (frequency[mnemonic] ?? 0) + 1;

          // Skip immediate operands for instructions that carry them
          codeOffset = skipImmediates(byte, wasm, codeOffset, bodyEnd);
        }

        bodyOffset = bodyEnd;
      }
    }

    offset = sectionEnd;
  }

  const distinctOpcodes = Object.keys(frequency).sort();

  return {
    distinctOpcodes,
    totalOpcodes: sequence.length,
    frequency,
    sequence,
  };
}

/**
 * Match the opcode sequence from an OpcodeIndex against all known
 * VULNERABLE_TEMPLATES and return every match found.
 */
export function matchVulnerableTemplates(
  index: OpcodeIndex,
  templates: VulnerableTemplate[] = VULNERABLE_TEMPLATES,
): VulnerabilityMatch[] {
  const matches: VulnerabilityMatch[] = [];
  const seq = index.sequence;

  for (const template of templates) {
    const pattern = template.opcodeSequence;
    const maxGap = template.maxGap ?? 0;

    if (pattern.length === 0) continue;

    // Single-opcode patterns: check frequency map for O(1) lookup
    if (pattern.length === 1) {
      if ((index.frequency[pattern[0]] ?? 0) > 0) {
        // Find first occurrence offset
        const firstIdx = seq.indexOf(pattern[0]);
        matches.push({
          templateId: template.id,
          description: template.description,
          matchOffset: firstIdx,
        });
      }
      continue;
    }

    // Multi-opcode patterns: sliding window search
    let patternIdx = 0;
    let windowStart = 0;

    for (let i = 0; i < seq.length; i++) {
      if (seq[i] === pattern[patternIdx]) {
        if (patternIdx === 0) windowStart = i;
        patternIdx++;
        if (patternIdx === pattern.length) {
          matches.push({
            templateId: template.id,
            description: template.description,
            matchOffset: windowStart,
          });
          break; // report first match only per template
        }
      } else if (patternIdx > 0) {
        // Check gap constraint: distance from last matched element
        const gap = i - windowStart - patternIdx;
        if (gap > maxGap) {
          // Reset and retry from current position
          i = windowStart; // will be incremented by loop
          patternIdx = 0;
        }
      }
    }
  }

  return matches;
}

/**
 * Full decompile pipeline: parse opcodes → match vulnerability templates →
 * produce a DecompileResult with a human-readable warning when issues are found.
 *
 * @param wasm  Raw Wasm bytecode buffer.
 * @param templates  Override the default VULNERABLE_TEMPLATES (useful for testing).
 */
export function decompileWasm(
  wasm: Buffer,
  templates: VulnerableTemplate[] = VULNERABLE_TEMPLATES,
): DecompileResult {
  const opcodeIndex = buildOpcodeIndex(wasm);
  const vulnerabilities = matchVulnerableTemplates(opcodeIndex, templates);
  const hasVulnerabilities = vulnerabilities.length > 0;

  let warningMessage: string | null = null;
  if (hasVulnerabilities) {
    const ids = vulnerabilities.map((v) => v.templateId).join(', ');
    warningMessage =
      `Unverified contract binary matches ${vulnerabilities.length} known vulnerable ` +
      `template(s): [${ids}]. This deployment may contain malicious backdoors or ` +
      `admin-drain functions. Review the source code before interacting with this contract.`;
  }

  return { opcodeIndex, vulnerabilities, hasVulnerabilities, warningMessage };
}

export function analyzeWasmContract(wasm: Buffer): ContractSourceAnalysis {
  if (wasm.length < 8) throw new Error('Invalid Wasm: binary too short');

  const sections = parseWasmSections(wasm);
  const moduleInfo = parseWasmModule(wasm);
  const now = new Date().toISOString();

  const functions = analyzeFunctionBodies(wasm, moduleInfo);
  const callGraph = buildCallGraph(functions);
  const pseudoCode = functions.map((fn) => fn.pseudoCode).join('\n\n');

  return {
    sourceType: 'wasm',
    language: 'wasm',
    compilerVersion: null,
    wasmHash: createHash('sha256').update(wasm).digest('hex'),
    bytecodeSize: wasm.length,
    sections,
    imports: moduleInfo.imports,
    exports: moduleInfo.exports,
    memory: moduleInfo.memories,
    globals: moduleInfo.globals,
    functions,
    callGraph,
    storageVariables: [],
    events: [],
    errors: [],
    metadata: {
      typeCount: moduleInfo.types.length,
      importCount: moduleInfo.imports.length,
      definedFunctionCount: functions.length,
    },
    pseudoCode,
    decompiledAt: now,
    verifiedAt: null,
    updatedAt: now,
  };
}

interface ParsedWasmModule {
  types: WasmTypeEntry[];
  imports: WasmImportEntry[];
  exports: WasmExportEntry[];
  memories: WasmMemoryEntry[];
  globals: WasmGlobalEntry[];
  functionTypeIndices: number[];
  importedFunctionCount: number;
  functionNameMap: Map<number, string>;
}

function parseWasmSections(wasm: Buffer): WasmSectionSummary[] {
  const sections: WasmSectionSummary[] = [];
  let offset = 8;

  while (offset < wasm.length) {
    const sectionId = wasm[offset++];
    const [sectionSize, sizeLen] = readUleb128(wasm, offset);
    offset += sizeLen;
    const sectionStart = offset;
    const sectionEnd = offset + sectionSize;
    const sectionName = sectionNameFromId(sectionId);
    const summary: WasmSectionSummary = {
      id: sectionId,
      name: sectionName,
      type: sectionName,
      size: sectionSize,
    };

    if (sectionId === 0) {
      const [name] = readString(wasm, offset);
      summary.details = { customName: name };
    }

    sections.push(summary);
    offset = sectionEnd;
  }

  return sections;
}

function parseWasmModule(wasm: Buffer): ParsedWasmModule {
  const types: WasmTypeEntry[] = [];
  const imports: WasmImportEntry[] = [];
  const exports: WasmExportEntry[] = [];
  const memories: WasmMemoryEntry[] = [];
  const globals: WasmGlobalEntry[] = [];
  const functionTypeIndices: number[] = [];
  const functionNameMap = new Map<number, string>();

  let offset = 8;
  let importedFunctionCount = 0;

  while (offset < wasm.length) {
    const sectionId = wasm[offset++];
    const [sectionSize, sizeLen] = readUleb128(wasm, offset);
    offset += sizeLen;
    const sectionEnd = offset + sectionSize;

    switch (sectionId) {
      case 1: {
        const [count, countLen] = readUleb128(wasm, offset);
        let pos = offset + countLen;
        for (let i = 0; i < count; i++) {
          const form = wasm[pos++];
          if (form !== 0x60) throw new Error('Unsupported Wasm type form');
          const [paramCount, paramLen] = readUleb128(wasm, pos);
          pos += paramLen;
          const params: string[] = [];
          for (let j = 0; j < paramCount; j++) {
            params.push(valTypeName(wasm[pos++]));
          }
          const [resultCount, resultLen] = readUleb128(wasm, pos);
          pos += resultLen;
          const results: string[] = [];
          for (let j = 0; j < resultCount; j++) {
            results.push(valTypeName(wasm[pos++]));
          }
          types.push({ params, results });
        }
        break;
      }
      case 2: {
        const [count, countLen] = readUleb128(wasm, offset);
        let pos = offset + countLen;
        for (let i = 0; i < count; i++) {
          const [module, moduleLen] = readString(wasm, pos);
          pos += moduleLen;
          const [name, nameLen] = readString(wasm, pos);
          pos += nameLen;
          const kind = wasm[pos++];
          const entry: WasmImportEntry = {
            module,
            name,
            kind: 'unknown',
          };
          if (kind === 0x00) {
            entry.kind = 'func';
            const [typeIndex, typeLen] = readUleb128(wasm, pos);
            pos += typeLen;
            entry.typeIndex = typeIndex;
            entry.type = typeIndex < types.length ? typeSignature(types[typeIndex]) : undefined;
            entry.host = module.startsWith('soroban_') || module === 'env';
            importedFunctionCount += 1;
          } else if (kind === 0x01) {
            entry.kind = 'table';
            const elemType = wasm[pos++];
            const [flags, flagsLen] = readUleb128(wasm, pos);
            pos += flagsLen;
            const [min, minLen] = readUleb128(wasm, pos);
            pos += minLen;
            let max;
            if (flags & 0x01) {
              const [value, valueLen] = readUleb128(wasm, pos);
              pos += valueLen;
              max = value;
            }
            entry.metadata = { elemType, min, max };
          } else if (kind === 0x02) {
            entry.kind = 'memory';
            const [flags, flagsLen] = readUleb128(wasm, pos);
            pos += flagsLen;
            const [min, minLen] = readUleb128(wasm, pos);
            pos += minLen;
            let max;
            if (flags & 0x01) {
              const [value, valueLen] = readUleb128(wasm, pos);
              pos += valueLen;
              max = value;
            }
            entry.metadata = { min, max, shared: Boolean(flags & 0x02) };
          } else if (kind === 0x03) {
            entry.kind = 'global';
            const typeName = valTypeName(wasm[pos++]);
            const mutable = wasm[pos++] === 1;
            entry.type = typeName;
            entry.mutable = mutable;
          }
          imports.push(entry);
        }
        break;
      }
      case 3: {
        const [count, countLen] = readUleb128(wasm, offset);
        let pos = offset + countLen;
        for (let i = 0; i < count; i++) {
          const [typeIndex, typeLen] = readUleb128(wasm, pos);
          pos += typeLen;
          functionTypeIndices.push(typeIndex);
        }
        break;
      }
      case 5: {
        const [count, countLen] = readUleb128(wasm, offset);
        let pos = offset + countLen;
        for (let i = 0; i < count; i++) {
          const [flags, flagsLen] = readUleb128(wasm, pos);
          pos += flagsLen;
          const [min, minLen] = readUleb128(wasm, pos);
          pos += minLen;
          let max;
          if (flags & 0x01) {
            const [value, valueLen] = readUleb128(wasm, pos);
            pos += valueLen;
            max = value;
          }
          memories.push({ min, max, shared: Boolean(flags & 0x02) });
        }
        break;
      }
      case 6: {
        const [count, countLen] = readUleb128(wasm, offset);
        let pos = offset + countLen;
        for (let i = 0; i < count; i++) {
          const typeName = valTypeName(wasm[pos++]);
          const mutable = wasm[pos++] === 1;
          globals.push({ index: globals.length, type: typeName, mutable });
          while (wasm[pos++] !== 0x0b && pos < sectionEnd) {
            // skip init expr
          }
        }
        break;
      }
      case 7: {
        const [count, countLen] = readUleb128(wasm, offset);
        let pos = offset + countLen;
        for (let i = 0; i < count; i++) {
          const [name, nameLen] = readString(wasm, pos);
          pos += nameLen;
          const kind = wasm[pos++];
          const [index, idxLen] = readUleb128(wasm, pos);
          pos += idxLen;
          exports.push({ name, kind: exportKindName(kind), index });
          if (kind === 0x00) {
            functionNameMap.set(index, name);
          }
        }
        break;
      }
      case 0: {
        const [customName, customNameLen] = readString(wasm, offset);
        let pos = offset + customNameLen;
        if (customName === 'name') {
          while (pos < sectionEnd) {
            const subsectionId = wasm[pos++];
            const [subSize, subSizeLen] = readUleb128(wasm, pos);
            pos += subSizeLen;
            const subEnd = pos + subSize;
            if (subsectionId === 1) {
              const [nameCount, nameCountLen] = readUleb128(wasm, pos);
              pos += nameCountLen;
              for (let i = 0; i < nameCount; i++) {
                const [idx, idxLen] = readUleb128(wasm, pos);
                pos += idxLen;
                const [name, nameLen] = readString(wasm, pos);
                pos += nameLen;
                functionNameMap.set(idx, name);
              }
            } else {
              pos = subEnd;
            }
          }
        }
        break;
      }
      default:
        break;
    }

    offset = sectionEnd;
  }

  return {
    types,
    imports,
    exports,
    memories,
    globals,
    functionTypeIndices,
    importedFunctionCount,
    functionNameMap,
  };
}

function analyzeFunctionBodies(wasm: Buffer, moduleInfo: ParsedWasmModule): FunctionAnalysis[] {
  let offset = 8;
  const functions: FunctionAnalysis[] = [];
  const importedCount = moduleInfo.importedFunctionCount;
  let functionBodyIndex = 0;

  while (offset < wasm.length) {
    const sectionId = wasm[offset++];
    const [sectionSize, sizeLen] = readUleb128(wasm, offset);
    offset += sizeLen;
    const sectionEnd = offset + sectionSize;

    if (sectionId === 10) {
      const [funcCount, funcCountLen] = readUleb128(wasm, offset);
      let pos = offset + funcCountLen;
      for (let i = 0; i < funcCount && pos < sectionEnd; i++) {
        const [bodySize, bodySizeLen] = readUleb128(wasm, pos);
        pos += bodySizeLen;
        const bodyStart = pos;
        const bodyEnd = bodyStart + bodySize;

        const [localCount, localCountLen] = readUleb128(wasm, pos);
        pos += localCountLen;
        const localTypes: string[] = [];
        for (let j = 0; j < localCount; j++) {
          const [count, countLen] = readUleb128(wasm, pos);
          pos += countLen;
          const typeName = valTypeName(wasm[pos++]);
          for (let k = 0; k < count; k++) {
            localTypes.push(typeName);
          }
        }

        const instructions: WasmInstruction[] = [];
        let instructionOffset = pos;
        while (instructionOffset < bodyEnd) {
          const instruction = readInstruction(wasm, instructionOffset);
          instructions.push(instruction);
          instructionOffset = instruction.nextOffset;
        }

        const functionIndex = importedCount + functionBodyIndex;
        const exportName = moduleInfo.exports.find(
          (entry) => entry.kind === 'func' && entry.index === functionIndex,
        )?.name;
        const explicitName =
          moduleInfo.functionNameMap.get(functionIndex) ?? exportName ?? `func_${functionIndex}`;
        const signature = moduleInfo.types[moduleInfo.functionTypeIndices[functionBodyIndex]] ?? {
          params: [],
          results: [],
        };
        const params = signature.params.map((_, idx) => `arg${idx}`);
        const returns = signature.results.map((_, idx) => `ret${idx}`);

        const calls: FunctionCallInfo[] = [];
        const hostCalls: HostCallInfo[] = [];
        const storageOperations: StorageOperation[] = [];
        const pseudoLines: string[] = [];
        let branchCount = 0;

        for (const insn of instructions) {
          const args = insn.immediates.join(', ');
          let line = '';
          switch (insn.mnemonic) {
            case 'local.get':
              line = `stack.push(local_${insn.immediates[0] ?? 0})`;
              break;
            case 'local.set':
              line = `local_${insn.immediates[0] ?? 0} = stack.pop()`;
              break;
            case 'local.tee':
              line = `local_${insn.immediates[0] ?? 0} = stack.top()`;
              break;
            case 'global.get':
              line = `stack.push(global_${insn.immediates[0] ?? 0})`;
              break;
            case 'global.set':
              line = `global_${insn.immediates[0] ?? 0} = stack.pop()`;
              break;
            case 'call': {
              const targetIndex = insn.immediates[0] ?? 0;
              const targetName =
                moduleInfo.functionNameMap.get(targetIndex) ?? `func_${targetIndex}`;
              const kind = targetIndex < importedCount ? 'imported' : 'internal';
              calls.push({ targetIndex, targetName, kind, instructionOffset: insn.offset });
              if (kind === 'imported') {
                const imported = moduleInfo.imports.find(
                  (imp) =>
                    imp.kind === 'func' &&
                    imp.typeIndex === moduleInfo.functionTypeIndices[targetIndex - importedCount],
                );
                hostCalls.push({
                  module: imported?.module ?? 'unknown',
                  name: imported?.name ?? targetName,
                  instructionOffset: insn.offset,
                });
              }
              line = `${targetName}(${args})`;
              break;
            }
            case 'call_indirect': {
              const typeIndex = insn.immediates[0] ?? 0;
              branchCount += 1;
              line = `call_indirect(type=${typeIndex})`;
              break;
            }
            case 'br_if':
              branchCount += 1;
              line = `if (stack.pop()) goto label_${insn.immediates[0] ?? 0}`;
              break;
            case 'br':
              line = `goto label_${insn.immediates[0] ?? 0}`;
              break;
            case 'loop':
              line = `loop`;
              branchCount += 1;
              break;
            case 'if':
              line = `if (stack.pop()) {`;
              branchCount += 1;
              break;
            case 'else':
              line = `} else {`;
              break;
            case 'end':
              line = `}`;
              break;
            case 'return':
              line = `return`;
              break;
            case 'i32.const':
            case 'i64.const':
            case 'f32.const':
            case 'f64.const':
              line = `stack.push(${insn.immediates.join(', ')})`;
              break;
            case 'i32.load':
            case 'i64.load':
            case 'i32.store':
            case 'i64.store':
              storageOperations.push({
                type: insn.mnemonic.endsWith('.load') ? 'read' : 'write',
                instruction: insn.mnemonic,
                offset: insn.offset,
              });
              line = `${insn.mnemonic} [${insn.immediates.join(', ')}]`;
              break;
            default:
              line = `${insn.mnemonic}${args ? ` ${args}` : ''}`;
              break;
          }
          pseudoLines.push(line);
        }

        const cyclomaticComplexity = Math.max(1, branchCount + 1);
        const complexity =
          cyclomaticComplexity <= 2 ? 'low' : cyclomaticComplexity <= 5 ? 'medium' : 'high';

        const cfg = buildFunctionCFG(instructions);

        functions.push({
          index: functionIndex,
          globalIndex: functionIndex,
          name: explicitName,
          exportName,
          selector: exportName
            ? createHash('sha256').update(exportName).digest('hex').slice(0, 10)
            : undefined,
          signature,
          params,
          returns,
          localTypes,
          bytecode: instructions.map((insn) => insn.raw),
          instructions,
          pseudoCode: pseudoLines.join('\n'),
          cfg,
          complexity,
          linesOfCode: pseudoLines.length,
          cyclomaticComplexity,
          calls,
          storageOperations,
          hostCalls,
          sourceMap: instructions.map((insn, idx) => ({
            instructionIndex: idx,
            wasmOffset: insn.offset,
            pseudoLine: idx,
          })),
        });

        functionBodyIndex += 1;
        pos = bodyEnd;
      }
    }

    offset = sectionEnd;
  }

  return functions;
}

function buildCallGraph(functions: FunctionAnalysis[]): {
  nodes: string[];
  edges: CallGraphEdge[];
} {
  const nodes = functions.map((fn) => fn.name);
  const edges: CallGraphEdge[] = [];
  for (const fn of functions) {
    for (const call of fn.calls) {
      edges.push({
        from: fn.name,
        to: call.targetName,
        type: call.kind === 'imported' ? 'import' : 'call',
      });
    }
  }
  return { nodes, edges };
}

function buildFunctionCFG(instructions: WasmInstruction[]): FunctionCFG {
  const blocks: FunctionBasicBlock[] = [];
  let currentId = 0;
  let currentBlock: FunctionBasicBlock = {
    id: `block_${currentId}`,
    instructions: [],
    successors: [],
  };
  const loops: string[] = [];

  for (const insn of instructions) {
    currentBlock.instructions.push(insn.raw);
    if (insn.mnemonic === 'loop') {
      loops.push(currentBlock.id);
    }
    if (['br', 'br_if', 'br_table', 'return', 'end', 'else'].includes(insn.mnemonic)) {
      blocks.push(currentBlock);
      currentId += 1;
      currentBlock = { id: `block_${currentId}`, instructions: [], successors: [] };
    }
  }
  if (currentBlock.instructions.length > 0) {
    blocks.push(currentBlock);
  }

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const last = block.instructions[block.instructions.length - 1] ?? '';
    if (
      !last.startsWith('br') &&
      !last.startsWith('return') &&
      block.id !== blocks[blocks.length - 1]?.id
    ) {
      block.successors.push(blocks[i + 1].id);
    }
  }

  return { entryBlock: 'block_0', blocks, loops };
}

function readInstruction(wasm: Buffer, offset: number): WasmInstruction & { nextOffset: number } {
  const start = offset;
  const opcode = wasm[offset++];
  const mnemonic = OPCODE_NAMES[opcode] ?? `0x${opcode.toString(16).padStart(2, '0')}`;
  const immediates: number[] = [];

  switch (opcode) {
    case 0x02:
    case 0x03:
    case 0x04: {
      const [value, len] = readSleb128(wasm, offset);
      immediates.push(value);
      offset += len;
      break;
    }
    case 0x0c:
    case 0x0d:
    case 0x10:
    case 0x12: {
      const [value, len] = readUleb128(wasm, offset);
      immediates.push(value);
      offset += len;
      break;
    }
    case 0x11:
    case 0x13: {
      const [value1, len1] = readUleb128(wasm, offset);
      offset += len1;
      const [value2, len2] = readUleb128(wasm, offset);
      offset += len2;
      immediates.push(value1, value2);
      break;
    }
    case 0x20:
    case 0x21:
    case 0x22:
    case 0x23:
    case 0x24:
    case 0x25:
    case 0x26: {
      const [value, len] = readUleb128(wasm, offset);
      immediates.push(value);
      offset += len;
      break;
    }
    case 0x0e: {
      const [count, countLen] = readUleb128(wasm, offset);
      offset += countLen;
      immediates.push(count);
      for (let i = 0; i <= count; i++) {
        const [value, len] = readUleb128(wasm, offset);
        immediates.push(value);
        offset += len;
      }
      break;
    }
    case 0x3f:
    case 0x40: {
      const [value, len] = readUleb128(wasm, offset);
      immediates.push(value);
      offset += len;
      break;
    }
    case 0x41:
    case 0x42: {
      const [value, len] = readSleb128(wasm, offset);
      immediates.push(value);
      offset += len;
      break;
    }
    case 0x43:
      immediates.push(wasm.readUInt32LE(offset));
      offset += 4;
      break;
    case 0x44:
      immediates.push(Number(wasm.readBigUInt64LE(offset)));
      offset += 8;
      break;
    case 0xfc: {
      const [subOpcode, subLen] = readUleb128(wasm, offset);
      immediates.push(subOpcode);
      offset += subLen;
      break;
    }
    default:
      break;
  }

  return {
    offset: start,
    mnemonic,
    immediates,
    raw: Buffer.from(wasm.slice(start, offset)).toString('hex'),
    nextOffset: offset,
  };
}

function readString(buf: Buffer, offset: number): [string, number] {
  const [length, lenBytes] = readUleb128(buf, offset);
  const start = offset + lenBytes;
  const value = buf.toString('utf8', start, start + length);
  return [value, lenBytes + length];
}

function readSleb128(buf: Buffer, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  let bytesRead = 0;
  let byte = 0;
  do {
    byte = buf[offset + bytesRead++];
    result |= (byte & 0x7f) << shift;
    shift += 7;
  } while ((byte & 0x80) !== 0);
  if (shift < 32 && (byte & 0x40) !== 0) {
    result |= -1 << shift;
  }
  return [result, bytesRead];
}

function sectionNameFromId(sectionId: number): string {
  switch (sectionId) {
    case 0:
      return 'custom';
    case 1:
      return 'type';
    case 2:
      return 'import';
    case 3:
      return 'function';
    case 4:
      return 'table';
    case 5:
      return 'memory';
    case 6:
      return 'global';
    case 7:
      return 'export';
    case 8:
      return 'start';
    case 9:
      return 'element';
    case 10:
      return 'code';
    case 11:
      return 'data';
    default:
      return 'unknown';
  }
}

function valTypeName(code: number): string {
  switch (code) {
    case 0x7f:
      return 'i32';
    case 0x7e:
      return 'i64';
    case 0x7d:
      return 'f32';
    case 0x7c:
      return 'f64';
    default:
      return `unknown(0x${code.toString(16)})`;
  }
}

function exportKindName(kind: number): WasmExportEntry['kind'] {
  switch (kind) {
    case 0x00:
      return 'func';
    case 0x01:
      return 'table';
    case 0x02:
      return 'memory';
    case 0x03:
      return 'global';
    default:
      return 'unknown';
  }
}

function typeSignature(type: WasmTypeEntry): string {
  return `(${type.params.join(', ')}) -> (${type.results.join(', ')})`;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Read an unsigned LEB128 integer; returns [value, bytesConsumed]. */
function readUleb128(buf: Buffer, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  let bytesRead = 0;
  while (offset + bytesRead < buf.length) {
    const byte = buf[offset + bytesRead++];
    result |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return [result, bytesRead];
}

/**
 * Advance `offset` past the immediate operands of a given opcode byte.
 * Returns the new offset.  Unknown opcodes are treated as having no immediates.
 */
function skipImmediates(opcode: number, buf: Buffer, offset: number, end: number): number {
  switch (opcode) {
    // block / loop / if — blocktype (sleb128 or single byte)
    case 0x02:
    case 0x03:
    case 0x04: {
      const [, len] = readUleb128(buf, offset);
      return offset + len;
    }
    // br / br_if — label index (uleb128)
    case 0x0c:
    case 0x0d: {
      const [, len] = readUleb128(buf, offset);
      return offset + len;
    }
    // br_table — vector of label indices + default
    case 0x0e: {
      const [count, countLen] = readUleb128(buf, offset);
      let o = offset + countLen;
      for (let i = 0; i <= count && o < end; i++) {
        const [, l] = readUleb128(buf, o);
        o += l;
      }
      return o;
    }
    // call — function index (uleb128)
    case 0x10: {
      const [, len] = readUleb128(buf, offset);
      return offset + len;
    }
    // call_indirect — type index + table index (two uleb128s)
    case 0x11: {
      const [, l1] = readUleb128(buf, offset);
      const [, l2] = readUleb128(buf, offset + l1);
      return offset + l1 + l2;
    }
    // return_call — function index
    case 0x12: {
      const [, len] = readUleb128(buf, offset);
      return offset + len;
    }
    // return_call_indirect — type + table
    case 0x13: {
      const [, l1] = readUleb128(buf, offset);
      const [, l2] = readUleb128(buf, offset + l1);
      return offset + l1 + l2;
    }
    // local.get / local.set / local.tee — local index
    case 0x20:
    case 0x21:
    case 0x22: {
      const [, len] = readUleb128(buf, offset);
      return offset + len;
    }
    // global.get / global.set — global index
    case 0x23:
    case 0x24: {
      const [, len] = readUleb128(buf, offset);
      return offset + len;
    }
    // table.get / table.set — table index
    case 0x25:
    case 0x26: {
      const [, len] = readUleb128(buf, offset);
      return offset + len;
    }
    // memory load/store instructions — alignment + offset (two uleb128s)
    case 0x28:
    case 0x29:
    case 0x2a:
    case 0x2b:
    case 0x2c:
    case 0x2d:
    case 0x2e:
    case 0x2f:
    case 0x30:
    case 0x31:
    case 0x32:
    case 0x33:
    case 0x34:
    case 0x35:
    case 0x36:
    case 0x37:
    case 0x38:
    case 0x39:
    case 0x3a:
    case 0x3b:
    case 0x3c:
    case 0x3d:
    case 0x3e: {
      const [, l1] = readUleb128(buf, offset);
      const [, l2] = readUleb128(buf, offset + l1);
      return offset + l1 + l2;
    }
    // memory.size / memory.grow — reserved byte
    case 0x3f:
    case 0x40:
      return offset + 1;
    // i32.const — sleb128
    case 0x41: {
      const [, len] = readUleb128(buf, offset);
      return offset + len;
    }
    // i64.const — sleb128
    case 0x42: {
      const [, len] = readUleb128(buf, offset);
      return offset + len;
    }
    // f32.const — 4 bytes
    case 0x43:
      return offset + 4;
    // f64.const — 8 bytes
    case 0x44:
      return offset + 8;
    // misc prefix (0xfc) — sub-opcode + optional immediates
    case 0xfc: {
      const [, len] = readUleb128(buf, offset);
      return offset + len;
    }
    default:
      return offset;
  }
}
