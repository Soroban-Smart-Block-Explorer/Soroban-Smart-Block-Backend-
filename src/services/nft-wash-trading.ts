/**
 * NFT Wash Trading Detection
 *
 * Detects and scores wash trading patterns:
 *  1. Self-sales (buyer == seller after routing)
 *  2. Same-item round-trip within configurable time window
 *  3. Circular trades (A→B→C→A)
 *  4. Rapid back-and-forth between 2 wallets
 *  5. Extreme price manipulation signals
 */

import { prismaRead, prismaWrite } from '../db';
import { logger } from '../logger';

const ROUND_TRIP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const RAPID_TRADE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
const RAPID_TRADE_MIN_COUNT = 3; // 3+ trades between same pair
const PRICE_SPIKE_THRESHOLD = 5; // 5x price change = suspicious

interface SaleRecord {
  id: string;
  tokenId: string;
  seller: string;
  buyer: string;
  price: number;
  saleAt: Date;
  txHash: string;
}

// ─── Detection algorithms ─────────────────────────────────────────────────────

function detectSelfSale(sale: SaleRecord): number {
  if (sale.seller === sale.buyer) return 1.0;
  return 0;
}

function detectRoundTrip(sale: SaleRecord, history: SaleRecord[]): number {
  // Check if the same item was previously sold by buyer → seller within window
  const cutoff = new Date(sale.saleAt.getTime() - ROUND_TRIP_WINDOW_MS);
  const priorSale = history.find(
    (h) =>
      h.tokenId === sale.tokenId &&
      h.seller === sale.buyer &&
      h.buyer === sale.seller &&
      h.saleAt >= cutoff &&
      h.id !== sale.id,
  );
  return priorSale ? 0.85 : 0;
}

function detectRapidBackAndForth(sale: SaleRecord, history: SaleRecord[]): number {
  const cutoff = new Date(sale.saleAt.getTime() - RAPID_TRADE_WINDOW_MS);
  const pairKey = [sale.seller, sale.buyer].sort().join('::');

  const pairTrades = history.filter((h) => {
    const hKey = [h.seller, h.buyer].sort().join('::');
    return hKey === pairKey && h.saleAt >= cutoff;
  });

  if (pairTrades.length >= RAPID_TRADE_MIN_COUNT) {
    return Math.min(0.9, 0.4 + pairTrades.length * 0.1);
  }
  return 0;
}

function detectCircularTrade(sale: SaleRecord, history: SaleRecord[]): number {
  // Check A→B→C→A within window
  const cutoff = new Date(sale.saleAt.getTime() - ROUND_TRIP_WINDOW_MS);
  const recentHistory = history.filter((h) => h.saleAt >= cutoff);

  // Build adjacency: who sold to whom
  const buyerOfSeller = recentHistory.find(
    (h) => h.seller === sale.buyer && h.buyer !== sale.seller,
  );
  if (!buyerOfSeller) return 0;

  const closingTrade = recentHistory.find(
    (h) => h.seller === buyerOfSeller.buyer && h.buyer === sale.seller,
  );
  return closingTrade ? 0.75 : 0;
}

function detectPriceManipulation(sale: SaleRecord, history: SaleRecord[]): number {
  const priorSales = history
    .filter((h) => h.tokenId === sale.tokenId && h.id !== sale.id)
    .sort((a, b) => b.saleAt.getTime() - a.saleAt.getTime());

  if (priorSales.length === 0) return 0;
  const lastPrice = priorSales[0].price;
  if (lastPrice === 0) return 0;

  const ratio = sale.price / lastPrice;
  if (ratio >= PRICE_SPIKE_THRESHOLD || ratio <= 1 / PRICE_SPIKE_THRESHOLD) {
    return Math.min(0.7, 0.3 + Math.log2(Math.abs(Math.log2(ratio))) * 0.1);
  }
  return 0;
}

/**
 * Compute wash trade score for a sale (0–1).
 * Combines all signal detectors with weights.
 */
function computeWashTradeScore(sale: SaleRecord, history: SaleRecord[]): number {
  const signals = [
    detectSelfSale(sale) * 1.0,
    detectRoundTrip(sale, history) * 0.9,
    detectRapidBackAndForth(sale, history) * 0.7,
    detectCircularTrade(sale, history) * 0.6,
    detectPriceManipulation(sale, history) * 0.4,
  ];

  // Take max signal (not additive — prevents double-penalizing)
  return Math.min(1, Math.max(...signals));
}

// ─── Batch analysis ───────────────────────────────────────────────────────────

export async function analyzeCollectionWashTrading(collectionId: string): Promise<void> {
  const sales = await prismaRead.nftSale.findMany({
    where: { collectionId },
    orderBy: { saleAt: 'asc' },
    select: {
      id: true,
      tokenId: true,
      seller: true,
      buyer: true,
      price: true,
      saleAt: true,
      txHash: true,
    },
  });

  if (sales.length === 0) return;

  const saleRecords: SaleRecord[] = sales.map((s) => ({
    id: s.id,
    tokenId: s.tokenId,
    seller: s.seller,
    buyer: s.buyer,
    price: Number(s.price),
    saleAt: s.saleAt,
    txHash: s.txHash,
  }));

  const updates: Array<{ id: string; score: number; isWash: boolean }> = [];

  for (let i = 0; i < saleRecords.length; i++) {
    const sale = saleRecords[i];
    const history = saleRecords.slice(0, i); // only prior sales
    const score = computeWashTradeScore(sale, history);
    updates.push({ id: sale.id, score, isWash: score >= 0.5 });
  }

  await Promise.allSettled(
    updates.map((u) =>
      prismaWrite.nftSale.update({
        where: { id: u.id },
        data: { washTradeScore: u.score, isWashTrade: u.isWash },
      }),
    ),
  );

  // Update collection stats with wash volumes
  const now = new Date();
  const cutoff24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const washSales24h = updates.filter((u, i) => u.isWash && saleRecords[i].saleAt >= cutoff24h);
  const washVolume24h = washSales24h.reduce(
    (sum, u, i) => sum + saleRecords.find((s) => s.id === u.id)!.price,
    0,
  );

  await prismaWrite.nftCollection.update({
    where: { id: collectionId },
    data: { updatedAt: new Date() },
  });

  logger.info('[wash-trading] Analysis complete', {
    collectionId,
    total: sales.length,
    washCount: washSales24h.length,
  });
}

// ─── Wash trading analytics API data ─────────────────────────────────────────

export async function getWashTradingAnalysis(collectionId: string) {
  const now = new Date();
  const cutoff24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const [washSales24h, totalSales24h] = await Promise.all([
    prismaRead.nftSale.findMany({
      where: { collectionId, isWashTrade: true, saleAt: { gte: cutoff24h } },
      select: { seller: true, buyer: true, price: true, txHash: true },
    }),
    prismaRead.nftSale.findMany({
      where: { collectionId, saleAt: { gte: cutoff24h } },
      select: { price: true, isWashTrade: true },
    }),
  ]);

  const washVolume24h = washSales24h.reduce((sum, s) => sum + Number(s.price), 0);
  const totalVolume24h = totalSales24h.reduce((sum, s) => sum + Number(s.price), 0);
  const washVolumePct = totalVolume24h > 0 ? (washVolume24h / totalVolume24h) * 100 : 0;
  const washFreeVolume = totalVolume24h - washVolume24h;

  // Aggregate suspected wallets
  const walletVolume = new Map<string, { volume: number; txCount: number }>();
  for (const sale of washSales24h) {
    for (const addr of [sale.seller, sale.buyer]) {
      const existing = walletVolume.get(addr) ?? { volume: 0, txCount: 0 };
      existing.volume += Number(sale.price);
      existing.txCount++;
      walletVolume.set(addr, existing);
    }
  }

  const suspectedWallets = Array.from(walletVolume.entries())
    .map(([address, stats]) => ({ address, ...stats }))
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 20);

  return {
    washVolume24h,
    washVolumePct24h: Math.round(washVolumePct * 100) / 100,
    washTxCount24h: washSales24h.length,
    washFreeVolume,
    suspectedWallets,
  };
}

// ─── Leaderboard ──────────────────────────────────────────────────────────────

export async function getWashTradingLeaderboard(limit = 20) {
  const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const washByCollection = await prismaRead.nftSale.groupBy({
    by: ['collectionId'],
    where: { isWashTrade: true, saleAt: { gte: cutoff24h } },
    _sum: { price: true },
    _count: { id: true },
    orderBy: { _sum: { price: 'desc' } },
    take: limit,
  });

  const collectionIds = washByCollection.map((w) => w.collectionId);
  const collections = await prismaRead.nftCollection.findMany({
    where: { id: { in: collectionIds } },
    select: { id: true, contractAddress: true, name: true, volume24h: true },
  });

  const collectionMap = new Map(collections.map((c) => [c.id, c]));

  return washByCollection.map((w) => {
    const col = collectionMap.get(w.collectionId);
    const washVol = Number(w._sum.price ?? 0);
    const totalVol = Number(col?.volume24h ?? 1);
    return {
      collectionId: w.collectionId,
      contractAddress: col?.contractAddress,
      name: col?.name,
      washVolume24h: washVol,
      washTxCount24h: w._count.id,
      washVolumePct24h: totalVol > 0 ? Math.round((washVol / totalVol) * 10000) / 100 : 0,
    };
  });
}
