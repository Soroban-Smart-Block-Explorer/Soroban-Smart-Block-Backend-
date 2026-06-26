/**
 * Arbitrage Intelligence Engine
 * Real-time multi-DEX arbitrage detection, MEV scoring,
 * sandwich attack detection, and execution simulation.
 */

import { Prisma } from '@prisma/client';
import { prismaRead, prismaWrite } from '../db';
import { cacheGet, cacheSet } from '../cache';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RouteStep {
  action: 'buy' | 'sell' | 'swap';
  dex: string;
  poolId?: string;
  tokenIn: string;
  tokenOut: string;
  expectedOutput: string;
  priceImpact?: string;
}

export interface ArbitrageRoute {
  type: 'direct' | 'triangular' | 'multi_hop' | 'cross_pool';
  steps: RouteStep[];
  profitPercentage: number;
  netProfit: number;
  capitalRequired: number;
  totalFees: number;
  hops: number;
}

export interface MevScore {
  overallScore: number;
  profitabilityScore: number;
  capitalEfficiency: number;
  speedRequirement: 'immediate' | 'fast' | 'moderate' | 'slow';
  competitionLevel: 'low' | 'medium' | 'high' | 'extreme';
  slippageRisk: number;
  frontrunningRisk: number;
  recommendation: 'execute_immediately' | 'monitor' | 'skip';
}

export interface SimulationStep {
  step: number;
  action: string;
  dex: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  expectedOut: string;
  estimatedPriceImpact: string;
}

export interface SimulationResult {
  opportunityId: string;
  profitability: {
    grossProfit: string;
    estimatedGas: string;
    netProfit: string;
    roi: string;
  };
  executionPlan: { steps: SimulationStep[] };
  riskAssessment: {
    slippageRisk: string;
    frontrunningRisk: string;
    executionRisk: string;
    recommendedGasPrice: string;
    estimatedBlocksToExecute: number;
  };
  alternativeRoutes: { description: string; profitDifference: string }[];
}

// ─── Price Graph (for Bellman-Ford / Floyd-Warshall) ─────────────────────────

interface PriceNode {
  poolId: string;
  dexName: string;
  tokenA: string;
  tokenB: string;
  spotPrice: number;
  feeTier: number;
  liquidity: number;
}

export interface PriceGraph {
  nodes: Map<string, PriceNode[]>; // token → [pool edges]
  edges: Map<string, number>; // "tokenA:tokenB:poolId" → log-price
}

/** Build a directed price graph from active pool prices. */
export async function buildPriceGraph(): Promise<PriceGraph> {
  const cacheKey = 'arb:price_graph';
  const cached = await cacheGet<PriceGraph>(cacheKey);
  if (cached) return cached;

  const pools = await prismaRead.dexPool.findMany({
    where: { isActive: true },
    include: {
      poolPrices: {
        orderBy: { timestamp: 'desc' },
        take: 1,
      },
    },
  });

  const nodes = new Map<string, PriceNode[]>();
  const edges = new Map<string, number>();

  for (const pool of pools) {
    const latest = pool.poolPrices[0];
    if (!latest) continue;

    const price = Number(latest.spotPrice);
    if (price <= 0) continue;

    const feeTier = Number(pool.feeTier ?? 0.003);
    const liquidity = Number(pool.totalLiquidity ?? 0);

    const node: PriceNode = {
      poolId: pool.id,
      dexName: pool.dexName,
      tokenA: pool.tokenA,
      tokenB: pool.tokenB,
      spotPrice: price,
      feeTier,
      liquidity,
    };

    // A→B direction
    const abKey = pool.tokenA;
    if (!nodes.has(abKey)) nodes.set(abKey, []);
    nodes.get(abKey)!.push(node);
    edges.set(`${pool.tokenA}:${pool.tokenB}:${pool.id}`, -Math.log(price * (1 - feeTier)));

    // B→A direction (inverse price)
    const baKey = pool.tokenB;
    if (!nodes.has(baKey)) nodes.set(baKey, []);
    nodes
      .get(baKey)!
      .push({ ...node, tokenA: pool.tokenB, tokenB: pool.tokenA, spotPrice: 1 / price });
    edges.set(`${pool.tokenB}:${pool.tokenA}:${pool.id}`, -Math.log((1 / price) * (1 - feeTier)));
  }

  const graph = { nodes, edges };
  await cacheSet(cacheKey, graph, 1); // 1 second TTL for real-time
  return graph;
}

// ─── Bellman-Ford Negative Cycle Detection (arbitrage = negative log-price cycle) ───

interface ArbitrageCycle {
  path: string[]; // token addresses in cycle
  poolIds: string[];
  dexNames: string[];
  profitMultiplier: number; // e.g. 1.008 = 0.8% profit
}

export function detectNegativeCycles(graph: PriceGraph, maxHops = 5): ArbitrageCycle[] {
  const tokens = Array.from(graph.nodes.keys());
  const cycles: ArbitrageCycle[] = [];
  const seen = new Set<string>();

  for (const startToken of tokens) {
    // Bellman-Ford from startToken
    const dist = new Map<string, number>();
    const prev = new Map<string, { token: string; poolId: string; dex: string }>();

    for (const t of tokens) dist.set(t, Infinity);
    dist.set(startToken, 0);

    for (let i = 0; i < tokens.length - 1; i++) {
      for (const [edgeKey, weight] of graph.edges) {
        const [from, to, poolId] = edgeKey.split(':');
        const d = dist.get(from);
        if (d === undefined || d === Infinity) continue;
        const newDist = d + weight;
        if (newDist < (dist.get(to) ?? Infinity)) {
          dist.set(to, newDist);
          const pools = Array.from(graph.nodes.get(from) ?? []);
          const node = pools.find((n) => n.poolId === poolId);
          prev.set(to, { token: from, poolId, dex: node?.dexName ?? '' });
        }
      }
    }

    // Check for negative cycles via Nth-pass relaxation (standard Bellman-Ford)
    for (const [edgeKey, weight] of graph.edges) {
      const [from, to, poolId] = edgeKey.split(':');
      const df = dist.get(from) ?? Infinity;
      const dt = dist.get(to) ?? Infinity;
      if (df + weight < dt && to === startToken && df !== Infinity) {
        // Reconstruct cycle path in forward order
        const reverseNodes: string[] = [];
        const poolIds: string[] = [];
        const dexNames: string[] = [];

        let cur = from;
        let safetyNet = 0;
        while (cur !== startToken && safetyNet < maxHops) {
          reverseNodes.push(cur);
          const p = prev.get(cur);
          if (!p) break;
          poolIds.push(p.poolId);
          dexNames.push(p.dex);
          cur = p.token;
          safetyNet++;
        }
        const path = [startToken, ...reverseNodes.reverse()];
        poolIds.push(poolId);
        const node = Array.from(graph.nodes.get(from) ?? []).find((n) => n.poolId === poolId);
        dexNames.push(node?.dexName ?? '');

        const cycleKey = [...path].sort().join('-');
        if (!seen.has(cycleKey)) {
          seen.add(cycleKey);
          const totalLogCost = poolIds.reduce((acc, pid, idx) => {
            const tk = path[idx];
            const tkNext = path[idx + 1] ?? path[0];
            const w = graph.edges.get(`${tk}:${tkNext}:${pid}`) ?? 0;
            return acc + w;
          }, 0);
          const profitMultiplier = Math.exp(-totalLogCost);
          if (profitMultiplier > 1.0001) {
            cycles.push({ path, poolIds, dexNames, profitMultiplier });
          }
        }
      }
    }
  }

  return cycles.sort((a, b) => b.profitMultiplier - a.profitMultiplier);
}

// ─── Direct Arbitrage Detection ───────────────────────────────────────────────

export interface DirectArbitrageResult {
  pair: string;
  tokenA: string;
  tokenB: string;
  buyPool: {
    id: string;
    dexName: string;
    contractAddress: string;
    price: number;
    liquidity: number;
  };
  sellPool: {
    id: string;
    dexName: string;
    contractAddress: string;
    price: number;
    liquidity: number;
  };
  profitPercentage: number;
  confidence: number;
}

export async function detectDirectArbitrage(minProfitPct = 0.1): Promise<DirectArbitrageResult[]> {
  const cacheKey = `arb:direct:${minProfitPct}`;
  const cached = await cacheGet<DirectArbitrageResult[]>(cacheKey);
  if (cached) return cached;

  // Find token pairs present on multiple DEXes
  const pools = await prismaRead.dexPool.findMany({
    where: { isActive: true },
    include: { poolPrices: { orderBy: { timestamp: 'desc' }, take: 1 } },
  });

  // Group by canonical pair (sorted token addresses)
  const pairMap = new Map<string, typeof pools>();
  for (const pool of pools) {
    if (!pool.poolPrices[0]) continue;
    const [ta, tb] = [pool.tokenA, pool.tokenB].sort();
    const key = `${ta}:${tb}`;
    if (!pairMap.has(key)) pairMap.set(key, []);
    pairMap.get(key)!.push(pool);
  }

  const results: DirectArbitrageResult[] = [];

  for (const [pairKey, pairPools] of pairMap) {
    if (pairPools.length < 2) continue;
    const [tokenA, tokenB] = pairKey.split(':');

    // Compare all pairs of pools
    for (let i = 0; i < pairPools.length; i++) {
      for (let j = i + 1; j < pairPools.length; j++) {
        const pA = pairPools[i];
        const pB = pairPools[j];
        const priceA = Number(pA.poolPrices[0].spotPrice);
        const priceB = Number(pB.poolPrices[0].spotPrice);
        if (priceA <= 0 || priceB <= 0) continue;

        const deviation = (Math.abs(priceA - priceB) / Math.min(priceA, priceB)) * 100;
        if (deviation < minProfitPct) continue;

        // Buy from cheaper, sell to more expensive
        const [buyPool, sellPool, buyPrice, sellPrice] =
          priceA < priceB ? [pA, pB, priceA, priceB] : [pB, pA, priceB, priceA];

        const feeCost =
          (Number(buyPool.feeTier ?? 0.003) + Number(sellPool.feeTier ?? 0.003)) * 100;
        const netProfit = deviation - feeCost;
        if (netProfit < minProfitPct) continue;

        const symA = buyPool.tokenASymbol ?? tokenA.slice(0, 8);
        const symB = buyPool.tokenBSymbol ?? tokenB.slice(0, 8);

        results.push({
          pair: `${symA}/${symB}`,
          tokenA,
          tokenB,
          buyPool: {
            id: buyPool.id,
            dexName: buyPool.dexName,
            contractAddress: buyPool.contractAddress,
            price: buyPrice,
            liquidity: Number(buyPool.totalLiquidity ?? 0),
          },
          sellPool: {
            id: sellPool.id,
            dexName: sellPool.dexName,
            contractAddress: sellPool.contractAddress,
            price: sellPrice,
            liquidity: Number(sellPool.totalLiquidity ?? 0),
          },
          profitPercentage: netProfit,
          confidence: Math.min(0.99, 0.5 + (netProfit / 2) * 0.1),
        });
      }
    }
  }

  results.sort((a, b) => b.profitPercentage - a.profitPercentage);
  await cacheSet(cacheKey, results, 1);
  return results;
}

// ─── MEV Scoring ──────────────────────────────────────────────────────────────

export function computeMevScore(params: {
  profitPercentage: number;
  capitalRequired: number;
  hops: number;
  liquidityBuyPool: number;
  liquiditySellPool: number;
  competingBotCount?: number;
}): MevScore {
  const {
    profitPercentage,
    capitalRequired,
    hops,
    liquidityBuyPool,
    liquiditySellPool,
    competingBotCount = 3,
  } = params;

  // Profitability (30%): scale 0-100 based on profit %
  const profitabilityScore = Math.min(100, profitPercentage * 20);

  // Capital efficiency (20%): profit per unit of capital
  const capitalEfficiency = capitalRequired > 0 ? profitPercentage / 100 : 0;

  // Speed requirement (20%): based on hops — more hops = more time needed
  const speedRequirement: MevScore['speedRequirement'] =
    hops === 1 ? 'immediate' : hops === 2 ? 'fast' : hops === 3 ? 'moderate' : 'slow';
  const speedScore = hops === 1 ? 100 : hops === 2 ? 80 : hops === 3 ? 60 : 40;

  // Competition (15%): inverse of competing bots
  const competitionLevel: MevScore['competitionLevel'] =
    competingBotCount <= 1
      ? 'low'
      : competingBotCount <= 3
        ? 'medium'
        : competingBotCount <= 7
          ? 'high'
          : 'extreme';
  const competitionScore = Math.max(0, 100 - competingBotCount * 12);

  // Slippage risk (10%): based on capital vs pool liquidity
  const minLiquidity = Math.min(liquidityBuyPool, liquiditySellPool);
  const slippageRisk = minLiquidity > 0 ? Math.min(100, (capitalRequired / minLiquidity) * 50) : 50;

  // Frontrunning risk (5%): high-profit opportunities attract frontrunners
  const frontrunningRisk = Math.min(100, profitPercentage * 10);

  const overallScore = Math.round(
    profitabilityScore * 0.3 +
      capitalEfficiency * 1000 * 0.2 +
      speedScore * 0.2 +
      competitionScore * 0.15 +
      (100 - slippageRisk) * 0.1 +
      (100 - frontrunningRisk) * 0.05,
  );

  const recommendation: MevScore['recommendation'] =
    overallScore >= 70 ? 'execute_immediately' : overallScore >= 40 ? 'monitor' : 'skip';

  return {
    overallScore: Math.min(100, Math.max(0, overallScore)),
    profitabilityScore: Math.round(profitabilityScore),
    capitalEfficiency,
    speedRequirement,
    competitionLevel,
    slippageRisk: Math.round(slippageRisk) / 100,
    frontrunningRisk: Math.round(frontrunningRisk) / 100,
    recommendation,
  };
}

// ─── Execution Simulation ─────────────────────────────────────────────────────

export async function simulateExecution(params: {
  opportunityId: string;
  capital: number;
  capitalToken: string;
  slippageTolerance: number;
  deadlineBlocks: number;
}): Promise<SimulationResult> {
  const { opportunityId, capital, slippageTolerance, deadlineBlocks } = params;

  const opp = await prismaRead.arbitrageOpportunity.findUnique({
    where: { id: opportunityId },
    include: {
      buyPool: true,
      sellPool: true,
      mevScore: true,
    },
  });
  if (!opp) throw new Error(`Opportunity ${opportunityId} not found`);

  const route = opp.route as RouteStep[];
  const profitPct = Number(opp.profitPercentage) / 100;
  const grossProfit = capital * profitPct;
  const estimatedGas = 0.5; // 0.5 XLM estimated gas per arb tx
  const netProfit = grossProfit - estimatedGas;
  const roi = ((netProfit / capital) * 100).toFixed(4);

  // Build execution plan from route
  const steps: SimulationStep[] = route.map((step, idx) => {
    const amountIn = idx === 0 ? capital.toString() : 'prev_output';
    const priceImpact =
      (capital /
        Math.max(
          1,
          Number(idx === 0 ? opp.buyPool?.totalLiquidity : opp.sellPool?.totalLiquidity) ?? 100000,
        )) *
      100;
    return {
      step: idx + 1,
      action: step.action,
      dex: step.dex,
      tokenIn: step.tokenIn,
      tokenOut: step.tokenOut,
      amountIn,
      expectedOut: step.expectedOutput,
      estimatedPriceImpact: `${Math.min(99, priceImpact).toFixed(3)}%`,
    };
  });

  const slippageRiskLabel =
    slippageTolerance < 0.003 ? 'low' : slippageTolerance < 0.01 ? 'medium' : 'high';
  const frRisk = Number(opp.mevScore?.frontrunningRisk ?? 0.05);
  const frontrunningRiskLabel = frRisk < 0.2 ? 'low' : frRisk < 0.5 ? 'medium' : 'high';

  return {
    opportunityId,
    profitability: {
      grossProfit: grossProfit.toFixed(2),
      estimatedGas: estimatedGas.toFixed(2),
      netProfit: netProfit.toFixed(2),
      roi: `${roi}%`,
    },
    executionPlan: { steps },
    riskAssessment: {
      slippageRisk: slippageRiskLabel,
      frontrunningRisk: frontrunningRiskLabel,
      executionRisk: opp.type === 'direct' ? 'low' : 'medium',
      recommendedGasPrice: '0.0001',
      estimatedBlocksToExecute: Math.min(deadlineBlocks, opp.type === 'direct' ? 1 : 2),
    },
    alternativeRoutes: [],
  };
}

export async function simulateCustomRoute(
  route: Array<{
    dex: string;
    poolId: string;
    action: string;
    token: string;
    amount?: string;
  }>,
): Promise<SimulationResult & { customRoute: boolean }> {
  const totalCapital = parseFloat(route[0]?.amount ?? '0');
  const profitEstimate = totalCapital * 0.005; // 0.5% default estimate for custom

  const steps: SimulationStep[] = route.map((r, idx) => ({
    step: idx + 1,
    action: r.action,
    dex: r.dex,
    tokenIn: r.token,
    tokenOut: 'unknown',
    amountIn: r.amount ?? 'auto',
    expectedOut: idx === route.length - 1 ? (totalCapital + profitEstimate).toFixed(2) : 'auto',
    estimatedPriceImpact: '0.050%',
  }));

  return {
    opportunityId: 'custom',
    customRoute: true,
    profitability: {
      grossProfit: profitEstimate.toFixed(2),
      estimatedGas: '0.50',
      netProfit: (profitEstimate - 0.5).toFixed(2),
      roi: `${((profitEstimate / totalCapital) * 100).toFixed(4)}%`,
    },
    executionPlan: { steps },
    riskAssessment: {
      slippageRisk: 'medium',
      frontrunningRisk: 'low',
      executionRisk: 'medium',
      recommendedGasPrice: '0.0001',
      estimatedBlocksToExecute: 2,
    },
    alternativeRoutes: [],
  };
}

// ─── Opportunity Persistence ──────────────────────────────────────────────────

export async function persistOpportunity(
  direct: DirectArbitrageResult,
  capital: number = 10000,
): Promise<string> {
  const mevParams = {
    profitPercentage: direct.profitPercentage,
    capitalRequired: capital,
    hops: 1,
    liquidityBuyPool: direct.buyPool.liquidity,
    liquiditySellPool: direct.sellPool.liquidity,
  };
  const score = computeMevScore(mevParams);

  const route: RouteStep[] = [
    {
      action: 'buy',
      dex: direct.buyPool.dexName,
      poolId: direct.buyPool.id,
      tokenIn: direct.tokenB,
      tokenOut: direct.tokenA,
      expectedOutput: (capital / direct.buyPool.price).toFixed(2),
      priceImpact: '0.02%',
    },
    {
      action: 'sell',
      dex: direct.sellPool.dexName,
      poolId: direct.sellPool.id,
      tokenIn: direct.tokenA,
      tokenOut: direct.tokenB,
      expectedOutput: (capital * (1 + direct.profitPercentage / 100)).toFixed(2),
      priceImpact: '0.05%',
    },
  ];

  const profitEstimate = BigInt(Math.round(capital * (direct.profitPercentage / 100) * 1e7));
  const capitalRequired = BigInt(Math.round(capital * 1e7));

  const opp = await prismaWrite.arbitrageOpportunity.create({
    data: {
      pair: direct.pair,
      tokenA: direct.tokenA,
      tokenB: direct.tokenB,
      type: 'direct',
      buyPoolId: direct.buyPool.id,
      sellPoolId: direct.sellPool.id,
      buyPrice: direct.buyPool.price,
      sellPrice: direct.sellPool.price,
      profitPercentage: direct.profitPercentage,
      profitEstimate,
      capitalRequired,
      confidence: direct.confidence,
      route: route as unknown as Prisma.InputJsonValue,
      status: 'active',
      detectedAt: new Date(),
      expiredAt: new Date(Date.now() + 30000), // 30s TTL
    },
  });

  await prismaWrite.mevOpportunityScore.create({
    data: {
      opportunityId: opp.id,
      profitabilityScore: score.profitabilityScore,
      capitalEfficiency: score.capitalEfficiency,
      speedRequirement: score.speedRequirement,
      competitionLevel: score.competitionLevel,
      slippageRisk: score.slippageRisk,
      frontrunningRisk: score.frontrunningRisk,
      overallScore: score.overallScore,
      recommendation: score.recommendation,
    },
  });

  return opp.id;
}

/** Expire stale opportunities older than TTL. */
export async function expireStaleOpportunities(): Promise<number> {
  const result = await prismaWrite.arbitrageOpportunity.updateMany({
    where: {
      status: 'active',
      expiredAt: { lte: new Date() },
    },
    data: { status: 'expired' },
  });
  return result.count;
}

// ─── Bot Detection & Profiling ────────────────────────────────────────────────

export async function detectAndUpdateBots(): Promise<void> {
  // Find accounts with high-frequency swap patterns that look like bots
  const swapAccounts = await prismaRead.transaction.groupBy({
    by: ['sourceAccount'],
    where: {
      functionName: { contains: 'swap', mode: 'insensitive' },
      ledgerCloseTime: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    },
    _count: { id: true },
    having: { id: { _count: { gte: 10 } } }, // 10+ swaps in 24h = bot candidate
    orderBy: { _count: { id: 'desc' } },
    take: 100,
  });

  for (const acct of swapAccounts) {
    const addr = acct.sourceAccount;
    const txCount = acct._count.id;

    // Calculate success rate
    const [success, total] = await Promise.all([
      prismaRead.transaction.count({
        where: {
          sourceAccount: addr,
          status: 'success',
          functionName: { contains: 'swap', mode: 'insensitive' },
        },
      }),
      prismaRead.transaction.count({
        where: { sourceAccount: addr, functionName: { contains: 'swap', mode: 'insensitive' } },
      }),
    ]);

    const successRate = total > 0 ? success / total : 0;
    const tags: string[] = [];
    if (txCount > 100) tags.push('high_frequency');
    if (successRate > 0.9) tags.push('sophisticated');
    if (txCount > 500) tags.push('ultra_high_frequency');

    await prismaWrite.arbitrageBot.upsert({
      where: { address: addr },
      create: {
        address: addr,
        firstSeen: new Date(Date.now() - 24 * 60 * 60 * 1000),
        lastSeen: new Date(),
        totalTrades: txCount,
        successfulTrades: success,
        failedTrades: txCount - success,
        successRate,
        tags,
        isActive: true,
      },
      update: {
        lastSeen: new Date(),
        totalTrades: { increment: txCount },
        successfulTrades: { increment: success },
        failedTrades: { increment: txCount - success },
        successRate,
        tags,
        isActive: true,
      },
    });
  }
}

export async function inferBotStrategy(address: string) {
  const bot = await prismaRead.arbitrageBot.findUnique({ where: { address } });
  if (!bot) return null;

  const recentTxs = await prismaRead.transaction.findMany({
    where: { sourceAccount: address, functionName: { contains: 'swap', mode: 'insensitive' } },
    orderBy: { ledgerCloseTime: 'desc' },
    take: 200,
    select: { contractAddress: true, feeCharged: true, ledgerCloseTime: true },
  });

  const dexCounts = new Map<string, number>();
  const fees: number[] = [];
  const hours = new Array(24).fill(0);

  for (const tx of recentTxs) {
    if (tx.contractAddress) {
      dexCounts.set(tx.contractAddress, (dexCounts.get(tx.contractAddress) ?? 0) + 1);
    }
    if (tx.feeCharged) fees.push(parseFloat(tx.feeCharged));
    hours[tx.ledgerCloseTime.getUTCHours()]++;
  }

  const topDexs = [...dexCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([addr]) => addr);
  const avgGas = fees.length > 0 ? fees.reduce((a, b) => a + b, 0) / fees.length : 0;
  const maxGas = fees.length > 0 ? Math.max(...fees) : 0;

  // Find most active hours
  const maxCount = Math.max(...hours);
  const activeHours = hours.reduce((acc: string[], count, h) => {
    if (count > maxCount * 0.5) acc.push(`${h.toString().padStart(2, '0')}:00`);
    return acc;
  }, []);

  return {
    address,
    inferredStrategy: {
      type: 'cross_dex_arbitrage',
      targetPairs: bot.preferredPairs,
      targetDexs: topDexs,
      avgHoldTime: '1 block',
      capitalRange: {
        min: Number(bot.avgCapitalPerTrade ?? 0) * 0.5,
        max: Number(bot.avgCapitalPerTrade ?? 0) * 2,
        avg: Number(bot.avgCapitalPerTrade ?? 0),
      },
      gasBidding: {
        strategy: avgGas > 0.0003 ? 'aggressive' : 'moderate',
        avgGasPrice: avgGas.toFixed(4),
        maxGasPrice: maxGas.toFixed(4),
      },
      activeHours,
    },
    strategySignature: `0x${Buffer.from(address + bot.totalTrades)
      .toString('hex')
      .slice(0, 16)}`,
  };
}

// ─── Sandwich Attack Detection ────────────────────────────────────────────────

export async function detectSandwichAttacks(ledgerSeq: number): Promise<void> {
  const txs = await prismaRead.transaction.findMany({
    where: { ledgerSequence: ledgerSeq },
    include: { events: true },
    orderBy: { id: 'asc' },
  });

  const swapTxs = txs.filter(
    (tx) =>
      tx.functionName?.toLowerCase().includes('swap') ||
      tx.events.some((e) => e.eventType === 'swap'),
  );

  const byContract = new Map<string, typeof swapTxs>();
  for (const tx of swapTxs) {
    if (!tx.contractAddress) continue;
    const list = byContract.get(tx.contractAddress) ?? [];
    list.push(tx);
    byContract.set(tx.contractAddress, list);
  }

  for (const [contractAddress, txList] of byContract) {
    if (txList.length < 3) continue;

    for (let i = 0; i + 2 < txList.length; i++) {
      const front = txList[i];
      const victim = txList[i + 1];
      const back = txList[i + 2];

      if (
        front.sourceAccount === back.sourceAccount &&
        front.sourceAccount !== victim.sourceAccount
      ) {
        // Estimate victim slippage based on fee events
        const victimFee = parseFloat(victim.feeCharged ?? '0.001');
        const slippagePct = victimFee * 1000; // rough estimate

        // Look up pool info
        const pool = await prismaRead.dexPool.findFirst({
          where: { contractAddress },
        });

        await prismaWrite.sandwichAttack.upsert({
          where: {
            // Use a composite unique via raw check to avoid duplicates
            id: `${front.hash.slice(0, 8)}-${victim.hash.slice(0, 8)}-${back.hash.slice(0, 8)}`,
          },
          create: {
            id: `${front.hash.slice(0, 8)}-${victim.hash.slice(0, 8)}-${back.hash.slice(0, 8)}`,
            pair: pool
              ? `${pool.tokenASymbol ?? pool.tokenA.slice(0, 6)}/${pool.tokenBSymbol ?? pool.tokenB.slice(0, 6)}`
              : 'UNKNOWN',
            dex: pool?.dexName ?? contractAddress.slice(0, 12),
            victimTx: victim.hash,
            victimAddress: victim.sourceAccount,
            victimSlippage: slippagePct,
            victimLoss: BigInt(Math.round(slippagePct * 100)),
            attackerAddress: front.sourceAccount,
            attackerProfit: BigInt(Math.round(slippagePct * 90)),
            frontRunTx: front.hash,
            backRunTx: back.hash,
            blockNumber: BigInt(ledgerSeq),
            timestamp: victim.ledgerCloseTime,
          },
          update: {},
        });
      }
    }
  }
}

// ─── Market Analytics ─────────────────────────────────────────────────────────

export async function getMarketAnalytics() {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [current, last24h, byPairRaw, byDexRaw, sandwichStats] = await Promise.all([
    // Current active opportunities
    prismaRead.arbitrageOpportunity.aggregate({
      where: { status: 'active' },
      _count: { id: true },
      _avg: { profitPercentage: true },
    }),
    // Last 24h stats
    prismaRead.arbitrageOpportunity.groupBy({
      by: ['status'],
      where: { detectedAt: { gte: since24h } },
      _count: { id: true },
    }),
    // By pair
    prismaRead.arbitrageOpportunity.groupBy({
      by: ['pair'],
      where: { detectedAt: { gte: since24h } },
      _count: { id: true },
      _avg: { profitPercentage: true },
      orderBy: { _count: { id: 'desc' } },
      take: 10,
    }),
    // By DEX (buy side)
    prismaRead.dexPool.findMany({
      where: { isActive: true },
      select: { dexName: true, id: true },
      distinct: ['dexName'],
    }),
    // Sandwich stats
    prismaRead.sandwichAttack.aggregate({
      where: { timestamp: { gte: since24h } },
      _count: { id: true },
      _sum: { victimLoss: true, attackerProfit: true },
      _max: { victimLoss: true },
    }),
  ]);

  const totalOpps24h = last24h.reduce((acc, r) => acc + r._count.id, 0);
  const executedOpps = last24h.find((r) => r.status === 'executed')?._count.id ?? 0;

  const avgScoreRes = await prismaRead.mevOpportunityScore.aggregate({
    _avg: { overallScore: true },
    _max: { overallScore: true },
  });

  const byPair = byPairRaw.map((r) => ({
    pair: r.pair,
    opportunities: r._count.id,
    avgProfit: Number(r._avg.profitPercentage ?? 0),
    competition: r._count.id > 500 ? 'high' : r._count.id > 200 ? 'medium' : 'low',
  }));

  return {
    current: {
      totalOpportunities: current._count.id,
      avgProfitability: Number(current._avg.profitPercentage ?? 0),
      totalMEVScores: {
        avg: Number(avgScoreRes._avg.overallScore ?? 0),
        max: Number(avgScoreRes._max.overallScore ?? 0),
      },
    },
    last24h: {
      totalOpportunities: totalOpps24h,
      executedOpportunities: executedOpps,
      totalBotProfit: '0',
      avgOpportunityLifetime: '3.5s',
    },
    byPair,
    byDex: byDexRaw.map((d) => ({
      name: d.dexName,
      opportunitiesAsBuySide: 0,
      opportunitiesAsSellSide: 0,
      inefficiencyScore: 0.15,
    })),
    sandwichStats24h: {
      totalSandwiches: sandwichStats._count.id,
      totalVictimLoss: sandwichStats._sum.victimLoss?.toString() ?? '0',
      totalAttackerProfit: sandwichStats._sum.attackerProfit?.toString() ?? '0',
      worstSingleVictimLoss: sandwichStats._max.victimLoss?.toString() ?? '0',
    },
    efficiencyMetrics: {
      overallMarketEfficiency: 0.92,
      avgDeviationBeforeCorrection: 0.35,
      avgTimeToCorrection: '2.3s',
    },
  };
}

// ─── Historical Replay ────────────────────────────────────────────────────────

export async function replayBlock(
  blockNumber: number,
  capital: number = 10000,
  minProfit: number = 0.1,
) {
  const txs = await prismaRead.transaction.findMany({
    where: { ledgerSequence: blockNumber },
    include: { events: true },
  });

  const missed: Array<{
    pair: string;
    type: string;
    profitPercentage: number;
    route: unknown[];
    capital: number;
    estimatedProfit: number;
  }> = [];

  // Simulate what arbitrage could have been done at this block
  const swapEvents = txs.flatMap((tx) =>
    tx.events.filter((e) => e.eventType === 'swap').map((e) => ({ tx, event: e })),
  );

  const tokenPairPrices = new Map<string, number[]>();
  for (const { event } of swapEvents) {
    const d = event.decoded as Record<string, unknown> | null;
    if (!d) continue;
    const tokenIn = String(d.token_in ?? d.tokenIn ?? '');
    const tokenOut = String(d.token_out ?? d.tokenOut ?? '');
    const amtIn = parseFloat(String(d.amount_in ?? d.amountIn ?? '0'));
    const amtOut = parseFloat(String(d.amount_out ?? d.amountOut ?? '0'));
    if (amtIn > 0 && amtOut > 0) {
      const price = amtOut / amtIn;
      const key = [tokenIn, tokenOut].sort().join(':');
      if (!tokenPairPrices.has(key)) tokenPairPrices.set(key, []);
      tokenPairPrices.get(key)!.push(price);
    }
  }

  for (const [pair, prices] of tokenPairPrices) {
    if (prices.length < 2) continue;
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const deviation = ((max - min) / min) * 100;
    if (deviation < minProfit) continue;

    missed.push({
      pair: pair.replace(':', '/').slice(0, 20),
      type: 'direct',
      profitPercentage: deviation,
      route: [],
      capital,
      estimatedProfit: (capital * deviation) / 100,
    });
  }

  return {
    blockNumber,
    missedOpportunities: missed.sort((a, b) => b.profitPercentage - a.profitPercentage),
    totalMissed: missed.length,
    totalMissedProfit: missed.reduce((acc, m) => acc + m.estimatedProfit, 0).toFixed(2),
  };
}
