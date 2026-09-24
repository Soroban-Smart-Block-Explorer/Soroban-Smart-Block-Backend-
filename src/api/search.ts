import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prismaRead, prismaWrite } from '../db';
import { asyncHandler } from '../middleware/asyncHandler';
import { safeString } from '../schemas/common';
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
