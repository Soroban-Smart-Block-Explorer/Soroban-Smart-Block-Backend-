/**
 * Token Discovery API — Issue #335
 *
 * Full REST API for the Token Launch & Airdrop Detection Platform.
 *
 * All endpoints are under /api/v1/discover/ with pagination, filtering,
 * and comprehensive response schemas.
 */

import { Router, Request, Response } from 'express';
import { prismaRead as prisma } from '../db';
import { asyncHandler } from '../middleware/asyncHandler';
import {
  analyzeTokenSecurity,
  findSimilarContracts,
} from '../discover/forensics';
import {
  computeTrendingMetrics,
  getRisingTokens,
  getWhaleInterestTokens,
  classifyToken,
} from '../discover/trending';
import {
  createAlertRule,
  updateAlertRule,
  deleteAlertRule,
  getUserAlertRules,
  getAlertHistory,
  testAlertRule,
  subscribeToAlertType,
} from '../discover/alert-engine';
import { checkAirdropEligibility } from '../discover/airdrop-detector';
import { detectInsiderActivity } from '../discover/insider-detector';

export const discoverRouter = Router();

// ───────────────────────────────────────────────────────────────────────────────
// 1. Core Discovery Endpoints
// ───────────────────────────────────────────────────────────────────────────────

/**
 * GET /discover/tokens — recently launched tokens (paginated, filterable)
 */
discoverRouter.get(
  '/tokens',
  asyncHandler(async (req: Request, res: Response) => {
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10));
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10)));
    const status = req.query.status ? String(req.query.status) : undefined;
    const standard = req.query.standard ? String(req.query.standard) : undefined;
    const category = req.query.category ? String(req.query.category) : undefined;

    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    if (standard) where.tokenStandard = standard;
    if (category) {
      where.analyses = {
        some: {
          analysisType: 'classification',
          findings: { path: ['category'], equals: category },
        },
      };
    }

    const skip = (page - 1) * limit;
    const [tokens, total] = await Promise.all([
      prisma.detectedToken.findMany({
        where,
        orderBy: { detectedAt: 'desc' },
        skip,
        take: limit,
        include: {
          rugRiskScores: { select: { overallScore: true, overallRiskLabel: true } },
          liquidityEvents: { take: 3, orderBy: { timestamp: 'desc' }, select: { liquidityUsdValue: true, dexName: true } },
        },
      }),
      prisma.detectedToken.count({ where }),
    ]);

    const pages = Math.ceil(total / limit);

    res.json({
      data: tokens,
      total,
      page,
      limit,
      pages,
      hasNext: page < pages,
      hasPrev: page > 1,
    });
  }),
);

/**
 * GET /discover/tokens/:address — token detail with full forensics report
 */
discoverRouter.get(
  '/tokens/:address',
  asyncHandler(async (req: Request, res: Response) => {
    const token = await prisma.detectedToken.findUnique({
      where: { contractAddress: req.params.address },
      include: {
        rugRiskScores: true,
        analyses: true,
        liquidityEvents: { orderBy: { timestamp: 'desc' }, take: 10 },
        airdrops: {
          include: { claims: { take: 5 } },
          orderBy: { detectedAt: 'desc' },
          take: 10,
        },
      },
    });

    if (!token) {
      return res.status(404).json({ error: 'Token not found' });
    }

    // Also fetch holder stats
    const holderCount = await prisma.tokenHolder.count({
      where: { tokenId: token.id },
    });

    res.json({
      ...token,
      holderCount,
    });
  }),
);

/**
 * GET /discover/tokens/:address/holders — holder distribution
 */
discoverRouter.get(
  '/tokens/:address/holders',
  asyncHandler(async (req: Request, res: Response) => {
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10));
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10)));

    const token = await prisma.detectedToken.findUnique({
      where: { contractAddress: req.params.address },
      select: { id: true },
    });

    if (!token) {
      return res.status(404).json({ error: 'Token not found' });
    }

    const skip = (page - 1) * limit;
    const [holders, total] = await Promise.all([
      prisma.tokenHolder.findMany({
        where: { tokenId: token.id },
        orderBy: { balance: 'desc' },
        skip,
        take: limit,
      }),
      prisma.tokenHolder.count({ where: { tokenId: token.id } }),
    ]);

    const pages = Math.ceil(total / limit);
    res.json({ data: holders, total, page, limit, pages });
  }),
);

/**
 * GET /discover/tokens/:address/liquidity — liquidity events
 */
discoverRouter.get(
  '/tokens/:address/liquidity',
  asyncHandler(async (req: Request, res: Response) => {
    const token = await prisma.detectedToken.findUnique({
      where: { contractAddress: req.params.address },
      select: { id: true },
    });

    if (!token) {
      return res.status(404).json({ error: 'Token not found' });
    }

    const events = await prisma.liquidityEvent.findMany({
      where: { tokenId: token.id },
      orderBy: { timestamp: 'desc' },
      take: 50,
    });

    res.json({ data: events });
  }),
);

/**
 * GET /discover/tokens/:address/transfers — initial transfer patterns
 */
discoverRouter.get(
  '/tokens/:address/transfers',
  asyncHandler(async (req: Request, res: Response) => {
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10));
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10)));

    const token = await prisma.detectedToken.findUnique({
      where: { contractAddress: req.params.address },
      select: { id: true },
    });

    if (!token) {
      return res.status(404).json({ error: 'Token not found' });
    }

    const skip = (page - 1) * limit;
    const [transfers, total] = await Promise.all([
      prisma.event.findMany({
        where: {
          contractAddress: req.params.address,
          eventType: 'transfer',
        },
        orderBy: { ledgerSequence: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          transactionHash: true,
          decoded: true,
          ledgerSequence: true,
          ledgerCloseTime: true,
        },
      }),
      prisma.event.count({
        where: {
          contractAddress: req.params.address,
          eventType: 'transfer',
        },
      }),
    ]);

    const pages = Math.ceil(total / limit);
    res.json({ data: transfers, total, page, limit, pages });
  }),
);

/**
 * GET /discover/tokens/:address/analysis — contract analysis results
 */
discoverRouter.get(
  '/tokens/:address/analysis',
  asyncHandler(async (req: Request, res: Response) => {
    const token = await prisma.detectedToken.findUnique({
      where: { contractAddress: req.params.address },
      select: { id: true, contractAddress: true },
    });

    if (!token) {
      return res.status(404).json({ error: 'Token not found' });
    }

    const analyses = await prisma.tokenContractAnalysis.findMany({
      where: { tokenId: token.id },
    });

    res.json({ data: analyses });
  }),
);

/**
 * GET /discover/tokens/:address/price-history — price since launch
 */
discoverRouter.get(
  '/tokens/:address/price-history',
  asyncHandler(async (req: Request, res: Response) => {
    const snapshots = await prisma.marketDataSnapshot.findMany({
      where: { tokenAddress: req.params.address },
      orderBy: { timestamp: 'desc' },
      take: 100,
    });

    res.json({ data: snapshots });
  }),
);

// ───────────────────────────────────────────────────────────────────────────────
// 2. Airdrop Endpoints
// ───────────────────────────────────────────────────────────────────────────────

/**
 * GET /discover/airdrops — ongoing/completed airdrops
 */
discoverRouter.get(
  '/airdrops',
  asyncHandler(async (req: Request, res: Response) => {
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10));
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10)));
    const isClaimed = req.query.claimed !== undefined ? req.query.claimed === 'true' : undefined;

    const where: Record<string, unknown> = {};
    if (isClaimed !== undefined) where.isClaimed = isClaimed;

    const skip = (page - 1) * limit;
    const [airdrops, total] = await Promise.all([
      prisma.airdrop.findMany({
        where,
        orderBy: { detectedAt: 'desc' },
        skip,
        take: limit,
        include: {
          token: { select: { contractAddress: true, symbol: true, name: true } },
          claims: { select: { claimerAddress: true, amountClaimed: true, timestamp: true } },
        },
      }),
      prisma.airdrop.count({ where }),
    ]);

    const pages = Math.ceil(total / limit);
    res.json({ data: airdrops, total, page, limit, pages });
  }),
);

/**
 * GET /discover/airdrops/:id — airdrop detail with claim status
 */
discoverRouter.get(
  '/airdrops/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid airdrop ID' });

    const airdrop = await prisma.airdrop.findUnique({
      where: { id },
      include: {
        token: { select: { contractAddress: true, symbol: true, name: true } },
        claims: { orderBy: { timestamp: 'desc' } },
      },
    });

    if (!airdrop) return res.status(404).json({ error: 'Airdrop not found' });

    res.json(airdrop);
  }),
);

/**
 * GET /discover/airdrops/:id/eligible/:address — check eligibility
 */
discoverRouter.get(
  '/airdrops/:id/eligible/:address',
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid airdrop ID' });

    const result = await checkAirdropEligibility(id, req.params.address);
    res.json(result);
  }),
);

/**
 * GET /discover/airdrops/:id/claims — claim activity for airdrop
 */
discoverRouter.get(
  '/airdrops/:id/claims',
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid airdrop ID' });

    const claims = await prisma.airdropClaim.findMany({
      where: { airdropId: id },
      orderBy: { timestamp: 'desc' },
      take: 100,
    });

    res.json({ data: claims });
  }),
);

// ───────────────────────────────────────────────────────────────────────────────
// 3. Trending Endpoints
// ───────────────────────────────────────────────────────────────────────────────

/**
 * GET /discover/trending — trending tokens with multiple sort criteria
 */
discoverRouter.get(
  '/trending',
  asyncHandler(async (req: Request, res: Response) => {
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10)));
    const category = req.query.category ? String(req.query.category) : undefined;
    const sort = String(req.query.sort ?? 'trendingScore');
    const order = String(req.query.order ?? 'desc');

    const metrics = await computeTrendingMetrics(limit, category);

    // Sort by requested field
    const validSorts = ['trendingScore', 'volumeVelocity', 'holderVelocity', 'priceVelocity1h', 'priceVelocity24h'] as const;
    const sortField = validSorts.includes(sort as any) ? sort : 'trendingScore';
    metrics.sort((a, b) => {
      const aVal = a[sortField as keyof typeof a] as number;
      const bVal = b[sortField as keyof typeof b] as number;
      return order === 'asc' ? aVal - bVal : bVal - aVal;
    });

    res.json({ data: metrics.slice(0, limit) });
  }),
);

/**
 * GET /discover/rising — tokens with fastest-growing metrics
 */
discoverRouter.get(
  '/rising',
  asyncHandler(async (req: Request, res: Response) => {
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10)));
    const tokens = await getRisingTokens(limit);
    res.json({ data: tokens });
  }),
);

/**
 * GET /discover/trending/whale-interest — tokens whales are buying
 */
discoverRouter.get(
  '/trending/whale-interest',
  asyncHandler(async (req: Request, res: Response) => {
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10)));
    const tokens = await getWhaleInterestTokens(limit);
    res.json({ data: tokens });
  }),
);

// ───────────────────────────────────────────────────────────────────────────────
// 4. Forensics / Security Endpoints
// ───────────────────────────────────────────────────────────────────────────────

/**
 * GET /discover/forensics/:tokenAddress — full forensics report
 */
discoverRouter.get(
  '/forensics/:tokenAddress',
  asyncHandler(async (req: Request, res: Response) => {
    const token = await prisma.detectedToken.findUnique({
      where: { contractAddress: req.params.tokenAddress },
      select: { id: true, contractAddress: true },
    });

    if (!token) return res.status(404).json({ error: 'Token not found' });

    const report = await analyzeTokenSecurity(token.id, token.contractAddress);
    res.json(report);
  }),
);

/**
 * GET /discover/forensics/:tokenAddress/rug-risk — rug-pull risk score
 */
discoverRouter.get(
  '/forensics/:tokenAddress/rug-risk',
  asyncHandler(async (req: Request, res: Response) => {
    const token = await prisma.detectedToken.findUnique({
      where: { contractAddress: req.params.tokenAddress },
      include: { rugRiskScores: true },
    });

    if (!token) return res.status(404).json({ error: 'Token not found' });

    // If cached score exists, return it; otherwise compute fresh
    if (token.rugRiskScores) {
      return res.json(token.rugRiskScores);
    }

    const report = await analyzeTokenSecurity(token.id, token.contractAddress);
    const riskScore = await prisma.rugPullRiskScore.findUnique({
      where: { tokenId: token.id },
    });
    res.json(riskScore);
  }),
);

/**
 * GET /discover/forensics/:tokenAddress/ownership — ownership analysis
 */
discoverRouter.get(
  '/forensics/:tokenAddress/ownership',
  asyncHandler(async (req: Request, res: Response) => {
    const token = await prisma.detectedToken.findUnique({
      where: { contractAddress: req.params.tokenAddress },
      select: { id: true, contractAddress: true },
    });

    if (!token) return res.status(404).json({ error: 'Token not found' });

    const report = await analyzeTokenSecurity(token.id, token.contractAddress);
    res.json(report.ownership);
  }),
);

/**
 * GET /discover/forensics/:tokenAddress/honeypot — honeypot test
 */
discoverRouter.get(
  '/forensics/:tokenAddress/honeypot',
  asyncHandler(async (req: Request, res: Response) => {
    const token = await prisma.detectedToken.findUnique({
      where: { contractAddress: req.params.tokenAddress },
      select: { id: true, contractAddress: true },
    });

    if (!token) return res.status(404).json({ error: 'Token not found' });

    const report = await analyzeTokenSecurity(token.id, token.contractAddress);
    res.json(report.honeypotResult);
  }),
);

/**
 * POST /discover/forensics/scan — manual scan request
 */
discoverRouter.post(
  '/forensics/scan',
  asyncHandler(async (req: Request, res: Response) => {
    const { contractAddress } = req.body;
    if (!contractAddress) {
      return res.status(400).json({ error: 'contractAddress is required' });
    }

    const token = await prisma.detectedToken.findUnique({
      where: { contractAddress },
      select: { id: true, contractAddress: true },
    });

    if (!token) return res.status(404).json({ error: 'Token not found' });

    const report = await analyzeTokenSecurity(token.id, token.contractAddress);
    res.json({ status: 'completed', report });
  }),
);

/**
 * GET /discover/forensics/similar/:tokenAddress — find similar contracts
 */
discoverRouter.get(
  '/forensics/similar/:tokenAddress',
  asyncHandler(async (req: Request, res: Response) => {
    const similar = await findSimilarContracts(req.params.tokenAddress);
    res.json({ data: similar });
  }),
);

// ───────────────────────────────────────────────────────────────────────────────
// 5. Alert System Endpoints
// ───────────────────────────────────────────────────────────────────────────────

/**
 * POST /discover/alerts — create alert rule
 */
discoverRouter.post(
  '/alerts',
  asyncHandler(async (req: Request, res: Response) => {
    const { userAddress, alertType, conditions, channels, cooldownMinutes } = req.body;

    if (!userAddress || !alertType || !conditions || !channels) {
      return res.status(400).json({ error: 'Missing required fields: userAddress, alertType, conditions, channels' });
    }

    const rule = await createAlertRule({
      userAddress,
      alertType,
      conditions,
      channels,
      cooldownMinutes,
    });

    res.status(201).json(rule);
  }),
);

/**
 * GET /discover/alerts — list user's alert rules
 */
discoverRouter.get(
  '/alerts',
  asyncHandler(async (req: Request, res: Response) => {
    const userAddress = req.query.user ? String(req.query.user) : undefined;

    if (userAddress) {
      const rules = await getUserAlertRules(userAddress);
      return res.json({ data: rules });
    }

    const rules = await prisma.alertRule.findMany({
      orderBy: { createdAt: 'desc' },
    });
    res.json({ data: rules });
  }),
);

/**
 * PUT /discover/alerts/:id — update alert rule
 */
discoverRouter.put(
  '/alerts/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { conditions, channels, cooldownMinutes, alertType } = req.body;

    const rule = await updateAlertRule(req.params.id, {
      conditions,
      channels,
      cooldownMinutes,
      alertType,
    });

    res.json(rule);
  }),
);

/**
 * DELETE /discover/alerts/:id — delete alert rule
 */
discoverRouter.delete(
  '/alerts/:id',
  asyncHandler(async (req: Request, res: Response) => {
    await deleteAlertRule(req.params.id);
    res.json({ success: true });
  }),
);

/**
 * POST /discover/alerts/:id/test — test alert
 */
discoverRouter.post(
  '/alerts/:id/test',
  asyncHandler(async (req: Request, res: Response) => {
    const result = await testAlertRule(req.params.id);
    res.json(result);
  }),
);

/**
 * GET /discover/alerts/history — alert event history
 */
discoverRouter.get(
  '/alerts/history',
  asyncHandler(async (req: Request, res: Response) => {
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10));
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10)));
    const alertType = req.query.type ? String(req.query.type) : undefined;
    const severity = req.query.severity ? String(req.query.severity) : undefined;

    const { events, total } = await getAlertHistory(limit, (page - 1) * limit, {
      alertType,
      severity,
    });

    const pages = Math.ceil(total / limit);
    res.json({ data: events, total, page, limit, pages });
  }),
);

/**
 * POST /discover/alerts/subscribe/:type — subscribe to alert type
 */
discoverRouter.post(
  '/alerts/subscribe/:type',
  asyncHandler(async (req: Request, res: Response) => {
    const { userAddress, channels } = req.body;
    if (!userAddress || !channels) {
      return res.status(400).json({ error: 'userAddress and channels are required' });
    }

    const rule = await subscribeToAlertType(userAddress, req.params.type, channels);
    res.status(201).json(rule);
  }),
);

/**
 * POST /discover/webhooks — register webhook for alerts
 */
discoverRouter.post(
  '/webhooks',
  asyncHandler(async (req: Request, res: Response) => {
    const { url, secret, events } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'url is required' });
    }

    // Create an alert rule with webhook delivery channel
    const rule = await createAlertRule({
      userAddress: req.body.userAddress ?? 'anonymous',
      alertType: events?.join(',') ?? 'all',
      conditions: { webhookUrl: url },
      channels: { webhook: { url, secret } },
    });

    res.status(201).json(rule);
  }),
);

// ───────────────────────────────────────────────────────────────────────────────
// 6. Classification & Categories
// ───────────────────────────────────────────────────────────────────────────────

/**
 * GET /discover/categories — all categories
 */
discoverRouter.get(
  '/categories',
  asyncHandler(async (_req: Request, res: Response) => {
    const categories = await prisma.tokenCategory.groupBy({
      by: ['category'],
      _count: { category: true },
    });

    const result = categories.map((c) => ({
      category: c.category,
      count: c._count.category,
    }));

    res.json({ data: result });
  }),
);

/**
 * POST /discover/tokens/:address/classify — reclassify token
 */
discoverRouter.post(
  '/tokens/:address/classify',
  asyncHandler(async (req: Request, res: Response) => {
    const token = await prisma.detectedToken.findUnique({
      where: { contractAddress: req.params.address },
      select: { id: true, contractAddress: true },
    });

    if (!token) return res.status(404).json({ error: 'Token not found' });

    const categories = await classifyToken(token.id, token.contractAddress);
    res.json({ data: categories });
  }),
);

/**
 * GET /discover/tokens/:address/category-scores — category probability scores
 */
discoverRouter.get(
  '/tokens/:address/category-scores',
  asyncHandler(async (req: Request, res: Response) => {
    const token = await prisma.detectedToken.findUnique({
      where: { contractAddress: req.params.address },
      select: { id: true },
    });

    if (!token) return res.status(404).json({ error: 'Token not found' });

    const scores = await prisma.tokenCategory.findMany({
      where: { tokenId: token.id },
    });

    res.json({ data: scores });
  }),
);

// ───────────────────────────────────────────────────────────────────────────────
// 7. Insider Trading Detection
// ───────────────────────────────────────────────────────────────────────────────

/**
 * GET /discover/insider/:tokenAddress — insider activity report
 */
discoverRouter.get(
  '/insider/:tokenAddress',
  asyncHandler(async (req: Request, res: Response) => {
    const token = await prisma.detectedToken.findUnique({
      where: { contractAddress: req.params.tokenAddress },
      select: { id: true, contractAddress: true, deployerAddress: true, deployBlock: true },
    });

    if (!token) return res.status(404).json({ error: 'Token not found' });

    const report = await detectInsiderActivity(
      token.id,
      token.contractAddress,
      token.deployerAddress,
      Number(token.deployBlock),
    );

    res.json(report ?? { message: 'No insider activity detected', wallets: [], fundingGraph: [] });
  }),
);

/**
 * GET /discover/insider/:tokenAddress/wallets — suspected insider wallets
 */
discoverRouter.get(
  '/insider/:tokenAddress/wallets',
  asyncHandler(async (req: Request, res: Response) => {
    const token = await prisma.detectedToken.findUnique({
      where: { contractAddress: req.params.tokenAddress },
      select: { id: true },
    });

    if (!token) return res.status(404).json({ error: 'Token not found' });

    const activities = await prisma.insiderActivity.findMany({
      where: { tokenId: token.id },
      include: { walletId: false },
    });

    // Fetch wallet details
    const walletIds = activities.map((a) => a.walletId);
    const wallets = await prisma.insiderWallet.findMany({
      where: { id: { in: walletIds } },
    });

    res.json({ data: wallets });
  }),
);

/**
 * GET /discover/insider/flagged-wallets — globally flagged wallets
 */
discoverRouter.get(
  '/insider/flagged-wallets',
  asyncHandler(async (req: Request, res: Response) => {
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10));
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10)));

    const skip = (page - 1) * limit;
    const [wallets, total] = await Promise.all([
      prisma.insiderWallet.findMany({
        where: { riskScore: { gte: BigInt(3000) } }, // riskScore >= 30 (stored as * 100)
        orderBy: { riskScore: 'desc' },
        skip,
        take: limit,
      }),
      prisma.insiderWallet.count({
        where: { riskScore: { gte: BigInt(3000) } },
      }),
    ]);

    const pages = Math.ceil(total / limit);
    res.json({ data: wallets, total, page, limit, pages });
  }),
);

// ───────────────────────────────────────────────────────────────────────────────
// 8. Portfolio Strategy Endpoints
// ───────────────────────────────────────────────────────────────────────────────

/**
 * POST /discover/portfolio/strategy  — create allocation strategy
 */
discoverRouter.post(
  '/portfolio/strategy',
  asyncHandler(async (req: Request, res: Response) => {
    const { name, strategyType, config, userId } = req.body;

    if (!name || !strategyType || !config) {
      return res.status(400).json({ error: 'name, strategyType, and config are required' });
    }

    const strategy = await prisma.portfolioStrategy.create({
      data: {
        name,
        strategyType,
        config,
        userId,
      },
    });

    res.status(201).json(strategy);
  }),
);

/**
 * GET /discover/portfolio/strategies — list strategies
 */
discoverRouter.get(
  '/portfolio/strategies',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.query.user ? String(req.query.user) : undefined;

    const where: Record<string, unknown> = {};
    if (userId) where.userId = userId;

    const strategies = await prisma.portfolioStrategy.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });

    res.json({ data: strategies });
  }),
);

/**
 * POST /discover/portfolio/strategies/:id/execute — execute allocation
 */
discoverRouter.post(
  '/portfolio/strategies/:id/execute',
  asyncHandler(async (req: Request, res: Response) => {
    const strategy = await prisma.portfolioStrategy.findUnique({
      where: { id: req.params.id },
    });

    if (!strategy) return res.status(404).json({ error: 'Strategy not found' });

    // Get active tokens to allocate
    const tokens = await prisma.detectedToken.findMany({
      where: { status: 'active' },
      select: { id: true, contractAddress: true, symbol: true },
      orderBy: { detectedAt: 'desc' },
      take: 20,
    });

    // Simple equal-weight allocation
    const weight = tokens.length > 0 ? parseFloat((1 / tokens.length).toFixed(6)) : 0;

    const allocations = tokens.map((token) => ({
      strategyId: strategy.id,
      tokenId: token.id,
      weight: BigInt(Math.round(weight * 1000000)),
    }));

    if (allocations.length > 0) {
      await prisma.portfolioAllocation.createMany({ data: allocations as any });
    }

    res.json({
      status: 'executed',
      strategyId: strategy.id,
      allocations: allocations.length,
    });
  }),
);

/**
 * GET /discover/portfolio/performance — portfolio performance
 */
discoverRouter.get(
  '/portfolio/performance',
  asyncHandler(async (_req: Request, res: Response) => {
    const strategies = await prisma.portfolioStrategy.findMany({
      include: {
        allocations: {
          include: { tokenId: false },
          take: 100,
        },
      },
    });

    res.json({ data: strategies });
  }),
);

// ───────────────────────────────────────────────────────────────────────────────
// 9. Social Sentiment Endpoints
// ───────────────────────────────────────────────────────────────────────────────

/**
 * GET /discover/social/:tokenAddress — social metrics for token
 */
discoverRouter.get(
  '/social/:tokenAddress',
  asyncHandler(async (req: Request, res: Response) => {
    const token = await prisma.detectedToken.findUnique({
      where: { contractAddress: req.params.tokenAddress },
      select: { id: true },
    });

    if (!token) return res.status(404).json({ error: 'Token not found' });

    const signals = await prisma.socialSignal.findMany({
      where: { tokenId: token.id },
      orderBy: { timestamp: 'desc' },
      take: 100,
    });

    res.json({ data: signals });
  }),
);

/**
 * GET /discover/social/:tokenAddress/sentiment — sentiment timeline
 */
discoverRouter.get(
  '/social/:tokenAddress/sentiment',
  asyncHandler(async (req: Request, res: Response) => {
    const token = await prisma.detectedToken.findUnique({
      where: { contractAddress: req.params.tokenAddress },
      select: { id: true },
    });

    if (!token) return res.status(404).json({ error: 'Token not found' });

    const sentiments = await prisma.socialSignal.findMany({
      where: { tokenId: token.id, metric: 'sentiment_score' },
      orderBy: { timestamp: 'desc' },
      take: 50,
    });

    res.json({ data: sentiments });
  }),
);

// ── Service Info ─────────────────────────────────────────────────────────────

/**
 * GET /discover — service info
 */
discoverRouter.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({
      service: 'Token Discovery & Airdrop Detection Platform',
      version: '1.0.0',
      endpoints: {
        tokens: '/api/v1/discover/tokens',
        trending: '/api/v1/discover/trending',
        forensics: '/api/v1/discover/forensics',
        airdrops: '/api/v1/discover/airdrops',
        alerts: '/api/v1/discover/alerts',
        categories: '/api/v1/discover/categories',
        insider: '/api/v1/discover/insider',
        social: '/api/v1/discover/social',
        portfolio: '/api/v1/discover/portfolio',
      },
    });
  }),
);
