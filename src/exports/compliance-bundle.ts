/**
 * Consolidated compliance report bundle (VE04).
 *
 * Aggregates RWA, commodity and regulatory (sanctions screening) compliance
 * data into a single, versioned report object with JSON and Markdown renderings.
 * Each section is collected independently so one failing source degrades the
 * bundle (section status "unavailable") instead of failing the whole export.
 */
import { prismaRead } from '../db';
import { logger } from '../logger';

export const BUNDLE_SCHEMA_VERSION = '1.0.0';

export interface BundleOptions {
  from?: Date;
  to?: Date;
  limit: number;
}

export interface BundleSection<T = unknown> {
  status: 'ok' | 'unavailable';
  summary: Record<string, number | string>;
  records: T[];
  error?: string;
}

export interface ComplianceBundle {
  schemaVersion: string;
  generatedAt: string;
  period: { from: string | null; to: string | null };
  sections: {
    rwa: BundleSection;
    commodity: BundleSection;
    regulatory: BundleSection;
  };
}

function range(field: string, o: BundleOptions): Record<string, unknown> {
  if (!o.from && !o.to) return {};
  return { [field]: { ...(o.from ? { gte: o.from } : {}), ...(o.to ? { lte: o.to } : {}) } };
}

async function safeSection<T>(
  name: string,
  fn: () => Promise<{ summary: Record<string, number | string>; records: T[] }>,
): Promise<BundleSection<T>> {
  try {
    return { status: 'ok', ...(await fn()) };
  } catch (err) {
    logger.error('[compliance-bundle] section failed', { section: name, err });
    return { status: 'unavailable', summary: {}, records: [], error: `${name} source unavailable` };
  }
}

export async function buildComplianceBundle(o: BundleOptions): Promise<ComplianceBundle> {
  const [rwa, commodity, regulatory] = await Promise.all([
    safeSection('rwa', async () => {
      const where = range('ledgerCloseTime', o);
      const [total, records] = await Promise.all([
        prismaRead.rwaComplianceEvent.count({ where }),
        prismaRead.rwaComplianceEvent.findMany({
          where,
          orderBy: { ledgerCloseTime: 'desc' },
          take: o.limit,
        }),
      ]);
      return { summary: { totalEvents: total }, records };
    }),
    safeSection('commodity', async () => {
      const where = range('ledgerCloseTime', o);
      const [total, bothSigned, records] = await Promise.all([
        prismaRead.commodityDualSignerLog.count({ where }),
        prismaRead.commodityDualSignerLog.count({ where: { ...where, bothSigned: true } }),
        prismaRead.commodityDualSignerLog.findMany({
          where,
          orderBy: { ledgerCloseTime: 'desc' },
          take: o.limit,
        }),
      ]);
      return { summary: { totalEvents: total, bothSigned, singleSigned: total - bothSigned }, records };
    }),
    safeSection('regulatory', async () => {
      const where = range('screenedAt', o);
      const [total, flagged, records] = await Promise.all([
        prismaRead.screeningResult.count({ where }),
        prismaRead.screeningResult.count({ where: { ...where, status: { not: 'clear' } } }),
        prismaRead.screeningResult.findMany({
          where: { ...where, status: { not: 'clear' } },
          orderBy: { screenedAt: 'desc' },
          take: o.limit,
        }),
      ]);
      return { summary: { totalScreenings: total, flagged }, records };
    }),
  ]);

  return {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    period: { from: o.from?.toISOString() ?? null, to: o.to?.toISOString() ?? null },
    sections: { rwa, commodity, regulatory },
  };
}

export function renderBundleMarkdown(b: ComplianceBundle): string {
  const lines = [
    '# Compliance Report Bundle',
    '',
    `Schema version: ${b.schemaVersion}`,
    `Generated: ${b.generatedAt}`,
    `Period: ${b.period.from ?? 'beginning'} to ${b.period.to ?? 'now'}`,
    '',
  ];
  for (const [name, s] of Object.entries(b.sections)) {
    lines.push(`## ${name.toUpperCase()} (${s.status})`, '');
    for (const [k, v] of Object.entries(s.summary)) lines.push(`- ${k}: ${v}`);
    if (s.error) lines.push(`- error: ${s.error}`);
    lines.push(`- records included: ${s.records.length}`, '');
  }
  return lines.join('\n');
}
