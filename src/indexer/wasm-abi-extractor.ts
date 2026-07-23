import { xdr } from '@stellar/stellar-sdk';

export type ScValType =
  | 'bool'
  | 'void'
  | 'u32'
  | 'i32'
  | 'u64'
  | 'i64'
  | 'u128'
  | 'i128'
  | 'u256'
  | 'i256'
  | 'bytes'
  | 'string'
  | 'symbol'
  | 'address'
  | 'vec'
  | 'map'
  | 'tuple'
  | 'option'
  | 'val';

export interface ExtractedParam {
  name: string;
  type: ScValType;
  doc?: string;
}

export interface ExtractedFunction {
  name: string;
  params: ExtractedParam[];
  returns: ScValType;
  doc?: string;
  confidence: number;
  source: 'spec' | 'export' | 'callsite' | 'sep' | 'generic';
}

export interface WasmSection {
  id: number;
  size: number;
  data: Buffer;
}

export interface WasmExport {
  name: string;
  kind: 'function' | 'table' | 'memory' | 'global';
  index: number;
}

export interface WasmImport {
  module: string;
  name: string;
  kind: 'function' | 'table' | 'memory' | 'global';
  typeIndex?: number;
}

export interface WasmFuncType {
  params: string[];
  results: string[];
}

export interface WasmAbiResult {
  functions: ExtractedFunction[];
  exports: WasmExport[];
  imports: WasmImport[];
  sepStandards: string[];
  coverageScore: number;
  source: 'on-chain-spec' | 'inferred' | 'sep-matched' | 'generic';
  warnings: string[];
}

const WASM_TYPES: Record<number, string> = {
  0x7f: 'i32',
  0x7e: 'i64',
  0x7d: 'f32',
  0x7c: 'f64',
  0x7b: 'v128',
  0x70: 'funcref',
  0x6f: 'externref',
};

// SEP-41 token standard function signatures
const SEP41_FUNCTIONS: ExtractedFunction[] = [
  {
    name: 'allowance',
    params: [
      { name: 'from', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    returns: 'i128',
    confidence: 0.99,
    source: 'sep',
  },
  {
    name: 'approve',
    params: [
      { name: 'from', type: 'address' },
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'i128' },
      { name: 'expiration_ledger', type: 'u32' },
    ],
    returns: 'void',
    confidence: 0.99,
    source: 'sep',
  },
  {
    name: 'balance',
    params: [{ name: 'id', type: 'address' }],
    returns: 'i128',
    confidence: 0.99,
    source: 'sep',
  },
  {
    name: 'burn',
    params: [
      { name: 'from', type: 'address' },
      { name: 'amount', type: 'i128' },
    ],
    returns: 'void',
    confidence: 0.99,
    source: 'sep',
  },
  {
    name: 'burn_from',
    params: [
      { name: 'spender', type: 'address' },
      { name: 'from', type: 'address' },
      { name: 'amount', type: 'i128' },
    ],
    returns: 'void',
    confidence: 0.99,
    source: 'sep',
  },
  { name: 'decimals', params: [], returns: 'u32', confidence: 0.99, source: 'sep' },
  {
    name: 'mint',
    params: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'i128' },
    ],
    returns: 'void',
    confidence: 0.99,
    source: 'sep',
  },
  { name: 'name', params: [], returns: 'string', confidence: 0.99, source: 'sep' },
  {
    name: 'set_admin',
    params: [{ name: 'new_admin', type: 'address' }],
    returns: 'void',
    confidence: 0.99,
    source: 'sep',
  },
  { name: 'symbol', params: [], returns: 'string', confidence: 0.99, source: 'sep' },
  { name: 'total_supply', params: [], returns: 'i128', confidence: 0.99, source: 'sep' },
  {
    name: 'transfer',
    params: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'i128' },
    ],
    returns: 'void',
    confidence: 0.99,
    source: 'sep',
  },
  {
    name: 'transfer_from',
    params: [
      { name: 'spender', type: 'address' },
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'i128' },
    ],
    returns: 'void',
    confidence: 0.99,
    source: 'sep',
  },
];

const _SEP41_NAMES = new Set(SEP41_FUNCTIONS.map((f) => f.name));

const SEP10_FUNCTIONS: ExtractedFunction[] = [
  {
    name: 'challenge',
    params: [
      { name: 'account', type: 'address' },
      { name: 'home_domain', type: 'string' },
    ],
    returns: 'string',
    confidence: 0.95,
    source: 'sep',
  },
  {
    name: 'verify',
    params: [{ name: 'transaction', type: 'string' }],
    returns: 'address',
    confidence: 0.95,
    source: 'sep',
  },
];

const SEP24_FUNCTIONS: ExtractedFunction[] = [
  {
    name: 'deposit',
    params: [
      { name: 'account', type: 'address' },
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'i128' },
    ],
    returns: 'string',
    confidence: 0.9,
    source: 'sep',
  },
  {
    name: 'withdraw',
    params: [
      { name: 'account', type: 'address' },
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'i128' },
    ],
    returns: 'string',
    confidence: 0.9,
    source: 'sep',
  },
  { name: 'info', params: [], returns: 'map', confidence: 0.9, source: 'sep' },
];

const SEP38_FUNCTIONS: ExtractedFunction[] = [
  {
    name: 'prices',
    params: [
      { name: 'sell_asset', type: 'string' },
      { name: 'buy_asset', type: 'string' },
    ],
    returns: 'vec',
    confidence: 0.9,
    source: 'sep',
  },
  {
    name: 'price',
    params: [
      { name: 'sell_asset', type: 'string' },
      { name: 'buy_asset', type: 'string' },
      { name: 'sell_amount', type: 'i128' },
    ],
    returns: 'map',
    confidence: 0.9,
    source: 'sep',
  },
  {
    name: 'quote',
    params: [
      { name: 'sell_asset', type: 'string' },
      { name: 'buy_asset', type: 'string' },
      { name: 'sell_amount', type: 'i128' },
    ],
    returns: 'map',
    confidence: 0.9,
    source: 'sep',
  },
];

// Common Soroban contract function signatures for call-site inference
const COMMON_SIGNATURES: Record<string, { params: ExtractedParam[]; returns: ScValType }> = {
  initialize: { params: [{ name: 'admin', type: 'address' }], returns: 'void' },
  upgrade: { params: [{ name: 'new_wasm_hash', type: 'bytes' }], returns: 'void' },
  admin: { params: [], returns: 'address' },
  set_admin: { params: [{ name: 'new_admin', type: 'address' }], returns: 'void' },
  get_config: { params: [], returns: 'map' },
  set_config: { params: [{ name: 'config', type: 'map' }], returns: 'void' },
  version: { params: [], returns: 'u32' },
  pause: { params: [], returns: 'void' },
  unpause: { params: [], returns: 'void' },
  is_paused: { params: [], returns: 'bool' },
};

function readUleb128(buf: Buffer, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  let bytesRead = 0;
  for (;;) {
    if (offset + bytesRead >= buf.length) break;
    const byte = buf[offset + bytesRead++];
    result |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return [result, bytesRead];
}

function parseSections(wasm: Buffer): WasmSection[] {
  const sections: WasmSection[] = [];
  if (wasm.length < 8) return sections;
  let offset = 8;
  while (offset < wasm.length) {
    const id = wasm[offset++];
    const [size, sizeLen] = readUleb128(wasm, offset);
    offset += sizeLen;
    sections.push({ id, size, data: wasm.slice(offset, offset + size) });
    offset += size;
  }
  return sections;
}

function parseTypeSection(data: Buffer): WasmFuncType[] {
  const types: WasmFuncType[] = [];
  let offset = 0;
  const [count, cl] = readUleb128(data, offset);
  offset += cl;
  for (let i = 0; i < count; i++) {
    if (data[offset++] !== 0x60) continue;
    const [paramCount, pl] = readUleb128(data, offset);
    offset += pl;
    const params: string[] = [];
    for (let j = 0; j < paramCount; j++) {
      params.push(WASM_TYPES[data[offset++]] ?? 'unknown');
    }
    const [resultCount, rl] = readUleb128(data, offset);
    offset += rl;
    const results: string[] = [];
    for (let j = 0; j < resultCount; j++) {
      results.push(WASM_TYPES[data[offset++]] ?? 'unknown');
    }
    types.push({ params, results });
  }
  return types;
}

function parseExportSection(data: Buffer): WasmExport[] {
  const exports: WasmExport[] = [];
  let offset = 0;
  const [count, cl] = readUleb128(data, offset);
  offset += cl;
  for (let i = 0; i < count; i++) {
    const [nameLen, nl] = readUleb128(data, offset);
    offset += nl;
    const name = data.slice(offset, offset + nameLen).toString('utf8');
    offset += nameLen;
    const kindByte = data[offset++];
    const kindMap: Record<number, WasmExport['kind']> = {
      0: 'function',
      1: 'table',
      2: 'memory',
      3: 'global',
    };
    const kind = kindMap[kindByte] ?? 'function';
    const [index, il] = readUleb128(data, offset);
    offset += il;
    exports.push({ name, kind, index });
  }
  return exports;
}

function parseImportSection(data: Buffer): WasmImport[] {
  const imports: WasmImport[] = [];
  let offset = 0;
  const [count, cl] = readUleb128(data, offset);
  offset += cl;
  for (let i = 0; i < count; i++) {
    const [modLen, ml] = readUleb128(data, offset);
    offset += ml;
    const module = data.slice(offset, offset + modLen).toString('utf8');
    offset += modLen;
    const [nameLen, nl] = readUleb128(data, offset);
    offset += nl;
    const name = data.slice(offset, offset + nameLen).toString('utf8');
    offset += nameLen;
    const kindByte = data[offset++];
    const kindMap: Record<number, WasmImport['kind']> = {
      0: 'function',
      1: 'table',
      2: 'memory',
      3: 'global',
    };
    const kind = kindMap[kindByte] ?? 'function';
    let typeIndex: number | undefined;
    if (kindByte === 0) {
      const [ti, tl] = readUleb128(data, offset);
      typeIndex = ti;
      offset += tl;
    } else {
      offset += 2;
    }
    imports.push({ module, name, kind, typeIndex });
  }
  return imports;
}

function wasmTypeToScVal(wasmType: string, name: string): ScValType {
  if (wasmType === 'externref') {
    const lname = name.toLowerCase();
    if (lname.includes('addr') || lname.includes('account') || lname.includes('sender'))
      return 'address';
    if (lname.includes('amount') || lname.includes('balance') || lname.includes('value'))
      return 'i128';
    if (
      lname.includes('count') ||
      lname.includes('index') ||
      lname.includes('id') ||
      lname.includes('ledger')
    )
      return 'u32';
    if (lname.includes('hash') || lname.includes('bytes') || lname.includes('wasm')) return 'bytes';
    if (
      lname.includes('name') ||
      lname.includes('symbol') ||
      lname.includes('str') ||
      lname.includes('text')
    )
      return 'string';
    if (
      lname.includes('flag') ||
      lname.includes('active') ||
      lname.includes('enabled') ||
      lname.includes('paused')
    )
      return 'bool';
    return 'val';
  }
  if (wasmType === 'i32') return 'i32';
  if (wasmType === 'i64') return 'i64';
  if (wasmType === 'v128') return 'i128';
  return 'val';
}

function specEntryToFunction(entry: xdr.ScSpecEntry): ExtractedFunction | null {
  try {
    if (entry.switch().value !== xdr.ScSpecEntryKind.scSpecEntryFunctionV0().value) return null;
    const fn = entry.functionV0();
    const name = fn.name().toString();
    const params: ExtractedParam[] = fn.inputs().map((inp: xdr.ScSpecFunctionInputV0) => ({
      name: inp.name().toString(),
      type: scSpecTypeToScVal(inp.type()),
      doc: inp.doc().toString() || undefined,
    }));
    const returnTypes = fn.outputs();
    const returns: ScValType = returnTypes.length > 0 ? scSpecTypeToScVal(returnTypes[0]) : 'void';
    return {
      name,
      params,
      returns,
      doc: fn.doc().toString() || undefined,
      confidence: 1.0,
      source: 'spec',
    };
  } catch {
    return null;
  }
}

function scSpecTypeToScVal(t: xdr.ScSpecTypeDef): ScValType {
  try {
    const sw = t.switch().value;
    const map: Record<number, ScValType> = {
      0: 'val',
      1: 'bool',
      2: 'void',
      6: 'u32',
      7: 'i32',
      8: 'u64',
      9: 'i64',
      10: 'u128',
      11: 'i128',
      12: 'u256',
      13: 'i256',
      14: 'bytes',
      15: 'string',
      16: 'symbol',
      17: 'address',
      1000: 'option',
      1001: 'vec',
      1002: 'map',
      1003: 'tuple',
    };
    return map[sw] ?? 'val';
  } catch {
    return 'val';
  }
}

function detectSepStandards(exportNames: Set<string>): {
  standards: string[];
  matchedFunctions: ExtractedFunction[];
} {
  const standards: string[] = [];
  const matchedFunctions: ExtractedFunction[] = [];

  const sep41Required = ['transfer', 'balance', 'decimals', 'name', 'symbol', 'total_supply'];
  const sep41Score = sep41Required.filter((n) => exportNames.has(n)).length;
  if (sep41Score >= 4) {
    standards.push('SEP-41');
    for (const fn of SEP41_FUNCTIONS) {
      if (exportNames.has(fn.name)) matchedFunctions.push(fn);
    }
  }

  const sep10Names = SEP10_FUNCTIONS.map((f) => f.name);
  if (sep10Names.some((n) => exportNames.has(n))) {
    standards.push('SEP-10');
    matchedFunctions.push(...SEP10_FUNCTIONS.filter((f) => exportNames.has(f.name)));
  }

  const sep24Names = SEP24_FUNCTIONS.map((f) => f.name);
  if (sep24Names.filter((n) => exportNames.has(n)).length >= 2) {
    standards.push('SEP-24');
    matchedFunctions.push(...SEP24_FUNCTIONS.filter((f) => exportNames.has(f.name)));
  }

  const sep38Names = SEP38_FUNCTIONS.map((f) => f.name);
  if (sep38Names.filter((n) => exportNames.has(n)).length >= 2) {
    standards.push('SEP-38');
    matchedFunctions.push(...SEP38_FUNCTIONS.filter((f) => exportNames.has(f.name)));
  }

  return { standards, matchedFunctions };
}

function inferFunctionFromExport(
  exp: WasmExport,
  funcTypes: WasmFuncType[],
  importCount: number,
  funcSection: number[],
): ExtractedFunction {
  const typeIndex = exp.index >= importCount ? funcSection[exp.index - importCount] : undefined;
  const wasmType = typeIndex !== undefined ? funcTypes[typeIndex] : undefined;

  if (COMMON_SIGNATURES[exp.name]) {
    const sig = COMMON_SIGNATURES[exp.name];
    return {
      name: exp.name,
      params: sig.params,
      returns: sig.returns,
      confidence: 0.85,
      source: 'callsite',
    };
  }

  // Infer from WASM type signature
  const params: ExtractedParam[] = [];
  if (wasmType) {
    wasmType.params.forEach((wt, i) => {
      const paramName = `arg${i}`;
      params.push({ name: paramName, type: wasmTypeToScVal(wt, exp.name) });
    });
  }

  const returns: ScValType = wasmType?.results?.[0]
    ? wasmTypeToScVal(wasmType.results[0], exp.name)
    : 'void';

  const confidence = params.length > 0 ? 0.5 : 0.3;
  return { name: exp.name, params, returns, confidence, source: 'generic' };
}

function parseFunctionSection(data: Buffer): number[] {
  const indices: number[] = [];
  let offset = 0;
  const [count, cl] = readUleb128(data, offset);
  offset += cl;
  for (let i = 0; i < count; i++) {
    const [idx, il] = readUleb128(data, offset);
    offset += il;
    indices.push(idx);
  }
  return indices;
}

const SOROBAN_INTERNAL_EXPORTS = new Set([
  '_start',
  '__wasm_call_ctors',
  '__data_end',
  '__heap_base',
  'memory',
  '__stack_pointer',
  '_ZN',
  '__rust_alloc',
]);

function isInternalExport(name: string): boolean {
  if (SOROBAN_INTERNAL_EXPORTS.has(name)) return true;
  if (name.startsWith('_ZN') || name.startsWith('__') || name.startsWith('_')) return true;
  return false;
}

export function extractWasmAbi(wasm: Buffer): WasmAbiResult {
  const warnings: string[] = [];
  const sections = parseSections(wasm);

  const typeSection = sections.find((s) => s.id === 1);
  const importSection = sections.find((s) => s.id === 2);
  const funcSection = sections.find((s) => s.id === 3);
  const exportSection = sections.find((s) => s.id === 7);

  const funcTypes = typeSection ? parseTypeSection(typeSection.data) : [];
  const imports = importSection ? parseImportSection(importSection.data) : [];
  const funcIndices = funcSection ? parseFunctionSection(funcSection.data) : [];
  const exports = exportSection ? parseExportSection(exportSection.data) : [];

  const importCount = imports.filter((i) => i.kind === 'function').length;

  // Try contractspecv0 first (highest fidelity)
  const specSection = sections.find(
    (s) =>
      s.id === 0 &&
      (() => {
        try {
          const [nl, nb] = readUleb128(s.data, 0);
          return s.data.slice(nb, nb + nl).toString('utf8') === 'contractspecv0';
        } catch {
          return false;
        }
      })(),
  );

  if (specSection) {
    try {
      const [nl, nb] = readUleb128(specSection.data, 0);
      const payloadStart = nb + nl;
      const payload = specSection.data.slice(payloadStart);
      const specEntries: xdr.ScSpecEntry[] = [];
      let pos = 0;
      while (pos < payload.length) {
        const entry = xdr.ScSpecEntry.fromXDR(payload.slice(pos));
        specEntries.push(entry);
        pos += entry.toXDR().length;
      }
      const fns = specEntries.map(specEntryToFunction).filter(Boolean) as ExtractedFunction[];
      if (fns.length > 0) {
        const exportNames = new Set(
          exports.filter((e) => e.kind === 'function').map((e) => e.name),
        );
        const { standards } = detectSepStandards(exportNames);
        return {
          functions: fns,
          exports,
          imports,
          sepStandards: standards,
          coverageScore: 1.0,
          source: 'on-chain-spec',
          warnings,
        };
      }
    } catch {
      warnings.push('contractspecv0 section parse failed, falling back to export inference');
    }
  }

  // Phase 2: Infer from exports
  const publicExports = exports.filter((e) => e.kind === 'function' && !isInternalExport(e.name));
  const exportNames = new Set(publicExports.map((e) => e.name));

  // Phase 3: SEP detection
  const { standards, matchedFunctions } = detectSepStandards(exportNames);
  const sepMatchedNames = new Set(matchedFunctions.map((f) => f.name));

  const functions: ExtractedFunction[] = [];
  for (const exp of publicExports) {
    if (sepMatchedNames.has(exp.name)) {
      const sepFn = matchedFunctions.find((f) => f.name === exp.name)!;
      functions.push(sepFn);
    } else {
      functions.push(inferFunctionFromExport(exp, funcTypes, importCount, funcIndices));
    }
  }

  const specCount = functions.filter((f) => f.source === 'sep' || f.source === 'callsite').length;
  const coverageScore = functions.length > 0 ? specCount / functions.length : 0;

  const source =
    standards.length > 0 ? 'sep-matched' : functions.length > 0 ? 'inferred' : 'generic';

  return { functions, exports, imports, sepStandards: standards, coverageScore, source, warnings };
}

export interface CallSiteSample {
  functionName: string;
  args: { type: string; value: unknown }[];
  txHash: string;
  ledgerSequence: number;
}

export function mergeCallSiteInference(
  base: WasmAbiResult,
  samples: CallSiteSample[],
): WasmAbiResult {
  if (samples.length === 0) return base;

  const byName = new Map<string, CallSiteSample[]>();
  for (const s of samples) {
    if (!byName.has(s.functionName)) byName.set(s.functionName, []);
    byName.get(s.functionName)!.push(s);
  }

  const updated = base.functions.map((fn) => {
    const fnSamples = byName.get(fn.name);
    if (!fnSamples || fn.confidence >= 0.95) return fn;

    // Improve param names/types from observed call args
    const improvedParams = fn.params.map((p, i) => {
      const argValues = fnSamples.flatMap((s) => (s.args[i] ? [s.args[i]] : []));
      if (argValues.length === 0) return p;
      const types = argValues.map((v) => v.type);
      const mostCommon = types.sort(
        (a, b) => types.filter((t) => t === b).length - types.filter((t) => t === a).length,
      )[0];
      return { ...p, type: (mostCommon as ScValType) ?? p.type };
    });

    return {
      ...fn,
      params: improvedParams,
      confidence: Math.min(fn.confidence + 0.1 * Math.log10(fnSamples.length + 1), 0.95),
      source: 'callsite' as const,
    };
  });

  return { ...base, functions: updated };
}

export interface AbiValidationResult {
  contractAddress: string;
  totalCalls: number;
  matchedCalls: number;
  coveragePercent: number;
  falsePositives: string[];
  falseNegatives: string[];
  confidenceByFunction: Record<string, number>;
}

export function validateAbiCoverage(
  abi: WasmAbiResult,
  historicalCalls: { functionName: string; success: boolean }[],
): AbiValidationResult {
  const abiNames = new Set(abi.functions.map((f) => f.name));
  const callNames = new Set(historicalCalls.map((c) => c.functionName));

  const matched = historicalCalls.filter((c) => abiNames.has(c.functionName));
  const falseNegatives = [...callNames].filter((n) => !abiNames.has(n));
  const falsePositives = abi.functions.filter((f) => !callNames.has(f.name)).map((f) => f.name);

  const confidenceByFunction: Record<string, number> = {};
  for (const fn of abi.functions) {
    const calls = historicalCalls.filter((c) => c.functionName === fn.name);
    if (calls.length === 0) {
      confidenceByFunction[fn.name] = fn.confidence;
      continue;
    }
    const successRate = calls.filter((c) => c.success).length / calls.length;
    confidenceByFunction[fn.name] = (fn.confidence + successRate) / 2;
  }

  return {
    contractAddress: '',
    totalCalls: historicalCalls.length,
    matchedCalls: matched.length,
    coveragePercent:
      historicalCalls.length > 0 ? (matched.length / historicalCalls.length) * 100 : 0,
    falsePositives,
    falseNegatives,
    confidenceByFunction,
  };
}
