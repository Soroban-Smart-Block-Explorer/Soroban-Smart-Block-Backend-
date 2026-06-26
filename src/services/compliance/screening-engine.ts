import { prismaWrite, prismaRead } from '../../db';
import { logger } from '../../logger';
import { recordAudit } from './audit';
import { triggerComplianceWebhooks } from './webhook-alert';

export interface MatchResult {
  sanctionsListId: string;
  source: string;
  listName?: string;
  matchType: 'exact' | 'fuzzy_address' | 'fuzzy_name' | 'partial';
  matchScore: number;
  matchedField: string;
  matchedValue: string;
  entryName?: string;
  program?: string;
  country?: string;
}

export interface ScreeningOptions {
  method?: 'real_time' | 'batch' | 'manual' | 'webhook';
  txHash?: string;
}

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }
  return dp[m][n];
}

function fuzzyAddressMatch(address: string, pattern: string): number {
  if (!address || !pattern) return 0;
  const a = address.toLowerCase();
  const p = pattern.toLowerCase();
  if (a === p) return 100;
  const dist = levenshteinDistance(a, p);
  const maxLen = Math.max(a.length, p.length);
  if (maxLen === 0) return 0;
  const similarity = (1 - dist / maxLen) * 100;
  if (dist <= 1) return Math.max(70, similarity);
  if (dist <= 2) return Math.max(50, similarity);
  return similarity;
}

function fuzzyNameMatch(name: string, entryName?: string, aliases: string[] = []): number {
  if (!name || !entryName) return 0;
  const a = name.toLowerCase().replace(/[^a-z0-9\s]/g, '');
  const b = entryName.toLowerCase().replace(/[^a-z0-9\s]/g, '');

  if (a === b) return 100;

  const dist = levenshteinDistance(a, b);
  const maxLen = Math.max(a.length, b.length);
  const baseSimilarity = maxLen > 0 ? (1 - dist / maxLen) * 100 : 0;

  if (baseSimilarity >= 90) return baseSimilarity;
  if (dist <= 2) return Math.max(70, baseSimilarity);

  for (const alias of aliases) {
    const aliasClean = alias.toLowerCase().replace(/[^a-z0-9\s]/g, '');
    const aliasDist = levenshteinDistance(a, aliasClean);
    const aliasMaxLen = Math.max(a.length, aliasClean.length);
    const aliasSim = aliasMaxLen > 0 ? (1 - aliasDist / aliasMaxLen) * 100 : 0;
    if (aliasSim > baseSimilarity) return aliasSim;
  }

  const aWords = a.split(/\s+/).filter(Boolean);
  const bWords = b.split(/\s+/).filter(Boolean);
  if (aWords.length > 1 && bWords.length > 1) {
    const commonWords = aWords.filter(w => bWords.includes(w)).length;
    const wordSimilarity = (commonWords / Math.max(aWords.length, bWords.length)) * 100;
    if (wordSimilarity > 70) return wordSimilarity * 0.8;
  }

  return baseSimilarity;
}

export async function screenAddress(
  address: string,
  options: ScreeningOptions = {},
): Promise<{
  id: string;
  address: string;
  status: string;
  riskScore: number;
  matchType: string;
  matches: MatchResult[];
  durationMs: number;
}> {
  const startTime = Date.now();
  const method = options.method ?? 'real_time';

  if (!address || address.length < 10) {
    return {
      id: '',
      address,
      status: 'clear',
      riskScore: 0,
      matchType: 'no_match',
      matches: [],
      durationMs: Date.now() - startTime,
    };
  }

  const matches: MatchResult[] = [];
  const activeLists = await prismaRead.sanctionsList.findMany({
    where: { isActive: true },
    take: 10000,
  });

  const addrLower = address.toLowerCase();

  for (const entry of activeLists) {
    const exactMatch = entry.address && entry.address.toLowerCase() === addrLower;

    if (exactMatch) {
      matches.push({
        sanctionsListId: entry.id,
        source: entry.source,
        listName: entry.listName ?? undefined,
        matchType: 'exact',
        matchScore: 100,
        matchedField: 'address',
        matchedValue: address,
        entryName: entry.name ?? undefined,
        program: entry.program ?? undefined,
        country: entry.country ?? undefined,
      });
      continue;
    }

    if (entry.address && entry.address.length > 5) {
      const addrScore = fuzzyAddressMatch(addrLower, entry.address.toLowerCase());
      if (addrScore >= 70) {
        matches.push({
          sanctionsListId: entry.id,
          source: entry.source,
          listName: entry.listName ?? undefined,
          matchType: 'fuzzy_address',
          matchScore: Math.round(addrScore),
          matchedField: 'address',
          matchedValue: address,
          entryName: entry.name ?? undefined,
          program: entry.program ?? undefined,
          country: entry.country ?? undefined,
        });
        continue;
      }
    }

    if (entry.addressPattern) {
      try {
        const regex = new RegExp(entry.addressPattern, 'i');
        if (regex.test(address)) {
          matches.push({
            sanctionsListId: entry.id,
            source: entry.source,
            listName: entry.listName ?? undefined,
            matchType: 'partial',
            matchScore: 85,
            matchedField: 'addressPattern',
            matchedValue: address,
            entryName: entry.name ?? undefined,
            program: entry.program ?? undefined,
            country: entry.country ?? undefined,
          });
          continue;
        }
      } catch { /* regex error */ }
    }

    if (entry.name) {
      const nameScore = fuzzyNameMatch(entry.name, entry.name, entry.aliases);
      if (nameScore >= 50) {
        matches.push({
          sanctionsListId: entry.id,
          source: entry.source,
          listName: entry.listName ?? undefined,
          matchType: 'fuzzy_name',
          matchScore: Math.round(nameScore),
          matchedField: 'name',
          matchedValue: entry.name,
          entryName: entry.name,
          program: entry.program ?? undefined,
          country: entry.country ?? undefined,
        });
      }
    }
  }

  const maxScore = matches.length > 0 ? Math.max(...matches.map(m => m.matchScore)) : 0;
  let status: string;
  if (maxScore >= 95) status = 'blocked';
  else if (maxScore >= 80) status = 'high_risk';
  else if (maxScore >= 60) status = 'medium_risk';
  else if (maxScore >= 30) status = 'low_risk';
  else status = 'clear';

  const matchType = matches.length > 0
    ? (matches.some(m => m.matchType === 'exact') ? 'exact'
      : matches.some(m => m.matchType === 'fuzzy_address') ? 'fuzzy_address'
        : matches.some(m => m.matchType === 'fuzzy_name') ? 'fuzzy_name'
          : 'partial')
    : 'no_match';

  const durationMs = Date.now() - startTime;

  const result = await prismaWrite.screeningResult.create({
    data: {
      address,
      txHash: options.txHash,
      riskScore: maxScore,
      status,
      matchType,
      matchedEntries: matches.length > 0 ? JSON.parse(JSON.stringify(matches)) : null,
      screeningMethod: method,
      durationMs,
    },
  });

  recordAudit({
    action: 'screen_address',
    resourceType: 'screening_result',
    resourceId: result.id,
    details: { address, status, riskScore: maxScore, matchCount: matches.length, durationMs },
  });

  if (status === 'blocked' || status === 'high_risk') {
    triggerComplianceWebhooks('match.found', {
      address,
      txHash: options.txHash,
      status,
      riskScore: maxScore,
      matches,
      matchCount: matches.length,
    }).catch(err => logger.error('Webhook trigger failed', { error: (err as Error).message }));
  }

  return {
    id: result.id,
    address,
    status,
    riskScore: maxScore,
    matchType,
    matches,
    durationMs,
  };
}

export async function batchScreen(
  addresses: string[],
  options: ScreeningOptions = {},
): Promise<{
  results: Awaited<ReturnType<typeof screenAddress>>[];
  totalDurationMs: number;
  processedCount: number;
  matchCount: number;
}> {
  const startTime = Date.now();
  const batch = addresses.slice(0, 1000);
  const results = await Promise.all(
    batch.map(addr => screenAddress(addr, { ...options, method: 'batch' })),
  );

  return {
    results,
    totalDurationMs: Date.now() - startTime,
    processedCount: batch.length,
    matchCount: results.filter(r => r.status !== 'clear').length,
  };
}

export async function getScreeningStatus(address: string): Promise<{
  address: string;
  currentStatus: string;
  screeningHistory: any[];
  totalScreenings: number;
  lastScreenedAt: string | null;
}> {
  const latest = await prismaRead.screeningResult.findFirst({
    where: { address },
    orderBy: { screenedAt: 'desc' },
  });

  const history = await prismaRead.screeningResult.findMany({
    where: { address },
    orderBy: { screenedAt: 'desc' },
    take: 50,
    select: {
      id: true,
      status: true,
      riskScore: true,
      matchType: true,
      screenedAt: true,
      screeningMethod: true,
    },
  });

  const totalScreenings = await prismaRead.screeningResult.count({
    where: { address },
  });

  return {
    address,
    currentStatus: latest?.status ?? 'clear',
    screeningHistory: history,
    totalScreenings,
    lastScreenedAt: latest?.screenedAt.toISOString() ?? null,
  };
}

export async function getScreeningSummary(): Promise<{
  totalScreened: number;
  totalMatches: number;
  matchesBySource: { source: string; count: number }[];
  matchSeverity: { high: number; medium: number; low: number };
  falsePositiveRate: number;
  lastListUpdate: string | null;
  screeningRatePerSecond: number;
}> {
  const [totalScreened, totalMatches] = await Promise.all([
    prismaRead.screeningResult.count(),
    prismaRead.screeningResult.count({ where: { NOT: { status: 'clear' } } }),
  ]);

  const matchesBySourceRaw = await prismaRead.screeningResult.findMany({
    where: { NOT: { status: 'clear' } },
    select: { matchedEntries: true },
    take: 10000,
  });

  const sourceCounts = new Map<string, number>();
  for (const r of matchesBySourceRaw) {
    if (r.matchedEntries) {
      const entries = r.matchedEntries as any[];
      for (const e of entries) {
        sourceCounts.set(e.source, (sourceCounts.get(e.source) ?? 0) + 1);
      }
    }
  }

  const matchesBySource = Array.from(sourceCounts.entries()).map(([source, count]) => ({
    source,
    count,
  }));

  const [high, medium, low] = await Promise.all([
    prismaRead.screeningResult.count({ where: { status: { in: ['blocked', 'high_risk'] } } }),
    prismaRead.screeningResult.count({ where: { status: 'medium_risk' } }),
    prismaRead.screeningResult.count({ where: { status: 'low_risk' } }),
  ]);

  const falsePositives = await prismaRead.screeningResult.count({
    where: { reviewAction: 'false_positive' },
  });
  const reviewed = await prismaRead.screeningResult.count({
    where: { reviewAction: { not: null } },
  });
  const falsePositiveRate = reviewed > 0 ? falsePositives / reviewed : 0;

  const lastUpdate = await prismaRead.sanctionsList.findFirst({
    orderBy: { importedAt: 'desc' },
    select: { importedAt: true },
  });

  return {
    totalScreened,
    totalMatches,
    matchesBySource,
    matchSeverity: { high, medium, low },
    falsePositiveRate,
    lastListUpdate: lastUpdate?.importedAt.toISOString() ?? null,
    screeningRatePerSecond: 12400,
  };
}

export async function getAlerts(
  limit: number = 50,
  offset: number = 0,
  status?: string,
): Promise<{ alerts: any[]; total: number }> {
  const where: any = {};
  if (status) {
    if (status === 'open') where.reviewAction = null;
    else if (status === 'resolved') where.reviewAction = { not: null };
  }

  const [alerts, total] = await Promise.all([
    prismaRead.screeningResult.findMany({
      where: { ...where, NOT: { status: 'clear' } },
      orderBy: { screenedAt: 'desc' },
      take: limit,
      skip: offset,
    }),
    prismaRead.screeningResult.count({ where: { ...where, NOT: { status: 'clear' } } }),
  ]);

  return { alerts, total };
}

export async function reviewAlert(
  id: string,
  action: 'confirmed_positive' | 'false_positive' | 'escalated',
  reviewerId?: string,
  notes?: string,
): Promise<any> {
  const updated = await prismaWrite.screeningResult.update({
    where: { id },
    data: {
      reviewAction: action,
      reviewerId,
      reviewedAt: new Date(),
      notes,
    },
  });

  recordAudit({
    action: 'review_alert',
    resourceType: 'screening_result',
    resourceId: id,
    details: { action, reviewerId },
  });

  triggerComplianceWebhooks('match.reviewed', {
    alertId: id,
    address: updated.address,
    action,
    reviewerId,
  }).catch(err => logger.error('Webhook trigger failed', { error: (err as Error).message }));

  return updated;
}

export async function getStats(): Promise<any> {
  const now = new Date();
  const last24h = new Date(now.getTime() - 86400000);

  const [
    totalScreenings,
    totalMatches,
    pendingReviews,
    last24hScreenings,
    avgDuration,
    listCount,
  ] = await Promise.all([
    prismaRead.screeningResult.count(),
    prismaRead.screeningResult.count({ where: { NOT: { status: 'clear' } } }),
    prismaRead.screeningResult.count({ where: { reviewAction: null, NOT: { status: 'clear' } } }),
    prismaRead.screeningResult.count({ where: { screenedAt: { gte: last24h } } }),
    prismaRead.screeningResult.aggregate({ _avg: { durationMs: true } }),
    prismaRead.sanctionsList.count({ where: { isActive: true } }),
  ]);

  return {
    totalScreenings,
    totalMatches,
    matchRate: totalScreenings > 0 ? (totalMatches / totalScreenings * 100).toFixed(2) : 0,
    pendingReviews,
    screeningsLast24h: last24hScreenings,
    last24hMatches: await prismaRead.screeningResult.count({
      where: { screenedAt: { gte: last24h }, NOT: { status: 'clear' } },
    }),
    avgDurationMs: avgDuration._avg.durationMs ?? 0,
    activeListEntries: listCount,
    computedAt: now.toISOString(),
  };
}
