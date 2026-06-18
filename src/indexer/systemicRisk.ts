import { prismaRead as prisma } from '../db';

export type CriticalityLevel = 'critical' | 'high' | 'medium' | 'low';
export type FailureType = 'hack' | 'oracle_failure' | 'governance_attack' | 'bank_run';
export type DependencyType = 'token' | 'oracle' | 'bridge' | 'liquidity' | 'admin' | 'code' | 'call';

export interface DependencyEdge {
  from: string;
  to: string;
  type: DependencyType;
  criticality: CriticalityLevel;
  weight: number;
  label?: string;
}

export interface ProtocolNode {
  address: string;
  name: string;
  type: 'contract' | 'token' | 'oracle' | 'bridge' | 'governance';
  tvlUsd: number;
  category?: string;
}

export interface SystemDependencyGraph {
  protocols: Map<string, ProtocolNode>;
  edges: DependencyEdge[];
  metadata: {
    totalProtocols: number;
    totalEdges: number;
    generatedAt: string;
  };
}

export interface SystemicImportance {
  address: string;
  name: string;
  importance: number;
  dependents: number;
  dependentProtocols: string[];
}

export interface SystemicFragility {
  address: string;
  name: string;
  fragility: number;
  dependencies: number;
  criticalDependencies: number;
}

export interface CascadeResult {
  directlyAffected: number;
  transitivelyAffected: number;
  totalValueAtRisk: string;
  affectedProtocols: Array<{
    address: string;
    distance: number;
    impact: string;
    valueAtRisk: string;
    expectedLoss: string;
  }>;
  systemicImportanceScore: number;
  estimatedRecoveryTime: string;
}

export interface ProtocolRiskProfile {
  address: string;
  name: string;
  systemicImportance: number;
  systemicFragility: number;
  dependents: number;
  criticalDependencies: Array<{
    type: DependencyType;
    address: string;
    criticality: CriticalityLevel;
  }>;
  cascadeImpact: {
    tvlAtRisk: string;
    protocolsAffected: number;
  };
}

export interface ConcentrationMetrics {
  tvlTop3: number;
  dependencyTop3: number;
  ecosystemDiversity: number;
  giniCoefficient: number;
}

export interface SystemicOverview {
  systemicRiskIndex: number;
  mostSystemicallyImportant: Array<{
    address: string;
    name: string;
    importance: number;
    dependents: number;
  }>;
  mostFragile: Array<{
    address: string;
    name: string;
    fragility: number;
    dependencies: number;
  }>;
  concentrationMetrics: ConcentrationMetrics;
}

// Criticality weights for computing weighted dependency counts
const CRITICALITY_WEIGHT: Record<CriticalityLevel, number> = {
  critical: 1.0,
  high: 0.7,
  medium: 0.4,
  low: 0.15,
};

// TVL lookup cache
let tvlCache: Map<string, number> = new Map();
let lastTvlFetch = 0;
const TVL_CACHE_TTL = 300_000; // 5 minutes

async function ensureTvlCache(): Promise<Map<string, number>> {
  const now = Date.now();
  if (tvlCache.size > 0 && now - lastTvlFetch < TVL_CACHE_TTL) {
    return tvlCache;
  }
  tvlCache = new Map();
  const snapshots = await prisma.portfolioSnapshot.findMany({
    orderBy: { snapshotAt: 'desc' },
    take: 5000,
  });
  for (const s of snapshots) {
    const current = tvlCache.get(s.contractAddress) ?? 0;
    tvlCache.set(s.contractAddress, current + (s.valueUsd ?? 0));
  }
  lastTvlFetch = now;
  return tvlCache;
}

function getTvl(address: string): number {
  return tvlCache.get(address) ?? 0;
}

function getTotalEcosystemTvl(): number {
  return Array.from(tvlCache.values()).reduce((s, v) => s + v, 0);
}

/**
 * Build the comprehensive cross-protocol dependency graph.
 */
export async function buildSystemDependencyGraph(): Promise<SystemDependencyGraph> {
  const protocols = new Map<string, ProtocolNode>();
  const edges: DependencyEdge[] = [];

  await ensureTvlCache();

  // 1. Load all contracts as protocol nodes
  const contracts = await prisma.contract.findMany({
    select: { address: true, name: true, wasmHash: true, isToken: true },
  });

  const contractMap = new Map(contracts.map((c) => [c.address, c]));

  for (const c of contracts) {
    protocols.set(c.address, {
      address: c.address,
      name: c.name || c.address.slice(0, 8),
      type: c.isToken ? 'token' : 'contract',
      tvlUsd: getTvl(c.address),
    });
  }

  // 2. Load SAC mappings (bridge/token deps)
  const sacMappings = await prisma.sacMapping.findMany({
    include: { ammPools: true },
  });
  for (const sac of sacMappings) {
    if (!protocols.has(sac.sacAddress)) {
      protocols.set(sac.sacAddress, {
        address: sac.sacAddress,
        name: `${sac.assetCode} (SAC)`,
        type: 'token',
        tvlUsd: getTvl(sac.sacAddress),
      });
    }
  }

  // 3. Load governance contracts (admin deps)
  const governanceContracts = await prisma.governanceContract.findMany({
    select: { contractAddress: true, votingToken: true, governanceType: true },
  });

  for (const gc of governanceContracts) {
    if (!protocols.has(gc.contractAddress)) {
      protocols.set(gc.contractAddress, {
        address: gc.contractAddress,
        name: `Governance:${gc.contractAddress.slice(0, 8)}`,
        type: 'governance',
        tvlUsd: getTvl(gc.contractAddress),
      });
    }
  }

  // -- TOKEN DEPENDENCIES --
  // Which protocols hold which tokens as reserves (from PortfolioSnapshot)
  const tokenHoldings = await prisma.portfolioSnapshot.findMany({
    select: { contractAddress: true, assetCode: true },
    distinct: ['contractAddress', 'assetCode'],
    take: 10000,
  });

  // Map asset codes back to contract addresses via SacMapping
  const assetToSac = new Map<string, string>();
  for (const sac of sacMappings) {
    assetToSac.set(sac.assetCode, sac.sacAddress);
  }

  for (const th of tokenHoldings) {
    const assetAddr = assetToSac.get(th.assetCode ?? '');
    if (assetAddr && protocols.has(th.contractAddress) && protocols.has(assetAddr)) {
      edges.push({
        from: th.contractAddress,
        to: assetAddr,
        type: 'token',
        criticality: 'high',
        weight: CRITICALITY_WEIGHT.high,
        label: `holds ${th.assetCode}`,
      });
    }
  }

  // -- ORACLE DEPENDENCIES --
  const oracleCallbacks = await prisma.oracleCallback.findMany({
    select: { oracleContractAddress: true, dataRequestorAddress: true },
    distinct: ['oracleContractAddress', 'dataRequestorAddress'],
    take: 10000,
  });

  const oracleAddresses = new Set(oracleCallbacks.map((o) => o.oracleContractAddress));
  for (const addr of Array.from(oracleAddresses)) {
    if (!protocols.has(addr)) {
      protocols.set(addr, {
        address: addr,
        name: `Oracle:${addr.slice(0, 8)}`,
        type: 'oracle',
        tvlUsd: getTvl(addr),
      });
    }
  }

  for (const oc of oracleCallbacks) {
    if (protocols.has(oc.dataRequestorAddress) && protocols.has(oc.oracleContractAddress)) {
      edges.push({
        from: oc.dataRequestorAddress,
        to: oc.oracleContractAddress,
        type: 'oracle',
        criticality: 'critical',
        weight: CRITICALITY_WEIGHT.critical,
        label: 'oracle dependency',
      });
    }
  }

  // -- BRIDGE DEPENDENCIES --
  for (const sac of sacMappings) {
    const bridgeAddress = sac.assetIssuer ? `B:${sac.assetIssuer}` : 'B:native';
    if (!protocols.has(bridgeAddress)) {
      protocols.set(bridgeAddress, {
        address: bridgeAddress,
        name: `Bridge:${sac.assetCode}`,
        type: 'bridge',
        tvlUsd: 0,
      });
    }
    edges.push({
      from: sac.sacAddress,
      to: bridgeAddress,
      type: 'bridge',
      criticality: 'high',
      weight: CRITICALITY_WEIGHT.high,
      label: `bridged ${sac.assetCode}`,
    });
  }

  // -- LIQUIDITY DEPENDENCIES (AMM pools share assets) --
  const ammPools = await prisma.ammPool.findMany({
    select: { poolAddress: true, assetAAddress: true, assetBAddress: true },
    take: 5000,
  });

  const poolAddresses = new Set(ammPools.map((p) => p.poolAddress));
  for (const addr of poolAddresses) {
    if (!protocols.has(addr)) {
      protocols.set(addr, {
        address: addr,
        name: `Pool:${addr.slice(0, 8)}`,
        type: 'contract',
        tvlUsd: getTvl(addr),
      });
    }
  }

  // Ensure asset addresses are registered as protocol nodes
  const assetAddresses = new Set(ammPools.flatMap((p) => [p.assetAAddress, p.assetBAddress]));
  for (const addr of assetAddresses) {
    if (!protocols.has(addr)) {
      protocols.set(addr, {
        address: addr,
        name: `Asset:${addr.slice(0, 8)}`,
        type: 'token',
        tvlUsd: getTvl(addr),
      });
    }
  }

  for (const pool of ammPools) {
    for (const assetAddr of [pool.assetAAddress, pool.assetBAddress]) {
      if (protocols.has(pool.poolAddress) && protocols.has(assetAddr)) {
        edges.push({
          from: pool.poolAddress,
          to: assetAddr,
          type: 'liquidity',
          criticality: 'medium',
          weight: CRITICALITY_WEIGHT.medium,
          label: 'shared liquidity',
        });
      }
    }
  }

  // -- ADMIN DEPENDENCIES (governance) --
  for (const gc of governanceContracts) {
    const votingTokenAddr = gc.votingToken;
    if (votingTokenAddr && protocols.has(gc.contractAddress) && protocols.has(votingTokenAddr)) {
      edges.push({
        from: gc.contractAddress,
        to: votingTokenAddr,
        type: 'admin',
        criticality: 'critical',
        weight: CRITICALITY_WEIGHT.critical,
        label: `governance via ${gc.governanceType}`,
      });
    }
  }

  // -- CODE DEPENDENCIES (same WASM hash) --
  const wasmGroups = new Map<string, string[]>();
  for (const c of contracts) {
    if (c.wasmHash) {
      const group = wasmGroups.get(c.wasmHash) ?? [];
      group.push(c.address);
      wasmGroups.set(c.wasmHash, group);
    }
  }

  for (const [, addrs] of Array.from(wasmGroups)) {
    if (addrs.length < 2) continue;
    for (let i = 0; i < addrs.length; i++) {
      for (let j = i + 1; j < addrs.length; j++) {
        edges.push({
          from: addrs[i],
          to: addrs[j],
          type: 'code',
          criticality: 'medium',
          weight: CRITICALITY_WEIGHT.medium,
          label: 'same WASM hash',
        });
      }
    }
  }

  // -- CALL DEPENDENCIES (cross-contract calls) --
  const transactions = await prisma.transaction.findMany({
    where: { contractAddress: { not: null } },
    select: { contractAddress: true, functionArgs: true },
    take: 10000,
  });

  for (const tx of transactions) {
    if (!tx.contractAddress || !tx.functionArgs) continue;
    const calledAddresses = extractCalledAddresses(tx.functionArgs as Record<string, unknown>);
    for (const called of calledAddresses) {
      if (protocols.has(called) && called !== tx.contractAddress) {
        edges.push({
          from: tx.contractAddress,
          to: called,
          type: 'call',
          criticality: 'medium',
          weight: CRITICALITY_WEIGHT.medium,
          label: 'cross-contract call',
        });
      }
    }
  }

  // Deduplicate edges
  const edgeKeySet = new Set<string>();
  const uniqueEdges: DependencyEdge[] = [];
  for (const e of edges) {
    const key = `${e.from}|${e.to}|${e.type}`;
    if (!edgeKeySet.has(key)) {
      edgeKeySet.add(key);
      uniqueEdges.push(e);
    }
  }

  return {
    protocols,
    edges: uniqueEdges,
    metadata: {
      totalProtocols: protocols.size,
      totalEdges: uniqueEdges.length,
      generatedAt: new Date().toISOString(),
    },
  };
}

function extractCalledAddresses(obj: Record<string, unknown>): string[] {
  const addresses: string[] = [];
  const visited = new Set<unknown>();
  function traverse(val: unknown) {
    if (visited.has(val)) return;
    visited.add(val);
    if (typeof val === 'string' && val.startsWith('C') && val.length === 56) {
      addresses.push(val);
    } else if (typeof val === 'object' && val !== null) {
      for (const v of Object.values(val)) traverse(v);
    } else if (Array.isArray(val)) {
      for (const item of val) traverse(item);
    }
  }
  traverse(obj);
  return addresses;
}

/**
 * Compute systemic importance for each protocol.
 * Importance = weighted out-degree (how many others depend on this protocol).
 */
export function computeSystemicImportance(graph: SystemDependencyGraph): SystemicImportance[] {
  const dependentsMap = new Map<string, Set<string>>();

  for (const edge of graph.edges) {
    const target = edge.to;
    const source = edge.from;
    if (!dependentsMap.has(target)) {
      dependentsMap.set(target, new Set());
    }
    dependentsMap.get(target)!.add(source);
  }

  const totalProtocols = graph.protocols.size;
  const results: SystemicImportance[] = [];

  for (const [address, protocol] of Array.from(graph.protocols)) {
    const deps = dependentsMap.get(address);
    const numDependents = deps?.size ?? 0;
    const weight = numDependents / Math.max(totalProtocols - 1, 1);
    results.push({
      address,
      name: protocol.name,
      importance: Math.round(weight * 100) / 100,
      dependents: numDependents,
      dependentProtocols: deps ? Array.from(deps) : [],
    });
  }

  return results.sort((a, b) => b.importance - a.importance);
}

/**
 * Compute systemic fragility for each protocol.
 * Fragility = weighted in-degree (how many critical dependencies this protocol has).
 */
export function computeSystemicFragility(graph: SystemDependencyGraph): SystemicFragility[] {
  const dependencyCount = new Map<string, { total: number; critical: number }>();

  for (const edge of graph.edges) {
    const source = edge.from;
    const entry = dependencyCount.get(source) ?? { total: 0, critical: 0 };
    entry.total += CRITICALITY_WEIGHT[edge.criticality];
    if (edge.criticality === 'critical') {
      entry.critical++;
    }
    dependencyCount.set(source, entry);
  }

  const totalProtocols = graph.protocols.size;
  const results: SystemicFragility[] = [];
  const maxWeight = Math.max(
    ...Array.from(dependencyCount.values()).map((d) => d.total),
    1,
  );

  for (const [address, protocol] of Array.from(graph.protocols)) {
    const deps = dependencyCount.get(address);
    const numDeps = deps?.total ?? 0;
    const numCritical = deps?.critical ?? 0;
    const fragility = numDeps / Math.max(maxWeight, 1);

    results.push({
      address,
      name: protocol.name,
      fragility: Math.round(fragility * 100) / 100,
      dependencies: Math.round(numDeps),
      criticalDependencies: numCritical,
    });
  }

  return results.sort((a, b) => b.fragility - a.fragility);
}

/**
 * Simulate cascade failure from a protocol failure.
 */
export async function simulateCascade(
  failedProtocol: string,
  failureType: FailureType,
): Promise<CascadeResult | null> {
  const graph = await buildSystemDependencyGraph();
  await ensureTvlCache();

  if (!graph.protocols.has(failedProtocol)) return null;

  // Impact probability by failure type
  const failureImpact: Record<FailureType, Record<CriticalityLevel, number>> = {
    hack: { critical: 0.9, high: 0.6, medium: 0.3, low: 0.05 },
    oracle_failure: { critical: 0.95, high: 0.7, medium: 0.2, low: 0.02 },
    governance_attack: { critical: 0.8, high: 0.5, medium: 0.3, low: 0.1 },
    bank_run: { critical: 0.7, high: 0.4, medium: 0.15, low: 0.05 },
  };

  const impactProb = failureImpact[failureType];
  const affected = new Set<string>();
  const queue: Array<{ address: string; distance: number }> = [
    { address: failedProtocol, distance: 0 },
  ];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current.address)) continue;
    visited.add(current.address);
    if (current.distance > 0) affected.add(current.address);

    // Find all protocols that depend on the current one
    for (const edge of graph.edges) {
      if (edge.to === current.address && !visited.has(edge.from)) {
        const prob = impactProb[edge.criticality];
        if (Math.random() < prob) {
          queue.push({ address: edge.from, distance: current.distance + 1 });
        }
      }
    }
  }

  // Deduplicate
  const uniqueAffected = Array.from(affected);
  const directAffected: string[] = [];
  const transitiveAffected: string[] = [];

  for (const addr of uniqueAffected) {
    // Check if there's a direct edge
    const hasDirect = graph.edges.some(
      (e) => e.to === failedProtocol && e.from === addr,
    );
    if (hasDirect) {
      directAffected.push(addr);
    } else {
      transitiveAffected.push(addr);
    }
  }

  const totalEcosystemTvl = getTotalEcosystemTvl();
  let totalValueAtRisk = 0;
  const protocolDetails = uniqueAffected
    .map((addr) => {
      const node = graph.protocols.get(addr);
      const tvl = getTvl(addr);
      totalValueAtRisk += tvl;

      // Find the shortest distance
      let minDist = Infinity;
      for (const edge of graph.edges) {
        if (edge.to === failedProtocol && edge.from === addr) {
          minDist = 1;
          break;
        }
      }
      if (minDist === Infinity) {
        for (const edge of graph.edges) {
          if (affected.has(edge.from) && edge.to === addr) {
            minDist = 2;
            break;
          }
        }
      }
      if (minDist === Infinity) minDist = 3;

      const lossRatio =
        failureType === 'hack'
          ? 0.5
          : failureType === 'oracle_failure'
            ? 0.3
            : failureType === 'governance_attack'
              ? 0.6
              : 0.4;

      return {
        address: addr,
        distance: minDist,
        impact: minDist <= 1 ? 'high' : minDist <= 2 ? 'medium' : 'low' as string,
        valueAtRisk: formatUsd(tvl),
        expectedLoss: formatUsd(tvl * lossRatio),
        name: node?.name ?? addr.slice(0, 8),
      };
    })
    .sort((a, b) => b.distance - a.distance);

  const systemicScore = totalEcosystemTvl > 0
    ? Math.round((totalValueAtRisk / totalEcosystemTvl) * 100) / 100
    : 0;

  const recoveryDays =
    failureType === 'hack' ? 14
      : failureType === 'oracle_failure' ? 3
        : failureType === 'governance_attack' ? 21
          : 7;

  return {
    directlyAffected: directAffected.length,
    transitivelyAffected: transitiveAffected.length,
    totalValueAtRisk: formatUsd(totalValueAtRisk),
    affectedProtocols: protocolDetails,
    systemicImportanceScore: systemicScore,
    estimatedRecoveryTime: `${recoveryDays} days`,
  };
}

/**
 * Compute protocol risk profile.
 */
export async function getProtocolRiskProfile(address: string): Promise<ProtocolRiskProfile | null> {
  const graph = await buildSystemDependencyGraph();
  const protocol = graph.protocols.get(address);
  if (!protocol) return null;

  const importance = computeSystemicImportance(graph);
  const fragilities = computeSystemicFragility(graph);

  const imp = importance.find((i) => i.address === address);
  const frag = fragilities.find((f) => f.address === address);

  const criticalDeps = graph.edges
    .filter((e) => e.from === address)
    .map((e) => ({
      type: e.type as DependencyType,
      address: e.to,
      criticality: e.criticality,
    }));

  // Cascade impact
  const cascade = await simulateCascade(address, 'hack');
  const protocolsAffected = cascade
    ? cascade.directlyAffected + cascade.transitivelyAffected
    : 0;
  const tvlAtRisk = cascade?.totalValueAtRisk ?? '0';

  return {
    address,
    name: protocol.name,
    systemicImportance: imp?.importance ?? 0,
    systemicFragility: frag?.fragility ?? 0,
    dependents: imp?.dependents ?? 0,
    criticalDependencies: criticalDeps,
    cascadeImpact: {
      tvlAtRisk,
      protocolsAffected,
    },
  };
}

/**
 * Compute systemic risk index (0-1).
 * A weighted composite of concentration, interconnectedness, and fragility.
 */
export function computeSystemicRiskIndex(graph: SystemDependencyGraph): number {
  const totalProtocols = graph.protocols.size;
  if (totalProtocols === 0) return 0;

  // 1. Concentration: Gini coefficient of dependency distribution
  const importance = computeSystemicImportance(graph);
  const totalImportance = importance.reduce((s, i) => s + i.importance, 0);
  const sorted = [...importance].sort((a, b) => a.importance - b.importance);
  let cumulative = 0;
  let giniNumerator = 0;
  for (let i = 0; i < sorted.length; i++) {
    cumulative += sorted[i].importance;
    giniNumerator += cumulative;
  }
  const gini = totalImportance > 0
    ? 1 - (2 * giniNumerator) / (totalImportance * sorted.length) + 1 / sorted.length
    : 0;

  // 2. Interconnectedness: edge density
  const maxPossibleEdges = totalProtocols * (totalProtocols - 1);
  const density = maxPossibleEdges > 0
    ? graph.edges.length / maxPossibleEdges
    : 0;

  // 3. Average fragility
  const fragilities = computeSystemicFragility(graph);
  const avgFragility = fragilities.reduce((s, f) => s + f.fragility, 0) / totalProtocols;

  // 4. Critical dependency concentration
  const criticalEdges = graph.edges.filter((e) => e.criticality === 'critical');
  const criticalConcentration = criticalEdges.length / Math.max(graph.edges.length, 1);

  // Weighted composite
  const index =
    gini * 0.3 +
    density * 0.25 +
    avgFragility * 0.25 +
    criticalConcentration * 0.2;

  return Math.round(Math.min(index, 1) * 100) / 100;
}

/**
 * Compute concentration metrics.
 */
export function computeConcentrationMetrics(graph: SystemDependencyGraph): ConcentrationMetrics {
  const importance = computeSystemicImportance(graph);

  // TVL concentration (top 3)
  const sortedByTvl = Array.from(graph.protocols.values()).sort(
    (a, b) => b.tvlUsd - a.tvlUsd,
  );
  const totalTvl = sortedByTvl.reduce((s, p) => s + p.tvlUsd, 0);
  const tvlTop3 = totalTvl > 0
    ? sortedByTvl.slice(0, 3).reduce((s, p) => s + p.tvlUsd, 0) / totalTvl
    : 0;

  // Dependency concentration (top 3 most depended-upon)
  const depTop3 = importance.length > 0
    ? importance.slice(0, 3).reduce((s, i) => s + i.importance, 0) /
      importance.reduce((s, i) => s + i.importance, 0) || 0
    : 0;

  // Ecosystem diversity = 1 - gini coefficient
  const totalImportance = importance.reduce((s, i) => s + i.importance, 0);
  const sorted = [...importance].sort((a, b) => a.importance - b.importance);
  let cumulative = 0;
  let giniNumerator = 0;
  for (let i = 0; i < sorted.length; i++) {
    cumulative += sorted[i].importance;
    giniNumerator += cumulative;
  }
  const gini = totalImportance > 0
    ? 1 - (2 * giniNumerator) / (totalImportance * sorted.length) + 1 / sorted.length
    : 0;

  return {
    tvlTop3: Math.round(tvlTop3 * 100) / 100,
    dependencyTop3: Math.round(depTop3 * 100) / 100,
    ecosystemDiversity: Math.round((1 - gini) * 100) / 100,
    giniCoefficient: Math.round(gini * 100) / 100,
  };
}

/**
 * Get systemic overview dashboard data.
 */
export async function getSystemicOverview(): Promise<SystemicOverview> {
  const graph = await buildSystemDependencyGraph();

  const importance = computeSystemicImportance(graph);
  const fragilities = computeSystemicFragility(graph);
  const concentration = computeConcentrationMetrics(graph);
  const riskIndex = computeSystemicRiskIndex(graph);

  return {
    systemicRiskIndex: riskIndex,
    mostSystemicallyImportant: importance.slice(0, 10).map((i) => ({
      address: i.address,
      name: graph.protocols.get(i.address)?.name ?? i.address.slice(0, 8),
      importance: i.importance,
      dependents: i.dependents,
    })),
    mostFragile: fragilities.slice(0, 10).map((f) => ({
      address: f.address,
      name: graph.protocols.get(f.address)?.name ?? f.address.slice(0, 8),
      fragility: f.fragility,
      dependencies: f.dependencies,
    })),
    concentrationMetrics: concentration,
  };
}

/**
 * Get critical nodes (top 10 most systemically important).
 */
export async function getCriticalNodes(): Promise<SystemicImportance[]> {
  const graph = await buildSystemDependencyGraph();
  const importance = computeSystemicImportance(graph);
  return importance.slice(0, 10).map((i) => ({
    ...i,
    dependentProtocols: i.dependentProtocols.slice(0, 20),
  }));
}

function formatUsd(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B USD`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M USD`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K USD`;
  return `${value.toFixed(2)} USD`;
}

/**
 * Compute correlation risk between protocols.
 * Higher means protocols share more dependencies (more correlated risk).
 */
export function computeCorrelationRisk(graph: SystemDependencyGraph): Map<string, number> {
  const correlationScores = new Map<string, number>();
  const protocolDeps = new Map<string, Set<string>>();

  for (const edge of graph.edges) {
    const deps = protocolDeps.get(edge.from) ?? new Set();
    deps.add(edge.to);
    protocolDeps.set(edge.from, deps);
  }

  const protocolList = Array.from(graph.protocols.keys());
  for (let i = 0; i < protocolList.length; i++) {
    const depsA = protocolDeps.get(protocolList[i]) ?? new Set();
    let sharedMax = 0;
    for (let j = i + 1; j < protocolList.length; j++) {
      const depsB = protocolDeps.get(protocolList[j]) ?? new Set();
      const intersection = new Set(Array.from(depsA).filter((x) => depsB.has(x)));
      const union = new Set([...Array.from(depsA), ...Array.from(depsB)]);
      const jaccard = union.size > 0 ? intersection.size / union.size : 0;
      if (jaccard > sharedMax) sharedMax = jaccard;
    }
    correlationScores.set(protocolList[i], Math.round(sharedMax * 100) / 100);
  }

  return correlationScores;
}
