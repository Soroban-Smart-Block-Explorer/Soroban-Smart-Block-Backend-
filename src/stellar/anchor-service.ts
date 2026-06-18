import { prismaRead as prisma, prismaWrite } from '../db';
import { fetchStellarToml } from './horizon-client';

export interface AnchorSummary {
  name: string;
  homeDomain: string;
  address: string | null;
  supportedAssets: string[];
  regions: string[];
  kycRequired: boolean;
  kycTypes: string[];
  supportedSeps: string[];
  isVerified: boolean;
  rating: number;
  reviewCount: number;
  status: string;
}

export interface AnchorListResponse {
  anchors: AnchorSummary[];
  totalAnchors: number;
  totalVerified: number;
  totalActive: number;
}

function detectSupportedSeps(toml: Record<string, unknown>): string[] {
  const seps: string[] = ['SEP-1'];
  if (toml.TRANSFER_SERVER || toml.TRANSFER_SERVER_SEP0024) seps.push('SEP-6');
  if (toml.TRANSFER_SERVER_SEP0024) seps.push('SEP-24');
  if (toml.DIRECT_PAYMENT_SERVER) seps.push('SEP-31');
  if (toml.PRICE_SERVER) seps.push('SEP-38');
  return seps;
}

function extractAssets(toml: Record<string, unknown>): string[] {
  const currencies = toml.CURRENCIES;
  if (!currencies || typeof currencies !== 'object') return [];
  const assets: string[] = [];
  for (const key of Object.keys(currencies as Record<string, unknown>)) {
    const entry = (currencies as Record<string, Record<string, unknown>>)[key];
    if (entry?.code) assets.push(String(entry.code));
  }
  if (toml.ACCOUNTS && typeof toml.ORG_NAME === 'string') {
    assets.push(toml.ORG_NAME as string);
  }
  return assets;
}

export async function discoverAnchorFromDomain(homeDomain: string): Promise<AnchorSummary | null> {
  const toml = await fetchStellarToml(homeDomain);
  if (!toml) return null;

  const accounts = toml.ACCOUNTS;
  const address = typeof accounts === 'string' ? accounts.split(',')[0].trim() : null;
  const name = (toml.ORG_NAME as string) ?? (toml.ORG_DBA as string) ?? homeDomain;
  const supportedSeps = detectSupportedSeps(toml);
  const supportedAssets = extractAssets(toml);

  const kycTypes: string[] = [];
  if (toml.KYC_SERVER) kycTypes.push('individual');
  if (toml.KYC_SERVER && toml.ORG_TYPE === 'business') kycTypes.push('business');

  return {
    name,
    homeDomain,
    address,
    supportedAssets,
    regions: [],
    kycRequired: !!toml.KYC_SERVER,
    kycTypes,
    supportedSeps,
    isVerified: !!address,
    rating: 0,
    reviewCount: 0,
    status: 'active',
  };
}

export async function listAnchors(filters?: {
  region?: string;
  asset?: string;
  sep?: string;
  status?: string;
}): Promise<AnchorListResponse> {
  const where: Record<string, unknown> = {};
  if (filters?.status) where.status = filters.status;
  if (filters?.region) where.regions = { has: filters.region };
  if (filters?.sep) where.supportedSeps = { has: filters.sep };

  let anchors = await prisma.anchorsRegistry.findMany({
    where,
    orderBy: { rating: 'desc' },
    take: 100,
  });

  if (filters?.asset) {
    anchors = anchors.filter((a) => {
      const assets = a.assets as string[];
      return assets.includes(filters.asset!);
    });
  }

  const summaries: AnchorSummary[] = anchors.map((a) => ({
    name: a.name,
    homeDomain: a.homeDomain,
    address: a.address,
    supportedAssets: (a.assets as string[]) ?? [],
    regions: a.regions,
    kycRequired: a.kycRequired,
    kycTypes: a.kycTypes,
    supportedSeps: a.supportedSeps,
    isVerified: a.isVerified,
    rating: Number(a.rating),
    reviewCount: a.reviewCount,
    status: a.status,
  }));

  const [totalAnchors, totalVerified, totalActive] = await Promise.all([
    prisma.anchorsRegistry.count(),
    prisma.anchorsRegistry.count({ where: { isVerified: true } }),
    prisma.anchorsRegistry.count({ where: { status: 'active' } }),
  ]);

  return { anchors: summaries, totalAnchors, totalVerified, totalActive };
}

export async function getAnchorByAddress(address: string) {
  const anchor = await prisma.anchorsRegistry.findFirst({
    where: { OR: [{ address }, { homeDomain: address }] },
    include: { reviews: { orderBy: { createdAt: 'desc' }, take: 20 } },
  });

  if (!anchor) {
    const discovered = await discoverAnchorFromDomain(address);
    if (!discovered) return null;
    return { ...discovered, fees: null, limits: null, reviews: [], metadata: null };
  }

  return {
    name: anchor.name,
    homeDomain: anchor.homeDomain,
    address: anchor.address,
    supportedAssets: (anchor.assets as string[]) ?? [],
    regions: anchor.regions,
    kycRequired: anchor.kycRequired,
    kycTypes: anchor.kycTypes,
    supportedSeps: anchor.supportedSeps,
    isVerified: anchor.isVerified,
    rating: Number(anchor.rating),
    reviewCount: anchor.reviewCount,
    status: anchor.status,
    fees: anchor.fees,
    limits: anchor.limits,
    metadata: anchor.metadata,
    reviews: anchor.reviews.map((r) => ({
      id: r.id,
      reviewer: r.reviewer,
      rating: Number(r.rating),
      comment: r.comment,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

export async function getAnchorReviews(address: string) {
  const anchor = await prisma.anchorsRegistry.findFirst({
    where: { OR: [{ address }, { homeDomain: address }] },
  });
  if (!anchor) return { reviews: [], total: 0 };

  const reviews = await prisma.anchorReview.findMany({
    where: { anchorId: anchor.id },
    orderBy: { createdAt: 'desc' },
  });

  return {
    reviews: reviews.map((r) => ({
      id: r.id,
      reviewer: r.reviewer,
      rating: Number(r.rating),
      comment: r.comment,
      createdAt: r.createdAt.toISOString(),
    })),
    total: reviews.length,
  };
}

export async function submitAnchorReview(
  address: string,
  reviewer: string,
  rating: number,
  comment?: string,
) {
  let anchor = await prisma.anchorsRegistry.findFirst({
    where: { OR: [{ address }, { homeDomain: address }] },
  });

  if (!anchor) {
    const discovered = await discoverAnchorFromDomain(address);
    if (!discovered) throw new Error('Anchor not found');
    anchor = await prismaWrite.anchorsRegistry.create({
      data: {
        name: discovered.name,
        homeDomain: discovered.homeDomain,
        address: discovered.address,
        assets: discovered.supportedAssets,
        regions: discovered.regions,
        kycRequired: discovered.kycRequired,
        kycTypes: discovered.kycTypes,
        supportedSeps: discovered.supportedSeps,
        isVerified: discovered.isVerified,
      },
    });
  }

  const review = await prismaWrite.anchorReview.create({
    data: { anchorId: anchor.id, reviewer, rating, comment },
  });

  const allReviews = await prisma.anchorReview.findMany({ where: { anchorId: anchor.id } });
  const avgRating = allReviews.reduce((sum, r) => sum + Number(r.rating), 0) / allReviews.length;

  await prismaWrite.anchorsRegistry.update({
    where: { id: anchor.id },
    data: { rating: avgRating, reviewCount: allReviews.length },
  });

  return {
    id: review.id,
    rating: Number(review.rating),
    createdAt: review.createdAt.toISOString(),
  };
}

export async function registerAnchor(data: {
  name: string;
  homeDomain: string;
  address?: string;
  assets: string[];
  regions?: string[];
  kycRequired?: boolean;
  supportedSeps?: string[];
}) {
  const discovered = await discoverAnchorFromDomain(data.homeDomain);
  const supportedSeps = data.supportedSeps ?? discovered?.supportedSeps ?? ['SEP-1'];

  return prismaWrite.anchorsRegistry.create({
    data: {
      name: data.name,
      homeDomain: data.homeDomain,
      address: data.address ?? discovered?.address ?? null,
      assets: data.assets,
      regions: data.regions ?? [],
      kycRequired: data.kycRequired ?? false,
      kycTypes: [],
      supportedSeps,
      isVerified: !!data.address,
    },
  });
}

export async function updateAnchor(address: string, updates: Record<string, unknown>) {
  const anchor = await prisma.anchorsRegistry.findFirst({
    where: { OR: [{ address }, { homeDomain: address }] },
  });
  if (!anchor) throw new Error('Anchor not found');

  return prismaWrite.anchorsRegistry.update({
    where: { id: anchor.id },
    data: updates,
  });
}

export async function getAnchorTransactionAnalytics(address: string) {
  const anchor = await prisma.anchorsRegistry.findFirst({
    where: { OR: [{ address }, { homeDomain: address }] },
  });
  if (!anchor?.address) return { volume24h: '0', txCount24h: 0, topAssets: [] };

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const txs = await prisma.unifiedTransaction.findMany({
    where: {
      OR: [{ sourceAccount: anchor.address }, { destination: anchor.address }],
      createdAt: { gte: since },
    },
    take: 1000,
  });

  const volume = txs.reduce((sum, tx) => sum + Number(tx.amount ?? 0), 0);
  const assetCounts: Record<string, number> = {};
  for (const tx of txs) {
    const key = tx.assetCode ?? 'XLM';
    assetCounts[key] = (assetCounts[key] ?? 0) + 1;
  }

  const topAssets = Object.entries(assetCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([asset, count]) => ({ asset, count }));

  return { volume24h: volume.toFixed(7), txCount24h: txs.length, topAssets };
}
