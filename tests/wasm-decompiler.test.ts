import { describe, it, expect } from 'vitest';
import {
  buildOpcodeIndex,
  matchVulnerableTemplates,
  decompileWasm,
  VULNERABLE_TEMPLATES,
  type VulnerableTemplate,
} from '../src/indexer/wasm-decompiler';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal valid Wasm binary with a single code section containing
 * the provided raw opcode bytes (no local declarations).
 *
 * Layout:
 *   magic (4) + version (4)
 *   + section id 10 (code)
 *   + section size (uleb128)
 *   + func count = 1 (uleb128)
 *   + body size (uleb128)
 *   + local count = 0 (1 byte)
 *   + opcodes
 *   + end (0x0b)
 */
function makeWasm(opcodes: number[]): Buffer {
  const body = Buffer.from([0x00, ...opcodes, 0x0b]); // local count=0, opcodes, end
  const bodySize = encodeUleb128(body.length);
  const funcCount = Buffer.from([0x01]); // 1 function
  const sectionPayload = Buffer.concat([funcCount, bodySize, body]);
  const sectionSize = encodeUleb128(sectionPayload.length);

  return Buffer.concat([
    Buffer.from([0x00, 0x61, 0x73, 0x6d]), // magic
    Buffer.from([0x01, 0x00, 0x00, 0x00]), // version
    Buffer.from([0x0a]),                    // section id = 10 (code)
    sectionSize,
    sectionPayload,
  ]);
}

function encodeUleb128(value: number): Buffer {
  const bytes: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (value !== 0);
  return Buffer.from(bytes);
}

// ── buildOpcodeIndex ──────────────────────────────────────────────────────────

describe('buildOpcodeIndex', () => {
  it('throws on a buffer that is too short', () => {
    expect(() => buildOpcodeIndex(Buffer.from([0x00, 0x61]))).toThrow('Invalid Wasm');
  });

  it('throws on a bad magic number', () => {
    const bad = Buffer.alloc(8);
    bad.writeUInt32BE(0xdeadbeef, 0);
    bad.writeUInt32LE(1, 4);
    expect(() => buildOpcodeIndex(bad)).toThrow('bad magic');
  });

  it('returns empty index for a Wasm with no code section', () => {
    // Minimal valid Wasm: magic + version only
    const wasm = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    const idx = buildOpcodeIndex(wasm);
    expect(idx.totalOpcodes).toBe(0);
    expect(idx.distinctOpcodes).toHaveLength(0);
    expect(idx.sequence).toHaveLength(0);
  });

  it('decodes a single nop opcode', () => {
    const wasm = makeWasm([0x01]); // nop
    const idx = buildOpcodeIndex(wasm);
    expect(idx.sequence).toContain('nop');
    expect(idx.frequency['nop']).toBeGreaterThanOrEqual(1);
    expect(idx.distinctOpcodes).toContain('nop');
  });

  it('decodes call (0x10) with a function index immediate', () => {
    // call 0 → opcode 0x10, uleb128(0) = 0x00
    const wasm = makeWasm([0x10, 0x00]);
    const idx = buildOpcodeIndex(wasm);
    expect(idx.sequence).toContain('call');
    expect(idx.frequency['call']).toBeGreaterThanOrEqual(1);
  });

  it('decodes global.get (0x23) with a global index immediate', () => {
    const wasm = makeWasm([0x23, 0x00]);
    const idx = buildOpcodeIndex(wasm);
    expect(idx.sequence).toContain('global.get');
  });

  it('counts frequency correctly for repeated opcodes', () => {
    // Three nop instructions
    const wasm = makeWasm([0x01, 0x01, 0x01]);
    const idx = buildOpcodeIndex(wasm);
    expect(idx.frequency['nop']).toBe(3);
    expect(idx.totalOpcodes).toBeGreaterThanOrEqual(3);
  });

  it('renders unknown opcodes as hex strings', () => {
    // 0xef is not a standard opcode
    const wasm = makeWasm([0xef]);
    const idx = buildOpcodeIndex(wasm);
    expect(idx.sequence.some((op) => op.startsWith('0x'))).toBe(true);
  });
});

// ── matchVulnerableTemplates ──────────────────────────────────────────────────

describe('matchVulnerableTemplates', () => {
  it('returns no matches for an empty opcode sequence', () => {
    const idx = buildOpcodeIndex(
      Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
    );
    expect(matchVulnerableTemplates(idx)).toHaveLength(0);
  });

  it('matches a single-opcode template when the opcode is present', () => {
    // call_indirect (0x11) with type=0, table=0
    const wasm = makeWasm([0x11, 0x00, 0x00]);
    const idx = buildOpcodeIndex(wasm);
    const matches = matchVulnerableTemplates(idx);
    const ids = matches.map((m) => m.templateId);
    expect(ids).toContain('backdoor-init');
  });

  it('matches admin-drain pattern: global.get → call → return', () => {
    // global.get 0, call 0, return
    const wasm = makeWasm([0x23, 0x00, 0x10, 0x00, 0x0f]);
    const idx = buildOpcodeIndex(wasm);
    const matches = matchVulnerableTemplates(idx);
    expect(matches.some((m) => m.templateId === 'admin-drain')).toBe(true);
  });

  it('matches reentrancy-loop pattern: loop → call → br_if', () => {
    // loop (blocktype void=0x40), call 0, br_if 0, end
    const wasm = makeWasm([0x03, 0x40, 0x10, 0x00, 0x0d, 0x00, 0x0b]);
    const idx = buildOpcodeIndex(wasm);
    const matches = matchVulnerableTemplates(idx);
    expect(matches.some((m) => m.templateId === 'reentrancy-loop')).toBe(true);
  });

  it('does not match a template whose opcodes are absent', () => {
    const wasm = makeWasm([0x01]); // only nop
    const idx = buildOpcodeIndex(wasm);
    const customTemplate: VulnerableTemplate[] = [
      { id: 'test', description: 'test', opcodeSequence: ['i64.div_s'] },
    ];
    expect(matchVulnerableTemplates(idx, customTemplate)).toHaveLength(0);
  });

  it('reports matchOffset as the index of the first matched opcode', () => {
    // nop, nop, call_indirect 0 0
    const wasm = makeWasm([0x01, 0x01, 0x11, 0x00, 0x00]);
    const idx = buildOpcodeIndex(wasm);
    const matches = matchVulnerableTemplates(idx);
    const backdoor = matches.find((m) => m.templateId === 'backdoor-init');
    expect(backdoor).toBeDefined();
    expect(backdoor!.matchOffset).toBeGreaterThanOrEqual(0);
  });
});

// ── decompileWasm ─────────────────────────────────────────────────────────────

describe('decompileWasm', () => {
  it('returns hasVulnerabilities=false and null warningMessage for a clean binary', () => {
    const wasm = makeWasm([0x01]); // only nop — no vulnerable patterns
    const customTemplates: VulnerableTemplate[] = [
      { id: 'drain', description: 'drain', opcodeSequence: ['i64.div_s'] },
    ];
    const result = decompileWasm(wasm, customTemplates);
    expect(result.hasVulnerabilities).toBe(false);
    expect(result.warningMessage).toBeNull();
    expect(result.vulnerabilities).toHaveLength(0);
  });

  it('returns hasVulnerabilities=true and a non-null warningMessage when a pattern matches', () => {
    // call_indirect triggers backdoor-init
    const wasm = makeWasm([0x11, 0x00, 0x00]);
    const result = decompileWasm(wasm);
    expect(result.hasVulnerabilities).toBe(true);
    expect(result.warningMessage).not.toBeNull();
    expect(result.warningMessage).toContain('backdoor-init');
    expect(result.warningMessage).toContain('malicious backdoors');
  });

  it('warning message mentions all matched template ids', () => {
    // global.get 0, call 0, return → admin-drain
    // call_indirect 0 0 → backdoor-init
    const wasm = makeWasm([0x23, 0x00, 0x10, 0x00, 0x0f, 0x11, 0x00, 0x00]);
    const result = decompileWasm(wasm);
    expect(result.warningMessage).toContain('admin-drain');
    expect(result.warningMessage).toContain('backdoor-init');
  });

  it('opcodeIndex contains distinctOpcodes and frequency', () => {
    const wasm = makeWasm([0x01, 0x01, 0x01]); // three nops
    const result = decompileWasm(wasm);
    expect(result.opcodeIndex.distinctOpcodes).toContain('nop');
    expect(result.opcodeIndex.frequency['nop']).toBe(3);
    expect(result.opcodeIndex.totalOpcodes).toBeGreaterThanOrEqual(3);
  });

  it('throws on invalid Wasm input', () => {
    expect(() => decompileWasm(Buffer.from([0x00, 0x61]))).toThrow('Invalid Wasm');
  });
});
