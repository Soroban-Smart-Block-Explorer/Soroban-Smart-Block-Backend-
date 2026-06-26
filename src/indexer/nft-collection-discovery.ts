/**
 * NFT Collection Auto-Discovery
 *
 * Scans on-chain events for new NFT collection candidates every hour.
 * Detection strategy:
 *  1. Find contracts emitting transfer/mint events with tokenId patterns
 *  2. Verify contract has NFT-like interface (name/symbol/totalSupply)
 *  3. Create NftCollection record and trigger metadata fetch
 *  4. Update collection stats on each run
 */

import { prismaRead, prismaWrite } from '../db';
import { logger } from '../logger';
import { fetchCollectionMetadataFromChain } from './nft-metadata-fetcher';

const DISCOVERY_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const NFT_EVENT_PATTERNS = ['transfer', 'mint', 'burn', 'approve', 'set_metadata', 'token_uri'];
const MIN_UNIQUE_TOKEN_IDS = 2; // at least 2 different tokenIds to qualify

// ─── Event pattern matcher ────────────────────────────────────────────────────

function looksLikeNftEvent(topicSymbol: string | null | undefined): boolean {
  if (!topicSymbol) return false;
  const lower = topicSymbol.toLowerCase();
  return NFT_EVENT_PATTERNS.some((p) => lower.includes(p));
}

/**
 * Heuristically detect if a contract's events suggest an NFT collection.
 * Checks for token ID patterns in event data (numeric or short string token IDs
 * alongside address topics — characteristic of ERC-721-style transfers).
 */
function hasTokenIdPattern(decoded: unknown): boolean {
  if (!decoded || typeof decoded !== 'object') return false;
  const d = decoded as Record<string, unknown>;
  // Look for fields named tokenId, token_id, id with numeric-looking values
  const tokenIdFields = ['tokenId', 'token_id', 'id', 'tokenid'];
  for (const field of tokenIdFields) {
    if (field in d) {
      const val = d[field];
      if (typeof val === 'number' || (typeof val === 'string' && /^\d+$/.test(val))) return true;
    }
  }
  return false;
}

// ─── Collection candidate detection ──────────────────────────────────────────

async function findNewCollectionCandidates(): Promise<string[]> {
  // Look at events from contracts not yet registered as collections
  const existingContracts = await prismaRead.nftCollection.findMany({
    select: { contractAddress: true },
  });
  const existingSet = new Set(existingContracts.map((c) => c.contractAddress));

  // Find contracts emitting NFT-pattern events with diverse token IDs
  const candidates = await prismaRead.event.groupBy({
    by: ['contractAddress'],
    where: {
      topicSymbol: { in: NFT_EVENT_PATTERNS.map((p) => p), mode: 'insensitive' },
      contractAddress: { notIn: Array.from(existingSet) },
    },
    _count: { id: true },
    having: { id: { _count: { gte: MIN_UNIQUE_TOKEN_IDS } } },
    orderBy: { _count: { id: 'desc' } },
    take: 100,
  });

  // Secondary pass: check decoded data for tokenId patterns
  const qualifiedCandidates: string[] = [];
  for (const candidate of candidates) {
    const sampleEvents = await prismaRead.event.findMany({
      where: {
        contractAddress: candidate.contractAddress,
        topicSymbol: { in: NFT_EVENT_PATTERNS, mode: 'insensitive' },
      },
      take: 5,
      select: { decoded: true, topicSymbol: true },
    });

    const hasNftEvents = sampleEvents.some(
      (e) => looksLikeNftEvent(e.topicSymbol) && hasTokenIdPattern(e.decoded),
    );

    if (hasNftEvents) {
      qualifiedCandidates.push(candidate.contractAddress);
    }
  }

  return qualifiedCandidates;
}

// ─── Collection registration ──────────────────────────────────────────────────

async function registerCollection(contractAddress: string): Promise<void> {
  // Check not already registered
  const existing = await prismaRead.nftCollection.findUnique({
    where: { contractAddress },
  });
  if (existing) return;

  logger.info({ contractAddress }, '[nft-discovery] Registering new NFT collection');

  // Fetch on-chain metadata (name, symbol, totalSupply) if available
  const chainMeta = await fetchCollectionMetadataFromChain(contractAddress).catch(() => null);

  await prismaWrite.nftCollection.create({
    data: {
      contractAddress,
      name: chainMeta?.name ?? null,
      symbol: chainMeta?.symbol ?? null,
      totalSupply: chainMeta?.totalSupply ?? 0,
      detectedAt: new Date(),
    },
  });

  logger.info({ contractAddress, name: chainMeta?.name }, '[nft-discovery] Collection registered');
}

// ─── Stats snapshot ───────────────────────────────────────────────────────────

async function snapshotCollectionStats(): Promise<void> {
  const collections = await prismaRead.nftCollection.findMany({
    select: {
      id: true,
      floorPrice: true,
      floorPriceUsd: true,
      totalVolume: true,
      volume24h: true,
      avgPrice24h: true,
      uniqueHolders: true,
      totalSupply: true,
      volume7d: true,
    },
  });

  if (collections.length === 0) return;

  const now = new Date();
  // Bucket to the nearest hour for deduplication
  const bucket = new Date(now);
  bucket.setMinutes(0, 0, 0);

  const data = collections.map((c) => ({
    collectionId: c.id,
    timestamp: bucket,
    floorPrice: c.floorPrice,
    floorPriceUsd: c.floorPriceUsd,
    totalVolume: c.totalVolume,
    volume24h: c.volume24h,
    avgPrice24h: c.avgPrice24h,
    uniqueHolders: c.uniqueHolders,
    totalSupply: c.totalSupply,
    washVolume24h: 0,
    washTxCount24h: 0,
  }));

  // Upsert hourly snapshots
  await Promise.allSettled(
    data.map((d) =>
      prismaWrite.nftCollectionStats.upsert({
        where: { collectionId_timestamp: { collectionId: d.collectionId, timestamp: d.timestamp } },
        create: d,
        update: {
          floorPrice: d.floorPrice,
          floorPriceUsd: d.floorPriceUsd,
          totalVolume: d.totalVolume,
          volume24h: d.volume24h,
          avgPrice24h: d.avgPrice24h,
          uniqueHolders: d.uniqueHolders,
          totalSupply: d.totalSupply,
        },
      }),
    ),
  );
}

// ─── Holder count updater ─────────────────────────────────────────────────────

async function updateHolderCounts(): Promise<void> {
  const collections = await prismaRead.nftCollection.findMany({
    select: { id: true },
  });

  for (const collection of collections) {
    const holderCount = await prismaRead.nftItem.groupBy({
      by: ['owner'],
      where: { collectionId: collection.id },
      _count: { owner: true },
    });

    await prismaWrite.nftCollection.update({
      where: { id: collection.id },
      data: { uniqueHolders: holderCount.length },
    });
  }
}

// ─── Main discovery loop ──────────────────────────────────────────────────────

export async function runNftCollectionDiscovery(): Promise<void> {
  logger.info('[nft-discovery] Starting collection discovery run');

  try {
    const candidates = await findNewCollectionCandidates();
    logger.info({ count: candidates.length }, '[nft-discovery] Found candidates');

    for (const address of candidates) {
      await registerCollection(address).catch((err) =>
        logger.error({ err, address }, '[nft-discovery] Failed to register collection'),
      );
    }

    await snapshotCollectionStats();
    await updateHolderCounts();

    logger.info('[nft-discovery] Discovery run complete');
  } catch (err) {
    logger.error({ err }, '[nft-discovery] Discovery run failed');
  }
}

export function startNftCollectionDiscovery(): void {
  // Run immediately on start, then every hour
  void runNftCollectionDiscovery();
  setInterval(() => void runNftCollectionDiscovery(), DISCOVERY_INTERVAL_MS);
  logger.info('[nft-discovery] Collection discovery scheduler started');
}
