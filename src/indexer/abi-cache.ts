import { prismaRead, prismaWrite } from '../db';
import { cacheGet, cacheSet, cacheDelete } from '../cache';

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
const cache = new Map<string, ContractAbi>();
const CACHE_PREFIX = 'abi:';

function evictIfFull() {
  if (cache.size >= MAX_SIZE) {
    cache.delete(cache.keys().next().value!);
  }
}

function localEntry(address: string): ContractAbi | null {
  return cache.has(address) ? cache.get(address)! : null;
}

/** Read ABI from cache; on miss, load from DB and populate cache. */
export async function getCachedAbi(address: string): Promise<ContractAbi | null> {
  const local = localEntry(address);
  if (local) return local;

  const remote = await cacheGet<ContractAbi>(`${CACHE_PREFIX}${address}`);
  if (remote) {
    evictIfFull();
    cache.set(address, remote);
    return remote;
  }

  const row = await prismaRead.contract.findUnique({
    where: { address },
    select: { abi: true },
  });

  if (!row?.abi) return null;

  const abi = row.abi as unknown as ContractAbi;
  evictIfFull();
  cache.set(address, abi);
  await cacheSet(`${CACHE_PREFIX}${address}`, abi);
  return abi;
}

/** Write ABI to DB and update cache. */
export async function setCachedAbi(address: string, abi: ContractAbi): Promise<void> {
  await prismaWrite.contract.upsert({
    where: { address },
    update: { abi: abi as object },
    create: { address, abi: abi as object },
  });
  cache.delete(address);
  evictIfFull();
  cache.set(address, abi);
  await cacheSet(`${CACHE_PREFIX}${address}`, abi);
}

/** Remove ABI from DB and cache. */
export async function deleteCachedAbi(address: string): Promise<void> {
  await prismaWrite.contract.update({
    where: { address },
    data: { abi: undefined },
  });
  cache.delete(address);
  await cacheDelete(`${CACHE_PREFIX}${address}`);
}

/** Invalidate a cache entry without touching the DB (e.g. after external update). */
export function invalidateCache(address: string): void {
  cache.delete(address);
  void cacheDelete(`${CACHE_PREFIX}${address}`);
}
