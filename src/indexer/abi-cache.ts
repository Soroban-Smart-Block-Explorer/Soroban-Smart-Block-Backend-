import { prismaRead, prismaWrite } from '../db';

export interface AbiFunction {
  name: string;
  inputs: { name: string; type: string }[];
  outputs?: { type: string }[];
  humanTemplate?: string;
}

export interface ContractAbi {
  functions: AbiFunction[];
}

const MAX_SIZE = 512;
// address -> { abi, insertionOrder }
const cache = new Map<string, ContractAbi>();

function evictIfFull() {
  if (cache.size >= MAX_SIZE) {
    // evict oldest entry (Map preserves insertion order)
    cache.delete(cache.keys().next().value!);
  }
}

/** Read ABI from cache; on miss, load from DB and populate cache. */
export async function getCachedAbi(address: string): Promise<ContractAbi | null> {
  if (cache.has(address)) return cache.get(address)!;

  const row = await prismaRead.contract.findUnique({
    where: { address },
    select: { abi: true },
  });

  if (!row?.abi) return null;

  const abi = row.abi as unknown as ContractAbi;
  evictIfFull();
  cache.set(address, abi);
  return abi;
}

/** Write ABI to DB and update cache. */
export async function setCachedAbi(address: string, abi: ContractAbi): Promise<void> {
  await prismaWrite.contract.upsert({
    where: { address },
    update: { abi: abi as object },
    create: {
      address,
      name: `Unknown Contract (${address.slice(0, 8)}…)`,
      abi: abi as object,
    },
  });
  cache.delete(address); // remove stale entry
  evictIfFull();
  cache.set(address, abi);
}

/** Remove ABI from DB and cache. */
export async function deleteCachedAbi(address: string): Promise<void> {
  await prismaWrite.contract.update({
    where: { address },
    data: { abi: undefined },
  });
  cache.delete(address);
}

/** Invalidate a cache entry without touching the DB (e.g. after external update). */
export function invalidateCache(address: string): void {
  cache.delete(address);
}
