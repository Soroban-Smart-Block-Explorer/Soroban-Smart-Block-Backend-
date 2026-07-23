import { prisma } from '../db';

export interface CorpusEntry {
  functionName: string;
  args: unknown[];
  ledger?: number;
  txHash?: string;
}

export interface TypedCorpus {
  byFunction: Map<string, CorpusEntry[]>;
  totalEntries: number;
}

const BOUNDARY_VALUES: Record<string, unknown[]> = {
  u32: [0, 1, 255, 65535, 0xffffffff],
  i32: [-2147483648, -1, 0, 1, 2147483647],
  u64: ['0', '1', '18446744073709551615'],
  i64: ['-9223372036854775808', '-1', '0', '1', '9223372036854775807'],
  u128: ['0', '1', '340282366920938463463374607431768211455'],
  i128: ['-170141183460469231731687303715884105728', '-1', '0', '1', '170141183460469231731687303715884105727'],
  string: ['', 'a', 'A'.repeat(255), '\x00', '<script>'],
  symbol: ['', 'transfer', 'a'.repeat(32)],
  address: [
    'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
    'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF2U',
  ],
  bytes: ['0x', '0x00', '0x' + 'ff'.repeat(32)],
  bool: [true, false],
};

export function getBoundaryValues(type: string): unknown[] {
  const normalised = type.toLowerCase().replace(/[^a-z0-9]/g, '');
  return BOUNDARY_VALUES[normalised] ?? [null, 0, '', false];
}

export async function buildCorpusFromHistory(contractAddress: string): Promise<TypedCorpus> {
  const txs = await prisma.transaction.findMany({
    where: { contractAddress, functionArgs: { not: undefined } },
    select: { functionName: true, functionArgs: true, ledger: true, hash: true },
    orderBy: { ledger: 'desc' },
    take: 200,
  });

  const byFunction = new Map<string, CorpusEntry[]>();

  for (const tx of txs) {
    if (!tx.functionName) continue;
    const args = Array.isArray(tx.functionArgs) ? tx.functionArgs : [];
    const entry: CorpusEntry = { functionName: tx.functionName, args, ledger: tx.ledger, txHash: tx.hash };
    if (!byFunction.has(tx.functionName)) byFunction.set(tx.functionName, []);
    byFunction.get(tx.functionName)!.push(entry);
  }

  // Add synthetic boundary-value entries for each seen function
  for (const [fn, entries] of byFunction) {
    if (entries.length === 0) continue;
    const argCount = entries[0].args.length;
    for (let i = 0; i < argCount; i++) {
      for (const bv of [null, 0, '', false, 0xffffffff]) {
        const syntheticArgs = [...entries[0].args];
        syntheticArgs[i] = bv;
        byFunction.get(fn)!.push({ functionName: fn, args: syntheticArgs });
      }
    }
  }

  return { byFunction, totalEntries: [...byFunction.values()].reduce((s, e) => s + e.length, 0) };
}
