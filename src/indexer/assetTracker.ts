import axios from 'axios';
import { prismaRead as prisma } from '../db';

export interface AssetMetric {
  contractAddress: string;
  assetCode: string | null;
  assetIssuer: string | null;
  totalEvents: number;
  totalTransactions: number;
  /** Raw token quantity (sum of transfer amounts parsed from decoded events, if available) */
  estimatedVolume: number;
  /** XLM-denominated value (null if price unavailable) */
  volumeXlm: number | null;
  /** USD-denominated value (null if price unavailable) */
  volumeUsd: number | null;
  priceXlm: number | null;
  priceUsd: number | null;
  lastActivityAt: Date | null;
}

// ---------------------------------------------------------------------------
// Price fetching (Stellar Expert public API — no key required)
// ---------------------------------------------------------------------------

interface PriceMap {
  [assetCode: string]: { xlm: number; usd: number };
}

async function fetchPrices(assetCodes: string[]): Promise<PriceMap> {
  const prices: PriceMap = {};
  if (assetCodes.length === 0) return prices;

  try {
    // Stellar Expert aggregated ticker — returns price in XLM for each asset
    const { data } = await axios.get<{
      _embedded: { records: Array<{ asset: string; price: number }> };
    }>('https://api.stellar.expert/explorer/public/asset', {
      params: { limit: 200 },
      timeout: 5000,
    });

    // Fetch XLM/USD price from CoinGecko (free, no key)
    let xlmUsd = 0;
    try {
      const cg = await axios.get<{ stellar: { usd: number } }>(
        'https://api.coingecko.com/api/v3/simple/price',
        { params: { ids: 'stellar', vs_currencies: 'usd' }, timeout: 5000 },
      );
      xlmUsd = cg.data?.stellar?.usd ?? 0;
    } catch {
      // price unavailable — leave xlmUsd = 0
    }

    for (const record of data?._embedded?.records ?? []) {
      const code = record.asset?.split('-')[0];
      if (code && assetCodes.includes(code)) {
        prices[code] = { xlm: record.price ?? 0, usd: (record.price ?? 0) * xlmUsd };
      }
    }

    // XLM itself
    if (assetCodes.includes('XLM')) {
      prices['XLM'] = { xlm: 1, usd: xlmUsd };
    }
  } catch {
    // price fetch failed — return empty map; callers handle null gracefully
  }

  return prices;
}

// ---------------------------------------------------------------------------
// Core metrics computation
// ---------------------------------------------------------------------------

/**
 * Compute live token storage metrics for all known SAC-mapped assets.
 * Cross-references token volumes against public exchange pricing APIs.
 */
export async function computeAssetMetrics(): Promise<AssetMetric[]> {
  // Load all SAC mappings
  const sacMappings = await prisma.sacMapping.findMany({
    select: { sacAddress: true, assetCode: true, assetIssuer: true },
  });

  if (sacMappings.length === 0) return [];

  const assetCodes = [...new Set(sacMappings.map((m) => m.assetCode).filter(Boolean))] as string[];
  const prices = await fetchPrices(assetCodes);

  const metrics: AssetMetric[] = [];

  for (const mapping of sacMappings) {
    const [eventCount, txCount, lastEvent] = await Promise.all([
      prisma.event.count({ where: { contractAddress: mapping.sacAddress } }),
      prisma.transaction.count({ where: { contractAddress: mapping.sacAddress } }),
      prisma.event.findFirst({
        where: { contractAddress: mapping.sacAddress },
        orderBy: { ledgerCloseTime: 'desc' },
        select: { ledgerCloseTime: true },
      }),
    ]);

    // Estimate volume from decoded transfer events (best-effort)
    const transferEvents = await prisma.event.findMany({
      where: { contractAddress: mapping.sacAddress, eventType: 'transfer' },
      select: { decoded: true },
      take: 1000,
    });

    let estimatedVolume = 0;
    for (const ev of transferEvents) {
      const decoded = ev.decoded as Record<string, unknown> | null;
      const amount = Number(decoded?.amount ?? decoded?.amount_in ?? 0);
      if (Number.isFinite(amount)) estimatedVolume += amount;
    }

    const priceInfo = mapping.assetCode ? prices[mapping.assetCode] : undefined;

    metrics.push({
      contractAddress: mapping.sacAddress,
      assetCode: mapping.assetCode,
      assetIssuer: mapping.assetIssuer,
      totalEvents: eventCount,
      totalTransactions: txCount,
      estimatedVolume,
      volumeXlm: priceInfo ? estimatedVolume * priceInfo.xlm : null,
      volumeUsd: priceInfo ? estimatedVolume * priceInfo.usd : null,
      priceXlm: priceInfo?.xlm ?? null,
      priceUsd: priceInfo?.usd ?? null,
      lastActivityAt: lastEvent?.ledgerCloseTime ?? null,
    });
  }

  return metrics.sort((a, b) => b.totalEvents - a.totalEvents);
}
