import { type WasmFunction, type WasmInstr } from './symbolic-executor';

export interface WasmModule {
  functions: WasmFunction[];
  imports: WasmImport[];
  exports: WasmExport[];
  memories: WasmMemory[];
}

export interface WasmImport {
  module: string;
  name: string;
  kind: 'func' | 'table' | 'memory' | 'global';
  typeIndex?: number;
}

export interface WasmExport {
  name: string;
  kind: 'func' | 'table' | 'memory' | 'global';
  index: number;
}

export interface WasmMemory {
  initial: number;
  maximum?: number;
}

interface _WasmOpcode {
  offset: number;
  opcode: string;
  immediates: number[];
  blockType?: number;
}

export class WasmCfgExtractor {
  extractWasmFunctions(wasmBytes: Buffer): WasmModule {
    const module = this.parseWasmModule(wasmBytes);
    return module;
  }

  private parseWasmModule(wasmBytes: Buffer): WasmModule {
    if (wasmBytes.readUInt32LE(0) !== 0x6d736100) {
      throw new Error('Invalid WASM magic number: expected \\0asm');
    }

    if (wasmBytes.readUInt32LE(4) !== 1) {
      throw new Error('Unsupported WASM version; only version 1 is supported');
    }

    const types: Array<{ params: number[]; results: number[] }> = [];
    const imports: WasmImport[] = [];
    const functions: Array<{ typeIndex: number; locals: number[]; body: Buffer }> = [];
    const exports: WasmExport[] = [];
    let memories: WasmMemory[] = [];

    let offset = 8;

    while (offset < wasmBytes.length) {
      const sectionId = wasmBytes[offset++];
      const sectionSize = this.readLEB128(wasmBytes, offset);
      offset += this.leb128Size(wasmBytes, offset);
      const sectionEnd = offset + sectionSize;

      switch (sectionId) {
        case 1:
          types = this.parseTypeSection(wasmBytes, offset, sectionEnd);
          break;
        case 2:
          imports = this.parseImportSection(wasmBytes, offset, sectionEnd);
          break;
        case 3:
          functions = this.parseFunctionSection(wasmBytes, offset, sectionEnd);
          break;
        case 4:
          exports = this.parseExportSection(wasmBytes, offset, sectionEnd);
          break;
        case 5:
          memories = this.parseMemorySection(wasmBytes, offset, sectionEnd);
          break;
        case 10:
          this.parseCodeSection(wasmBytes, offset, sectionEnd, functions);
          break;
      }

      offset = sectionEnd;
    }

    const wasmFunctions: WasmFunction[] = [];
    const importFuncCount = imports.filter((i) => i.kind === 'func').length;

    for (let i = 0; i < functions.length; i++) {
      const func = functions[i];
      const typeIdx = func.typeIndex;
      const type_ = types[typeIdx];

      if (!type_) continue;

      const exportEntry = exports.find((e) => e.kind === 'func' && e.index === i + importFuncCount);

      const funcName = exportEntry?.name ?? `func_${i}`;

      const paramNames = type_.params.map((_, pi) => ({
        name: `arg_${pi}`,
        type: this.valTypeToWasmType(pi < type_.params.length ? type_.params[pi] : 0x7f),
      }));

      const body = this.parseWasmBody(func.body, types, importFuncCount);

      wasmFunctions.push({
        name: funcName,
        params: paramNames,
        results: type_.results.map((rt) => this.valTypeToWasmType(rt)),
        body,
      });
    }

    return {
      functions: wasmFunctions,
      imports,
      exports,
      memories,
    };
  }

  private valTypeToWasmType(valType: number): 'i32' | 'i64' | 'f32' | 'f64' {
    switch (valType) {
      case 0x7f:
        return 'i32';
      case 0x7e:
        return 'i64';
      case 0x7d:
        return 'f32';
      case 0x7c:
        return 'f64';
      default:
        return 'i64';
    }
  }

  private parseTypeSection(
    buf: Buffer,
    start: number,
    _end: number,
  ): Array<{ params: number[]; results: number[] }> {
    const types: Array<{ params: number[]; results: number[] }> = [];
    let offset = start;
    const count = this.readLEB128(buf, offset);
    offset += this.leb128Size(buf, offset);

    for (let i = 0; i < count; i++) {
      if (buf[offset++] !== 0x60) continue;
      const paramCount = this.readLEB128(buf, offset);
      offset += this.leb128Size(buf, offset);
      const params: number[] = [];
      for (let j = 0; j < paramCount; j++) {
        params.push(buf[offset++]);
      }
      const resultCount = this.readLEB128(buf, offset);
      offset += this.leb128Size(buf, offset);
      const results: number[] = [];
      for (let j = 0; j < resultCount; j++) {
        results.push(buf[offset++]);
      }
      types.push({ params, results });
    }

    return types;
  }

  private parseImportSection(buf: Buffer, start: number, _end: number): WasmImport[] {
    const imports: WasmImport[] = [];
    let offset = start;
    const count = this.readLEB128(buf, offset);
    offset += this.leb128Size(buf, offset);

    for (let i = 0; i < count; i++) {
      const moduleLen = this.readLEB128(buf, offset);
      offset += this.leb128Size(buf, offset);
      const module = buf.toString('utf-8', offset, offset + moduleLen);
      offset += moduleLen;

      const nameLen = this.readLEB128(buf, offset);
      offset += this.leb128Size(buf, offset);
      const name = buf.toString('utf-8', offset, offset + nameLen);
      offset += nameLen;

      const kind = buf[offset++];
      const importEntry: WasmImport = {
        module,
        name,
        kind: kind === 0 ? 'func' : kind === 1 ? 'table' : kind === 2 ? 'memory' : 'global',
      };

      if (kind === 0) {
        importEntry.typeIndex = this.readLEB128(buf, offset);
        offset += this.leb128Size(buf, offset);
      }

      imports.push(importEntry);
    }

    return imports;
  }

  private parseFunctionSection(
    buf: Buffer,
    start: number,
    _end: number,
  ): Array<{ typeIndex: number; locals: number[]; body: Buffer }> {
    const functions: Array<{ typeIndex: number; locals: number[]; body: Buffer }> = [];
    let offset = start;
    const count = this.readLEB128(buf, offset);
    offset += this.leb128Size(buf, offset);

    for (let i = 0; i < count; i++) {
      const typeIndex = this.readLEB128(buf, offset);
      offset += this.leb128Size(buf, offset);
      functions.push({ typeIndex, locals: [], body: Buffer.alloc(0) });
    }

    return functions;
  }

  private parseExportSection(buf: Buffer, start: number, _end: number): WasmExport[] {
    const exports: WasmExport[] = [];
    let offset = start;
    const count = this.readLEB128(buf, offset);
    offset += this.leb128Size(buf, offset);

    for (let i = 0; i < count; i++) {
      const nameLen = this.readLEB128(buf, offset);
      offset += this.leb128Size(buf, offset);
      const name = buf.toString('utf-8', offset, offset + nameLen);
      offset += nameLen;

      const kind = buf[offset++];
      const index = this.readLEB128(buf, offset);
      offset += this.leb128Size(buf, offset);

      exports.push({
        name,
        kind: kind === 0 ? 'func' : kind === 1 ? 'table' : kind === 2 ? 'memory' : 'global',
        index,
      });
    }

    return exports;
  }

  private parseMemorySection(buf: Buffer, start: number, _end: number): WasmMemory[] {
    const memories: WasmMemory[] = [];
    let offset = start;
    const count = this.readLEB128(buf, offset);
    offset += this.leb128Size(buf, offset);

    for (let i = 0; i < count; i++) {
      const flags = this.readLEB128(buf, offset);
      offset += this.leb128Size(buf, offset);
      const initial = this.readLEB128(buf, offset);
      offset += this.leb128Size(buf, offset);
      let maximum: number | undefined;
      if (flags & 0x01) {
        maximum = this.readLEB128(buf, offset);
        offset += this.leb128Size(buf, offset);
      }
      memories.push({ initial, maximum });
    }

    return memories;
  }

  private parseCodeSection(
    buf: Buffer,
    start: number,
    end: number,
    functions: Array<{ typeIndex: number; locals: number[]; body: Buffer }>,
  ): void {
    let offset = start;

    for (let i = 0; i < functions.length; i++) {
      const bodySize = this.readLEB128(buf, offset);
      offset += this.leb128Size(buf, offset);
      const _bodyStart = offset;
      const bodyEnd = offset + bodySize;

      const localsCount = this.readLEB128(buf, offset);
      offset += this.leb128Size(buf, offset);
      const locals: number[] = [];

      for (let j = 0; j < localsCount; j++) {
        const count = this.readLEB128(buf, offset);
        offset += this.leb128Size(buf, offset);
        const type = buf[offset++];
        for (let k = 0; k < count; k++) {
          locals.push(type);
        }
      }

      functions[i].locals = locals;
      functions[i].body = buf.subarray(offset, bodyEnd);
      offset = bodyEnd;
    }
  }

  private parseWasmBody(
    bodyBytes: Buffer,
    types: Array<{ params: number[]; results: number[] }>,
    importFuncCount: number,
  ): WasmInstr[] {
    const instructions: WasmInstr[] = [];
    let offset = 0;

    while (offset < bodyBytes.length) {
      const opcode = bodyBytes[offset++];
      const result = this.parseInstruction(bodyBytes, offset, opcode, types, importFuncCount);
      instructions.push(result.instr);
      offset = result.newOffset;
    }

    return instructions;
  }

  private parseInstruction(
    buf: Buffer,
    offset: number,
    opcode: number,
    types: Array<{ params: number[]; results: number[] }>,
    importFuncCount: number,
  ): { instr: WasmInstr; newOffset: number } {
    switch (opcode) {
      case 0x00:
        return { instr: { op: 'host_fn', name: 'panic', args: [] }, newOffset: offset };
      case 0x01:
        return { instr: { op: 'nop' }, newOffset: offset };
      case 0x02: {
        const _blockType = this.readLEB128(buf, offset);
        offset += this.leb128Size(buf, offset);
        const blockBody: WasmInstr[] = [];
        while (buf[offset] !== 0x0b) {
          const inner = this.parseInstruction(buf, offset, buf[offset], types, importFuncCount);
          blockBody.push(inner.instr);
          offset = inner.newOffset;
        }
        offset++;
        return {
          instr: { op: 'block', label: `block_${offset}`, body: blockBody },
          newOffset: offset,
        };
      }
      case 0x03: {
        const _blockType = this.readLEB128(buf, offset);
        offset += this.leb128Size(buf, offset);
        const loopBody: WasmInstr[] = [];
        while (buf[offset] !== 0x0b) {
          const inner = this.parseInstruction(buf, offset, buf[offset], types, importFuncCount);
          loopBody.push(inner.instr);
          offset = inner.newOffset;
        }
        offset++;
        return {
          instr: { op: 'loop', label: `loop_${offset}`, body: loopBody },
          newOffset: offset,
        };
      }
      case 0x04: {
        const ifBody: WasmInstr[] = [];
        while (buf[offset] !== 0x05 && buf[offset] !== 0x0b) {
          const inner = this.parseInstruction(buf, offset, buf[offset], types, importFuncCount);
          ifBody.push(inner.instr);
          offset = inner.newOffset;
        }
        const elseBody: WasmInstr[] = [];
        if (buf[offset] === 0x05) {
          offset++;
          while (buf[offset] !== 0x0b) {
            const inner = this.parseInstruction(buf, offset, buf[offset], types, importFuncCount);
            elseBody.push(inner.instr);
            offset = inner.newOffset;
          }
        }
        offset++;
        return {
          instr: {
            op: 'if_else',
            cond: [],
            then: ifBody,
            else: elseBody,
          },
          newOffset: offset,
        };
      }
      case 0x0b:
        return { instr: { op: 'nop' }, newOffset: offset };
      case 0x0c: {
        const label = this.readLEB128(buf, offset);
        offset += this.leb128Size(buf, offset);
        return { instr: { op: 'br', label: `label_${label}` }, newOffset: offset };
      }
      case 0x0d: {
        const label = this.readLEB128(buf, offset);
        offset += this.leb128Size(buf, offset);
        return { instr: { op: 'br_if', label: `label_${label}`, cond: [] }, newOffset: offset };
      }
      case 0x0f:
        return { instr: { op: 'return' }, newOffset: offset };
      case 0x10: {
        const funcIdx = this.readLEB128(buf, offset);
        offset += this.leb128Size(buf, offset);
        return {
          instr: { op: 'call', funcIdx: funcIdx - importFuncCount, args: [] },
          newOffset: offset,
        };
      }
      case 0x1a:
        return { instr: { op: 'drop', value: [] }, newOffset: offset };
      case 0x1b:
        return { instr: { op: 'select', cond: [], then: [], else: [] }, newOffset: offset };
      case 0x20: {
        const idx = this.readLEB128(buf, offset);
        offset += this.leb128Size(buf, offset);
        return { instr: { op: 'local.get', idx }, newOffset: offset };
      }
      case 0x21: {
        const idx = this.readLEB128(buf, offset);
        offset += this.leb128Size(buf, offset);
        return { instr: { op: 'local.set', idx, value: [] }, newOffset: offset };
      }
      case 0x22: {
        const idx = this.readLEB128(buf, offset);
        offset += this.leb128Size(buf, offset);
        return { instr: { op: 'local.tee', idx, value: [] }, newOffset: offset };
      }
      case 0x41: {
        const value = this.readLEB128Signed(buf, offset);
        offset += this.leb128Size(buf, offset);
        return { instr: { op: 'i32.const', value }, newOffset: offset };
      }
      case 0x42: {
        const value = this.readLEB128Signed64(buf, offset);
        offset += this.leb128Size(buf, offset);
        return { instr: { op: 'i64.const', value }, newOffset: offset };
      }
      case 0x45:
        return { instr: { op: 'i32.eqz', value: [] }, newOffset: offset };
      case 0x46:
        return { instr: { op: 'i32.eq', left: [], right: [] }, newOffset: offset };
      case 0x47:
        return { instr: { op: 'i32.ne', left: [], right: [] }, newOffset: offset };
      case 0x48:
        return { instr: { op: 'i32.lt_s', left: [], right: [] }, newOffset: offset };
      case 0x49:
        return { instr: { op: 'i32.lt_u', left: [], right: [] }, newOffset: offset };
      case 0x4a:
        return { instr: { op: 'i32.gt_s', left: [], right: [] }, newOffset: offset };
      case 0x4b:
        return { instr: { op: 'i32.gt_u', left: [], right: [] }, newOffset: offset };
      case 0x4c:
        return { instr: { op: 'i32.le_s', left: [], right: [] }, newOffset: offset };
      case 0x4d:
        return { instr: { op: 'i32.le_u', left: [], right: [] }, newOffset: offset };
      case 0x4e:
        return { instr: { op: 'i32.ge_s', left: [], right: [] }, newOffset: offset };
      case 0x4f:
        return { instr: { op: 'i32.ge_u', left: [], right: [] }, newOffset: offset };
      case 0x50:
        return { instr: { op: 'i64.eqz', value: [] }, newOffset: offset };
      case 0x51:
        return { instr: { op: 'i64.eq', left: [], right: [] }, newOffset: offset };
      case 0x52:
        return { instr: { op: 'i64.ne', left: [], right: [] }, newOffset: offset };
      case 0x53:
        return { instr: { op: 'i64.lt_s', left: [], right: [] }, newOffset: offset };
      case 0x54:
        return { instr: { op: 'i64.lt_u', left: [], right: [] }, newOffset: offset };
      case 0x55:
        return { instr: { op: 'i64.gt_s', left: [], right: [] }, newOffset: offset };
      case 0x56:
        return { instr: { op: 'i64.gt_u', left: [], right: [] }, newOffset: offset };
      case 0x57:
        return { instr: { op: 'i64.le_s', left: [], right: [] }, newOffset: offset };
      case 0x58:
        return { instr: { op: 'i64.le_u', left: [], right: [] }, newOffset: offset };
      case 0x59:
        return { instr: { op: 'i64.ge_s', left: [], right: [] }, newOffset: offset };
      case 0x5a:
        return { instr: { op: 'i64.ge_u', left: [], right: [] }, newOffset: offset };
      case 0x6a:
        return { instr: { op: 'i32.add', left: [], right: [] }, newOffset: offset };
      case 0x6b:
        return { instr: { op: 'i32.sub', left: [], right: [] }, newOffset: offset };
      case 0x6c:
        return { instr: { op: 'i32.mul', left: [], right: [] }, newOffset: offset };
      case 0x6d:
        return { instr: { op: 'i32.div_s', left: [], right: [] }, newOffset: offset };
      case 0x6f:
        return { instr: { op: 'i32.rem_s', left: [], right: [] }, newOffset: offset };
      case 0x7c:
        return { instr: { op: 'i64.add', left: [], right: [] }, newOffset: offset };
      case 0x7d:
        return { instr: { op: 'i64.sub', left: [], right: [] }, newOffset: offset };
      case 0x7e:
        return { instr: { op: 'i64.mul', left: [], right: [] }, newOffset: offset };
      case 0x7f:
        return { instr: { op: 'i64.div_s', left: [], right: [] }, newOffset: offset };
      case 0x81:
        return { instr: { op: 'i64.rem_s', left: [], right: [] }, newOffset: offset };
      default:
        return { instr: { op: 'nop' }, newOffset: offset };
    }
  }

  private readLEB128(buf: Buffer, offset: number): number {
    let result = 0;
    let shift = 0;
    let byte: number;

    do {
      byte = buf[offset++];
      result |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);

    return result;
  }

  private readLEB128Signed(buf: Buffer, offset: number): number {
    let result = 0;
    let shift = 0;
    let byte: number;

    do {
      byte = buf[offset++];
      result |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);

    if (shift < 32 && byte & 0x40) {
      result |= ~0 << shift;
    }

    return result;
  }

  private readLEB128Signed64(buf: Buffer, offset: number): bigint {
    let result = BigInt(0);
    let shift = BigInt(0);
    let byte: number;

    do {
      byte = buf[offset++];
      result |= BigInt(byte & 0x7f) << shift;
      shift += BigInt(7);
    } while (byte & 0x80);

    if ((byte & 0x40) !== 0) {
      result |= ~BigInt(0) << shift;
    }

    return result;
  }

  private leb128Size(buf: Buffer, offset: number): number {
    let size = 0;
    let byte: number;

    do {
      byte = buf[offset + size];
      size++;
    } while (byte & 0x80);

    return size;
  }

  isSorobanContract(wasmBytes: Buffer): boolean {
    return wasmBytes.includes('soroban') || wasmBytes.includes('contract');
  }

  extractPublicFunctions(module: WasmModule): WasmFunction[] {
    return module.functions.filter((f) =>
      module.exports.some(
        (e) =>
          e.kind === 'func' &&
          module.functions.indexOf(f) ===
            e.index - module.imports.filter((i) => i.kind === 'func').length,
      ),
    );
  }
}
