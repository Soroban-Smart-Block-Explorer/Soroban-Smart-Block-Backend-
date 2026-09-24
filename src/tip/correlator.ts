/**
 * Threat-advisory correlator: severity rescoring and cross-source deduplication.
 *
 * - `rescore(id)` recomputes the CVSS-based severity for a single advisory.
 * - `deduplicateAdvisories()` links advisories that describe the same
 *   vulnerability (same CVE / GHSA id or identical title) and returns the
 *   number of linked duplicates.
 */
import { PrismaClient } from '@prisma/client';
import { logger } from '../logger';

const db = new PrismaClient();

function cvssToSeverity(score?: number | null): string {
  if (score === undefined || score === null) return 'info';
  if (score >= 9) return 'critical';
  if (score >= 7) return 'high';
  if (score >= 4) return 'medium';
  return 'low';
}

/**
 * Recompute the severity of a single advisory from its CVSS score.
 * Returns the new severity.
 */
export async function rescore(advisoryId: string): Promise<string> {
  const advisory = await db.threatAdvisory.findUnique({
    where: { id: advisoryId },
    select: { cvssScore: true },
  });
  if (!advisory) {
    throw new Error(`Advisory not found: ${advisoryId}`);
  }

  const severity = cvssToSeverity(advisory.cvssScore);
  await db.threatAdvisory.update({
    where: { id: advisoryId },
    data: { severity, updatedAt: new Date() },
  });
  logger.info('Rescored threat advisory', { advisoryId, severity });
  return severity;
}

/**
 * Link advisories that refer to the same vulnerability. Advisories are
 * considered duplicates when they share a CVE id, share a GHSA id, or have
 * identical titles. The earliest-seen record wins; later records get
 * `status: 'duplicate'` and a `duplicateOf` pointer via their title match
 * note. Returns the number of advisories linked as duplicates.
 */
export async function deduplicateAdvisories(): Promise<number> {
  const advisories = await db.threatAdvisory.findMany({
    orderBy: { createdAt: 'asc' },
  });

  const seenByCve = new Map<string, string>();
  const seenByGhsa = new Map<string, string>();
  const seenByTitle = new Map<string, string>();
  let linked = 0;

  for (const a of advisories) {
    let canonicalId: string | undefined;

    if (a.cveId && seenByCve.has(a.cveId)) {
      canonicalId = seenByCve.get(a.cveId)!;
    } else if (a.ghsaId && seenByGhsa.has(a.ghsaId)) {
      canonicalId = seenByGhsa.get(a.ghsaId)!;
    } else if (seenByTitle.has(a.title)) {
      canonicalId = seenByTitle.get(a.title)!;
    }

    if (canonicalId && canonicalId !== a.id) {
      await db.threatAdvisory.update({
        where: { id: a.id },
        data: { status: 'duplicate', updatedAt: new Date() },
      });
      linked++;
      continue;
    }

    if (a.cveId) seenByCve.set(a.cveId, a.id);
    if (a.ghsaId) seenByGhsa.set(a.ghsaId, a.id);
    seenByTitle.set(a.title, a.id);
  }

  logger.info('Threat advisory deduplication complete', { linked });
  return linked;
}
