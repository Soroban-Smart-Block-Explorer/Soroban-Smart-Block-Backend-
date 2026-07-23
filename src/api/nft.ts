/**
 * NFT Collection Discovery, Rarity Engine, Marketplace Analytics & Portfolio Tracker
 *
 * Routes:
 *   GET  /nft/collections
 *   GET  /nft/collections/:address
 *   GET  /nft/collections/:address/items
 *   GET  /nft/collections/:address/items/:tokenId
 *   GET  /nft/collections/:address/activity
 *   GET  /nft/collections/:address/traits
 *   GET  /nft/collections/:address/charts
 *   GET  /nft/collections/:address/listings
 *   GET  /nft/collections/:address/sales
 *   GET  /nft/collections/:address/holders
 *   GET  /nft/collections/:address/rarity
 *   GET  /nft/collections/:address/items/:tokenId/rarity
 *   GET  /nft/collections/:address/wash-trading
 *   GET  /nft/collections/compare (POST)
 *   GET  /nft/marketplaces
 *   GET  /nft/marketplaces/:address
 *   GET  /nft/marketplaces/:address/collections
 *   GET  /nft/wash-trading/leaderboard
 *   POST /nft/portfolio
 *   GET  /nft/portfolio/:id
 *   GET  /nft/portfolio/:id/history
 *   GET  /nft/portfolio/:id/activity
 *   POST /nft/portfolio/import/:address
 *   GET  /nft/trending
 *   GET  /nft/search
 *   POST /nft/collections/:address/register
 */

import { Router } from 'express';
import { z } from 'zod';
import { prismaRead, prismaWrite } from '../db';
import { asyncHandler } from '../middleware/asyncHandler';
import { getItemRarityDetail, getCollectionRarityOverview } from '../services/nft-rarity-engine';
import { getWashTradingAnalysis, getWashTradingLeaderboard } from '../services/nft-wash-trading';
import {
  createPortfolio,
  getPortfolio,
  importPortfolioByAddress,
  getPortfolioActivity,
  getPortfolioValueHistory,
} from '../services/nft-portfolio-service';

export const nftRouter = Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

const collectionSortSchema = z
  .enum(['volume24h', 'volume7d', 'floorPrice', 'marketCap', 'uniqueHolders', 'detectedAt'])
  .default('volume24h');

function formatCollection(c: Record<string, unknown>) {
  return {
    ...c,
    floorPrice: c.floorPrice != null ? Number(c.floorPrice) : null,
    floorPriceUsd: c.floorPriceUsd != null ? Number(c.floorPriceUsd) : null,
    totalVolume: Number(c.totalVolume ?? 0),
    volume24h: Number(c.volume24h ?? 0),
    volume7d: Number(c.volume7d ?? 0),
    volume30d: Number(c.volume30d ?? 0),
    marketCap: c.marketCap != null ? Number(c.marketCap) : null,
    avgPrice24h: c.avgPrice24h != null ? Number(c.avgPrice24h) : null,
    avgPrice7d: c.avgPrice7d != null ? Number(c.avgPrice7d) : null,
  };
}

// ─── GET /nft/collections ─────────────────────────────────────────────────────

nftRouter.get(
  '/collections',
  asyncHandler(async (req, res) => {
    const { limit, cursor } = paginationSchema.parse(req.query);
    const sort = collectionSortSchema.parse(req.query.sort ?? 'volume24h');
    const category = typeof req.query.category === 'string' ? req.query.category : undefined;
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;

    const where: Record<string, unknown> = { isSpam: false };
    if (category) where.category = category;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { symbol: { contains: search, mode: 'insensitive' } },
        { contractAddress: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (cursor) where.id = { gt: cursor };

    const collections = await prismaRead.nftCollection.findMany({
      where,
      orderBy: [{ [sort]: 'desc' }, { id: 'asc' }],
      take: limit + 1,
    });

    const hasMore = collections.length > limit;
    const items = hasMore ? collections.slice(0, limit) : collections;
    const nextCursor = hasMore ? items[items.length - 1].id : undefined;

    const [totalCollections, volumeAgg] = await Promise.all([
      prismaRead.nftCollection.count({ where: { isSpam: false } }),
      prismaRead.nftCollection.aggregate({
        _sum: { volume24h: true },
        where: { isSpam: false },
      }),
    ]);

    res.json({
      collections: items.map(formatCollection),
      pagination: { cursor: nextCursor, hasMore },
      stats: {
        totalCollections,
        totalVolume24h: Number(volumeAgg._sum.volume24h ?? 0),
      },
    });
  }),
);

// ─── POST /nft/collections/:address/register ──────────────────────────────────

nftRouter.post(
  '/collections/:address/register',
  asyncHandler(async (req, res) => {
    const { address } = req.params;
    const body = z
      .object({
        name: z.string().max(256).optional(),
        symbol: z.string().max(32).optional(),
        category: z.string().max(64).optional(),
        description: z.string().max(2048).optional(),
        website: z.string().url().optional(),
        logoUri: z.string().url().optional(),
      })
      .parse(req.body);

    const existing = await prismaRead.nftCollection.findUnique({
      where: { contractAddress: address },
    });
    if (existing) return res.status(409).json({ error: 'Collection already registered' });

    const collection = await prismaWrite.nftCollection.create({
      data: { contractAddress: address, detectedAt: new Date(), ...body },
    });
    res.status(201).json(formatCollection(collection as unknown as Record<string, unknown>));
  }),
);

// ─── GET /nft/collections/:address ───────────────────────────────────────────

nftRouter.get(
  '/collections/:address',
  asyncHandler(async (req, res) => {
    const { address } = req.params;
    const include = (req.query.include as string | undefined)?.split(',') ?? [];

    const collection = await prismaRead.nftCollection.findUnique({
      where: { contractAddress: address },
      include: {
        traits: include.includes('traits'),
        stats: include.includes('stats')
          ? { orderBy: { timestamp: 'desc' as const }, take: 1 }
          : false,
        sales: include.includes('sales')
          ? { orderBy: { saleAt: 'desc' as const }, take: 10 }
          : false,
        listings: include.includes('listings')
          ? { where: { status: 'active' }, orderBy: { price: 'asc' as const }, take: 10 }
          : false,
      },
    });

    if (!collection) return res.status(404).json({ error: 'Collection not found' });
    res.json(formatCollection(collection as unknown as Record<string, unknown>));
  }),
);

// ─── GET /nft/collections/:address/items ─────────────────────────────────────

nftRouter.get(
  '/collections/:address/items',
  asyncHandler(async (req, res) => {
    const { address } = req.params;
    const { limit, cursor } = paginationSchema.parse(req.query);
    const sort = z
      .enum(['rarity', 'price', 'lastSale', 'tokenId'])
      .default('rarity')
      .parse(req.query.sort ?? 'rarity');
    const order = z
      .enum(['asc', 'desc'])
      .default('asc')
      .parse(req.query.order ?? 'asc');
    const owner = typeof req.query.owner === 'string' ? req.query.owner : undefined;
    const attributes = typeof req.query.attributes === 'string' ? req.query.attributes : undefined;

    const collection = await prismaRead.nftCollection.findUnique({
      where: { contractAddress: address },
      select: { id: true },
    });
    if (!collection) return res.status(404).json({ error: 'Collection not found' });

    const where: Record<string, unknown> = { collectionId: collection.id };
    if (owner) where.owner = owner;
    if (cursor) where.id = { gt: cursor };

    // Parse attribute filters: "background:red,skin:gold"
    if (attributes) {
      const attrFilters = attributes
        .split(',')
        .map((a) => {
          const [type, value] = a.split(':');
          return { type: type.trim(), value: value?.trim() };
        })
        .filter((a) => a.type && a.value);

      if (attrFilters.length > 0) {
        // Filter items whose metadata contains all specified traits
        where.AND = attrFilters.map((af) => ({
          metadata: {
            path: ['attributes'],
            array_contains: [{ trait_type: af.type, value: af.value }],
          },
        }));
      }
    }

    const orderByMap: Record<string, Record<string, unknown>> = {
      rarity: { rarityScore: order },
      price: { listingPrice: order },
      lastSale: { lastSaleAt: order },
      tokenId: { tokenId: order },
    };

    const items = await prismaRead.nftItem.findMany({
      where,
      orderBy: orderByMap[sort] ?? { rarityScore: 'asc' },
      take: limit + 1,
    });

    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;

    res.json({
      items: page.map((item) => ({
        ...item,
        mintPrice: item.mintPrice ? Number(item.mintPrice) : null,
        lastSalePrice: item.lastSalePrice ? Number(item.lastSalePrice) : null,
        lastSalePriceUsd: item.lastSalePriceUsd ? Number(item.lastSalePriceUsd) : null,
        listingPrice: item.listingPrice ? Number(item.listingPrice) : null,
      })),
      pagination: { cursor: hasMore ? page[page.length - 1].id : undefined, hasMore },
    });
  }),
);

// ─── GET /nft/collections/:address/items/:tokenId ────────────────────────────

nftRouter.get(
  '/collections/:address/items/:tokenId',
  asyncHandler(async (req, res) => {
    const { address, tokenId } = req.params;

    const collection = await prismaRead.nftCollection.findUnique({
      where: { contractAddress: address },
      select: { id: true },
    });
    if (!collection) return res.status(404).json({ error: 'Collection not found' });

    const item = await prismaRead.nftItem.findUnique({
      where: { collectionId_tokenId: { collectionId: collection.id, tokenId } },
    });
    if (!item) return res.status(404).json({ error: 'Item not found' });

    res.json({
      ...item,
      mintPrice: item.mintPrice ? Number(item.mintPrice) : null,
      lastSalePrice: item.lastSalePrice ? Number(item.lastSalePrice) : null,
      lastSalePriceUsd: item.lastSalePriceUsd ? Number(item.lastSalePriceUsd) : null,
      listingPrice: item.listingPrice ? Number(item.listingPrice) : null,
    });
  }),
);

// ─── GET /nft/collections/:address/activity ───────────────────────────────────

nftRouter.get(
  '/collections/:address/activity',
  asyncHandler(async (req, res) => {
    const { address } = req.params;
    const { limit, cursor } = paginationSchema.parse(req.query);
    const types = typeof req.query.types === 'string' ? req.query.types.split(',') : undefined;
    const fromDate = typeof req.query.from === 'string' ? new Date(req.query.from) : undefined;

    const collection = await prismaRead.nftCollection.findUnique({
      where: { contractAddress: address },
      select: { id: true },
    });
    if (!collection) return res.status(404).json({ error: 'Collection not found' });

    const where: Record<string, unknown> = { collectionId: collection.id };
    if (types?.length) where.activityType = { in: types };
    if (fromDate) where.occurredAt = { gte: fromDate };
    if (cursor) where.id = { gt: cursor };

    const activity = await prismaRead.nftActivity.findMany({
      where,
      orderBy: { occurredAt: 'desc' },
      take: limit + 1,
    });

    const hasMore = activity.length > limit;
    res.json({
      activity: (hasMore ? activity.slice(0, limit) : activity).map((a) => ({
        ...a,
        price: a.price ? Number(a.price) : null,
        priceUsd: a.priceUsd ? Number(a.priceUsd) : null,
      })),
      pagination: { cursor: hasMore ? activity[limit - 1]?.id : undefined, hasMore },
    });
  }),
);

// ─── GET /nft/collections/:address/traits ─────────────────────────────────────

nftRouter.get(
  '/collections/:address/traits',
  asyncHandler(async (req, res) => {
    const { address } = req.params;

    const collection = await prismaRead.nftCollection.findUnique({
      where: { contractAddress: address },
      select: { id: true, totalSupply: true },
    });
    if (!collection) return res.status(404).json({ error: 'Collection not found' });

    const totalSupply = collection.totalSupply || 1;
    const traits = await prismaRead.nftTrait.findMany({
      where: { collectionId: collection.id },
      orderBy: [{ traitType: 'asc' }, { count: 'desc' }],
    });

    // Group by traitType
    const grouped = new Map<
      string,
      Array<{
        value: string;
        count: number;
        rarityScore: number | null;
        rarityTier: string | null;
        pct: number;
      }>
    >();

    for (const t of traits) {
      const arr = grouped.get(t.traitType) ?? [];
      arr.push({
        value: t.traitValue,
        count: t.count,
        rarityScore: t.rarityScore,
        rarityTier: t.rarityTier,
        pct: Math.round((t.count / totalSupply) * 10000) / 100,
      });
      grouped.set(t.traitType, arr);
    }

    const traitTypes = Array.from(grouped.entries()).map(([traitType, values]) => ({
      traitType,
      values,
    }));

    res.json({
      traits: traitTypes,
      uniqueTraitCount: traits.length,
      maxTraitCombinations: traitTypes.reduce((acc, t) => acc * t.values.length, 1),
    });
  }),
);

// ─── GET /nft/collections/:address/charts ─────────────────────────────────────

nftRouter.get(
  '/collections/:address/charts',
  asyncHandler(async (req, res) => {
    const { address } = req.params;
    const period = z
      .enum(['1h', '24h', '7d', '30d'])
      .default('7d')
      .parse(req.query.period ?? '7d');

    const collection = await prismaRead.nftCollection.findUnique({
      where: { contractAddress: address },
      select: { id: true },
    });
    if (!collection) return res.status(404).json({ error: 'Collection not found' });

    const periodMs: Record<string, number> = {
      '1h': 60 * 60 * 1000,
      '24h': 24 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000,
      '30d': 30 * 24 * 60 * 60 * 1000,
    };
    const cutoff = new Date(Date.now() - periodMs[period]);

    const stats = await prismaRead.nftCollectionStats.findMany({
      where: { collectionId: collection.id, timestamp: { gte: cutoff } },
      orderBy: { timestamp: 'asc' },
      select: {
        timestamp: true,
        floorPrice: true,
        floorPriceUsd: true,
        volume24h: true,
        avgPrice24h: true,
        uniqueHolders: true,
        washVolume24h: true,
      },
    });

    res.json({
      period,
      floorPriceHistory: stats.map((s) => ({
        t: s.timestamp,
        v: s.floorPrice ? Number(s.floorPrice) : null,
        usd: s.floorPriceUsd ? Number(s.floorPriceUsd) : null,
      })),
      volumeHistory: stats.map((s) => ({
        t: s.timestamp,
        v: Number(s.volume24h),
        washV: Number(s.washVolume24h),
      })),
      holderHistory: stats.map((s) => ({ t: s.timestamp, v: s.uniqueHolders })),
      avgPriceHistory: stats.map((s) => ({
        t: s.timestamp,
        v: s.avgPrice24h ? Number(s.avgPrice24h) : null,
      })),
    });
  }),
);

// ─── GET /nft/collections/:address/listings ───────────────────────────────────

nftRouter.get(
  '/collections/:address/listings',
  asyncHandler(async (req, res) => {
    const { address } = req.params;
    const { limit, cursor } = paginationSchema.parse(req.query);
    const marketplace =
      typeof req.query.marketplace === 'string' ? req.query.marketplace : undefined;
    const seller = typeof req.query.seller === 'string' ? req.query.seller : undefined;
    const minPrice = req.query.minPrice ? Number(req.query.minPrice) : undefined;
    const maxPrice = req.query.maxPrice ? Number(req.query.maxPrice) : undefined;

    const collection = await prismaRead.nftCollection.findUnique({
      where: { contractAddress: address },
      select: { id: true },
    });
    if (!collection) return res.status(404).json({ error: 'Collection not found' });

    const where: Record<string, unknown> = { collectionId: collection.id, status: 'active' };
    if (marketplace) where.marketplace = marketplace;
    if (seller) where.seller = seller;
    if (minPrice != null || maxPrice != null) {
      where.price = {};
      if (minPrice != null) (where.price as Record<string, unknown>).gte = minPrice;
      if (maxPrice != null) (where.price as Record<string, unknown>).lte = maxPrice;
    }
    if (cursor) where.id = { gt: cursor };

    const listings = await prismaRead.nftListing.findMany({
      where,
      orderBy: { price: 'asc' },
      take: limit + 1,
    });

    const hasMore = listings.length > limit;
    res.json({
      listings: (hasMore ? listings.slice(0, limit) : listings).map((l) => ({
        ...l,
        price: Number(l.price),
        priceUsd: l.priceUsd ? Number(l.priceUsd) : null,
      })),
      pagination: { cursor: hasMore ? listings[limit - 1]?.id : undefined, hasMore },
    });
  }),
);

// ─── GET /nft/collections/:address/sales ─────────────────────────────────────

nftRouter.get(
  '/collections/:address/sales',
  asyncHandler(async (req, res) => {
    const { address } = req.params;
    const { limit, cursor } = paginationSchema.parse(req.query);
    const washOnly = req.query.washOnly === 'true';

    const collection = await prismaRead.nftCollection.findUnique({
      where: { contractAddress: address },
      select: { id: true },
    });
    if (!collection) return res.status(404).json({ error: 'Collection not found' });

    const where: Record<string, unknown> = { collectionId: collection.id };
    if (washOnly) where.isWashTrade = true;
    if (cursor) where.id = { gt: cursor };

    const sales = await prismaRead.nftSale.findMany({
      where,
      orderBy: { saleAt: 'desc' },
      take: limit + 1,
    });

    const hasMore = sales.length > limit;
    res.json({
      sales: (hasMore ? sales.slice(0, limit) : sales).map((s) => ({
        ...s,
        price: Number(s.price),
        priceUsd: s.priceUsd ? Number(s.priceUsd) : null,
      })),
      pagination: { cursor: hasMore ? sales[limit - 1]?.id : undefined, hasMore },
    });
  }),
);

// ─── GET /nft/collections/:address/holders ────────────────────────────────────

nftRouter.get(
  '/collections/:address/holders',
  asyncHandler(async (req, res) => {
    const { address } = req.params;
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(500)
      .default(100)
      .parse(req.query.limit ?? 100);

    const collection = await prismaRead.nftCollection.findUnique({
      where: { contractAddress: address },
      select: { id: true, uniqueHolders: true, totalSupply: true },
    });
    if (!collection) return res.status(404).json({ error: 'Collection not found' });

    const holderGroups = await prismaRead.nftItem.groupBy({
      by: ['owner'],
      where: { collectionId: collection.id },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: limit,
    });

    const totalHolders = collection.uniqueHolders;
    const totalSupply = collection.totalSupply || 1;

    const distribution = holderGroups.map((h) => ({
      holder: h.owner,
      balance: h._count.id,
      pct: Math.round((h._count.id / totalSupply) * 10000) / 100,
    }));

    // Concentration metrics
    const top10 = distribution.slice(0, 10);
    const top50 = distribution.slice(0, 50);
    const top10Pct = top10.reduce((s, h) => s + h.pct, 0);
    const top50Pct = top50.reduce((s, h) => s + h.pct, 0);

    res.json({
      totalHolders,
      distribution,
      concentration: {
        top10Pct: Math.round(top10Pct * 100) / 100,
        top50Pct: Math.round(top50Pct * 100) / 100,
      },
    });
  }),
);

// ─── GET /nft/collections/:address/rarity ─────────────────────────────────────

nftRouter.get(
  '/collections/:address/rarity',
  asyncHandler(async (req, res) => {
    const { address } = req.params;
    const collection = await prismaRead.nftCollection.findUnique({
      where: { contractAddress: address },
      select: { id: true },
    });
    if (!collection) return res.status(404).json({ error: 'Collection not found' });

    const overview = await getCollectionRarityOverview(collection.id);
    if (!overview) return res.status(404).json({ error: 'Rarity not yet computed' });
    res.json(overview);
  }),
);

// ─── GET /nft/collections/:address/items/:tokenId/rarity ─────────────────────

nftRouter.get(
  '/collections/:address/items/:tokenId/rarity',
  asyncHandler(async (req, res) => {
    const { address, tokenId } = req.params;
    const collection = await prismaRead.nftCollection.findUnique({
      where: { contractAddress: address },
      select: { id: true },
    });
    if (!collection) return res.status(404).json({ error: 'Collection not found' });

    const detail = await getItemRarityDetail(collection.id, tokenId);
    if (!detail) return res.status(404).json({ error: 'Rarity not computed for this item' });
    res.json(detail);
  }),
);

// ─── GET /nft/collections/:address/items/:tokenId/score ───────────────────────
// P2: Composite NFT scoring

nftRouter.get(
  '/collections/:address/items/:tokenId/score',
  asyncHandler(async (req, res) => {
    const { address, tokenId } = req.params;
    const collection = await prismaRead.nftCollection.findUnique({
      where: { contractAddress: address },
      select: { id: true, totalSupply: true },
    });
    if (!collection) return res.status(404).json({ error: 'Collection not found' });

    const item = await prismaRead.nftItem.findUnique({
      where: { collectionId_tokenId: { collectionId: collection.id, tokenId } },
      select: { rarityScore: true, rarityRank: true, lastSalePrice: true, metadata: true },
    });
    if (!item) return res.status(404).json({ error: 'Item not found' });

    const totalItems = await prismaRead.nftItem.count({ where: { collectionId: collection.id } });

    // Rarity component (40%)
    const maxPossibleRarity = totalItems; // rough upper bound
    const rarityComponent = item.rarityScore
      ? Math.min(100, (item.rarityScore / maxPossibleRarity) * 100)
      : 0;

    // Volume component (20%) — proxy: does the item have sale history?
    const salesCount = await prismaRead.nftSale.count({
      where: { collectionId: collection.id, tokenId, isWashTrade: false },
    });
    const volumeComponent = Math.min(100, salesCount * 10);

    // Holder concentration (15%) — lower concentration = higher score
    const collectionData = await prismaRead.nftCollection.findUnique({
      where: { id: collection.id },
      select: { uniqueHolders: true, totalSupply: true },
    });
    const holderRatio = collectionData
      ? collectionData.uniqueHolders / (collectionData.totalSupply || 1)
      : 0.5;
    const holderComponent = Math.min(100, holderRatio * 100);

    // Price stability (15%) — items with multiple sales and stable pricing score higher
    const priceStabilityComponent = Math.min(100, salesCount >= 3 ? 70 : salesCount * 20);

    // Metadata quality (10%) — check completeness
    const meta = item.metadata as Record<string, unknown> | null;
    const metaFields = meta
      ? ['name', 'description', 'image', 'attributes'].filter((f) => !!meta[f]).length
      : 0;
    const metadataComponent = (metaFields / 4) * 100;

    const compositeScore = Math.round(
      rarityComponent * 0.4 +
        volumeComponent * 0.2 +
        holderComponent * 0.15 +
        priceStabilityComponent * 0.15 +
        metadataComponent * 0.1,
    );

    res.json({
      tokenId,
      compositeScore,
      breakdown: {
        rarity: { score: Math.round(rarityComponent), weight: 0.4 },
        volume: { score: Math.round(volumeComponent), weight: 0.2 },
        holderConcentration: { score: Math.round(holderComponent), weight: 0.15 },
        priceStability: { score: Math.round(priceStabilityComponent), weight: 0.15 },
        metadataQuality: { score: Math.round(metadataComponent), weight: 0.1 },
      },
    });
  }),
);

// ─── GET /nft/collections/:address/wash-trading ───────────────────────────────

nftRouter.get(
  '/collections/:address/wash-trading',
  asyncHandler(async (req, res) => {
    const { address } = req.params;
    const collection = await prismaRead.nftCollection.findUnique({
      where: { contractAddress: address },
      select: { id: true },
    });
    if (!collection) return res.status(404).json({ error: 'Collection not found' });

    const analysis = await getWashTradingAnalysis(collection.id);
    res.json(analysis);
  }),
);

// ─── GET /nft/collections/:address/floor-history ─────────────────────────────

nftRouter.get(
  '/collections/:address/floor-history',
  asyncHandler(async (req, res) => {
    const { address } = req.params;
    const period = z
      .enum(['24h', '7d', '30d', 'all'])
      .default('30d')
      .parse(req.query.period ?? '30d');

    const collection = await prismaRead.nftCollection.findUnique({
      where: { contractAddress: address },
      select: { id: true },
    });
    if (!collection) return res.status(404).json({ error: 'Collection not found' });

    const periodMs: Record<string, number> = {
      '24h': 24 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000,
      '30d': 30 * 24 * 60 * 60 * 1000,
    };
    const where: Record<string, unknown> = { collectionId: collection.id };
    if (period !== 'all') where.timestamp = { gte: new Date(Date.now() - periodMs[period]) };

    const stats = await prismaRead.nftCollectionStats.findMany({
      where,
      orderBy: { timestamp: 'asc' },
      select: { timestamp: true, floorPrice: true, floorPriceUsd: true, volume24h: true },
    });

    // Build OHLC candles grouped by day
    const byDay = new Map<
      string,
      { open: number; high: number; low: number; close: number; vol: number }
    >();
    for (const s of stats) {
      const day = s.timestamp.toISOString().slice(0, 10);
      const fp = s.floorPrice ? Number(s.floorPrice) : null;
      if (fp === null) continue;
      const existing = byDay.get(day);
      if (!existing) {
        byDay.set(day, { open: fp, high: fp, low: fp, close: fp, vol: Number(s.volume24h) });
      } else {
        existing.high = Math.max(existing.high, fp);
        existing.low = Math.min(existing.low, fp);
        existing.close = fp;
        existing.vol += Number(s.volume24h);
      }
    }

    res.json({
      period,
      candles: Array.from(byDay.entries()).map(([date, c]) => ({ date, ...c })),
    });
  }),
);

// ─── POST /nft/alerts (floor price alerts) ────────────────────────────────────

nftRouter.post(
  '/alerts',
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        collection: z.string(),
        type: z.enum(['floor_change', 'volume_spike', 'whale_buy']),
        condition: z.enum(['dropsBelow', 'risesAbove', 'changesBy']),
        threshold: z.string(),
        channels: z.array(z.enum(['email', 'webhook', 'discord'])).default(['webhook']),
      })
      .parse(req.body);

    // Persist via AlertConfiguration model (reusing existing alerts table)
    const alert = await prismaWrite.alertConfiguration.create({
      data: {
        userId: 'nft-alert',
        contractAddress: body.collection,
        name: `NFT ${body.type} alert`,
        alertType: body.type,
        conditions: { condition: body.condition, threshold: body.threshold },
        channels: body.channels,
      },
    });

    res.status(201).json({ id: alert.id, ...body });
  }),
);

// ─── GET /nft/wash-trading/leaderboard ───────────────────────────────────────

nftRouter.get(
  '/wash-trading/leaderboard',
  asyncHandler(async (req, res) => {
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(50)
      .default(20)
      .parse(req.query.limit ?? 20);
    const leaderboard = await getWashTradingLeaderboard(limit);
    res.json({ leaderboard });
  }),
);

// ─── GET /nft/marketplaces ────────────────────────────────────────────────────

nftRouter.get(
  '/marketplaces',
  asyncHandler(async (req, res) => {
    const marketplaces = await prismaRead.nftMarketplace.findMany({
      where: { isActive: true },
      orderBy: { volume24h: 'desc' },
    });
    res.json({
      marketplaces: marketplaces.map((m) => ({
        ...m,
        totalVolume: Number(m.totalVolume),
        volume24h: Number(m.volume24h),
      })),
    });
  }),
);

// ─── GET /nft/marketplaces/:address ──────────────────────────────────────────

nftRouter.get(
  '/marketplaces/:address',
  asyncHandler(async (req, res) => {
    const mp = await prismaRead.nftMarketplace.findUnique({
      where: { contractAddress: req.params.address },
    });
    if (!mp) return res.status(404).json({ error: 'Marketplace not found' });
    res.json({ ...mp, totalVolume: Number(mp.totalVolume), volume24h: Number(mp.volume24h) });
  }),
);

// ─── GET /nft/marketplaces/:address/collections ──────────────────────────────

nftRouter.get(
  '/marketplaces/:address/collections',
  asyncHandler(async (req, res) => {
    const { address } = req.params;
    const { limit, cursor } = paginationSchema.parse(req.query);

    // Find collections that have listings or sales on this marketplace
    const where: Record<string, unknown> = { marketplace: address };
    if (cursor) where.id = { gt: cursor };

    const listings = await prismaRead.nftListing.findMany({
      where: { marketplace: address },
      select: { collectionId: true },
      distinct: ['collectionId'],
      take: limit + 1,
    });

    const collectionIds = listings.map((l) => l.collectionId);
    const collections = await prismaRead.nftCollection.findMany({
      where: { id: { in: collectionIds } },
      orderBy: { volume24h: 'desc' },
    });

    const hasMore = collectionIds.length > limit;
    res.json({
      collections: (hasMore ? collections.slice(0, limit) : collections).map(formatCollection),
      pagination: { cursor: hasMore ? collectionIds[limit - 1] : undefined, hasMore },
    });
  }),
);

// ─── POST /nft/portfolio ──────────────────────────────────────────────────────

nftRouter.post(
  '/portfolio',
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        owner: z.string().min(1),
        name: z.string().max(256).optional(),
        userId: z.string().default('anonymous'),
      })
      .parse(req.body);

    const portfolio = await createPortfolio(body.userId, body.owner, body.name);
    res.status(201).json(portfolio);
  }),
);

// ─── GET /nft/portfolio/:id ───────────────────────────────────────────────────

nftRouter.get(
  '/portfolio/:id',
  asyncHandler(async (req, res) => {
    const portfolio = await getPortfolio(req.params.id);
    if (!portfolio) return res.status(404).json({ error: 'Portfolio not found' });
    res.json(portfolio);
  }),
);

// ─── GET /nft/portfolio/:id/history ──────────────────────────────────────────

nftRouter.get(
  '/portfolio/:id/history',
  asyncHandler(async (req, res) => {
    const history = await getPortfolioValueHistory(req.params.id);
    if (!history) return res.status(404).json({ error: 'Portfolio not found' });
    res.json({ history });
  }),
);

// ─── GET /nft/portfolio/:id/activity ─────────────────────────────────────────

nftRouter.get(
  '/portfolio/:id/activity',
  asyncHandler(async (req, res) => {
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(50)
      .parse(req.query.limit ?? 50);
    const activity = await getPortfolioActivity(req.params.id, limit);
    if (!activity) return res.status(404).json({ error: 'Portfolio not found' });
    res.json({ activity });
  }),
);

// ─── POST /nft/portfolio/import/:address ─────────────────────────────────────

nftRouter.post(
  '/portfolio/import/:address',
  asyncHandler(async (req, res) => {
    const userId = (req.query.userId as string) ?? 'anonymous';
    const result = await importPortfolioByAddress(userId, req.params.address);
    res.status(201).json(result);
  }),
);

// ─── GET /nft/trending ───────────────────────────────────────────────────────

nftRouter.get(
  '/trending',
  asyncHandler(async (req, res) => {
    const by = z
      .enum(['volume', 'holders', 'floor', 'wash_adjusted'])
      .default('volume')
      .parse(req.query.by ?? 'volume');
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(50)
      .default(20)
      .parse(req.query.limit ?? 20);

    const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const cutoff48h = new Date(Date.now() - 48 * 60 * 60 * 1000);

    let orderBy: Record<string, string>;
    switch (by) {
      case 'holders':
        orderBy = { uniqueHolders: 'desc' };
        break;
      case 'floor':
        orderBy = { floorPrice: 'desc' };
        break;
      default:
        orderBy = { volume24h: 'desc' };
    }

    const collections = await prismaRead.nftCollection.findMany({
      where: { isSpam: false },
      orderBy,
      take: limit,
      select: {
        id: true,
        contractAddress: true,
        name: true,
        symbol: true,
        floorPrice: true,
        floorPriceUsd: true,
        volume24h: true,
        volume7d: true,
        uniqueHolders: true,
        marketCap: true,
        logoUri: true,
        category: true,
        isVerified: true,
      },
    });

    // For wash_adjusted: fetch wash stats and filter/sort
    if (by === 'wash_adjusted') {
      const washStats = await prismaRead.nftSale.groupBy({
        by: ['collectionId'],
        where: { isWashTrade: true, saleAt: { gte: cutoff24h } },
        _sum: { price: true },
      });
      const washMap = new Map(washStats.map((w) => [w.collectionId, Number(w._sum.price ?? 0)]));

      const scored = collections
        .map((c) => ({
          ...c,
          floorPrice: c.floorPrice ? Number(c.floorPrice) : null,
          floorPriceUsd: c.floorPriceUsd ? Number(c.floorPriceUsd) : null,
          volume24h: Number(c.volume24h),
          volume7d: Number(c.volume7d),
          marketCap: c.marketCap ? Number(c.marketCap) : null,
          washVolume24h: washMap.get(c.id) ?? 0,
          washAdjustedVolume24h: Number(c.volume24h) - (washMap.get(c.id) ?? 0),
        }))
        .sort((a, b) => b.washAdjustedVolume24h - a.washAdjustedVolume24h);

      return res.json({ by, collections: scored });
    }

    res.json({
      by,
      collections: collections.map((c) => ({
        ...c,
        floorPrice: c.floorPrice ? Number(c.floorPrice) : null,
        floorPriceUsd: c.floorPriceUsd ? Number(c.floorPriceUsd) : null,
        volume24h: Number(c.volume24h),
        volume7d: Number(c.volume7d),
        marketCap: c.marketCap ? Number(c.marketCap) : null,
      })),
    });
  }),
);

// ─── GET /nft/search ──────────────────────────────────────────────────────────

nftRouter.get(
  '/search',
  asyncHandler(async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const collections =
      typeof req.query.collections === 'string'
        ? req.query.collections.split(',').filter(Boolean)
        : undefined;
    const { limit, cursor } = paginationSchema.parse(req.query);
    const priceMin = req.query.priceMin ? Number(req.query.priceMin) : undefined;
    const priceMax = req.query.priceMax ? Number(req.query.priceMax) : undefined;
    const rarityTier = typeof req.query.rarityTier === 'string' ? req.query.rarityTier : undefined;

    if (!q) return res.json({ collections: [], items: [], suggestions: [] });

    // Collection search
    const collectionResults = await prismaRead.nftCollection.findMany({
      where: {
        isSpam: false,
        ...(collections ? { contractAddress: { in: collections } } : {}),
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { symbol: { contains: q, mode: 'insensitive' } },
          { contractAddress: { contains: q, mode: 'insensitive' } },
          { description: { contains: q, mode: 'insensitive' } },
        ],
      },
      take: 10,
      select: {
        contractAddress: true,
        name: true,
        symbol: true,
        logoUri: true,
        floorPriceUsd: true,
        volume24h: true,
      },
    });

    // Item search (by token ID or metadata name)
    const itemWhere: Record<string, unknown> = {
      OR: [{ tokenId: { contains: q, mode: 'insensitive' } }],
    };
    if (collections) {
      const colIds = await prismaRead.nftCollection.findMany({
        where: { contractAddress: { in: collections } },
        select: { id: true },
      });
      itemWhere.collectionId = { in: colIds.map((c) => c.id) };
    }
    if (priceMin != null || priceMax != null) {
      itemWhere.listingPrice = {};
      if (priceMin != null) (itemWhere.listingPrice as Record<string, unknown>).gte = priceMin;
      if (priceMax != null) (itemWhere.listingPrice as Record<string, unknown>).lte = priceMax;
    }
    if (rarityTier) {
      // Join via traits is complex — use rarityScore ranges
      const tierRanges: Record<string, [number, number]> = {
        mythic: [200, 1e9],
        legendary: [50, 200],
        epic: [10, 50],
        rare: [3, 10],
        uncommon: [1, 3],
        common: [0, 1],
      };
      const range = tierRanges[rarityTier.toLowerCase()];
      if (range) {
        itemWhere.rarityScore = { gte: range[0], lt: range[1] };
      }
    }
    if (cursor) itemWhere.id = { gt: cursor };

    const items = await prismaRead.nftItem.findMany({
      where: itemWhere,
      orderBy: { rarityScore: 'desc' },
      take: limit + 1,
      include: { collection: { select: { contractAddress: true, name: true } } },
    });

    const hasMore = items.length > limit;

    res.json({
      collections: collectionResults.map((c) => ({
        ...c,
        floorPriceUsd: c.floorPriceUsd ? Number(c.floorPriceUsd) : null,
        volume24h: Number(c.volume24h),
      })),
      items: (hasMore ? items.slice(0, limit) : items).map((i) => ({
        id: i.id,
        tokenId: i.tokenId,
        owner: i.owner,
        rarityScore: i.rarityScore,
        rarityRank: i.rarityRank,
        listingPrice: i.listingPrice ? Number(i.listingPrice) : null,
        collection: i.collection,
      })),
      pagination: { cursor: hasMore ? items[limit - 1]?.id : undefined, hasMore },
      suggestions: collectionResults
        .slice(0, 5)
        .map((c) => c.name)
        .filter(Boolean),
    });
  }),
);

// ─── POST /nft/collections/compare ───────────────────────────────────────────

nftRouter.post(
  '/collections/compare',
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        collections: z.array(z.string()).min(2).max(5),
        metrics: z
          .array(z.string())
          .default(['volume24h', 'floorPrice', 'uniqueHolders', 'washVolumePct']),
      })
      .parse(req.body);

    const collections = await prismaRead.nftCollection.findMany({
      where: { contractAddress: { in: body.collections }, isSpam: false },
    });

    // Fetch wash trading data for wash volume percentage
    const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const washData = await prismaRead.nftSale.groupBy({
      by: ['collectionId'],
      where: {
        collectionId: { in: collections.map((c) => c.id) },
        isWashTrade: true,
        saleAt: { gte: cutoff24h },
      },
      _sum: { price: true },
    });
    const washMap = new Map(washData.map((w) => [w.collectionId, Number(w._sum.price ?? 0)]));

    const rows = collections.map((c) => {
      const washVol = washMap.get(c.id) ?? 0;
      const totalVol = Number(c.volume24h);
      return {
        contractAddress: c.contractAddress,
        name: c.name,
        volume24h: totalVol,
        volume7d: Number(c.volume7d),
        floorPrice: c.floorPrice ? Number(c.floorPrice) : null,
        floorPriceUsd: c.floorPriceUsd ? Number(c.floorPriceUsd) : null,
        uniqueHolders: c.uniqueHolders,
        totalSupply: c.totalSupply,
        marketCap: c.marketCap ? Number(c.marketCap) : null,
        washVolume24h: washVol,
        washVolumePct: totalVol > 0 ? Math.round((washVol / totalVol) * 10000) / 100 : 0,
        logoUri: c.logoUri,
        isVerified: c.isVerified,
      };
    });

    res.json({ metrics: body.metrics, rows });
  }),
);
