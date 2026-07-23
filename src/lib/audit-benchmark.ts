/**
 * Audit Competitive Benchmarking
 *
 * Compares a contract's audit scores against peers in the same:
 *   1. Contract category   (token/dex/nft/lending/staking/bridge/other)
 *   2. TVL range bucket    (<$10K / $10K-$100K / $100K-$1M / >$1M)
 *
 * Category inference priority:
 *   a) YieldOpportunity.type         → maps directly to our categories
 *   b) Contract.isToken / tokenSymbol → "token"
 *   c) DexPool presence              → "dex"
 *   d) StandardCompliance contractType inferred from tx function names
 *   e) Fallback                      → "other"
 *
 * TVL source priority:
 *   YieldOpportunity.tvl → PortfolioSnapshot.valueUsd → 0
 */

import { prismaRead } from '../db';
import { cacheGet, cacheSet } from '../cache';

// ── Types ──────────────────────────────────────────────────────────────────────

export type ContractCategory =
  | 'token'
  | 'dex'
  | 'nft'
  | 'lending'
  | 'staking'
  | 'bridge'
  | 'governance'
  | 'other';

export type TvlBucket =
  | 'micro' // < $10 K
  | 'small' // $10 K – $100 K
  | 'mid' // $100 K – $1 M
  | 'large'; // > $1 M

export interface PeerStats {
  count: number;
  avgOverall: number;
  avgSecurity: number;
  avgGovernance: number;
  avgEconomic: number;
  avgCompliance: number;
  avgLiquidity: number;
  p25Overall: number;
  p50Overall: number; // median
  p75Overall: number;
  minOverall: number;
  maxOverall: number;
  topScore: number;
  bottomScore: number;
}

export interface BenchmarkResult {
  contractAddress: string;
  category: ContractCategory;
  tvlUsd: number;
  tvlBucket: TvlBucket;
  // Subject contract scores
  scores: {
    overall: number;
    security: number;
    governance: number;
    economic: number;
    compliance: number;
    liquidity: number;
  };
  // Peer group stats
  peers: PeerStats;
  // Percentile ranks (0-100 — higher = better than X% of peers)
  percentileRanks: {
    overall: number;
    security: number;
    governance: number;
    economic: number;
    compliance: number;
    liquidity: number;
  };
  // Category average deltas (subject - peer avg, positive = above average)
  deltas: {
    overall: number;
    security: number;
    governance: number;
    economic: number;
    compliance: number;
    liquidity: number;
  };
  // Narrative insight
  insights: string[];
  // Peers list (limited to top/bottom for display)
  peerContracts: Array<{
    contractAddress: string;
    overallScore: number;
    tvlUsd: number;
    grade: string;
  }>;
  // Category-wide aggregates for radar comparison
  categoryAvgRadar: Array<{ dimension: string; subjectScore: number; peerAvg: number }>;
}

// ── Grade helper ──────────────────────────────────────────────────────────────

function grade(s: number): string {
  return s >= 85 ? 'A' : s >= 70 ? 'B' : s >= 55 ? 'C' : s >= 40 ? 'D' : 'F';
}

// ── TVL helpers ───────────────────────────────────────────────────────────────

export async function getContractTvl(contractAddress: string): Promise<number> {
  const [yieldOpp, portfolio] = await Promise.all([
    prismaRead.yieldOpportunity.findFirst({
      where: { contractAddress },
      orderBy: { updatedAt: 'desc' },
      select: { tvl: true },
    }),
    prismaRead.portfolioSnapshot.findFirst({
      where: { contractAddress },
      orderBy: { snapshotAt: 'desc' },
      select: { valueUsd: true },
    }),
  ]);

  if (yieldOpp?.tvl) {
    const v = parseFloat(yieldOpp.tvl);
    if (!isNaN(v) && v > 0) return v;
  }
  return portfolio?.valueUsd ?? 0;
}

export function tvlBucket(tvl: number): TvlBucket {
  if (tvl >= 1_000_000) return 'large';
  if (tvl >= 100_000) return 'mid';
  if (tvl >= 10_000) return 'small';
  return 'micro';
}

// ── Category inference ────────────────────────────────────────────────────────

export async function inferCategory(contractAddress: string): Promise<ContractCategory> {
  // 1. YieldOpportunity type
  const yieldOpp = await prismaRead.yieldOpportunity.findFirst({
    where: { contractAddress },
    select: { type: true },
  });
  if (yieldOpp?.type) {
    const typeMap: Record<string, ContractCategory> = {
      lp_farming: 'dex',
      staking: 'staking',
      lending: 'lending',
      liquid_staking: 'staking',
      vault: 'other',
    };
    const mapped = typeMap[yieldOpp.type];
    if (mapped) return mapped;
  }

  // 2. Token contract
  const contract = await prismaRead.contract.findUnique({
    where: { address: contractAddress },
    select: { isToken: true, tokenSymbol: true, name: true },
  });
  if (contract?.isToken) return 'token';

  // 3. DEX pool
  const dexPool = await prismaRead.dexPool.findFirst({
    where: { contractAddress },
    select: { id: true },
  });
  if (dexPool) return 'dex';

  // 4. AMM pool
  const ammPool = await prismaRead.ammPool.findFirst({
    where: { poolAddress: contractAddress },
    select: { id: true },
  });
  if (ammPool) return 'dex';

  // 5. Governance contract
  const govContract = await prismaRead.governanceContract.findFirst({
    where: { contractAddress },
    select: { id: true },
  });
  if (govContract) return 'governance';

  // 6. Function name heuristics from recent transactions
  const fns = await prismaRead.transaction.findMany({
    where: { contractAddress, functionName: { not: null } },
    select: { functionName: true },
    take: 20,
  });
  const fnNames = fns.map((t) => (t.functionName ?? '').toLowerCase()).join(' ');

  if (/\bborrow\b|\blend\b|\brepay\b|\bcollateral/.test(fnNames)) return 'lending';
  if (/\bstake\b|\bunstake\b|\bdelegate/.test(fnNames)) return 'staking';
  if (/\bnft\b|\bmint_pass\b|\btoken_id/.test(fnNames)) return 'nft';
  if (/\bswap\b|\bliquidity\b|\bpool/.test(fnNames)) return 'dex';
  if (/\bbridge\b|\block\b|\bunlock\b/.test(fnNames)) return 'bridge';
  if (/\btransfer\b|\bbalance_of\b|\bmint\b/.test(fnNames)) return 'token';

  return 'other';
}

// ── Peer statistics computation ───────────────────────────────────────────────

function computeStats(scores: number[]): Omit<PeerStats, 'topScore' | 'bottomScore'> & {
  topScore: number;
  bottomScore: number;
} {
  if (scores.length === 0) {
    return {
      count: 0,
      avgOverall: 0,
      avgSecurity: 0,
      avgGovernance: 0,
      avgEconomic: 0,
      avgCompliance: 0,
      avgLiquidity: 0,
      p25Overall: 0,
      p50Overall: 0,
      p75Overall: 0,
      minOverall: 0,
      maxOverall: 0,
      topScore: 0,
      bottomScore: 0,
    };
  }
  const sorted = [...scores].sort((a, b) => a - b);
  const avg = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  const pct = (p: number) =>
    sorted[Math.floor((sorted.length * p) / 100)] ?? sorted[sorted.length - 1];

  return {
    count: sorted.length,
    avgOverall: +avg.toFixed(1),
    avgSecurity: 0, // filled by caller
    avgGovernance: 0,
    avgEconomic: 0,
    avgCompliance: 0,
    avgLiquidity: 0,
    p25Overall: pct(25),
    p50Overall: pct(50),
    p75Overall: pct(75),
    minOverall: sorted[0],
    maxOverall: sorted[sorted.length - 1],
    topScore: sorted[sorted.length - 1],
    bottomScore: sorted[0],
  };
}

function percentileRank(value: number, sorted: number[]): number {
  if (sorted.length === 0) return 50;
  const below = sorted.filter((v) => v < value).length;
  return Math.round((below / sorted.length) * 100);
}

function avg(nums: number[]): number {
  return nums.length === 0 ? 0 : +(nums.reduce((s, v) => s + v, 0) / nums.length).toFixed(1);
}

// ── Insight generator ─────────────────────────────────────────────────────────

function generateInsights(
  subject: {
    overall: number;
    security: number;
    governance: number;
    economic: number;
    compliance: number;
    liquidity: number;
  },
  peers: PeerStats,
  percentiles: {
    overall: number;
    security: number;
    governance: number;
    economic: number;
    compliance: number;
    liquidity: number;
  },
  category: ContractCategory,
  tvlBucketName: TvlBucket,
): string[] {
  const insights: string[] = [];
  const p = percentiles.overall;

  // Overall positioning
  if (p >= 90) {
    insights.push(`Top 10% of ${category} contracts — exceptional security posture.`);
  } else if (p >= 75) {
    insights.push(`Above average for ${category} contracts (top 25%).`);
  } else if (p >= 50) {
    insights.push(`Slightly above median for ${category} contracts.`);
  } else if (p >= 25) {
    insights.push(`Below median for ${category} contracts — improvement recommended.`);
  } else {
    insights.push(`Bottom quartile for ${category} contracts — urgent remediation advised.`);
  }

  // Dimension-specific standouts
  const dims: Array<[string, number, number]> = [
    ['Security', subject.security, peers.avgSecurity],
    ['Governance', subject.governance, peers.avgGovernance],
    ['Economic', subject.economic, peers.avgEconomic],
    ['Compliance', subject.compliance, peers.avgCompliance],
    ['Liquidity', subject.liquidity, peers.avgLiquidity],
  ];

  for (const [dim, score, peerAvg] of dims) {
    const delta = score - peerAvg;
    if (delta >= 15)
      insights.push(
        `${dim} score is ${delta.toFixed(0)} pts above peer average — standout strength.`,
      );
    if (delta <= -15)
      insights.push(
        `${dim} score is ${Math.abs(delta).toFixed(0)} pts below peer average — focus area.`,
      );
  }

  // TVL-size context
  const tvlLabel: Record<TvlBucket, string> = {
    micro: 'under $10K',
    small: '$10K–$100K',
    mid: '$100K–$1M',
    large: 'over $1M',
  };
  insights.push(
    `Compared against ${peers.count} ${category} contracts with TVL ${tvlLabel[tvlBucketName]}.`,
  );

  return insights.slice(0, 5); // max 5 insights
}

// ── Main benchmark function ───────────────────────────────────────────────────

export async function benchmarkContract(contractAddress: string): Promise<BenchmarkResult | null> {
  const cacheKey = `audit:benchmark:${contractAddress}`;
  const cached = await cacheGet<BenchmarkResult>(cacheKey);
  if (cached) return cached;

  // Get subject's cert
  const subjectCert = await prismaRead.auditCertificate.findFirst({
    where: { contractAddress, status: 'published' },
    orderBy: { version: 'desc' },
    select: {
      overallScore: true,
      securityScore: true,
      governanceScore: true,
      economicScore: true,
      complianceScore: true,
      liquidityScore: true,
    },
  });
  if (!subjectCert) return null;

  // Infer category and TVL in parallel
  const [category, tvlUsd] = await Promise.all([
    inferCategory(contractAddress),
    getContractTvl(contractAddress),
  ]);
  const bucket = tvlBucket(tvlUsd);

  // Load all peer contracts in same category + TVL bucket
  // We join via YieldOpportunity for TVL-rich contracts, then union with cert data
  const allCerts = await prismaRead.auditCertificate.findMany({
    where: { status: 'published' },
    orderBy: { overallScore: 'desc' },
    distinct: ['contractAddress'],
    select: {
      contractAddress: true,
      overallScore: true,
      securityScore: true,
      governanceScore: true,
      economicScore: true,
      complianceScore: true,
      liquidityScore: true,
    },
  });

  // Filter peers by category (infer per cert — expensive for large sets, so cap)
  // Strategy: load all certs, check category for those with TVL in the same bucket.
  // Cap at 200 certs to keep p99 latency reasonable.
  const candidates = allCerts.filter((c) => c.contractAddress !== contractAddress).slice(0, 200);

  // Batch-infer categories for candidates (parallelised, 20 at a time)
  const BATCH = 20;
  const peerCerts: typeof candidates = [];

  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async (c) => {
        const [cat, tvl] = await Promise.all([
          inferCategory(c.contractAddress),
          getContractTvl(c.contractAddress),
        ]);
        return { cert: c, cat, tvl };
      }),
    );
    for (const { cert, cat, tvl } of results) {
      if (cat === category && tvlBucket(tvl) === bucket) {
        peerCerts.push(cert);
      }
    }
  }

  // If fewer than 3 peers in the TVL bucket, relax to category-only
  const effectivePeers =
    peerCerts.length >= 3
      ? peerCerts
      : candidates
          .filter((c) => {
            // Reuse already-inferred set from above
            return (
              peerCerts.find((p) => p.contractAddress === c.contractAddress) || peerCerts.length < 3
            );
          })
          .slice(0, 50);

  // Compute per-dimension averages
  const peerOverall = effectivePeers.map((p) => p.overallScore);
  const peerSecurity = effectivePeers.map((p) => p.securityScore);
  const peerGovernance = effectivePeers.map((p) => p.governanceScore);
  const peerEconomic = effectivePeers.map((p) => p.economicScore);
  const peerCompliance = effectivePeers.map((p) => p.complianceScore);
  const peerLiquidity = effectivePeers.map((p) => p.liquidityScore);

  const sortedOverall = [...peerOverall].sort((a, b) => a - b);
  const baseStats = computeStats(peerOverall);
  const peerStats: PeerStats = {
    ...baseStats,
    avgSecurity: avg(peerSecurity),
    avgGovernance: avg(peerGovernance),
    avgEconomic: avg(peerEconomic),
    avgCompliance: avg(peerCompliance),
    avgLiquidity: avg(peerLiquidity),
  };

  const subject = {
    overall: subjectCert.overallScore,
    security: subjectCert.securityScore,
    governance: subjectCert.governanceScore,
    economic: subjectCert.economicScore,
    compliance: subjectCert.complianceScore,
    liquidity: subjectCert.liquidityScore,
  };

  const percentileRanks = {
    overall: percentileRank(subject.overall, sortedOverall),
    security: percentileRank(
      subject.security,
      [...peerSecurity].sort((a, b) => a - b),
    ),
    governance: percentileRank(
      subject.governance,
      [...peerGovernance].sort((a, b) => a - b),
    ),
    economic: percentileRank(
      subject.economic,
      [...peerEconomic].sort((a, b) => a - b),
    ),
    compliance: percentileRank(
      subject.compliance,
      [...peerCompliance].sort((a, b) => a - b),
    ),
    liquidity: percentileRank(
      subject.liquidity,
      [...peerLiquidity].sort((a, b) => a - b),
    ),
  };

  const deltas = {
    overall: +(subject.overall - peerStats.avgOverall).toFixed(1),
    security: +(subject.security - peerStats.avgSecurity).toFixed(1),
    governance: +(subject.governance - peerStats.avgGovernance).toFixed(1),
    economic: +(subject.economic - peerStats.avgEconomic).toFixed(1),
    compliance: +(subject.compliance - peerStats.avgCompliance).toFixed(1),
    liquidity: +(subject.liquidity - peerStats.avgLiquidity).toFixed(1),
  };

  const insights = generateInsights(subject, peerStats, percentileRanks, category, bucket);

  // Top 5 + bottom 5 peers for display
  const topPeers = [...effectivePeers].sort((a, b) => b.overallScore - a.overallScore).slice(0, 5);
  const bottomPeers = [...effectivePeers]
    .sort((a, b) => a.overallScore - b.overallScore)
    .slice(0, 5);
  const peerContractsRaw = [
    ...new Map([...topPeers, ...bottomPeers].map((p) => [p.contractAddress, p])).values(),
  ];

  // Get TVL for displayed peers
  const peerContracts = await Promise.all(
    peerContractsRaw.map(async (p) => ({
      contractAddress: p.contractAddress,
      overallScore: p.overallScore,
      tvlUsd: await getContractTvl(p.contractAddress),
      grade: grade(p.overallScore),
    })),
  );

  const categoryAvgRadar = [
    { dimension: 'Security', subjectScore: subject.security, peerAvg: peerStats.avgSecurity },
    { dimension: 'Governance', subjectScore: subject.governance, peerAvg: peerStats.avgGovernance },
    { dimension: 'Economic', subjectScore: subject.economic, peerAvg: peerStats.avgEconomic },
    { dimension: 'Compliance', subjectScore: subject.compliance, peerAvg: peerStats.avgCompliance },
    { dimension: 'Liquidity', subjectScore: subject.liquidity, peerAvg: peerStats.avgLiquidity },
  ];

  const result: BenchmarkResult = {
    contractAddress,
    category,
    tvlUsd,
    tvlBucket: bucket,
    scores: subject,
    peers: peerStats,
    percentileRanks,
    deltas,
    insights,
    peerContracts,
    categoryAvgRadar,
  };

  await cacheSet(cacheKey, result, 600); // 10-min cache
  return result;
}

// ── Category-level benchmark aggregates ──────────────────────────────────────

export interface CategoryBenchmark {
  category: ContractCategory;
  contractCount: number;
  avgScores: {
    overall: number;
    security: number;
    governance: number;
    economic: number;
    compliance: number;
    liquidity: number;
  };
  scoreDistribution: {
    excellent: number; // ≥ 85
    good: number; // 70–84
    fair: number; // 55–69
    poor: number; // 40–54
    critical: number; // < 40
  };
  topContracts: Array<{
    contractAddress: string;
    overallScore: number;
    grade: string;
    tvlUsd: number;
  }>;
  tvlBreakdown: Record<TvlBucket, { count: number; avgScore: number }>;
  findingsBySeverity: { critical: number; high: number; medium: number; low: number };
}

export async function getCategoryBenchmark(
  category: ContractCategory,
): Promise<CategoryBenchmark | null> {
  const cacheKey = `audit:category-benchmark:${category}`;
  const cached = await cacheGet<CategoryBenchmark>(cacheKey);
  if (cached) return cached;

  // Get all published certs
  const allCerts = await prismaRead.auditCertificate.findMany({
    where: { status: 'published' },
    distinct: ['contractAddress'],
    select: {
      contractAddress: true,
      overallScore: true,
      securityScore: true,
      governanceScore: true,
      economicScore: true,
      complianceScore: true,
      liquidityScore: true,
      criticalFindings: true,
      highFindings: true,
      mediumFindings: true,
      lowFindings: true,
    },
  });

  if (allCerts.length === 0) return null;

  // Filter by category in batches
  const BATCH = 20;
  const matching: typeof allCerts = [];

  for (let i = 0; i < Math.min(allCerts.length, 300); i += BATCH) {
    const batch = allCerts.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async (c) => ({ c, cat: await inferCategory(c.contractAddress) })),
    );
    for (const { c, cat } of results) {
      if (cat === category) matching.push(c);
    }
  }

  if (matching.length === 0) return null;

  // Aggregate scores
  const avgField = (field: keyof (typeof matching)[0]) =>
    +(matching.reduce((s, c) => s + (c[field] as number), 0) / matching.length).toFixed(1);

  const dist = { excellent: 0, good: 0, fair: 0, poor: 0, critical: 0 };
  for (const c of matching) {
    if (c.overallScore >= 85) dist.excellent++;
    else if (c.overallScore >= 70) dist.good++;
    else if (c.overallScore >= 55) dist.fair++;
    else if (c.overallScore >= 40) dist.poor++;
    else dist.critical++;
  }

  // TVL breakdown
  const tvlBreakdown: Record<TvlBucket, { count: number; avgScore: number; scores: number[] }> = {
    micro: { count: 0, avgScore: 0, scores: [] },
    small: { count: 0, avgScore: 0, scores: [] },
    mid: { count: 0, avgScore: 0, scores: [] },
    large: { count: 0, avgScore: 0, scores: [] },
  };

  const tvlResults = await Promise.all(
    matching.map(async (c) => ({ c, tvl: await getContractTvl(c.contractAddress) })),
  );

  for (const { c, tvl } of tvlResults) {
    const bkt = tvlBucket(tvl);
    tvlBreakdown[bkt].count++;
    tvlBreakdown[bkt].scores.push(c.overallScore);
  }
  for (const bkt of Object.keys(tvlBreakdown) as TvlBucket[]) {
    const scores = tvlBreakdown[bkt].scores;
    tvlBreakdown[bkt].avgScore =
      scores.length > 0 ? +(scores.reduce((s, v) => s + v, 0) / scores.length).toFixed(1) : 0;
  }

  // Top contracts (exclude scores)
  const topContracts = await Promise.all(
    [...matching]
      .sort((a, b) => b.overallScore - a.overallScore)
      .slice(0, 10)
      .map(async (c) => ({
        contractAddress: c.contractAddress,
        overallScore: c.overallScore,
        grade: grade(c.overallScore),
        tvlUsd: await getContractTvl(c.contractAddress),
      })),
  );

  // Finding totals
  const findingsBySeverity = {
    critical: matching.reduce((s, c) => s + c.criticalFindings, 0),
    high: matching.reduce((s, c) => s + c.highFindings, 0),
    medium: matching.reduce((s, c) => s + c.mediumFindings, 0),
    low: matching.reduce((s, c) => s + c.lowFindings, 0),
  };

  const tvlBreakdownClean = Object.fromEntries(
    Object.entries(tvlBreakdown).map(([k, v]) => [k, { count: v.count, avgScore: v.avgScore }]),
  ) as Record<TvlBucket, { count: number; avgScore: number }>;

  const result: CategoryBenchmark = {
    category,
    contractCount: matching.length,
    avgScores: {
      overall: avgField('overallScore'),
      security: avgField('securityScore'),
      governance: avgField('governanceScore'),
      economic: avgField('economicScore'),
      compliance: avgField('complianceScore'),
      liquidity: avgField('liquidityScore'),
    },
    scoreDistribution: dist,
    topContracts,
    tvlBreakdown: tvlBreakdownClean,
    findingsBySeverity,
  };

  await cacheSet(cacheKey, result, 900); // 15-min cache
  return result;
}
