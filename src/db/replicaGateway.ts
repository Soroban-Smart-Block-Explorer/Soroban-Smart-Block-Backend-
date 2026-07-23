import { PrismaClient } from '@prisma/client';
import { prismaRead, prismaWrite } from '../db';
import { replicaLagCheckErrors } from '../metrics';

/** Ledgers behind primary before we fall back to the write node (~10 s). */
export const LAG_THRESHOLD_LEDGERS = 2;

/** How long (ms) to cache a lag measurement before re-checking. */
const CACHE_TTL_MS = 5_000;

let cachedLag: number | null = null;
let cacheExpiresAt = 0;

/**
 * Query the replica for its latest indexed ledger and compare to the primary.
 * Returns the lag in ledgers (primary − replica).
 *
 * On any error the function returns LAG_THRESHOLD_LEDGERS + 1 so that
 * getReadClient always selects the primary when replica health is unknown.
 * This avoids serving potentially stale data from a degraded replica.
 */
export async function measureReplicaLag(
  read: PrismaClient = prismaRead,
  write: PrismaClient = prismaWrite,
): Promise<number> {
  const now = Date.now();
  if (cachedLag !== null && now < cacheExpiresAt) return cachedLag;

  try {
    const [primaryState, replicaState] = await Promise.all([
      write.indexerState.findUnique({ where: { id: 'singleton' }, select: { lastLedger: true } }),
      read.indexerState.findUnique({ where: { id: 'singleton' }, select: { lastLedger: true } }),
    ]);

    const primaryLedger = primaryState?.lastLedger ?? 0;
    const replicaLedger = replicaState?.lastLedger ?? 0;
    cachedLag = Math.max(0, primaryLedger - replicaLedger);
  } catch {
    // Replica health is unknown — force primary to avoid serving stale data.
    replicaLagCheckErrors.inc();
    cachedLag = LAG_THRESHOLD_LEDGERS + 1;
  }

  cacheExpiresAt = now + CACHE_TTL_MS;
  return cachedLag;
}

/**
 * Returns `prismaRead` when the replica is within the acceptable lag window,
 * otherwise falls back to `prismaWrite` (primary).
 */
export async function getReadClient(
  read: PrismaClient = prismaRead,
  write: PrismaClient = prismaWrite,
): Promise<PrismaClient> {
  const lag = await measureReplicaLag(read, write);
  return lag > LAG_THRESHOLD_LEDGERS ? write : read;
}

/** Expose cache-busting for tests. */
export function _resetLagCache(): void {
  cachedLag = null;
  cacheExpiresAt = 0;
}
