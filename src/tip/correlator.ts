/**
 * Threat correlator: deduplication, cross-chain mapping, severity scoring.
 */
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

// ─── Deduplication ────────────────────────────────────────────────────────────

/**
 * Find near-duplicate advisories by title similarity and link them.
 */
export async function deduplicateAdvisories(): Promise<number> {
  const all = await db.threatAdvisory.findMany({
    select: { id: true, title: true, cveId: true, ghsaId: true },
    orderBy: { createdAt: 'asc' },
  });

  let linked = 0;
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i];
      const b = all[j];

      // Exact external ID match → duplicate
      const isDuplicate =
        (a.cveId && a.cveId === b.cveId) ||
        (a.ghsaId && a.ghsaId === b.ghsaId) ||
        titleSimilarity(a.title, b.title) > 0.85;

      if (!isDuplicate) continue;

      await db.threatCorrelation
        .upsert({
          where: { advisoryId_relatedId: { advisoryId: a.id, relatedId: b.id } },
          update: {},
          create: {
            advisoryId: a.id,
            relatedId: b.id,
            relationship: 'duplicate',
            confidence: 1.0,
          },
        })
        .catch(() => null); // ignore if already exists
      linked++;
    }
  }
  return linked;
}

// ─── Cross-chain mapping ──────────────────────────────────────────────────────

/**
 * For advisories that mention specific chains, link them as "related".
 */
export async function correlateCrossChain(): Promise<number> {
  const all = await db.threatAdvisory.findMany({
    select: { id: true, affectedChains: true },
  });

  // Group by each chain
  const byChain: Record<string, string[]> = {};
  for (const a of all) {
    for (const chain of a.affectedChains) {
      byChain[chain] ??= [];
      byChain[chain].push(a.id);
    }
  }

  let linked = 0;
  for (const ids of Object.values(byChain)) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        await db.threatCorrelation
          .upsert({
            where: { advisoryId_relatedId: { advisoryId: ids[i], relatedId: ids[j] } },
            update: {},
            create: {
              advisoryId: ids[i],
              relatedId: ids[j],
              relationship: 'related',
              confidence: 0.6,
            },
          })
          .catch(() => null);
        linked++;
      }
    }
  }
  return linked;
}

// ─── Severity re-scoring ──────────────────────────────────────────────────────

/**
 * Bump severity of an advisory based on how many contracts are affected and
 * whether it has active correlations.
 */
export async function rescore(advisoryId: string): Promise<string> {
  const advisory = await db.threatAdvisory.findUniqueOrThrow({
    where: { id: advisoryId },
    include: { correlations: true },
  });

  let score = advisory.cvssScore ?? severityToBase(advisory.severity);

  // Each affected contract adds 0.2 (capped)
  score += Math.min(advisory.affectedContracts.length * 0.2, 1.5);
  // Correlated high-confidence duplicates add 0.5
  const highConf = advisory.correlations.filter((c) => c.confidence >= 0.9).length;
  score += highConf * 0.5;

  const newSeverity = scoreToSeverity(score);
  await db.threatAdvisory.update({
    where: { id: advisoryId },
    data: { severity: newSeverity, cvssScore: Math.min(score, 10) },
  });

  return newSeverity;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function titleSimilarity(a: string, b: string): number {
  const wa = new Set(a.toLowerCase().split(/\W+/));
  const wb = new Set(b.toLowerCase().split(/\W+/));
  const intersection = [...wa].filter((w) => wb.has(w)).length;
  return intersection / Math.max(wa.size, wb.size, 1);
}

function severityToBase(s: string): number {
  return { critical: 9, high: 7, medium: 5, low: 2, info: 0 }[s] ?? 0;
}

function scoreToSeverity(s: number): string {
  if (s >= 9) return 'critical';
  if (s >= 7) return 'high';
  if (s >= 4) return 'medium';
  if (s >= 1) return 'low';
  return 'info';
}
