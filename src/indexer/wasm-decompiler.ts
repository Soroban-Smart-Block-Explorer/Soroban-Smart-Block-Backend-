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
  0xfc: 'misc',  // prefix for bulk-memory / saturating-trunc instructions
};

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
    description:
      'Backdoor initialisation: indirect call with no preceding auth/guard check',
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
    description:
      'Unchecked unsigned integer division: divisor is not guarded before i64.div_u',
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
        matches.push({ templateId: template.id, description: template.description, matchOffset: firstIdx });
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
          matches.push({ templateId: template.id, description: template.description, matchOffset: windowStart });
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
    case 0x02: case 0x03: case 0x04: {
      const [, len] = readUleb128(buf, offset);
      return offset + len;
    }
    // br / br_if — label index (uleb128)
    case 0x0c: case 0x0d: {
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
    case 0x20: case 0x21: case 0x22: {
      const [, len] = readUleb128(buf, offset);
      return offset + len;
    }
    // global.get / global.set — global index
    case 0x23: case 0x24: {
      const [, len] = readUleb128(buf, offset);
      return offset + len;
    }
    // table.get / table.set — table index
    case 0x25: case 0x26: {
      const [, len] = readUleb128(buf, offset);
      return offset + len;
    }
    // memory load/store instructions — alignment + offset (two uleb128s)
    case 0x28: case 0x29: case 0x2a: case 0x2b:
    case 0x2c: case 0x2d: case 0x2e: case 0x2f:
    case 0x30: case 0x31: case 0x32: case 0x33:
    case 0x34: case 0x35: case 0x36: case 0x37:
    case 0x38: case 0x39: case 0x3a: case 0x3b:
    case 0x3c: case 0x3d: case 0x3e: {
      const [, l1] = readUleb128(buf, offset);
      const [, l2] = readUleb128(buf, offset + l1);
      return offset + l1 + l2;
    }
    // memory.size / memory.grow — reserved byte
    case 0x3f: case 0x40:
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
