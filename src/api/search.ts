import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prismaRead as prisma, prismaWrite } from '../db';
import { asyncHandler } from '../middleware/asyncHandler';
import { safeString } from '../schemas/common';

interface SearchIndexEntry {
  contractAddress: string;
  contentType: string;
  content: string;
  metadata: unknown;
}

interface ContractSource {
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

// GET /search?q=<query> — full-text search across all contracts
// Supports faceted search with prefix notation:
//   - function:<name>
//   - import:<module>
//   - event:<name>
//   - storage:<key>
//   - error:<name>
searchRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
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

      const searchIndexEntries = await (prisma as any).searchIndexEntry.findMany({
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
searchRouter.get('/index', async (_req: Request, res: Response) => {
  try {
    const sources = await (prisma as any).contractSource.findMany({
      include: { functionDetails: true },
    });

    await (prismaWrite as any).searchIndexEntry.deleteMany({});

    let indexed = 0;
    for (const source of sources) {
      for (const fn of source.functionDetails || []) {
        await (
          prismaWrite as unknown as {
            searchIndexEntry: { create: (args: unknown) => Promise<unknown> };
          }
        ).searchIndexEntry.create({
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
        await (prismaWrite as any).searchIndexEntry.create({
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
        await (prismaWrite as any).searchIndexEntry.create({
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
        await (prismaWrite as any).searchIndexEntry.create({
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
        await (prismaWrite as any).searchIndexEntry.create({
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
        await (prismaWrite as any).searchIndexEntry.create({
          data: {
            contractAddress: source.contractAddress,
            contentType: 'storage',
            content: JSON.stringify(stor),
            metadata: stor,
          },
        });
        indexed++;
      }
    }

    return res.json({
      indexed,
      message: `Reindexed ${indexed} entries from ${sources.length} contracts`,
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'Indexing failed', detail: String(err) });
  }
});
