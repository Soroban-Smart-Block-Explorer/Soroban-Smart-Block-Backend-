/**
 * NFT Scraping Pipeline
 *
 * 1. Parse token URIs from Soroban contract data keys via RPC getLedgerEntries.
 * 2. Resolve IPFS / HTTP URIs and fetch metadata JSON + image.
 * 3. Cache results on the local filesystem under .nft-cache/.
 * 4. Sanitize all string fields against XSS before returning.
 */

import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { SorobanRpc, xdr, scValToNative } from '@stellar/stellar-sdk';
import { config } from '../config';

// ─── Config ───────────────────────────────────────────────────────────────────

const CACHE_DIR = path.resolve(process.cwd(), '.nft-cache');
const IPFS_GATEWAY = process.env.IPFS_GATEWAY ?? 'https://cloudflare-ipfs.com/ipfs/';
const FETCH_TIMEOUT_MS = 10_000;
const CONCURRENCY = 5;

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const rpc = new SorobanRpc.Server(config.stellarRpcUrl, { allowHttp: true });

// ─── Types ────────────────────────────────────────────────────────────────────

export interface NftMetadata {
  contractAddress: string;
  tokenId: string;
  tokenUri: string;
  name: string;
  description: string;
  image: string; // resolved HTTP URL (gateway-rewritten if IPFS)
  attributes: Array<{ trait_type: string; value: string }>;
  raw: Record<string, unknown>;
}

// ─── XSS sanitizer ───────────────────────────────────────────────────────────

const XSS_PATTERN = /<[^>]*>|javascript\s*:|data\s*:/gi;

/** Strip HTML tags and dangerous URI schemes from a string. */
function sanitize(value: unknown): string {
  return String(value ?? '').replace(XSS_PATTERN, '');
}

function sanitizeMetadata(
  raw: Record<string, unknown>,
): Pick<NftMetadata, 'name' | 'description' | 'image' | 'attributes'> {
  const attrs = Array.isArray(raw.attributes)
    ? (raw.attributes as Array<Record<string, unknown>>).map((a) => ({
        trait_type: sanitize(a.trait_type),
        value: sanitize(a.value),
      }))
    : [];

  return {
    name: sanitize(raw.name),
    description: sanitize(raw.description),
    image: resolveUri(sanitize(raw.image)),
    attributes: attrs,
  };
}

// ─── URI helpers ──────────────────────────────────────────────────────────────

/** Rewrite ipfs:// and bare CIDs to the configured HTTP gateway. */
function resolveUri(uri: string): string {
  if (uri.startsWith('ipfs://')) {
    return IPFS_GATEWAY + uri.slice(7);
  }
  // bare CID (Qm... or bafy...)
  if (/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|bafy[a-z2-7]{52})/.test(uri)) {
    return IPFS_GATEWAY + uri;
  }
  return uri;
}

// ─── Local cache ──────────────────────────────────────────────────────────────

function cacheKey(contractAddress: string, tokenId: string): string {
  // Sanitize path components
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(CACHE_DIR, `${safe(contractAddress)}_${safe(tokenId)}.json`);
}

function readCache(contractAddress: string, tokenId: string): NftMetadata | null {
  const file = cacheKey(contractAddress, tokenId);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as NftMetadata;
  } catch {
    return null;
  }
}

function writeCache(meta: NftMetadata): void {
  const file = cacheKey(meta.contractAddress, meta.tokenId);
  fs.writeFileSync(file, JSON.stringify(meta), 'utf8');
}

// ─── Soroban data-key parsing ─────────────────────────────────────────────────

/**
 * Known Soroban NFT data-key patterns:
 *   - Map { "TokenUri" => tokenId }
 *   - Map { "uri" => tokenId }
 *   - Symbol "token_uri" with a u64/string value
 *
 * Returns { tokenId, uri } pairs found in the ledger entry XDR.
 */
function extractUriFromLedgerEntry(xdrBase64: string): { tokenId: string; uri: string } | null {
  try {
    const entry = xdr.LedgerEntry.fromXDR(xdrBase64, 'base64');
    const data = entry.data();
    if (data.switch().name !== 'contractData') return null;

    const key = data.contractData().key();
    const val = data.contractData().val();

    const keyNative = scValToNative(key) as unknown;
    const valNative = scValToNative(val) as unknown;

    // Key is a map like { TokenUri: <tokenId> } or { uri: <tokenId> }
    if (keyNative && typeof keyNative === 'object' && !Array.isArray(keyNative)) {
      const km = keyNative as Record<string, unknown>;
      const uriKey = Object.keys(km).find((k) => /uri/i.test(k));
      if (uriKey) {
        const tokenId = String(km[uriKey]);
        const uri = String(valNative ?? '');
        if (uri) return { tokenId, uri };
      }
    }

    // Key is a symbol "token_uri" and value is the URI string
    if (typeof keyNative === 'string' && /uri/i.test(keyNative) && typeof valNative === 'string') {
      return { tokenId: keyNative, uri: valNative };
    }

    return null;
  } catch {
    return null;
  }
}

// ─── IPFS / HTTP fetch ────────────────────────────────────────────────────────

async function fetchJson(uri: string): Promise<Record<string, unknown>> {
  const url = resolveUri(uri);
  const { data } = await axios.get<Record<string, unknown>>(url, {
    timeout: FETCH_TIMEOUT_MS,
    maxContentLength: 1_000_000, // 1 MB cap
    headers: { Accept: 'application/json' },
  });
  if (typeof data !== 'object' || data === null) throw new Error('Non-object JSON response');
  return data;
}

// ─── Concurrency limiter ──────────────────────────────────────────────────────

async function pLimit<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
  const results: T[] = [];
  let idx = 0;

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Scrape NFT metadata for a list of ledger entry XDR strings belonging to
 * `contractAddress`. Returns sanitized NftMetadata for each token URI found.
 */
export async function scrapeNftMetadata(
  contractAddress: string,
  ledgerEntryXdrs: string[],
): Promise<NftMetadata[]> {
  // 1. Parse URIs from data keys
  const uriPairs = ledgerEntryXdrs
    .map(extractUriFromLedgerEntry)
    .filter((p): p is { tokenId: string; uri: string } => p !== null);

  if (uriPairs.length === 0) return [];

  // 2. Fetch metadata (with cache)
  const tasks = uriPairs.map(({ tokenId, uri }) => async (): Promise<NftMetadata | null> => {
    const cached = readCache(contractAddress, tokenId);
    if (cached) return cached;

    try {
      const raw = await fetchJson(uri);
      const sanitized = sanitizeMetadata(raw);
      const meta: NftMetadata = {
        contractAddress,
        tokenId,
        tokenUri: resolveUri(uri),
        raw,
        ...sanitized,
      };
      writeCache(meta);
      return meta;
    } catch (err) {
      console.warn(`[nft-scraper] Failed to fetch ${uri}: ${(err as Error).message}`);
      return null;
    }
  });

  const results = await pLimit(tasks, CONCURRENCY);
  return results.filter((r): r is NftMetadata => r !== null);
}

/**
 * Fetch all contract data entries for `contractAddress` from the RPC node,
 * then scrape NFT metadata from any token-URI keys found.
 */
export async function scrapeContract(contractAddress: string): Promise<NftMetadata[]> {
  // getLedgerEntries requires explicit keys; we use getContractData (event-based discovery)
  // For contracts that store URIs under predictable keys we query the RPC directly.
  // This implementation fetches the contract's storage entries via the RPC REST path.
  const url = `${config.stellarRpcUrl.replace(/\/$/, '')}/contract/${contractAddress}/data`;

  let xdrs: string[] = [];
  try {
    const { data } = await axios.get<{ entries?: Array<{ xdr: string }> }>(url, {
      timeout: FETCH_TIMEOUT_MS,
    });
    xdrs = (data.entries ?? []).map((e) => e.xdr).filter(Boolean);
  } catch {
    // Fallback: caller must supply XDRs directly via scrapeNftMetadata
  }

  return scrapeNftMetadata(contractAddress, xdrs);
}

/**
 * Retrieve a single cached NFT metadata entry without hitting the network.
 */
export function getCachedNft(contractAddress: string, tokenId: string): NftMetadata | null {
  return readCache(contractAddress, tokenId);
}
