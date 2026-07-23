import { fetchContractSpec } from '../indexer/wasm-spec';
import { getCachedAbi } from '../indexer/abi-cache';

export interface ResolvedFunction {
  name: string;
  inputs: { name: string; type: string }[];
  outputs: string[];
  source: 'on-chain' | 'manual' | 'sep41';
}

const SEP41_FUNCTIONS: ResolvedFunction[] = [
  { name: 'transfer', inputs: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'amount', type: 'i128' }], outputs: [], source: 'sep41' },
  { name: 'balance', inputs: [{ name: 'id', type: 'address' }], outputs: ['i128'], source: 'sep41' },
  { name: 'approve', inputs: [{ name: 'from', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'amount', type: 'i128' }, { name: 'expiration_ledger', type: 'u32' }], outputs: [], source: 'sep41' },
  { name: 'allowance', inputs: [{ name: 'from', type: 'address' }, { name: 'spender', type: 'address' }], outputs: ['i128'], source: 'sep41' },
  { name: 'decimals', inputs: [], outputs: ['u32'], source: 'sep41' },
  { name: 'name', inputs: [], outputs: ['string'], source: 'sep41' },
  { name: 'symbol', inputs: [], outputs: ['string'], source: 'sep41' },
  { name: 'total_supply', inputs: [], outputs: ['i128'], source: 'sep41' },
  { name: 'mint', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'i128' }], outputs: [], source: 'sep41' },
  { name: 'burn', inputs: [{ name: 'from', type: 'address' }, { name: 'amount', type: 'i128' }], outputs: [], source: 'sep41' },
];

function parseJsonSchemaFunctions(schema: Record<string, unknown>): ResolvedFunction[] {
  const fns: ResolvedFunction[] = [];
  const defs = (schema as any).definitions ?? {};
  for (const [key, def] of Object.entries(defs)) {
    if (typeof def !== 'object' || def === null) continue;
    const d = def as any;
    if (d.type !== 'object' || !d.properties) continue;
    const inputs = Object.entries(d.properties as Record<string, any>).map(([name, prop]) => ({
      name,
      type: typeof prop === 'object' && prop.$ref
        ? String(prop.$ref).split('/').pop() ?? 'unknown'
        : (prop as any).type ?? 'unknown',
    }));
    fns.push({ name: key, inputs, outputs: [], source: 'on-chain' });
  }
  return fns;
}

export async function resolveContractFunctions(address: string): Promise<{
  functions: ResolvedFunction[];
  source: 'on-chain' | 'manual' | 'sep41-fallback' | 'none';
}> {
  // 1. Try on-chain Wasm spec
  const onChain = await fetchContractSpec(address);
  if (onChain && typeof onChain === 'object') {
    const fns = parseJsonSchemaFunctions(onChain as Record<string, unknown>);
    if (fns.length > 0) return { functions: fns, source: 'on-chain' };
  }

  // 2. Try manually stored ABI
  const stored = await getCachedAbi(address);
  if (stored) {
    const fns: ResolvedFunction[] = stored.functions.map((f) => ({
      name: f.name,
      inputs: f.inputs,
      outputs: f.outputs?.map((o) => o.type) ?? [],
      source: 'manual' as const,
    }));
    return { functions: fns, source: 'manual' };
  }

  // 3. Fall back to SEP-41 standard interface
  return { functions: SEP41_FUNCTIONS, source: 'sep41-fallback' };
}
