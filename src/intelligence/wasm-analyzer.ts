import { parseWasmSpec } from '../indexer/wasm-spec';
import { rpc } from '../indexer/rpc';
import { xdr } from '@stellar/stellar-sdk';

export interface WasmFunction {
  name: string;
  inputs: { name: string; type: string }[];
  outputs: string[];
}

export interface WasmAnalysis {
  exports: WasmFunction[];
  rawFunctionNames: string[];
  hasContractSpec: boolean;
}

function specTypeToString(t: xdr.ScSpecTypeDef): string {
  const name = t.switch().name;
  switch (name) {
    case 'scSpecTypeU32': return 'u32';
    case 'scSpecTypeI32': return 'i32';
    case 'scSpecTypeU64': return 'u64';
    case 'scSpecTypeI64': return 'i64';
    case 'scSpecTypeU128': return 'u128';
    case 'scSpecTypeI128': return 'i128';
    case 'scSpecTypeBool': return 'bool';
    case 'scSpecTypeSymbol': return 'symbol';
    case 'scSpecTypeString': return 'string';
    case 'scSpecTypeAddress': return 'address';
    case 'scSpecTypeBytes': return 'bytes';
    case 'scSpecTypeVoid': return 'void';
    case 'scSpecTypeOption': return `option<${specTypeToString((t as any).option().valueType())}>`;
    case 'scSpecTypeVec': return `vec<${specTypeToString((t as any).vec().elementType())}>`;
    case 'scSpecTypeMap': return `map<${specTypeToString((t as any).map().keyType())},${specTypeToString((t as any).map().valueType())}>`;
    case 'scSpecTypeTuple': return `tuple`;
    case 'scSpecTypeUdt': return `udt:${(t as any).udt().name().toString()}`;
    default: return name;
  }
}

export async function analyzeContractWasm(contractAddress: string): Promise<WasmAnalysis | null> {
  let wasm: Buffer;
  try {
    wasm = await rpc.getContractWasmByContractId(contractAddress);
  } catch {
    return null;
  }

  let specEntries: xdr.ScSpecEntry[] = [];
  try {
    specEntries = parseWasmSpec(wasm);
  } catch {
    specEntries = [];
  }

  const exports: WasmFunction[] = [];
  for (const entry of specEntries) {
    if (entry.switch().name === 'scSpecEntryFunctionV0') {
      const fn = entry.functionV0();
      const name = fn.name().toString();
      const inputs = fn.inputs().map((inp: any) => ({
        name: inp.name().toString(),
        type: specTypeToString(inp.type()),
      }));
      const outputs = fn.outputs().map((out: any) => specTypeToString(out));
      exports.push({ name, inputs, outputs });
    }
  }

  return {
    exports,
    rawFunctionNames: exports.map((e) => e.name),
    hasContractSpec: specEntries.length > 0,
  };
}
