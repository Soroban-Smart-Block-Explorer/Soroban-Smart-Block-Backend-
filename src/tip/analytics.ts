/**
 * TIP analytics: severity distribution, trend data, top affected contracts.
 */
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

export async function getSeverityDistribution() {
  const rows = await db.threatAdvisory.groupBy({
    by: ['severity'],
    _count: { id: true },
  });
  return rows.map((r) => ({ severity: r.severity, count: r._count.id }));
}

export async function getTrendData(days = 30) {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await db.threatAdvisory.findMany({
    where: { createdAt: { gte: since } },
    select: { createdAt: true, severity: true },
    orderBy: { createdAt: 'asc' },
  });

  // Bucket by date
  const buckets: Record<string, { date: string; total: number; critical: number; high: number }> =
    {};
  for (const r of rows) {
    const date = r.createdAt.toISOString().slice(0, 10);
    buckets[date] ??= { date, total: 0, critical: 0, high: 0 };
    buckets[date].total++;
    if (r.severity === 'critical') buckets[date].critical++;
    if (r.severity === 'high') buckets[date].high++;
  }

  return Object.values(buckets);
}

export async function getTopAffectedContracts(limit = 10) {
  const advisories = await db.threatAdvisory.findMany({
    select: { affectedContracts: true },
  });

  const counts: Record<string, number> = {};
  for (const a of advisories) {
    for (const c of a.affectedContracts) {
      counts[c] = (counts[c] ?? 0) + 1;
    }
  }

  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([contract, count]) => ({ contract, count }));
}

export async function getStatusSummary() {
  const rows = await db.threatAdvisory.groupBy({
    by: ['status'],
    _count: { id: true },
  });
  return rows.map((r) => ({ status: r.status, count: r._count.id }));
}
