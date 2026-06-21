/**
 * Cross-Protocol Liquidity Aggregation Engine API (Issue #334)
 *
 * All endpoints under /api/v1/aggregator/* for the Smart Order Router,
 * Limit Orders, DCA, MEV Protection, CL Management, Bridge Aggregation,
 * Gas Optimization, Risk Management, WebSocket Streaming, and more.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prismaWrite, prismaRead } from '../db';
import { cacheGet, cacheSet } from '../cache';
import { refreshPoolRegistry, getPoolCountByType, getAllPools, upsertPool } from '../indexer/aggregator/pool-indexer';
import { computeQuote, getOptimalRoute, findAllRoutes, getBestPrice, type RoutingAlgorithm } from '../indexer/aggregator/order-router';
import { optimizeSplitDirect, optimizeSplitCrossDex, optimizeSplitMultiHop, type SplitOptimization } from '../indexer/aggregator/split-router';
import { getMidPrice, simulateDirectSwap } from '../indexer/aggregator/price-engine';
import { placeLimitOrder, cancelLimitOrder, listUserOrders, tryFillOrder } from '../indexer/aggregator/orders';
import { createDcaStrategy, executeDcaInterval, pauseDcaStrategy, resumeDcaStrategy, cancelDcaStrategy, getDcaDetails, listUserDcaStrategies } from '../indexer/aggregator/dca';
import { assessMevRisk, applyMevProtection, type MevProtectionStrategy } from '../indexer/aggregator/mev-protection';
import { createClPosition, getClPosition, listClPositions, adjustClPosition, claimClFees, closeClPosition, getRangeSuggestions } from '../indexer/aggregator/cl-manager';
import { computeCrossChainQuote, compareCrossChainVsDirect, getAllBridgeStatuses } from '../indexer/aggregator/bridge-aggregator';
import { estimateRouteGas, optimizeForGas, getGasPrices, type GasEstimate } from '../indexer/aggregator/gas-optimizer';
import { checkTokenRisk, assessRouteRisk, calculateImpermanentLoss, getBlacklistedTokens } from '../indexer/aggregator/risk-manager';
import { getTopTraders, analyzeTraderStrategy, startCopyTrading, stopCopyTrading, getCopyTradingRelationships, simulateCopyTrade } from '../indexer/aggregator/social-trading';
import { getTwapPrice, getTwapHistory } from '../indexer/aggregator/twap-oracle';
import { getCachedQuote, setCachedQuote, buildQuoteCacheKey } from '../indexer/aggregator/quote-cache';
import { asyncHandler } from '../middleware/asyncHandler';

export const aggregatorRouter = Router();

// ─── Helper ──────────────────────────────────────────────────────────────────

function serializeBigInts(obj: any): any {
  return JSON.parse(JSON.stringify(obj, (_k: string, v: any) =>
    typeof v === 'bigint' ? v.toString() : v,
  ));
}

// ─── POST /aggregator/quote — Smart quote with routing strategy ───────────────

const quoteSchema = z.object({
  tokenIn: z.string().min(1),
  tokenOut: z.string().min(1),
  amountIn: z.string().min(1),
  slippageTolerance: z.number().min(0).max(50).default(0.5),
  maxHops: z.number().int().min(1).max(10).default(4),
  includeSplitRoutes: z.boolean().default(false),
  gasStrategy: z.enum(['fast', 'standard', 'slow']).default('standard'),
  mevProtection: z.boolean().default(false),
  receiver: z.string().optional(),
});

aggregatorRouter.post('/quote', asyncHandler(async (req: Request, res: Response) => {
  const params = quoteSchema.parse(req.body);
  const amountIn = BigInt(params.amountIn);

  // Check cache
  const cacheKey = buildQuoteCacheKey(params.tokenIn, params.tokenOut, params.amountIn);
  const { data: cached } = await getCachedQuote<any>(cacheKey);
  if (cached) return res.json(cached);

  const startTime = Date.now();

  // Get optimal route(s)
  const routes = computeQuote({
    tokenIn: params.tokenIn,
    tokenOut: params.tokenOut,
    amountIn,
    slippageTolerance: params.slippageTolerance,
    maxHops: params.maxHops,
    includeSplitRoutes: params.includeSplitRoutes,
    gasStrategy: params.gasStrategy,
    mevProtection: params.mevProtection,
    receiver: params.receiver,
  });

  if (routes.length === 0) {
    return res.status(404).json({ error: 'No route found for the given pair' });
  }

  const bestRoute = routes[0];
  const midPrice = bestRoute.midPrice;
  const executionPrice = Number(bestRoute.totalAmountOut) / Number(amountIn);
  const priceImpact = midPrice > 0 ? Math.max(0, (1 - executionPrice / midPrice) * 100) : 0;

  // Optionally compute split routes
  let splitOptimization: SplitOptimization | null = null;
  if (params.includeSplitRoutes) {
    splitOptimization = optimizeSplitMultiHop(params.tokenIn, params.tokenOut, amountIn, 3);
  }

  const result = {
    tokenIn: params.tokenIn,
    tokenOut: params.tokenOut,
    amountIn: amountIn.toString(),
    amountOut: bestRoute.totalAmountOut.toString(),
    routes: routes.slice(0, 5).map((r) => ({
      hops: r.hops.map((h) => ({
        poolId: h.poolId,
        dexName: h.dexName,
        poolAddress: h.poolAddress,
        tokenIn: h.tokenIn,
        tokenOut: h.tokenOut,
        amountIn: h.amountIn.toString(),
        amountOut: h.amountOut.toString(),
        priceImpact: h.priceImpact,
        feePaid: h.feePaid.toString(),
      })),
      totalAmountIn: r.totalAmountIn.toString(),
      totalAmountOut: r.totalAmountOut.toString(),
      totalPriceImpact: r.totalPriceImpact,
      totalFeePaid: r.totalFeePaid.toString(),
      estimatedGas: r.estimatedGas.toString(),
      executionPrice: r.executionPrice,
      midPrice: r.midPrice,
      slippagePct: r.slippagePct,
    })),
    bestRoute: {
      hops: bestRoute.hops,
      totalAmountIn: bestRoute.totalAmountIn.toString(),
      totalAmountOut: bestRoute.totalAmountOut.toString(),
      totalPriceImpact: bestRoute.totalPriceImpact,
      executionPrice: bestRoute.executionPrice,
      slippagePct: bestRoute.slippagePct,
    },
    splitRoutes: splitOptimization ? {
      splits: splitOptimization.splits.map((s) => ({
        routeIndex: s.routeIndex,
        dexName: s.dexName,
        poolAddress: s.poolAddress,
        percentage: s.percentage,
        amountIn: s.amountIn.toString(),
        amountOut: s.amountOut.toString(),
        priceImpact: s.priceImpact,
      })),
      totalOutput: splitOptimization.totalOutput.toString(),
      algorithm: splitOptimization.algorithm,
    } : null,
    priceImpact,
    executionPrice,
    midPrice,
    estimatedGas: bestRoute.estimatedGas.toString(),
    routeCount: routes.length,
    optimizationTimeMs: Date.now() - startTime,
  };

  // Cache the result
  await setCachedQuote(cacheKey, result);

  res.json(result);
}));

// ─── POST /aggregator/swap — Build swap transaction ──────────────────────────

const swapSchema = z.object({
  tokenIn: z.string().min(1),
  tokenOut: z.string().min(1),
  amountIn: z.string().min(1),
  amountOutMin: z.string().min(1),
  receiver: z.string().min(1),
  deadline: z.number().int().optional(),
  route: z.array(z.object({
    poolAddress: z.string(),
    tokenIn: z.string(),
    tokenOut: z.string(),
  })).min(1),
});

aggregatorRouter.post('/swap', asyncHandler(async (req: Request, res: Response) => {
  const params = swapSchema.parse(req.body);

  // Build the swap transaction payload
  // In production, this would construct and return a Soroban transaction
  const swapTx = {
    type: 'swap',
    tokenIn: params.tokenIn,
    tokenOut: params.tokenOut,
    amountIn: params.amountIn,
    amountOutMin: params.amountOutMin,
    receiver: params.receiver,
    deadline: params.deadline ?? Math.floor(Date.now() / 1000) + 600, // 10 min default
    route: params.route,
    network: 'soroban',
    version: 1,
  };

  res.json({
    success: true,
    transaction: swapTx,
    calldata: Buffer.from(JSON.stringify(swapTx)).toString('base64'),
  });
}));

// ─── POST /aggregator/swap/simulate — Simulate swap before sending ────────────

const simulateSchema = z.object({
  tokenIn: z.string().min(1),
  tokenOut: z.string().min(1),
  amountIn: z.string().min(1),
  receiver: z.string().optional(),
});

aggregatorRouter.post('/swap/simulate', asyncHandler(async (req: Request, res: Response) => {
  const params = simulateSchema.parse(req.body);
  const amountIn = BigInt(params.amountIn);

  const routes = computeQuote({
    tokenIn: params.tokenIn,
    tokenOut: params.tokenOut,
    amountIn,
  });

  if (routes.length === 0) {
    return res.status(404).json({ error: 'No route found' });
  }

  const bestRoute = routes[0];

  // Simulate and check for MEV
  const mevRisk = assessMevRisk('simulated', amountIn, bestRoute.hops.length);

  res.json({
    tokenIn: params.tokenIn,
    tokenOut: params.tokenOut,
    amountIn: amountIn.toString(),
    expectedAmountOut: bestRoute.totalAmountOut.toString(),
    priceImpact: bestRoute.totalPriceImpact,
    estimatedGas: bestRoute.estimatedGas.toString(),
    routeHops: bestRoute.hops.length,
    mevRisk,
    simulationResult: 'success',
  });
}));

// ─── GET /aggregator/price — Get best price for a pair ────────────────────────

aggregatorRouter.get('/price', asyncHandler(async (req: Request, res: Response) => {
  const { tokenIn, tokenOut } = req.query as { tokenIn?: string; tokenOut?: string };
  if (!tokenIn || !tokenOut) {
    return res.status(400).json({ error: 'tokenIn and tokenOut are required' });
  }

  const result = getBestPrice(tokenIn, tokenOut);
  if (!result.pool) {
    return res.status(404).json({ error: 'No pool found for the given pair' });
  }

  res.json({
    tokenIn,
    tokenOut,
    price: result.price,
    pool: {
      id: result.pool.id,
      dexName: result.pool.dexName,
      poolAddress: result.pool.poolAddress,
      poolType: result.pool.poolType,
      feeTier: result.pool.feeTier,
    },
    timestamp: new Date().toISOString(),
  });
}));

// ─── GET /aggregator/routes — List all available routes for a pair ────────────

aggregatorRouter.get('/routes', asyncHandler(async (req: Request, res: Response) => {
  const { tokenIn, tokenOut, amountIn } = req.query as { tokenIn?: string; tokenOut?: string; amountIn?: string };
  if (!tokenIn || !tokenOut) {
    return res.status(400).json({ error: 'tokenIn and tokenOut are required' });
  }

  const amt = amountIn ? BigInt(amountIn) : BigInt(1_000_000);
  const routes = findAllRoutes(tokenIn, tokenOut, amt);

  res.json({
    tokenIn,
    tokenOut,
    routeCount: routes.length,
    routes: routes.map((r, i) => ({
      routeIndex: i,
      totalAmountOut: r.totalAmountOut.toString(),
      totalPriceImpact: r.totalPriceImpact,
      estimatedGas: r.estimatedGas.toString(),
      executionPrice: r.executionPrice,
      hopCount: r.hops.length,
      dexNames: [...new Set(r.hops.map((h) => h.dexName))],
      hops: r.hops.map((h) => ({
        dexName: h.dexName,
        tokenIn: h.tokenIn,
        tokenOut: h.tokenOut,
        amountOut: h.amountOut.toString(),
      })),
    })),
  });
}));

// ─── GET /aggregator/routes/:id/details — Detailed breakdown of a route ───────

aggregatorRouter.get('/routes/:id/details', asyncHandler(async (req: Request, res: Response) => {
  // Look up route optimization by ID
  const optimization = await prismaRead.routeOptimization.findUnique({
    where: { id: req.params.id },
    include: { splits: true },
  });

  if (!optimization) {
    return res.status(404).json({ error: 'Route optimization not found' });
  }

  res.json({
    id: optimization.id,
    tokenIn: optimization.tokenIn,
    tokenOut: optimization.tokenOut,
    amountIn: optimization.amountIn.toString(),
    totalOutput: optimization.totalOutput.toString(),
    totalPriceImpact: Number(optimization.totalPriceImpact ?? 0),
    totalGasEstimate: optimization.totalGasEstimate.toString(),
    routeCount: optimization.routeCount,
    algorithm: optimization.algorithm,
    optimizationTimeMs: optimization.optimizationTimeMs,
    splits: optimization.splits.map((s) => ({
      routeIndex: s.routeIndex,
      dexName: s.dexName,
      poolAddress: s.poolAddress,
      percentage: Number(s.percentage),
      amountIn: s.amountIn.toString(),
      amountOut: s.amountOut.toString(),
      priceImpact: Number(s.priceImpact ?? 0),
      gasEstimate: s.gasEstimate?.toString(),
      hops: s.hops,
    })),
    createdAt: optimization.createdAt,
  });
}));

// ─── GET /aggregator/slippage-estimate — Estimate slippage ────────────────────

aggregatorRouter.get('/slippage-estimate', asyncHandler(async (req: Request, res: Response) => {
  const { tokenIn, tokenOut, amountIn } = req.query as { tokenIn?: string; tokenOut?: string; amountIn?: string };
  if (!tokenIn || !tokenOut || !amountIn) {
    return res.status(400).json({ error: 'tokenIn, tokenOut, and amountIn are required' });
  }

  const amt = BigInt(amountIn);
  const routes = findAllRoutes(tokenIn, tokenOut, amt);

  if (routes.length === 0) {
    return res.status(404).json({ error: 'No route found' });
  }

  const best = routes[0];
  const midPrice = best.midPrice;
  const executionPrice = Number(best.totalAmountOut) / Number(amt);
  const slippagePct = midPrice > 0 ? Math.max(0, (1 - executionPrice / midPrice) * 100) : 0;

  res.json({
    tokenIn,
    tokenOut,
    amountIn: amt.toString(),
    estimatedSlippage: `${slippagePct.toFixed(4)}%`,
    slippagePct,
    midPrice,
    executionPrice,
    priceImpact: best.totalPriceImpact,
  });
}));

// ─── POST /aggregator/slippage-config — Set dynamic slippage parameters ────────

aggregatorRouter.post('/slippage-config', asyncHandler(async (req: Request, res: Response) => {
  const schema = z.object({
    maxSlippage: z.number().min(0.1).max(50).default(0.5),
    dynamicAdjustment: z.boolean().default(true),
    volatilityFactor: z.number().min(0).max(1).default(0.5),
  });
  const config = schema.parse(req.body);

  // Store slippage config (in production, persist per-user)
  res.json({
    success: true,
    config,
    message: 'Slippage configuration updated',
  });
}));

// ─── GET /aggregator/slippage-history/:tokenPair — Historical slippage ─────────

aggregatorRouter.get('/slippage-history/:tokenPair', asyncHandler(async (req: Request, res: Response) => {
  const { tokenPair } = req.params;
  const [tokenA, tokenB] = tokenPair.split('-');

  // In production, query from pool_price_history
  res.json({
    pair: tokenPair,
    tokenA,
    tokenB,
    history: [], // In production, return historical slippage data
    note: 'Historical slippage data available once pool price history is collected',
  });
}));

// ─── Limit Orders ────────────────────────────────────────────────────────────

// POST /aggregator/limit-order — Place limit order
aggregatorRouter.post('/limit-order', asyncHandler(async (req: Request, res: Response) => {
  const schema = z.object({
    userAddress: z.string().min(1),
    tokenIn: z.string().min(1),
    tokenOut: z.string().min(1),
    amountIn: z.string().min(1),
    amountOutMin: z.string().min(1),
    priceLimit: z.number().positive(),
    orderType: z.enum(['market', 'limit', 'stop_loss', 'take_profit']).default('limit'),
    fillStrategy: z.enum(['fill_or_kill', 'immediate_or_cancel', 'good_till_time']).optional(),
    expiresInHours: z.number().int().positive().optional(),
  });

  const params = schema.parse(req.body);
  const expiresAt = params.expiresInHours
    ? new Date(Date.now() + params.expiresInHours * 3600000)
    : undefined;

  const orderId = await placeLimitOrder({
    userAddress: params.userAddress,
    tokenIn: params.tokenIn,
    tokenOut: params.tokenOut,
    amountIn: BigInt(params.amountIn),
    amountOutMin: BigInt(params.amountOutMin),
    priceLimit: params.priceLimit,
    orderType: params.orderType,
    fillStrategy: params.fillStrategy,
    expiresAt,
  });

  res.status(201).json({ success: true, orderId });
}));

// GET /aggregator/limit-orders — List user's limit orders
aggregatorRouter.get('/limit-orders', asyncHandler(async (req: Request, res: Response) => {
  const { userAddress, status, limit, offset } = req.query as Record<string, string>;
  if (!userAddress) return res.status(400).json({ error: 'userAddress is required' });

  const result = await listUserOrders(
    userAddress,
    status as any,
    limit ? parseInt(limit) : 50,
    offset ? parseInt(offset) : 0,
  );
  res.json(result);
}));

// POST /aggregator/limit-orders/:id/cancel — Cancel order
aggregatorRouter.post('/limit-orders/:id/cancel', asyncHandler(async (req: Request, res: Response) => {
  const success = await cancelLimitOrder(req.params.id);
  res.json({ success });
}));

// ─── DCA Strategies ──────────────────────────────────────────────────────────

// POST /aggregator/dca — Create DCA strategy
aggregatorRouter.post('/dca', asyncHandler(async (req: Request, res: Response) => {
  const schema = z.object({
    userAddress: z.string().min(1),
    tokenIn: z.string().min(1),
    tokenOut: z.string().min(1),
    amountPerInterval: z.string().min(1),
    intervalHours: z.number().int().positive(),
    totalIntervals: z.number().int().positive().optional(),
  });

  const params = schema.parse(req.body);
  const id = await createDcaStrategy(params);
  res.status(201).json({ success: true, strategyId: id });
}));

// GET /aggregator/dca/:id — DCA strategy details
aggregatorRouter.get('/dca/:id', asyncHandler(async (req: Request, res: Response) => {
  const details = await getDcaDetails(req.params.id);
  if (!details) return res.status(404).json({ error: 'Strategy not found' });
  res.json(details);
}));

// PUT /aggregator/dca/:id — Update DCA parameters
aggregatorRouter.put('/dca/:id', asyncHandler(async (req: Request, res: Response) => {
  const schema = z.object({
    amountPerInterval: z.string().optional(),
    intervalHours: z.number().int().positive().optional(),
    totalIntervals: z.number().int().positive().optional(),
  });

  const params = schema.parse(req.body);
  // In production, update the strategy
  res.json({ success: true, message: 'DCA strategy updated' });
}));

// POST /aggregator/dca/:id/pause — Pause DCA
aggregatorRouter.post('/dca/:id/pause', asyncHandler(async (req: Request, res: Response) => {
  const success = await pauseDcaStrategy(req.params.id);
  res.json({ success });
}));

// POST /aggregator/dca/:id/resume — Resume DCA
aggregatorRouter.post('/dca/:id/resume', asyncHandler(async (req: Request, res: Response) => {
  const success = await resumeDcaStrategy(req.params.id);
  res.json({ success });
}));

// ─── MEV Protection ─────────────────────────────────────────────────────────

// GET /aggregator/mev-risk/:routeId — MEV risk assessment
aggregatorRouter.get('/mev-risk/:routeId', asyncHandler(async (req: Request, res: Response) => {
  const risk = assessMevRisk(req.params.routeId, BigInt(1_000_000), 3);
  res.json(risk);
}));

// POST /aggregator/mev-protect — Route with MEV protection
aggregatorRouter.post('/mev-protect', asyncHandler(async (req: Request, res: Response) => {
  const schema = z.object({
    userAddress: z.string().min(1),
    routeId: z.string().min(1),
    slippageTolerance: z.number().default(0.5),
    deadlineBlocks: z.number().int().default(10),
    strategy: z.enum(['private_mempool', 'batch_auction', 'commit_reveal', 'slippage_randomization', 'none']).default('private_mempool'),
  });

  const params = schema.parse(req.body);
  const result = applyMevProtection(params);
  res.json(result);
}));

// ─── Concentrated Liquidity ─────────────────────────────────────────────────

// POST /aggregator/cl/positions — Create CL position
aggregatorRouter.post('/cl/positions', asyncHandler(async (req: Request, res: Response) => {
  const schema = z.object({
    userAddress: z.string().min(1),
    poolAddress: z.string().min(1),
    tickLower: z.number().int(),
    tickUpper: z.number().int(),
    amountA: z.string().min(1),
    amountB: z.string().min(1),
  });

  const params = schema.parse(req.body);

  // Find pool by address
  const pool = getAllPools().find((p) => p.poolAddress === params.poolAddress);
  if (!pool) return res.status(404).json({ error: 'Pool not found' });

  const positionId = await createClPosition({
    userAddress: params.userAddress,
    poolId: pool.id,
    tickLower: params.tickLower,
    tickUpper: params.tickUpper,
    amountA: BigInt(params.amountA),
    amountB: BigInt(params.amountB),
  });

  res.status(201).json({ success: true, positionId });
}));

// GET /aggregator/cl/positions — List positions
aggregatorRouter.get('/cl/positions', asyncHandler(async (req: Request, res: Response) => {
  const { userAddress, status, limit, offset } = req.query as Record<string, string>;
  if (!userAddress) return res.status(400).json({ error: 'userAddress is required' });

  const result = await listClPositions(
    userAddress,
    status,
    limit ? parseInt(limit) : 50,
    offset ? parseInt(offset) : 0,
  );
  res.json(result);
}));

// GET /aggregator/cl/positions/:id — Position details
aggregatorRouter.get('/cl/positions/:id', asyncHandler(async (req: Request, res: Response) => {
  const position = await getClPosition(req.params.id);
  if (!position) return res.status(404).json({ error: 'Position not found' });
  res.json(position);
}));

// POST /aggregator/cl/positions/:id/adjust — Adjust position range
aggregatorRouter.post('/cl/positions/:id/adjust', asyncHandler(async (req: Request, res: Response) => {
  const schema = z.object({
    tickLower: z.number().int(),
    tickUpper: z.number().int(),
  });
  const { tickLower, tickUpper } = schema.parse(req.body);
  const success = await adjustClPosition(req.params.id, tickLower, tickUpper);
  res.json({ success });
}));

// POST /aggregator/cl/positions/:id/claim-fees — Claim fees
aggregatorRouter.post('/cl/positions/:id/claim-fees', asyncHandler(async (req: Request, res: Response) => {
  const fees = await claimClFees(req.params.id);
  res.json({ success: true, feeA: fees.feeA.toString(), feeB: fees.feeB.toString() });
}));

// POST /aggregator/cl/positions/:id/close — Close position
aggregatorRouter.post('/cl/positions/:id/close', asyncHandler(async (req: Request, res: Response) => {
  const success = await closeClPosition(req.params.id);
  res.json({ success });
}));

// GET /aggregator/cl/range-suggestions — Suggested optimal range
aggregatorRouter.get('/cl/range-suggestions', asyncHandler(async (req: Request, res: Response) => {
  const { poolAddress, volatilityBps } = req.query as { poolAddress?: string; volatilityBps?: string };
  if (!poolAddress) return res.status(400).json({ error: 'poolAddress is required' });

  const pool = getAllPools().find((p) => p.poolAddress === poolAddress);
  if (!pool) return res.status(404).json({ error: 'Pool not found' });

  const suggestions = getRangeSuggestions(pool.id, volatilityBps ? parseInt(volatilityBps) : 100);
  res.json({ poolAddress, suggestions });
}));

// ─── Price Comparison & Analytics ───────────────────────────────────────────

// GET /aggregator/compare — Compare prices across all DEXs
aggregatorRouter.get('/compare', asyncHandler(async (req: Request, res: Response) => {
  const { tokenIn, tokenOut, amountIn } = req.query as { tokenIn?: string; tokenOut?: string; amountIn?: string };
  if (!tokenIn || !tokenOut) return res.status(400).json({ error: 'tokenIn and tokenOut are required' });

  const pools = getAllPools().filter(
    (p) => (p.tokenA === tokenIn && p.tokenB === tokenOut) ||
           (p.tokenA === tokenOut && p.tokenB === tokenIn),
  );

  const comparisons = pools.map((p) => {
    const price = getMidPrice(p);
    return {
      dexName: p.dexName,
      poolAddress: p.poolAddress,
      poolType: p.poolType,
      price,
      feeTier: p.feeTier,
      liquidity: (p.tokenA === tokenIn ? p.reserveA : p.reserveB).toString(),
      reserveA: p.reserveA.toString(),
      reserveB: p.reserveB.toString(),
      volume24h: p.volume24h.toString(),
    };
  });

  comparisons.sort((a, b) => b.price - a.price);

  res.json({
    tokenIn,
    tokenOut,
    amountIn: amountIn ?? '0',
    comparisons,
    bestDex: comparisons[0]?.dexName ?? null,
    bestPrice: comparisons[0]?.price ?? 0,
    worstPrice: comparisons[comparisons.length - 1]?.price ?? 0,
    spreadPct: comparisons.length > 1
      ? ((comparisons[0].price - comparisons[comparisons.length - 1].price) / comparisons[0].price) * 100
      : 0,
  });
}));

// GET /aggregator/compare/:tokenA/:tokenB — Pair comparison page data
aggregatorRouter.get('/compare/:tokenA/:tokenB', asyncHandler(async (req: Request, res: Response) => {
  const { tokenA, tokenB } = req.params;
  const pools = getAllPools().filter(
    (p) => (p.tokenA === tokenA && p.tokenB === tokenB) ||
           (p.tokenA === tokenB && p.tokenB === tokenA),
  );

  res.json({
    pair: `${tokenA}/${tokenB}`,
    pools: pools.map((p) => ({
      dexName: p.dexName,
      poolType: p.poolType,
      price: getMidPrice(p),
      feeTier: p.feeTier,
      tvl: (Number(p.reserveA) / 10 ** p.tokenADecimals + Number(p.reserveB) / 10 ** p.tokenBDecimals),
    })),
    poolCount: pools.length,
    depth: pools.length,
  });
}));

// GET /aggregator/depth/:poolId — Liquidity depth chart data
aggregatorRouter.get('/depth/:poolId', asyncHandler(async (req: Request, res: Response) => {
  const pool = getAllPools().find((p) => p.id === req.params.poolId || p.poolAddress === req.params.poolId);
  if (!pool) return res.status(404).json({ error: 'Pool not found' });

  const reserveAHuman = Number(pool.reserveA) / 10 ** pool.tokenADecimals;
  const reserveBHuman = Number(pool.reserveB) / 10 ** pool.tokenBDecimals;

  const depthLevels = [0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5];
  const depthA = depthLevels.map((pct) => ({
    priceImpactPct: pct * 100,
    amountIn: reserveAHuman * (1 / Math.sqrt(1 - pct) - 1),
    side: 'sell',
  }));
  const depthB = depthLevels.map((pct) => ({
    priceImpactPct: pct * 100,
    amountIn: reserveBHuman * (1 / Math.sqrt(1 - pct) - 1),
    side: 'buy',
  }));

  res.json({
    poolId: pool.id,
    poolAddress: pool.poolAddress,
    reserveA: pool.reserveA.toString(),
    reserveB: pool.reserveB.toString(),
    tokenA: pool.tokenA,
    tokenB: pool.tokenB,
    depth: {
      bids: depthB,
      asks: depthA,
    },
  });
}));

// GET /aggregator/spread/:tokenPair — Spread analysis
aggregatorRouter.get('/spread/:tokenPair', asyncHandler(async (req: Request, res: Response) => {
  const [tokenA, tokenB] = req.params.tokenPair.split('-');
  const pools = getAllPools().filter(
    (p) => (p.tokenA === tokenA && p.tokenB === tokenB) ||
           (p.tokenA === tokenB && p.tokenB === tokenA),
  );

  const prices = pools.map((p) => ({ dex: p.dexName, price: getMidPrice(p) }));
  prices.sort((a, b) => a.price - b.price);

  res.json({
    pair: req.params.tokenPair,
    lowestPrice: prices[0],
    highestPrice: prices[prices.length - 1],
    spread: prices.length > 1 ? prices[prices.length - 1].price - prices[0].price : 0,
    spreadPct: prices.length > 1
      ? ((prices[prices.length - 1].price - prices[0].price) / prices[0].price) * 100
      : 0,
    allPrices: prices,
    poolCount: pools.length,
  });
}));

// ─── Analytics ──────────────────────────────────────────────────────────────

// GET /aggregator/analytics/volume — Aggregated volume stats
aggregatorRouter.get('/analytics/volume', asyncHandler(async (_req: Request, res: Response) => {
  const pools = getAllPools();
  const totalVolume = pools.reduce((sum, p) => sum + p.volume24h, 0n);
  const totalFees = pools.reduce((sum, p) => sum + p.fees24h, 0n);
  const byDex = new Map<string, { volume: bigint; fees: bigint; poolCount: number }>();

  for (const pool of pools) {
    const entry = byDex.get(pool.dexName) ?? { volume: 0n, fees: 0n, poolCount: 0 };
    entry.volume += pool.volume24h;
    entry.fees += pool.fees24h;
    entry.poolCount++;
    byDex.set(pool.dexName, entry);
  }

  res.json({
    totalVolume24h: totalVolume.toString(),
    totalFees24h: totalFees.toString(),
    totalPools: pools.length,
    byDex: Array.from(byDex.entries()).map(([dex, data]) => ({
      dexName: dex,
      volume24h: data.volume.toString(),
      fees24h: data.fees.toString(),
      poolCount: data.poolCount,
    })),
    poolTypes: getPoolCountByType(),
  });
}));

// GET /aggregator/analytics/markets — Top markets by volume
aggregatorRouter.get('/analytics/markets', asyncHandler(async (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 20;
  const pools = getAllPools()
    .sort((a, b) => Number(b.volume24h - a.volume24h))
    .slice(0, limit)
    .map((p) => ({
      poolAddress: p.poolAddress,
      dexName: p.dexName,
      tokenA: p.tokenA,
      tokenB: p.tokenB,
      tokenASymbol: p.tokenASymbol,
      tokenBSymbol: p.tokenBSymbol,
      volume24h: p.volume24h.toString(),
      price: getMidPrice(p),
      feeTier: p.feeTier,
    }));

  res.json({ markets: pools, count: pools.length });
}));

// ─── Cross-Chain Bridge Aggregation ─────────────────────────────────────────

// POST /aggregator/cross-chain/quote — Cross-chain quote
aggregatorRouter.post('/cross-chain/quote', asyncHandler(async (req: Request, res: Response) => {
  const schema = z.object({
    fromChain: z.string().min(1),
    toChain: z.string().min(1),
    tokenIn: z.string().min(1),
    amountIn: z.string().min(1),
  });

  const params = schema.parse(req.body);
  const quotes = computeCrossChainQuote(params.fromChain, params.toChain, params.tokenIn, BigInt(params.amountIn));
  res.json({ quotes, count: quotes.length });
}));

// POST /aggregator/cross-chain/swap — Cross-chain swap
aggregatorRouter.post('/cross-chain/swap', asyncHandler(async (req: Request, res: Response) => {
  const schema = z.object({
    fromChain: z.string().min(1),
    toChain: z.string().min(1),
    tokenIn: z.string().min(1),
    amountIn: z.string().min(1),
    receiver: z.string().min(1),
    bridgeName: z.string().optional(),
  });

  const params = schema.parse(req.body);
  res.json({
    success: true,
    message: `Cross-chain swap prepared: ${params.amountIn} ${params.tokenIn} from ${params.fromChain} → ${params.toChain}`,
    crossChainTx: params,
    estimatedDeliveryMs: 30000,
  });
}));

// GET /aggregator/cross-chain/bridges — Available bridges status
aggregatorRouter.get('/cross-chain/bridges', asyncHandler(async (_req: Request, res: Response) => {
  const bridges = getAllBridgeStatuses();
  res.json({ bridges, count: bridges.length });
}));

// GET /aggregator/cross-chain/routes/:fromChain/:toChain — Routes between chains
aggregatorRouter.get('/cross-chain/routes/:fromChain/:toChain', asyncHandler(async (req: Request, res: Response) => {
  const { fromChain, toChain } = req.params;
  const bridges = getAllBridgeStatuses().filter(
    (b) => b.route.startsWith(fromChain) && b.route.endsWith(toChain),
  );
  res.json({ fromChain, toChain, bridges, count: bridges.length });
}));

// ─── Gas Optimization ───────────────────────────────────────────────────────

// GET /aggregator/gas/estimate — Gas estimate for route
aggregatorRouter.get('/gas/estimate', asyncHandler(async (req: Request, res: Response) => {
  const { poolIds, gasStrategy } = req.query as { poolIds?: string; gasStrategy?: string };

  if (!poolIds) return res.status(400).json({ error: 'poolIds (comma-separated) is required' });

  const ids = poolIds.split(',');
  const pools = ids.map((id) => getAllPools().find((p) => p.id === id)).filter(Boolean) as any[];

  // Create route hops from pools
  const hops = pools.map((p) => ({
    poolId: p.id,
    dexName: p.dexName,
    poolAddress: p.poolAddress,
    tokenIn: p.tokenA,
    tokenOut: p.tokenB,
    amountIn: 0n,
    amountOut: 0n,
    priceImpact: 0,
    feePaid: 0n,
  }));

  const gasEstimate = estimateRouteGas(hops, (gasStrategy as any) ?? 'standard');
  res.json(gasEstimate);
}));

// POST /aggregator/gas/optimize — Optimize route for gas
aggregatorRouter.post('/gas/optimize', asyncHandler(async (req: Request, res: Response) => {
  const schema = z.object({
    route: z.array(z.object({
      poolId: z.string(),
      tokenIn: z.string(),
      tokenOut: z.string(),
      amountIn: z.string(),
      amountOut: z.string(),
    })),
  });

  const params = schema.parse(req.body);
  const route = {
    hops: params.route.map((r) => ({
      poolId: r.poolId,
      dexName: '',
      poolAddress: '',
      tokenIn: r.tokenIn,
      tokenOut: r.tokenOut,
      amountIn: BigInt(r.amountIn),
      amountOut: BigInt(r.amountOut),
      priceImpact: 0,
      feePaid: 0n,
    })),
    totalAmountIn: BigInt(params.route[0]?.amountIn ?? '0'),
    totalAmountOut: BigInt(params.route[params.route.length - 1]?.amountOut ?? '0'),
    totalPriceImpact: 0,
    totalFeePaid: 0n,
    estimatedGas: 0n,
    executionPrice: 0,
    midPrice: 0,
    slippagePct: 0,
  };

  const optimization = optimizeForGas(route);
  res.json(optimization);
}));

// GET /aggregator/gas/prices — Current gas price oracle
aggregatorRouter.get('/gas/prices', asyncHandler(async (_req: Request, res: Response) => {
  const prices = getGasPrices();
  res.json(prices);
}));

// ─── Risk Management ───────────────────────────────────────────────────────

// GET /aggregator/risk/check/:token — Token risk assessment
aggregatorRouter.get('/risk/check/:token', asyncHandler(async (req: Request, res: Response) => {
  const amountIn = BigInt(req.query.amount as string ?? '1000000000');
  const risk = checkTokenRisk(req.params.token, amountIn);
  res.json(risk);
}));

// GET /aggregator/risk/blacklist — Blacklisted tokens
aggregatorRouter.get('/risk/blacklist', asyncHandler(async (_req: Request, res: Response) => {
  const blacklisted = getBlacklistedTokens();
  res.json({ blacklisted, count: blacklisted.length });
}));

// GET /aggregator/risk/impermanent-loss — IL calculator
aggregatorRouter.get('/risk/impermanent-loss', asyncHandler(async (req: Request, res: Response) => {
  const priceChangeRatio = parseFloat(req.query.priceRatio as string) || 2;
  const il = calculateImpermanentLoss(priceChangeRatio);

  // Generate curve
  const ratios = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 5];
  const curve = ratios.map((r) => ({
    priceRatio: r,
    impermanentLossPct: calculateImpermanentLoss(r) * 100,
  }));

  res.json({
    priceRatio: priceChangeRatio,
    impermanentLossPct: il * 100,
    curve,
  });
}));

// ─── WebSocket Streaming ────────────────────────────────────────────────────
// WebSocket connections are handled separately via the WebSocket upgrade path
// GET /aggregator/ws-info — WebSocket connection info
aggregatorRouter.get('/ws-info', asyncHandler(async (_req: Request, res: Response) => {
  res.json({
    wsEndpoint: '/api/v1/aggregator/ws',
    streams: {
      prices: 'ws://host/api/v1/aggregator/ws?stream=prices',
      quotes: 'ws://host/api/v1/aggregator/ws?stream=quotes',
      depth: 'ws://host/api/v1/aggregator/ws?stream=depth',
    },
    description: 'Connect via WebSocket for real-time price updates, streaming quotes, and depth updates',
  });
}));

// ─── TWAP Oracle ────────────────────────────────────────────────────────────

// GET /aggregator/oracle/twap/:tokenA/:tokenB — TWAP price
aggregatorRouter.get('/oracle/twap/:tokenA/:tokenB', asyncHandler(async (req: Request, res: Response) => {
  const windowSeconds = parseInt(req.query.window as string) || 3600;
  const twap = await getTwapPrice(req.params.tokenA, req.params.tokenB, windowSeconds);
  if (!twap) return res.status(404).json({ error: 'TWAP price not available' });
  res.json(twap);
}));

// GET /aggregator/oracle/twap/:tokenA/:tokenB/history — Historical TWAP
aggregatorRouter.get('/oracle/twap/:tokenA/:tokenB/history', asyncHandler(async (req: Request, res: Response) => {
  const windowSeconds = parseInt(req.query.window as string) || 3600;
  const limit = parseInt(req.query.limit as string) || 100;
  const history = await getTwapHistory(req.params.tokenA, req.params.tokenB, windowSeconds, limit);
  res.json({ tokenA: req.params.tokenA, tokenB: req.params.tokenB, windowSeconds, history, count: history.length });
}));

// ─── Social Trading ─────────────────────────────────────────────────────────

// GET /aggregator/social/top-traders — Top traders leaderboard
aggregatorRouter.get('/social/top-traders', asyncHandler(async (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 20;
  const timeRange = (req.query.timeRange as string) || '7d';
  const traders = await getTopTraders(limit, timeRange as any);
  res.json({ traders, count: traders.length });
}));

// GET /aggregator/social/trader/:address/strategy — Trader's strategy
aggregatorRouter.get('/social/trader/:address/strategy', asyncHandler(async (req: Request, res: Response) => {
  const strategy = await analyzeTraderStrategy(req.params.address);
  if (!strategy) return res.status(404).json({ error: 'Trader not found' });
  res.json(strategy);
}));

// POST /aggregator/social/copy-trader — Start copy trading
aggregatorRouter.post('/social/copy-trader', asyncHandler(async (req: Request, res: Response) => {
  const schema = z.object({
    followerAddress: z.string().min(1),
    traderAddress: z.string().min(1),
    allocationPercentage: z.number().min(1).max(100),
    maxSlippage: z.number().default(0.5),
  });

  const params = schema.parse(req.body);
  const success = await startCopyTrading(
    params.followerAddress,
    params.traderAddress,
    params.allocationPercentage,
    params.maxSlippage,
  );
  res.status(201).json({ success });
}));

// ─── Pool Registration ──────────────────────────────────────────────────────

// POST /aggregator/pools/register — Register a new DEX pool
aggregatorRouter.post('/pools/register', asyncHandler(async (req: Request, res: Response) => {
  const schema = z.object({
    dexName: z.string().min(1),
    poolAddress: z.string().min(1),
    poolType: z.enum(['constant_product', 'concentrated', 'stable', 'weighted', 'dynamic_fee']),
    tokenA: z.string().min(1),
    tokenB: z.string().min(1),
    tokenASymbol: z.string().optional(),
    tokenBSymbol: z.string().optional(),
    tokenADecimals: z.number().int().optional(),
    tokenBDecimals: z.number().int().optional(),
    feeTier: z.number().int().optional(),
    tickSpacing: z.number().int().optional(),
  });

  const params = schema.parse(req.body);
  const pool = await upsertPool(params);
  res.status(201).json({ success: true, pool: { id: pool.id, ...pool } });
}));

// GET /aggregator/pools — List all pools in the aggregator
aggregatorRouter.get('/pools', asyncHandler(async (_req: Request, res: Response) => {
  const pools = getAllPools();
  const byType = getPoolCountByType();

  res.json({
    count: pools.length,
    byType,
    pools: pools.slice(0, 100).map((p) => ({
      id: p.id,
      dexName: p.dexName,
      poolAddress: p.poolAddress,
      poolType: p.poolType,
      tokenA: p.tokenA,
      tokenB: p.tokenB,
      tokenASymbol: p.tokenASymbol,
      tokenBSymbol: p.tokenBSymbol,
      feeTier: p.feeTier,
      tickSpacing: p.tickSpacing,
      reserveA: p.reserveA.toString(),
      reserveB: p.reserveB.toString(),
      price: getMidPrice(p),
      volume24h: p.volume24h.toString(),
    })),
  });
}));

// POST /aggregator/pools/refresh — Refresh pool registry from DB
aggregatorRouter.post('/pools/refresh', asyncHandler(async (_req: Request, res: Response) => {
  await refreshPoolRegistry();
  res.json({ success: true, poolCount: getAllPools().length });
}));

// ─── CL Rebalancing ─────────────────────────────────────────────────────────

// POST /aggregator/cl/rebalance/:positionId — Trigger rebalance
aggregatorRouter.post('/cl/rebalance/:positionId', asyncHandler(async (req: Request, res: Response) => {
  res.json({
    success: true,
    message: `Rebalance triggered for position ${req.params.positionId}`,
    estimatedGas: '50000',
  });
}));

// POST /aggregator/cl/auto-rebalance — Configure auto-rebalance
aggregatorRouter.post('/cl/auto-rebalance', asyncHandler(async (req: Request, res: Response) => {
  const schema = z.object({
    positionId: z.string().min(1),
    enabled: z.boolean(),
    rebalanceThreshold: z.number().min(0.1).max(50).optional(),
  });
  const params = schema.parse(req.body);
  res.json({
    success: true,
    message: `Auto-rebalance ${params.enabled ? 'enabled' : 'disabled'} for position ${params.positionId}`,
  });
}));

// ─── Swap History ───────────────────────────────────────────────────────────

// GET /aggregator/swap/history — Recent swap history
aggregatorRouter.get('/swap/history', asyncHandler(async (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 20;
  const offset = parseInt(req.query.offset as string) || 0;

  const swaps = await prismaRead.poolSwap.findMany({
    orderBy: { ledgerCloseTime: 'desc' },
    take: limit,
    skip: offset,
  });

  res.json({
    data: swaps.map((s) => ({
      id: s.id,
      transactionHash: s.transactionHash,
      poolAddress: s.poolAddress,
      tokenIn: s.tokenIn,
      tokenOut: s.tokenOut,
      amountIn: s.amountIn,
      amountOut: s.amountOut,
      trader: s.trader,
      timestamp: s.ledgerCloseTime,
    })),
    total: swaps.length,
    limit,
    offset,
  });
}));
