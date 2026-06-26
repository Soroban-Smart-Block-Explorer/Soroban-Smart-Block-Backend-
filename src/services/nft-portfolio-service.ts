/**
 * NFT Portfolio Service
 *
 * Manages portfolio creation, import, and P&L calculation.
 * Tracks cost basis from purchase history and current floor-based value.
 */

import { prismaRead, prismaWrite } from '../db';

// ─── Portfolio value computation ──────────────────────────────────────────────

interface PortfolioItem {
  itemId: string;
  tokenId: string;
  collectionId: string;
  mintPrice: number | null;
  lastSalePrice: number | null;
  lastSalePriceUsd: number | null;
  collectionFloorUsd: number | null;
  collectionName: string | null;
  contractAddress: string;
}

async function computePortfolioValue(itemIds: string[]): Promise<{
  totalValueUsd: number;
  totalPaidUsd: number;
  byCollection: Array<{
    collectionId: string;
    collectionName: string | null;
    contractAddress: string;
    items: number;
    valueUsd: number;
    paidUsd: number;
    pnlUsd: number;
  }>;
}> {
  if (itemIds.length === 0) {
    return { totalValueUsd: 0, totalPaidUsd: 0, byCollection: [] };
  }

  const items = await prismaRead.nftItem.findMany({
    where: { id: { in: itemIds } },
    include: {
      collection: {
        select: { id: true, name: true, contractAddress: true, floorPriceUsd: true },
      },
    },
  });

  // Group by collection
  const byCollection = new Map<
    string,
    {
      collectionId: string;
      collectionName: string | null;
      contractAddress: string;
      items: number;
      valueUsd: number;
      paidUsd: number;
    }
  >();

  for (const item of items) {
    const col = item.collection;
    const floorUsd = col.floorPriceUsd ? Number(col.floorPriceUsd) : 0;
    // Value = floor price or last sale USD (whichever is available)
    const valueUsd = item.lastSalePriceUsd ? Number(item.lastSalePriceUsd) : floorUsd;
    // Cost basis = mint price USD or last sale at time of acquisition
    const paidUsd = item.mintPrice ? Number(item.mintPrice) * 0.1 : 0; // rough XLM-to-USD placeholder

    const existing = byCollection.get(col.id) ?? {
      collectionId: col.id,
      collectionName: col.name,
      contractAddress: col.contractAddress,
      items: 0,
      valueUsd: 0,
      paidUsd: 0,
    };
    existing.items++;
    existing.valueUsd += valueUsd;
    existing.paidUsd += paidUsd;
    byCollection.set(col.id, existing);
  }

  const byCollectionArr = Array.from(byCollection.values()).map((c) => ({
    ...c,
    pnlUsd: c.valueUsd - c.paidUsd,
  }));

  const totalValueUsd = byCollectionArr.reduce((s, c) => s + c.valueUsd, 0);
  const totalPaidUsd = byCollectionArr.reduce((s, c) => s + c.paidUsd, 0);

  return { totalValueUsd, totalPaidUsd, byCollection: byCollectionArr };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function createPortfolio(userId: string, owner: string, name?: string) {
  return prismaWrite.nftPortfolio.create({
    data: { userId, owner, name: name ?? `${owner.slice(0, 8)}... NFTs` },
  });
}

export async function getPortfolio(portfolioId: string) {
  const portfolio = await prismaRead.nftPortfolio.findUnique({
    where: { id: portfolioId },
  });
  if (!portfolio) return null;

  const { totalValueUsd, totalPaidUsd, byCollection } = await computePortfolioValue(
    portfolio.items,
  );

  const unrealizedPnlUsd = totalValueUsd - totalPaidUsd;
  const unrealizedPnlPct =
    totalPaidUsd > 0 ? ((unrealizedPnlUsd / totalPaidUsd) * 100).toFixed(2) : '0';

  // Recent activity across all items in portfolio
  const recentActivity = await prismaRead.nftActivity.findMany({
    where: { itemId: { in: portfolio.items } },
    orderBy: { occurredAt: 'desc' },
    take: 20,
    select: {
      id: true,
      tokenId: true,
      activityType: true,
      price: true,
      priceUsd: true,
      occurredAt: true,
      txHash: true,
    },
  });

  // Persist updated values
  await prismaWrite.nftPortfolio.update({
    where: { id: portfolioId },
    data: {
      totalValueUsd,
      totalPaidUsd,
      unrealizedPnlUsd,
    },
  });

  return {
    id: portfolio.id,
    name: portfolio.name,
    owner: portfolio.owner,
    totalItems: portfolio.items.length,
    totalValueUsd,
    totalPaidUsd,
    unrealizedPnlUsd,
    unrealizedPnlPct: parseFloat(unrealizedPnlPct),
    byCollection,
    recentActivity: recentActivity.map((a) => ({
      ...a,
      price: a.price ? Number(a.price) : null,
      priceUsd: a.priceUsd ? Number(a.priceUsd) : null,
    })),
  };
}

export async function importPortfolioByAddress(
  userId: string,
  ownerAddress: string,
): Promise<{ portfolioId: string; imported: number }> {
  // Find all NFT items owned by this address
  const items = await prismaRead.nftItem.findMany({
    where: { owner: ownerAddress },
    select: { id: true },
  });

  if (items.length === 0) {
    // Create empty portfolio if nothing found
    const portfolio = await createPortfolio(userId, ownerAddress);
    return { portfolioId: portfolio.id, imported: 0 };
  }

  const itemIds = items.map((i) => i.id);

  // Upsert portfolio for this owner+user combo
  const existing = await prismaRead.nftPortfolio.findFirst({
    where: { userId, owner: ownerAddress },
  });

  if (existing) {
    const updated = await prismaWrite.nftPortfolio.update({
      where: { id: existing.id },
      data: { items: itemIds },
    });
    return { portfolioId: updated.id, imported: itemIds.length };
  }

  const portfolio = await prismaWrite.nftPortfolio.create({
    data: {
      userId,
      owner: ownerAddress,
      name: `${ownerAddress.slice(0, 8)}... Portfolio`,
      items: itemIds,
    },
  });

  return { portfolioId: portfolio.id, imported: itemIds.length };
}

export async function getPortfolioActivity(portfolioId: string, limit = 50) {
  const portfolio = await prismaRead.nftPortfolio.findUnique({
    where: { id: portfolioId },
    select: { items: true },
  });
  if (!portfolio) return null;

  return prismaRead.nftActivity.findMany({
    where: { itemId: { in: portfolio.items } },
    orderBy: { occurredAt: 'desc' },
    take: limit,
  });
}

export async function getPortfolioValueHistory(portfolioId: string) {
  const portfolio = await prismaRead.nftPortfolio.findUnique({
    where: { id: portfolioId },
    select: { items: true },
  });
  if (!portfolio) return null;

  // Aggregate sale history for owned items as a proxy for value history
  const sales = await prismaRead.nftSale.findMany({
    where: { itemId: { in: portfolio.items } },
    orderBy: { saleAt: 'asc' },
    select: { saleAt: true, priceUsd: true, tokenId: true },
  });

  // Group by day
  const byDay = new Map<string, { date: string; totalValueUsd: number; trades: number }>();
  for (const sale of sales) {
    const day = sale.saleAt.toISOString().slice(0, 10);
    const existing = byDay.get(day) ?? { date: day, totalValueUsd: 0, trades: 0 };
    existing.totalValueUsd += Number(sale.priceUsd ?? 0);
    existing.trades++;
    byDay.set(day, existing);
  }

  return Array.from(byDay.values());
}
