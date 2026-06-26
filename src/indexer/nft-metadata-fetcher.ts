/**
 * NFT Metadata Fetcher
 *
 * Fetches and persists NFT metadata for items and collection-level on-chain info.
 * Supports IPFS (multiple gateways), HTTP/HTTPS, and data: URIs.
 * Results are stored in NftItem.metadata with a TTL of 24h.
 */

import axios from 'axios';
import { SorobanRpc, scValToNative, xdr } from '@stellar/stellar-sdk';
import { prismaRead, prismaWrite } from '../db';
import { logger } from '../logger';
import { config } from '../config';

const FETCH_TIMEOUT_MS = 10_000;
const METADATA_TTL_MS = 24 * 60 * 60 * 1000; // 24h

const IPFS_GATEWAYS = [
  process.env.IPFS_GATEWAY ?? 'https://cloudflare-ipfs.com/ipfs/',
  'https://ipfs.io/ipfs/',
  'https://gateway.pinata.cloud/ipfs/',
];

const XSS_PATTERN = /<[^>]*>|javascript\s*:|data\s*:/gi;
const sanitize = (v: unknown) => String(v ?? '').replace(XSS_PATTERN, '');

// ─── URI resolution ───────────────────────────────────────────────────────────

export function resolveIpfsUri(uri: string, gatewayIndex = 0): string {
  const gateway = IPFS_GATEWAYS[gatewayIndex] ?? IPFS_GATEWAYS[0];
  if (uri.startsWith('ipfs://')) return gateway + uri.slice(7);
  if (/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|bafy[a-z2-7]{52})/.test(uri)) return gateway + uri;
  return uri;
}

function parseDataUri(uri: string): Record<string, unknown> | null {
  // data:application/json;base64,...
  const match = uri.match(/^data:application\/json;base64,(.+)$/);
  if (!match) return null;
  try {
    return JSON.parse(Buffer.from(match[1], 'base64').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ─── Fetch with gateway fallback ─────────────────────────────────────────────

async function fetchMetadataJson(uri: string): Promise<Record<string, unknown>> {
  if (uri.startsWith('data:')) {
    const parsed = parseDataUri(uri);
    if (parsed) return parsed;
    throw new Error('Invalid data URI');
  }

  let lastError: Error | null = null;
  for (let i = 0; i < IPFS_GATEWAYS.length; i++) {
    const resolvedUri = resolveIpfsUri(uri, i);
    try {
      const { data } = await axios.get<Record<string, unknown>>(resolvedUri, {
        timeout: FETCH_TIMEOUT_MS,
        maxContentLength: 2_000_000,
        headers: { Accept: 'application/json' },
      });
      if (typeof data === 'object' && data !== null) return data;
    } catch (err) {
      lastError = err as Error;
      // try next gateway if IPFS URI
      if (!uri.startsWith('ipfs://') && !/^(Qm|bafy)/.test(uri)) break;
    }
  }
  throw lastError ?? new Error('Failed to fetch metadata');
}

// ─── Trait normalizer ─────────────────────────────────────────────────────────

export interface NormalizedAttribute {
  trait_type: string;
  value: string;
}

function normalizeAttributes(raw: unknown): NormalizedAttribute[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((a) => a && typeof a === 'object')
    .map((a: Record<string, unknown>) => ({
      trait_type: sanitize(a.trait_type ?? a.traitType ?? a.name ?? ''),
      value: sanitize(a.value ?? a.trait_value ?? ''),
    }))
    .filter((a) => a.trait_type && a.value);
}

// ─── Single item metadata fetch ───────────────────────────────────────────────

export async function fetchAndStoreItemMetadata(itemId: string): Promise<void> {
  const item = await prismaRead.nftItem.findUnique({ where: { id: itemId } });
  if (!item?.metadataUri) return;

  // Check TTL
  if (
    item.metadataFetchedAt &&
    Date.now() - item.metadataFetchedAt.getTime() < METADATA_TTL_MS
  ) {
    return;
  }

  try {
    const raw = await fetchMetadataJson(item.metadataUri);
    const attributes = normalizeAttributes(raw.attributes);
    const metadata = {
      name: sanitize(raw.name),
      description: sanitize(raw.description),
      image: resolveIpfsUri(sanitize(raw.image)),
      animation_url: raw.animation_url ? resolveIpfsUri(sanitize(raw.animation_url)) : undefined,
      external_url: sanitize(raw.external_url),
      attributes,
      raw,
    };

    await prismaWrite.nftItem.update({
      where: { id: itemId },
      data: {
        metadata,
        metadataFetchedAt: new Date(),
      },
    });
  } catch (err) {
    logger.warn({ err, itemId }, '[nft-metadata] Failed to fetch item metadata');
  }
}

// ─── Batch stale metadata refresh ────────────────────────────────────────────

export async function refreshStaleMetadata(limit = 200): Promise<void> {
  const cutoff = new Date(Date.now() - METADATA_TTL_MS);

  const staleItems = await prismaRead.nftItem.findMany({
    where: {
      metadataUri: { not: null },
      OR: [{ metadataFetchedAt: null }, { metadataFetchedAt: { lt: cutoff } }],
    },
    select: { id: true },
    take: limit,
  });

  logger.info({ count: staleItems.length }, '[nft-metadata] Refreshing stale metadata');

  const CONCURRENCY = 10;
  for (let i = 0; i < staleItems.length; i += CONCURRENCY) {
    const batch = staleItems.slice(i, i + CONCURRENCY);
    await Promise.allSettled(batch.map((item) => fetchAndStoreItemMetadata(item.id)));
  }
}

// ─── On-chain collection metadata ────────────────────────────────────────────

export interface CollectionChainMetadata {
  name?: string;
  symbol?: string;
  totalSupply?: number;
}

export async function fetchCollectionMetadataFromChain(
  contractAddress: string,
): Promise<CollectionChainMetadata> {
  const rpc = new SorobanRpc.Server(config.stellarRpcUrl, { allowHttp: true });

  // Try to read known storage keys: name, symbol, total_supply
  const keyAttempts = ['name', 'symbol', 'total_supply', 'totalSupply'];
  const result: CollectionChainMetadata = {};

  for (const keyName of keyAttempts) {
    try {
      const key = xdr.ScVal.scvSymbol(keyName);
      const ledgerKey = xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: xdr.ScAddress.scAddressTypeContract(
            xdr.Hash.fromXDR(contractAddress.startsWith('C') ? contractAddress : contractAddress, 'base64'),
          ),
          key,
          durability: xdr.ContractDataDurability.persistent(),
        }),
      );
      const entries = await rpc.getLedgerEntries(ledgerKey);
      if (entries.entries.length > 0) {
        const val = scValToNative(entries.entries[0].val.contractData().val());
        if (keyName === 'name' || keyName === 'symbol') {
          if (keyName === 'name') result.name = String(val);
          else result.symbol = String(val);
        } else {
          result.totalSupply = Number(val);
        }
      }
    } catch {
      // key not found, continue
    }
  }

  return result;
}

// ─── Start background refresh job ────────────────────────────────────────────

export function startMetadataRefreshJob(): void {
  // Refresh stale metadata every 6 hours
  const INTERVAL_MS = 6 * 60 * 60 * 1000;
  setInterval(() => void refreshStaleMetadata(), INTERVAL_MS);
  logger.info('[nft-metadata] Background metadata refresh job started');
}
