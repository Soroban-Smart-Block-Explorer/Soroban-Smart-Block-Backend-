import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../src/db', () => ({
  prismaRead: {
    nftCollection: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      aggregate: vi.fn(),
    },
    nftItem: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      groupBy: vi.fn(),
    },
    nftActivity: { findMany: vi.fn() },
    nftTrait: { findMany: vi.fn() },
    nftCollectionStats: { findMany: vi.fn() },
    nftListing: { findMany: vi.fn(), findFirst: vi.fn() },
    nftSale: { findMany: vi.fn(), groupBy: vi.fn(), count: vi.fn() },
    nftMarketplace: { findMany: vi.fn(), findUnique: vi.fn() },
  },
  prismaWrite: {
    nftCollection: { create: vi.fn() },
    alertConfiguration: { create: vi.fn() },
  },
}));

vi.mock('../../src/middleware/asyncHandler', () => ({
  asyncHandler: (fn: Mock) => {
    return (req: any, res: any, next: any) => {
      try {
        const result = fn(req, res, next);
        if (result && typeof result.catch === 'function') {
          result.catch(next);
        }
      } catch (err) {
        next(err);
      }
    };
  },
}));

vi.mock('../../src/middleware/errorHandler', () => ({
  AppError: class AppError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
  errorHandler: (err: any, _req: any, res: any, _next: any) => {
    // Zod validation errors → 400
    if (err?.name === 'ZodError' || err?.issues) {
      return res.status(400).json({ error: 'Validation failed', details: err.issues });
    }
    // AppError → use its status
    if (err?.status) {
      return res.status(err.status).json({ error: err.message });
    }
    // Default → 500
    res.status(500).json({ error: err.message || 'Internal server error' });
  },
}));

vi.mock('../../src/services/nft-rarity-engine', () => ({
  computeCollectionRarity: vi.fn(),
  getItemRarityDetail: vi.fn(),
  getCollectionRarityOverview: vi.fn(),
}));

vi.mock('../../src/services/nft-wash-trading', () => ({
  analyzeCollectionWashTrading: vi.fn(),
  getWashTradingAnalysis: vi.fn(),
  getWashTradingLeaderboard: vi.fn(),
}));

vi.mock('../../src/services/nft-portfolio-service', () => ({
  createPortfolio: vi.fn(),
  getPortfolio: vi.fn(),
  importPortfolioByAddress: vi.fn(),
  getPortfolioActivity: vi.fn(),
  getPortfolioValueHistory: vi.fn(),
}));

import * as db from '../../src/db';
import * as rarityEngine from '../../src/services/nft-rarity-engine';
import * as washTrading from '../../src/services/nft-wash-trading';
import * as portfolioService from '../../src/services/nft-portfolio-service';
import { nftRouter } from '../../src/api/nft';
import { errorHandler } from '../../src/middleware/errorHandler';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/nft', nftRouter);
  app.use(errorHandler);
  return app;
}

describe('GET /nft/collections', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns collections list with stats', async () => {
    vi.mocked(db.prismaRead.nftCollection.findMany).mockResolvedValue([
      {
        id: 'col-1',
        contractAddress: 'CA_COL',
        name: 'TestNFT',
        isSpam: false,
        floorPrice: null,
        floorPriceUsd: null,
        totalVolume: 0,
        volume24h: 0,
        volume7d: 0,
        volume30d: 0,
        marketCap: null,
        avgPrice24h: null,
        avgPrice7d: null,
      },
    ] as any);
    vi.mocked(db.prismaRead.nftCollection.count).mockResolvedValue(1);
    vi.mocked(db.prismaRead.nftCollection.aggregate).mockResolvedValue({
      _sum: { volume24h: 0 },
    } as any);

    const res = await request(makeApp()).get('/nft/collections');
    expect(res.status).toBe(200);
    expect(res.body.collections).toHaveLength(1);
    expect(res.body.stats.totalCollections).toBe(1);
  });

  it('returns empty list when no collections', async () => {
    vi.mocked(db.prismaRead.nftCollection.findMany).mockResolvedValue([]);
    vi.mocked(db.prismaRead.nftCollection.count).mockResolvedValue(0);
    vi.mocked(db.prismaRead.nftCollection.aggregate).mockResolvedValue({
      _sum: { volume24h: 0 },
    } as any);

    const res = await request(makeApp()).get('/nft/collections');
    expect(res.status).toBe(200);
    expect(res.body.collections).toHaveLength(0);
  });
});

describe('GET /nft/collections/:address', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 404 when collection not found', async () => {
    vi.mocked(db.prismaRead.nftCollection.findUnique).mockResolvedValue(null);
    const res = await request(makeApp()).get('/nft/collections/CA_UNKNOWN');
    expect(res.status).toBe(404);
  });

  it('returns collection data', async () => {
    vi.mocked(db.prismaRead.nftCollection.findUnique).mockResolvedValue({
      contractAddress: 'CA_COL',
      name: 'TestNFT',
      volume24h: 1000,
    } as any);

    const res = await request(makeApp()).get('/nft/collections/CA_COL');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('TestNFT');
  });
});

describe('POST /nft/collections/:address/register', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 409 when collection already exists', async () => {
    vi.mocked(db.prismaRead.nftCollection.findUnique).mockResolvedValue({
      contractAddress: 'CA_EXISTING',
    } as any);

    const res = await request(makeApp())
      .post('/nft/collections/CA_EXISTING/register')
      .send({ name: 'Existing' });

    expect(res.status).toBe(409);
  });

  it('creates new collection and returns 201', async () => {
    vi.mocked(db.prismaRead.nftCollection.findUnique).mockResolvedValue(null);
    vi.mocked(db.prismaWrite.nftCollection.create).mockResolvedValue({
      contractAddress: 'CA_NEW',
      name: 'New Collection',
      volume24h: 0,
    } as any);

    const res = await request(makeApp())
      .post('/nft/collections/CA_NEW/register')
      .send({ name: 'New Collection' });

    expect(res.status).toBe(201);
  });
});

describe('GET /nft/collections/:address/items', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 404 when collection not found', async () => {
    vi.mocked(db.prismaRead.nftCollection.findUnique).mockResolvedValue(null);
    const res = await request(makeApp()).get('/nft/collections/CA_UNKNOWN/items');
    expect(res.status).toBe(404);
  });

  it('returns paginated items', async () => {
    vi.mocked(db.prismaRead.nftCollection.findUnique).mockResolvedValue({ id: 'col-1' } as any);
    vi.mocked(db.prismaRead.nftItem.findMany).mockResolvedValue([
      {
        id: 'item-1',
        tokenId: '1',
        mintPrice: null,
        lastSalePrice: null,
        lastSalePriceUsd: null,
        listingPrice: null,
      },
    ] as any);

    const res = await request(makeApp()).get('/nft/collections/CA_COL/items');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
  });
});

describe('GET /nft/collections/:address/rarity', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 404 when collection not found', async () => {
    vi.mocked(db.prismaRead.nftCollection.findUnique).mockResolvedValue(null);
    const res = await request(makeApp()).get('/nft/collections/CA_UNKNOWN/rarity');
    expect(res.status).toBe(404);
  });

  it('returns 404 when rarity not computed', async () => {
    vi.mocked(db.prismaRead.nftCollection.findUnique).mockResolvedValue({ id: 'col-1' } as any);
    vi.mocked(rarityEngine.getCollectionRarityOverview).mockResolvedValue(null);

    const res = await request(makeApp()).get('/nft/collections/CA_COL/rarity');
    expect(res.status).toBe(404);
  });

  it('returns rarity overview', async () => {
    vi.mocked(db.prismaRead.nftCollection.findUnique).mockResolvedValue({ id: 'col-1' } as any);
    vi.mocked(rarityEngine.getCollectionRarityOverview).mockResolvedValue({
      distribution: { mythic: 1 },
    } as any);

    const res = await request(makeApp()).get('/nft/collections/CA_COL/rarity');
    expect(res.status).toBe(200);
  });
});

describe('GET /nft/wash-trading/leaderboard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns leaderboard', async () => {
    vi.mocked(washTrading.getWashTradingLeaderboard).mockResolvedValue([
      { contractAddress: 'CA_WASH', washVolume: 50000 },
    ] as any);

    const res = await request(makeApp()).get('/nft/wash-trading/leaderboard');
    expect(res.status).toBe(200);
    expect(res.body.leaderboard).toHaveLength(1);
  });
});

describe('POST /nft/portfolio', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates portfolio and returns 201', async () => {
    vi.mocked(portfolioService.createPortfolio).mockResolvedValue({
      id: 'port-1',
      owner: 'GA_OWNER',
    } as any);

    const res = await request(makeApp())
      .post('/nft/portfolio')
      .send({ owner: 'GA_OWNER', userId: 'user-1' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('port-1');
  });

  it('returns 400 for missing owner', async () => {
    const res = await request(makeApp()).post('/nft/portfolio').send({ userId: 'user-1' });

    expect(res.status).toBe(400);
  });
});

describe('GET /nft/portfolio/:id', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 404 when portfolio not found', async () => {
    vi.mocked(portfolioService.getPortfolio).mockResolvedValue(null);
    const res = await request(makeApp()).get('/nft/portfolio/nonexistent');
    expect(res.status).toBe(404);
  });

  it('returns portfolio data', async () => {
    vi.mocked(portfolioService.getPortfolio).mockResolvedValue({
      id: 'port-1',
      owner: 'GA_OWNER',
    } as any);

    const res = await request(makeApp()).get('/nft/portfolio/port-1');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('port-1');
  });
});

describe('GET /nft/trending', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns trending collections by volume', async () => {
    vi.mocked(db.prismaRead.nftCollection.findMany).mockResolvedValue([
      {
        id: 'col-1',
        contractAddress: 'CA_TREND',
        name: 'Trending',
        floorPrice: null,
        floorPriceUsd: null,
        volume24h: 5000,
        volume7d: 30000,
        marketCap: null,
        logoUri: null,
        category: 'art',
        isVerified: true,
        uniqueHolders: 100,
        symbol: 'TREND',
      },
    ] as any);

    const res = await request(makeApp()).get('/nft/trending');
    expect(res.status).toBe(200);
    expect(res.body.collections).toHaveLength(1);
    expect(res.body.by).toBe('volume');
  });
});

describe('GET /nft/marketplaces', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns active marketplaces', async () => {
    vi.mocked(db.prismaRead.nftMarketplace.findMany).mockResolvedValue([
      {
        contractAddress: 'CA_MP',
        name: 'TestMP',
        totalVolume: 1000000,
        volume24h: 50000,
        isActive: true,
      },
    ] as any);

    const res = await request(makeApp()).get('/nft/marketplaces');
    expect(res.status).toBe(200);
    expect(res.body.marketplaces).toHaveLength(1);
  });
});
