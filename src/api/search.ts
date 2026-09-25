import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prismaRead, prismaWrite } from '../db';
import { asyncHandler } from '../middleware/asyncHandler';
import { parseQuery, safeString } from '../schemas/common';
import { config } from '../config';
import { logger } from '../logger';
import { buildCacheKey, cacheGet, cacheSet } from '../cache';
import { searchFullText, rebuildSearchIndex } from '../services/search/full-text-search';

interface _ContractSource {
  contractAddress: string;
  functionDetails: Array<{
    name: string;
    pseudoCode?: string;
    params?: string[];
    returns?: string[];
    selector: string;
    complexity?: string;
  }>;
  imports: unknown[];
  exports: unknown[];
  events: unknown[];
  errors: unknown[];
  storageVariables: unknown[];
}

export const searchRouter = Router();

const searchQuerySchema = z.object({
  q: safeString
    .refine((s) => s.trim().length >= 2, 'Query string q required (min 2 chars)')
    .refine((s) => s.trim().length <= 512, 'Query must not exceed 512 characters'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// ── Unified full-text search (SR01) ─────────────────────────────────────────
// Query string is split into a sanitised `q` plus a `type` facet that selects
// contracts, decoded events or transaction metadata (or `all`).

/** Accepts `true`/`false`/`1`/`0` from a query string (z.coerce.boolean treats
 * the string "false" as truthy). Defaults to enabled. */
const booleanish = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((v) => (v === undefined ? true : v === true || v === 'true' || v === '1'));

const unifiedSearchSchema = z.object({
  q: safeString
    .refine((s) => s.trim().length >= 2, 'Query string q required (min 2 chars)')
    .refine((s) => s.trim().length <= 512, 'Query must not exceed 512 characters'),
  type: z.enum(['all', 'contract', 'event', 'transaction']).default('all'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  highlight: booleanish,
});

async function handleUnifiedSearch(req: Request, res: Response) {
  const parsed = unifiedSearchSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Invalid query parameters',
      details: parsed.error.flatten().fieldErrors,
    });
  }

  const { q, type, limit, offset, highlight } = parsed.data;

  try {
    const page = await searchFullText({ q: q.trim(), type, limit, offset, highlight });
    return res.json(page);
  } catch (err: any) {
    return res.status(500).json({ error: 'Search failed', detail: String(err) });
  }
}

// GET /search?q=<query>&type=<all|contract|event|transaction> — ranked,
// highlighted full-text search across the unified index (contracts, decoded
// events, transaction metadata). When `type` is omitted the legacy
// contract-source search below is used, which additionally supports faceted
// prefix notation:
//   - function:<name>
//   - import:<module>
//   - event:<name>
//   - storage:<key>
//   - error:<name>
searchRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    // `?type=` selects the unified full-text index; without it we keep the
    // legacy contract-source faceted search below for backward compatibility.
    if (req.query.type !== undefined) {
      return handleUnifiedSearch(req, res);
    }

    const parsed = searchQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Invalid query parameters', details: parsed.error.flatten().fieldErrors });
    }

    const { q, limit, offset } = parsed.data;
    const trimmedQ = q.trim();

    try {
      const functionMatch = trimmedQ.match(/function:(\w+)/i)?.[1];
      const importMatch = trimmedQ.match(/import:(\w+)/i)?.[1];
      const eventMatch = trimmedQ.match(/event:(\w+)/i)?.[1];
      const storageMatch = trimmedQ.match(/storage:(\w+)/i)?.[1];
      const errorMatch = trimmedQ.match(/error:(\w+)/i)?.[1];

      const cleanQuery = trimmedQ
        .replace(/function:\w+/i, '')
        .replace(/import:\w+/i, '')
        .replace(/event:\w+/i, '')
        .replace(/storage:\w+/i, '')
        .replace(/error:\w+/i, '')
        .trim();

      const searchIndexEntries = await prismaRead.searchIndexEntry.findMany({
        where: {
          AND: [
            cleanQuery ? { content: { contains: cleanQuery, mode: 'insensitive' } } : undefined,
            functionMatch
              ? {
                  AND: [
                    { contentType: 'function' },
                    { content: { contains: functionMatch, mode: 'insensitive' } },
                  ],
                }
              : undefined,
            importMatch
              ? {
                  AND: [
                    { contentType: 'import' },
                    { content: { contains: importMatch, mode: 'insensitive' } },
                  ],
                }
              : undefined,
            eventMatch
              ? {
                  AND: [
                    { contentType: 'event' },
                    { content: { contains: eventMatch, mode: 'insensitive' } },
                  ],
                }
              : undefined,
            storageMatch
              ? {
                  AND: [
                    { contentType: 'storage' },
                    { content: { contains: storageMatch, mode: 'insensitive' } },
                  ],
                }
              : undefined,
            errorMatch
              ? {
                  AND: [
                    { contentType: 'error' },
                    { content: { contains: errorMatch, mode: 'insensitive' } },
                  ],
                }
              : undefined,
          ].filter(Boolean),
        },
        select: { contractAddress: true, contentType: true, content: true, metadata: true },
        take: limit,
        skip: offset,
      });

      const results: Record<string, any> = {};
      for (const entry of searchIndexEntries) {
        if (!results[entry.contractAddress]) {
          results[entry.contractAddress] = { address: entry.contractAddress, hits: {} };
        }
        if (!results[entry.contractAddress].hits[entry.contentType]) {
          results[entry.contractAddress].hits[entry.contentType] = [];
        }
        results[entry.contractAddress].hits[entry.contentType].push({
          content: entry.content,
          metadata: entry.metadata,
        });
      }

      return res.json({
        query: trimmedQ,
        total: Object.keys(results).length,
        results: Object.values(results),
      });
    } catch (err: any) {
      return res.status(500).json({ error: 'Search failed', detail: String(err) });
    }
  }),
);

// GET /search/index — trigger re-indexing of all contracts
searchRouter.get(
  '/index',
  asyncHandler(async (_req: Request, res: Response) => {
    try {
      const sources = await prismaRead.contractSource.findMany({
        include: { functionDetails: true },
      });
      await prismaWrite.searchIndexEntry.deleteMany({});
      let indexed = 0;
      for (const source of sources) {
        indexed += await reindexSource(source, indexed);
      }

      // Also rebuild the unified full-text index (contracts, events,
      // transactions) so `GET /?q=&type=` reflects existing data.
      const searchIndex = await rebuildSearchIndex();

      return res.json({
        indexed,
        searchIndexed: searchIndex.indexed,
        message:
          `Reindexed ${indexed} entries from ${sources.length} contracts; ` +
          `rebuilt ${searchIndex.indexed} full-text documents`,
      });
    } catch (err: any) {
      return res.status(500).json({ error: 'Indexing failed', detail: String(err) });
    }
  }),
);

async function reindexSource(source: any, _startIndex: number): Promise<number> {
  let indexed = 0;
  for (const fn of source.functionDetails || []) {
    await prismaWrite.searchIndexEntry.create({
      data: {
        contractAddress: source.contractAddress,
        contentType: 'function',
        content: `${fn.name} ${fn.pseudoCode || ''} ${(fn.params || []).join(' ')} ${(fn.returns || []).join(' ')}`,
        metadata: { selector: fn.selector, complexity: fn.complexity },
      },
    });
    indexed++;
  }
  for (const imp of (source.imports as any[]) || []) {
    await prismaWrite.searchIndexEntry.create({
      data: {
        contractAddress: source.contractAddress,
        contentType: 'import',
        content: `${imp.module} ${imp.name}`,
        metadata: { kind: imp.kind, host: imp.host },
      },
    });
    indexed++;
  }
  for (const exp of (source.exports as any[]) || []) {
    await prismaWrite.searchIndexEntry.create({
      data: {
        contractAddress: source.contractAddress,
        contentType: 'export',
        content: exp.name,
        metadata: { kind: exp.kind, index: exp.index },
      },
    });
    indexed++;
  }
  for (const evt of (source.events as any[]) || []) {
    await prismaWrite.searchIndexEntry.create({
      data: {
        contractAddress: source.contractAddress,
        contentType: 'event',
        content: JSON.stringify(evt),
        metadata: evt,
      },
    });
    indexed++;
  }
  for (const err of (source.errors as any[]) || []) {
    await prismaWrite.searchIndexEntry.create({
      data: {
        contractAddress: source.contractAddress,
        contentType: 'error',
        content: JSON.stringify(err),
        metadata: err,
      },
    });
    indexed++;
  }
  for (const stor of (source.storageVariables as any[]) || []) {
    await prismaWrite.searchIndexEntry.create({
      data: {
        contractAddress: source.contractAddress,
        contentType: 'storage',
        content: JSON.stringify(stor),
        metadata: stor,
      },
    });
    indexed++;
  }
  return indexed;
}

// ── Autocomplete suggestions ──────────────────────────────────────────────────
//
// GET /search/suggest powers the omnibox/autocomplete UIs. Existing search
// endpoints are scoped per resource type, so a frontend matching contracts,
// wallets, transactions, events and tokens needs one round-trip per keystroke.
// This endpoint fans the query out to every source in parallel, merges the
// results by match quality, and bounds latency with a per-source budget, a
// merged-result cache, and per-type caps.

export const SUGGEST_TYPES = ['contract', 'wallet', 'transaction', 'event', 'token'] as const;
export type SuggestType = (typeof SUGGEST_TYPES)[number];

export interface SuggestCandidate {
  type: SuggestType;
  /** Canonical identifier for the resource (address, hash, event id). */
  id: string;
  /** Primary text shown for the candidate. */
  label: string;
  /** Secondary context (name, function, contract, ...). */
  sublabel?: string;
  /** 1-100; higher is a better match. */
  score: number;
}

export interface SuggestResult {
  query: string;
  data: SuggestCandidate[];
  count: number;
  tookMs: number;
}

const SUGGEST_DEFAULT_LIMIT = 10;
const SUGGEST_MAX_LIMIT = 25;
/** Each source may contribute at most this many candidates before merging. */
const SUGGEST_PER_TYPE_CAP = 5;

/**
 * Lower index ranks earlier when scores tie. Name-like resources (tokens,
 * contracts) are more useful mid-typing than pasted hashes/addresses, so they
 * lead the tiebreak.
 */
const SUGGEST_TYPE_PRIORITY: Record<SuggestType, number> = {
  token: 0,
  contract: 1,
  wallet: 2,
  transaction: 3,
  event: 4,
};

/**
 * Score how well `query` matches an ordered list of candidate fields. Fields
 * earlier in the list carry more weight (the primary identifier). Returns null
 * when nothing matches, otherwise a score between 1 and 100.
 */
export function scoreMatch(query: string, fields: (string | null | undefined)[]): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;

  let best: number | null = null;
  fields.forEach((field, index) => {
    if (!field) return;
    const value = field.toLowerCase();
    let score: number | null = null;
    if (value === q) score = 100 - index * 2;
    else if (value.startsWith(q)) score = 88 - index * 2;
    else if (value.includes(q)) score = 62 - index * 2;

    if (score !== null && (best === null || score > best)) best = score;
  });
  return best;
}

/** Merge candidates from every source and keep the best `limit`, deterministically. */
export function rankCandidates(candidates: SuggestCandidate[], limit: number): SuggestCandidate[] {
  return [...candidates]
    .sort(
      (a, b) =>
        b.score - a.score ||
        SUGGEST_TYPE_PRIORITY[a.type] - SUGGEST_TYPE_PRIORITY[b.type] ||
        a.label.localeCompare(b.label) ||
        a.id.localeCompare(b.id),
    )
    .slice(0, limit);
}

/**
 * Run a lookup against a per-source latency budget. A slow (or failing) source
 * resolves to an empty list instead of stalling the whole autocomplete request.
 */
export async function withBudget<T>(loader: () => Promise<T[]>, ms: number): Promise<T[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T[]>((resolve) => {
    timer = setTimeout(() => resolve([]), ms);
  });

  try {
    return await Promise.race([loader(), timeout]);
  } catch (err) {
    logger.warn('search suggest source failed', { error: String(err) });
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── per-type lookups ──────────────────────────────────────────────────────────

async function loadContracts(q: string): Promise<SuggestCandidate[]> {
  const rows = await prismaRead.contract.findMany({
    where: {
      isToken: false,
      OR: [
        { address: { startsWith: q, mode: 'insensitive' } },
        { name: { contains: q, mode: 'insensitive' } },
      ],
    },
    take: SUGGEST_PER_TYPE_CAP,
    orderBy: { name: 'asc' },
    select: { address: true, name: true, description: true },
  });

  return rows.flatMap((row): SuggestCandidate[] => {
    const score = scoreMatch(q, [row.address, row.name]);
    if (score === null) return [];
    return [
      {
        type: 'contract',
        id: row.address,
        label: row.name || row.address,
        sublabel: row.name ? row.address : (row.description ?? undefined),
        score,
      },
    ];
  });
}

async function loadTokens(q: string): Promise<SuggestCandidate[]> {
  const rows = await prismaRead.contract.findMany({
    where: {
      isToken: true,
      OR: [
        { tokenSymbol: { startsWith: q, mode: 'insensitive' } },
        { tokenName: { startsWith: q, mode: 'insensitive' } },
        { address: { startsWith: q, mode: 'insensitive' } },
      ],
    },
    take: SUGGEST_PER_TYPE_CAP,
    orderBy: { tokenSymbol: 'asc' },
    select: { address: true, tokenName: true, tokenSymbol: true },
  });

  return rows.flatMap((row): SuggestCandidate[] => {
    const score = scoreMatch(q, [row.tokenSymbol, row.tokenName, row.address]);
    if (score === null) return [];
    return [
      {
        type: 'token',
        id: row.address,
        label: row.tokenSymbol ?? row.tokenName ?? row.address,
        sublabel: row.tokenName && row.tokenName !== row.tokenSymbol ? row.tokenName : row.address,
        score,
      },
    ];
  });
}

async function loadWallets(q: string): Promise<SuggestCandidate[]> {
  // Wallets are not a table of their own — distinct source accounts stand in.
  const rows = await prismaRead.transaction.findMany({
    where: { sourceAccount: { startsWith: q, mode: 'insensitive' } },
    distinct: ['sourceAccount'],
    take: SUGGEST_PER_TYPE_CAP,
    orderBy: [{ sourceAccount: 'asc' }],
    select: { sourceAccount: true },
  });

  return rows.flatMap((row): SuggestCandidate[] => {
    const score = scoreMatch(q, [row.sourceAccount]);
    if (score === null) return [];
    return [{ type: 'wallet', id: row.sourceAccount, label: row.sourceAccount, score }];
  });
}

async function loadTransactions(q: string): Promise<SuggestCandidate[]> {
  const rows = await prismaRead.transaction.findMany({
    where: { hash: { startsWith: q, mode: 'insensitive' } },
    take: SUGGEST_PER_TYPE_CAP,
    orderBy: { ledgerSequence: 'desc' },
    select: { hash: true, functionName: true, humanReadable: true, status: true },
  });

  return rows.flatMap((row): SuggestCandidate[] => {
    const score = scoreMatch(q, [row.hash, row.functionName, row.humanReadable]);
    if (score === null) return [];
    return [
      {
        type: 'transaction',
        id: row.hash,
        label: row.hash,
        sublabel: row.functionName ?? row.humanReadable ?? row.status,
        score,
      },
    ];
  });
}

async function loadEvents(q: string): Promise<SuggestCandidate[]> {
  const rows = await prismaRead.event.findMany({
    where: {
      OR: [
        { eventType: { contains: q, mode: 'insensitive' } },
        { contractAddress: { startsWith: q, mode: 'insensitive' } },
      ],
    },
    take: SUGGEST_PER_TYPE_CAP,
    orderBy: { ledgerSequence: 'desc' },
    select: { id: true, eventType: true, contractAddress: true },
  });

  return rows.flatMap((row): SuggestCandidate[] => {
    const score = scoreMatch(q, [row.contractAddress, row.eventType]);
    if (score === null) return [];
    return [
      {
        type: 'event',
        id: row.id,
        label: row.eventType,
        sublabel: row.contractAddress,
        score,
      },
    ];
  });
}

const SUGGEST_LOADERS: Record<SuggestType, (q: string) => Promise<SuggestCandidate[]>> = {
  contract: loadContracts,
  wallet: loadWallets,
  transaction: loadTransactions,
  event: loadEvents,
  token: loadTokens,
};

// ── suggest API ───────────────────────────────────────────────────────────────

export async function getSearchSuggestions(params: {
  q: string;
  limit?: number;
  types?: SuggestType[];
}): Promise<SuggestResult> {
  const startedAt = Date.now();
  const q = params.q.trim();
  const limit = params.limit ?? SUGGEST_DEFAULT_LIMIT;
  const types = params.types && params.types.length ? params.types : [...SUGGEST_TYPES];

  const key = buildCacheKey('search-suggest', q, limit, [...types].sort().join(','));
  const cached = await cacheGet<SuggestCandidate[]>(key);
  if (cached) {
    return { query: q, data: cached, count: cached.length, tookMs: Date.now() - startedAt };
  }

  const perSource = await Promise.all(
    types.map((type) => withBudget(() => SUGGEST_LOADERS[type](q), config.searchSuggestBudgetMs)),
  );

  const data = rankCandidates(perSource.flat(), limit);

  if (config.searchSuggestCacheTtlMs > 0) {
    await cacheSet(key, data, Math.max(1, Math.round(config.searchSuggestCacheTtlMs / 1000)));
  }

  return { query: q, data, count: data.length, tookMs: Date.now() - startedAt };
}

const suggestQuerySchema = z.object({
  q: safeString
    .refine((s) => s.trim().length >= 1, 'Query string q required')
    .refine((s) => s.trim().length <= 128, 'Query must not exceed 128 characters'),
  limit: z.coerce.number().int().min(1).max(SUGGEST_MAX_LIMIT).default(SUGGEST_DEFAULT_LIMIT),
  /** Comma-separated subset of contract,wallet,transaction,event,token. */
  types: z.string().optional(),
});

function parseSuggestTypes(raw?: string): SuggestType[] | undefined {
  if (!raw) return undefined;
  const valid = raw
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t): t is SuggestType => (SUGGEST_TYPES as readonly string[]).includes(t));
  return valid.length ? valid : undefined;
}

/**
 * @swagger
 * /search/suggest:
 *   get:
 *     summary: Ranked autocomplete suggestions across every resource type
 *     description: >-
 *       Fans a partial query out to contracts, wallets, transactions, events and
 *       tokens in parallel, then merges and ranks the candidates for omnibox /
 *       autocomplete UIs. Each source runs behind a latency budget so a slow
 *       lookup cannot stall the response.
 *     tags: [Search]
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema: { type: string, maxLength: 128 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 25, default: 10 }
 *       - in: query
 *         name: types
 *         description: Comma-separated subset of contract,wallet,transaction,event,token
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Ranked suggestions
 *       400:
 *         description: Invalid query parameters
 */
// GET /search/suggest?q=&limit=&types=
searchRouter.get(
  '/suggest',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = parseQuery(suggestQuerySchema, req, res);
    if (!parsed.ok) return;

    const { q, limit, types } = parsed.data;
    const result = await getSearchSuggestions({ q, limit, types: parseSuggestTypes(types) });
    res.json(result);
  }),
);
