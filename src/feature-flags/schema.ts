/**
 * Schema availability for feature flags
 *
 * A feature whose required tables are missing (migration not yet applied) must
 * never start — previously this was the *only* gate. Here it becomes a hard
 * capability check layered under the toggle: the toggle decides whether the
 * feature *should* run, schema availability decides whether it *can*.
 *
 * The table list is cached briefly so per-request evaluation stays cheap and
 * the boot path can read it synchronously after an async warm-up.
 */

import type { PrismaClient } from '@prisma/client';
import { prismaRead } from '../db';
import { logger } from '../logger';

const CACHE_TTL_MS = 30_000;

let cachedTables: Set<string> | null = null;
let cacheLoadedAt = 0;

export async function loadExistingTables(client: PrismaClient = prismaRead): Promise<Set<string>> {
  const now = Date.now();
  if (cachedTables !== null && now - cacheLoadedAt < CACHE_TTL_MS) {
    return cachedTables;
  }
  try {
    const rows = await client.$queryRawUnsafe<Array<{ table_name: string }>>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    cachedTables = new Set(rows.map((r) => r.table_name));
    cacheLoadedAt = now;
    return cachedTables;
  } catch (err) {
    // DB unreachable — treat every table as missing (fail safe) so features
    // report "schema unavailable" instead of crashing mid-run.
    logger.warn('[feature-flags] schema availability check failed; treating tables as missing', {
      error: String(err),
    });
    cachedTables = new Set();
    cacheLoadedAt = now;
    return cachedTables;
  }
}

export function invalidateSchemaCache(): void {
  cachedTables = null;
  cacheLoadedAt = 0;
}

/** Async check: every required table must exist. */
export async function tablesExist(
  tables: string[],
  client: PrismaClient = prismaRead,
): Promise<boolean> {
  if (tables.length === 0) return true;
  const existing = await loadExistingTables(client);
  return tables.every((t) => existing.has(t));
}

/**
 * Sync check against the cached table set. Safe to call on the boot path after
 * `loadExistingTables()` has been warmed; a cold cache (no warm-up yet) is
 * treated as unavailable.
 */
export function tablesExistSync(tables: string[]): boolean {
  if (tables.length === 0) return true;
  if (cachedTables === null) return false;
  return tables.every((t) => cachedTables.has(t));
}
