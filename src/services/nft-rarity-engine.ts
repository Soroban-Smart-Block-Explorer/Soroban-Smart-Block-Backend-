/**
 * NFT Rarity Engine
 *
 * Computes statistical rarity scores for all items in a collection.
 * Formula: traitRarity = 1 / (itemsWithTrait / totalSupply)
 *          itemRarityScore = sum(traitRarity for all traits of item)
 *
 * Rarity tiers:
 *   common      < 1x average
 *   uncommon    1–3x
 *   rare        3–10x
 *   epic        10–50x
 *   legendary   50–200x
 *   mythic      > 200x
 */

import { prismaRead, prismaWrite } from '../db';
import { logger } from '../logger';

// ─── Types ────────────────────────────────────────────────────────────────────

interface TraitCount {
  traitType: string;
  traitValue: string;
  count: number;
}

interface ItemWithTraits {
  id: string;
  tokenId: string;
  metadata: unknown;
}

interface TraitInfo {
  traitType: string;
  value: string;
  rarityScore: number;
  occurrence: number; // fraction 0-1
  rarityTier: string;
}

export interface ItemRarityResult {
  tokenId: string;
  rarityScore: number;
  rarityRank: number;
  rarityTier: string;
  percentile: number;
  traitBreakdown: TraitInfo[];
}

// ─── Rarity tier classification ───────────────────────────────────────────────

const TRAIT_RARITY_TIERS = [
  { tier: 'mythic', minScore: 200 },
  { tier: 'legendary', minScore: 50 },
  { tier: 'epic', minScore: 10 },
  { tier: 'rare', minScore: 3 },
  { tier: 'uncommon', minScore: 1 },
  { tier: 'common', minScore: 0 },
];

function classifyTier(rarityScore: number): string {
  for (const { tier, minScore } of TRAIT_RARITY_TIERS) {
    if (rarityScore >= minScore) return tier;
  }
  return 'common';
}

// ─── Attribute extractor ──────────────────────────────────────────────────────

function extractAttributes(metadata: unknown): Array<{ trait_type: string; value: string }> {
  if (!metadata || typeof metadata !== 'object') return [];
  const m = metadata as Record<string, unknown>;
  if (!Array.isArray(m.attributes)) return [];
  return (m.attributes as Array<Record<string, unknown>>)
    .filter((a) => a.trait_type && a.value != null)
    .map((a) => ({
      trait_type: String(a.trait_type),
      value: String(a.value),
    }));
}

// ─── Core computation ─────────────────────────────────────────────────────────

export async function computeCollectionRarity(collectionId: string): Promise<void> {
  const collection = await prismaRead.nftCollection.findUnique({
    where: { id: collectionId },
    select: { id: true, totalSupply: true },
  });

  if (!collection) return;

  const items = await prismaRead.nftItem.findMany({
    where: { collectionId },
    select: { id: true, tokenId: true, metadata: true },
  });

  if (items.length === 0) return;

  const totalSupply = items.length; // use actual item count for accuracy

  // 1. Count trait occurrences
  const traitCounts = new Map<string, number>(); // "traitType::value" => count
  for (const item of items) {
    const attrs = extractAttributes(item.metadata);
    for (const attr of attrs) {
      const key = `${attr.trait_type}::${attr.value}`;
      traitCounts.set(key, (traitCounts.get(key) ?? 0) + 1);
    }
  }

  // 2. Compute trait rarity scores
  const traitRarityMap = new Map<string, number>(); // key => rarityScore
  for (const [key, count] of traitCounts.entries()) {
    traitRarityMap.set(key, totalSupply / count);
  }

  // 3. Upsert NftTrait records
  const traitUpdates: Array<{
    collectionId: string;
    traitType: string;
    traitValue: string;
    count: number;
    rarityScore: number;
    rarityTier: string;
  }> = [];

  for (const [key, count] of traitCounts.entries()) {
    const [traitType, traitValue] = key.split('::');
    const rarityScore = traitRarityMap.get(key) ?? 1;
    traitUpdates.push({
      collectionId,
      traitType,
      traitValue,
      count,
      rarityScore,
      rarityTier: classifyTier(rarityScore),
    });
  }

  await Promise.allSettled(
    traitUpdates.map((t) =>
      prismaWrite.nftTrait.upsert({
        where: {
          collectionId_traitType_traitValue: {
            collectionId: t.collectionId,
            traitType: t.traitType,
            traitValue: t.traitValue,
          },
        },
        create: t,
        update: { count: t.count, rarityScore: t.rarityScore, rarityTier: t.rarityTier },
      }),
    ),
  );

  // 4. Score each item
  const itemScores: Array<{ id: string; tokenId: string; score: number }> = [];

  for (const item of items) {
    const attrs = extractAttributes(item.metadata);
    let score = 0;
    for (const attr of attrs) {
      const key = `${attr.trait_type}::${attr.value}`;
      score += traitRarityMap.get(key) ?? 1;
    }
    // Items with no traits get base score of 1
    if (attrs.length === 0) score = 1;
    itemScores.push({ id: item.id, tokenId: item.tokenId, score });
  }

  // 5. Rank items by score descending
  itemScores.sort((a, b) => b.score - a.score);

  // 6. Persist rarity scores and ranks
  await Promise.allSettled(
    itemScores.map((item, idx) =>
      prismaWrite.nftItem.update({
        where: { id: item.id },
        data: {
          rarityScore: item.score,
          rarityRank: idx + 1,
        },
      }),
    ),
  );

  logger.info('[rarity-engine] Rarity computed', { collectionId, items: items.length });
}

// ─── Item rarity detail ───────────────────────────────────────────────────────

export async function getItemRarityDetail(
  collectionId: string,
  tokenId: string,
): Promise<ItemRarityResult | null> {
  const item = await prismaRead.nftItem.findUnique({
    where: { collectionId_tokenId: { collectionId, tokenId } },
  });
  if (!item || item.rarityScore == null || item.rarityRank == null) return null;

  const totalItems = await prismaRead.nftItem.count({ where: { collectionId } });
  const percentile = ((totalItems - item.rarityRank) / totalItems) * 100;

  const attrs = extractAttributes(item.metadata);
  const traits = await prismaRead.nftTrait.findMany({
    where: {
      collectionId,
      traitType: { in: attrs.map((a) => a.trait_type) },
    },
  });

  const traitMap = new Map(traits.map((t) => [`${t.traitType}::${t.traitValue}`, t]));

  const traitBreakdown: TraitInfo[] = attrs.map((attr) => {
    const trait = traitMap.get(`${attr.trait_type}::${attr.value}`);
    return {
      traitType: attr.trait_type,
      value: attr.value,
      rarityScore: trait?.rarityScore ?? 1,
      occurrence: trait ? trait.count / totalItems : 1,
      rarityTier: trait?.rarityTier ?? 'common',
    };
  });

  return {
    tokenId,
    rarityScore: item.rarityScore,
    rarityRank: item.rarityRank,
    rarityTier: classifyTier(item.rarityScore),
    percentile: Math.round(percentile * 100) / 100,
    traitBreakdown,
  };
}

// ─── Rarity overview ──────────────────────────────────────────────────────────

export async function getCollectionRarityOverview(collectionId: string) {
  const items = await prismaRead.nftItem.findMany({
    where: { collectionId, rarityScore: { not: null } },
    select: { id: true, tokenId: true, rarityScore: true, rarityRank: true },
    orderBy: { rarityScore: 'desc' },
  });

  if (items.length === 0) return null;

  const scores = items.map((i) => i.rarityScore as number);
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;

  // Histogram: 10 buckets
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const bucketSize = (max - min) / 10 || 1;
  const histogram = Array.from({ length: 10 }, (_, i) => ({
    rangeMin: min + i * bucketSize,
    rangeMax: min + (i + 1) * bucketSize,
    count: 0,
  }));
  for (const s of scores) {
    const idx = Math.min(Math.floor((s - min) / bucketSize), 9);
    histogram[idx].count++;
  }

  const rarityTraits = await prismaRead.nftTrait.findMany({
    where: { collectionId },
    orderBy: { rarityScore: 'desc' },
    take: 10,
  });

  return {
    totalItems: items.length,
    avgRarityScore: Math.round(avg * 100) / 100,
    top20Rarest: items.slice(0, 20).map((i) => ({
      tokenId: i.tokenId,
      rarityScore: i.rarityScore,
      rarityRank: i.rarityRank,
    })),
    rarestTraits: rarityTraits.map((t) => ({
      traitType: t.traitType,
      value: t.traitValue,
      rarityScore: t.rarityScore,
      rarityTier: t.rarityTier,
    })),
    histogram,
  };
}
