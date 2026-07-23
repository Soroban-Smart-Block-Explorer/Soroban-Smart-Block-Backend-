import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prismaRead } from '../db';
import { asyncHandler } from '../middleware/asyncHandler';
import { searchDocuments, fullTextSearch } from '../services/search/inverted-index';
import { fuzzySearch, fuzzySearchAddress } from '../services/search/fuzzy';
import { queryAutocomplete, querySuffixAutocomplete } from '../services/search/autocomplete';
import { rebuildAllIndexes, getIndexStatus } from '../services/search/indexer';
import {
  searchSimilarContracts,
  searchSimilarTransactions,
  searchSimilarEvents,
} from '../services/search/semantic';

export const searchRouter = Router();

const TxSearchSchema = z.object({
  q: z.string().optional(),
  sender: z.string().optional(),
  receiver: z.string().optional(),
  contract: z.string().optional(),
  amountMin: z.coerce.number().optional(),
  amountMax: z.coerce.number().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  eventType: z.string().optional(),
  memoContent: z.string().optional(),
  status: z.string().optional(),
  token: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  sort: z.enum(['recent', 'amount', 'relevance']).default('recent'),
});

// ── GET /api/v1/search/transactions ─────────────────────────────────────────

searchRouter.get(
  '/transactions',
  asyncHandler(async (req: Request, res: Response) => {
    const params = TxSearchSchema.parse(req.query);

    const where: Record<string, unknown> = {};

    if (params.sender) where.sourceAccount = params.sender;
    if (params.contract) where.contractAddress = params.contract;
    if (params.status) where.status = params.status;
    if (params.memoContent) {
      where.humanReadable = { contains: params.memoContent, mode: 'insensitive' };
    }
    if (params.dateFrom || params.dateTo) {
      const dateFilter: Record<string, Date> = {};
      if (params.dateFrom) dateFilter.gte = new Date(params.dateFrom);
      if (params.dateTo) dateFilter.lte = new Date(params.dateTo);
      where.ledgerCloseTime = dateFilter;
    }

    if (params.q) {
      const searchResults = await fullTextSearch(
        params.q,
        'transaction',
        params.limit,
        params.offset,
      );
      const txIds = searchResults.results.map((r) => r.docId);

      const txs = await prismaRead.transaction.findMany({
        where: { id: { in: txIds } },
        orderBy: params.sort === 'recent' ? { ledgerCloseTime: 'desc' } : { id: 'asc' },
      });

      return res.json({
        query: params.q,
        total: searchResults.total,
        results: txs,
      });
    }

    const orderBy: Record<string, string> =
      params.sort === 'recent' ? { ledgerCloseTime: 'desc' as const } : { id: 'asc' };

    const [txs, total] = await Promise.all([
      prismaRead.transaction.findMany({
        where,
        take: params.limit,
        skip: params.offset,
        orderBy,
      }),
      prismaRead.transaction.count({ where }),
    ]);

    return res.json({ total, results: txs });
  }),
);

// ── GET /api/v1/search/contracts ────────────────────────────────────────────

const ContractSearchSchema = z.object({
  q: z.string().optional(),
  name: z.string().optional(),
  functionSignature: z.string().optional(),
  wasmHash: z.string().optional(),
  sourceCode: z.string().optional(),
  compiler: z.string().optional(),
  isVerified: z.coerce.boolean().optional(),
  isToken: z.coerce.boolean().optional(),
  tokenSymbol: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

searchRouter.get(
  '/contracts',
  asyncHandler(async (req: Request, res: Response) => {
    const params = ContractSearchSchema.parse(req.query);

    const where: Record<string, unknown> = {};

    if (params.name) where.name = { contains: params.name, mode: 'insensitive' };
    if (params.wasmHash) where.wasmHash = params.wasmHash;
    if (params.isVerified !== undefined) where.isVerified = params.isVerified;
    if (params.isToken !== undefined) where.isToken = params.isToken;
    if (params.tokenSymbol)
      where.tokenSymbol = { contains: params.tokenSymbol, mode: 'insensitive' };
    if (params.functionSignature) {
      where.functionSignatures = { contains: params.functionSignature };
    }

    if (params.q) {
      const searchResults = await searchDocuments({
        query: params.q,
        docType: 'contract',
        limit: params.limit,
        offset: params.offset,
      });
      const contractIds = searchResults.results.map((r) => r.docId);

      const contracts = await prismaRead.contract.findMany({
        where: { id: { in: contractIds } },
      });

      return res.json({
        query: params.q,
        total: searchResults.total,
        results: contracts,
      });
    }

    const [contracts, total] = await Promise.all([
      prismaRead.contract.findMany({
        where,
        take: params.limit,
        skip: params.offset,
        orderBy: { createdAt: 'desc' },
      }),
      prismaRead.contract.count({ where }),
    ]);

    return res.json({ total, results: contracts });
  }),
);

// ── GET /api/v1/search/wallets ──────────────────────────────────────────────

const WalletSearchSchema = z.object({
  q: z.string().optional(),
  address: z.string().optional(),
  stellarName: z.string().optional(),
  txCountMin: z.coerce.number().optional(),
  txCountMax: z.coerce.number().optional(),
  balanceMin: z.coerce.number().optional(),
  balanceMax: z.coerce.number().optional(),
  createdAfter: z.string().optional(),
  createdBefore: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

searchRouter.get(
  '/wallets',
  asyncHandler(async (req: Request, res: Response) => {
    const params = WalletSearchSchema.parse(req.query);

    if (params.q) {
      const fuzzy = await fuzzySearchAddress(params.q, params.limit);
      const txResults = await fullTextSearch(params.q, 'transaction', params.limit, 0);

      const accountSet = new Set<string>();
      for (const r of fuzzy) {
        const meta = r as { docId?: string };
        if (meta.docId) accountSet.add(meta.docId);
      }
      for (const r of txResults.results) {
        const meta = r.metadata as { sourceAccount?: string } | null;
        if (meta?.sourceAccount) accountSet.add(meta.sourceAccount);
      }

      const stellarAccounts = await prismaRead.stellarAccount.findMany({
        where: { address: { in: Array.from(accountSet) } },
        take: params.limit,
      });

      return res.json({
        query: params.q,
        total: stellarAccounts.length,
        results: stellarAccounts,
      });
    }

    const where: Record<string, unknown> = {};
    if (params.address) where.address = { contains: params.address, mode: 'insensitive' };

    const [accounts, total] = await Promise.all([
      prismaRead.stellarAccount.findMany({
        where,
        take: params.limit,
        skip: params.offset,
        orderBy: { lastActivity: 'desc' },
      }),
      prismaRead.stellarAccount.count({ where }),
    ]);

    return res.json({ total, results: accounts });
  }),
);

// ── GET /api/v1/search/events ───────────────────────────────────────────────

const EventSearchSchema = z.object({
  q: z.string().optional(),
  eventType: z.string().optional(),
  contract: z.string().optional(),
  topicSymbol: z.string().optional(),
  paramValue: z.string().optional(),
  timestampFrom: z.string().optional(),
  timestampTo: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

searchRouter.get(
  '/events',
  asyncHandler(async (req: Request, res: Response) => {
    const params = EventSearchSchema.parse(req.query);

    const where: Record<string, unknown> = {};

    if (params.eventType) where.eventType = params.eventType;
    if (params.contract) where.contractAddress = params.contract;
    if (params.topicSymbol) where.topicSymbol = params.topicSymbol;
    if (params.paramValue) {
      where.decoded = { contains: params.paramValue };
    }
    if (params.timestampFrom || params.timestampTo) {
      const dateFilter: Record<string, Date> = {};
      if (params.timestampFrom) dateFilter.gte = new Date(params.timestampFrom);
      if (params.timestampTo) dateFilter.lte = new Date(params.timestampTo);
      where.ledgerCloseTime = dateFilter;
    }

    if (params.q) {
      const searchResults = await fullTextSearch(params.q, 'event', params.limit, params.offset);
      const eventIds = searchResults.results.map((r) => r.docId);

      const events = await prismaRead.event.findMany({
        where: { id: { in: eventIds } },
        orderBy: { ledgerCloseTime: 'desc' },
      });

      return res.json({
        query: params.q,
        total: searchResults.total,
        results: events,
      });
    }

    const [events, total] = await Promise.all([
      prismaRead.event.findMany({
        where,
        take: params.limit,
        skip: params.offset,
        orderBy: { ledgerCloseTime: 'desc' },
      }),
      prismaRead.event.count({ where }),
    ]);

    return res.json({ total, results: events });
  }),
);

// ── GET /api/v1/search/fuzzy ────────────────────────────────────────────────

searchRouter.get(
  '/fuzzy',
  asyncHandler(async (req: Request, res: Response) => {
    const q = String(req.query.q ?? '');
    const docType = req.query.docType ? String(req.query.docType) : undefined;
    const limit = Math.min(parseInt(String(req.query.limit ?? '10'), 10), 50);

    if (!q || q.length < 2) {
      return res.status(400).json({ error: 'Query string q required (min 2 chars)' });
    }

    const results = await fuzzySearch(q, docType, limit);

    const grouped: Record<
      string,
      Array<{ docId: string; similarity: number; content: string }>
    > = {};
    for (const r of results) {
      if (!grouped[r.docType]) grouped[r.docType] = [];
      grouped[r.docType].push({ docId: r.docId, similarity: r.similarity, content: r.content });
    }

    return res.json({
      query: q,
      total: results.length,
      results: grouped,
    });
  }),
);

// ── GET /api/v1/search/semantic ─────────────────────────────────────────────

searchRouter.get(
  '/semantic',
  asyncHandler(async (req: Request, res: Response) => {
    const q = String(req.query.q ?? '');
    const type = String(req.query.type ?? 'contract');
    const limit = Math.min(parseInt(String(req.query.limit ?? '10'), 10), 50);
    const threshold = parseFloat(String(req.query.threshold ?? '0.5'));

    if (!q) {
      return res.status(400).json({ error: 'Query string q required' });
    }

    const mockEmbedding = generateMockEmbedding(q, type === 'contract' ? 768 : 384);
    let results;

    if (type === 'contract') {
      results = await searchSimilarContracts(mockEmbedding, 'codebert', limit, threshold);
    } else if (type === 'transaction') {
      results = await searchSimilarTransactions(mockEmbedding, limit, threshold);
    } else if (type === 'event') {
      results = await searchSimilarEvents(mockEmbedding, limit, threshold);
    } else {
      return res.status(400).json({ error: 'Invalid type. Use: contract, transaction, event' });
    }

    return res.json({
      query: q,
      type,
      results,
    });
  }),
);

// ── GET /api/v1/search/semantic/contracts/:address ──────────────────────────

searchRouter.get(
  '/semantic/contracts/:address',
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    const limit = Math.min(parseInt(String(req.query.limit ?? '10'), 10), 50);

    const contract = await prismaRead.contract.findUnique({ where: { address } });
    if (!contract) {
      return res.status(404).json({ error: 'Contract not found' });
    }

    const content = [contract.name, contract.description, contract.address]
      .filter(Boolean)
      .join(' ');
    const mockEmbedding = generateMockEmbedding(content, 768);

    const results = await searchSimilarContracts(mockEmbedding, 'codebert', limit, 0.5);

    return res.json({
      contract: address,
      results: results.filter((r) => r.contractAddress !== address),
    });
  }),
);

// ── GET /api/v1/suggest ─────────────────────────────────────────────────────

searchRouter.get(
  '/suggest',
  asyncHandler(async (req: Request, res: Response) => {
    const q = String(req.query.q ?? '').toLowerCase();
    const docType = req.query.docType ? String(req.query.docType) : undefined;
    const mode = String(req.query.mode ?? 'prefix') as 'prefix' | 'suffix';
    const limit = Math.min(parseInt(String(req.query.limit ?? '10'), 10), 50);

    if (!q || q.length < 1) {
      return res.status(400).json({ error: 'Query string q required' });
    }

    const suggestions =
      mode === 'suffix'
        ? await querySuffixAutocomplete(q, docType, limit)
        : await queryAutocomplete(q, docType, limit);

    return res.json({
      query: q,
      mode,
      suggestions,
    });
  }),
);

// ── GET /api/v1/search/index/status ─────────────────────────────────────────

searchRouter.get(
  '/index/status',
  asyncHandler(async (_req: Request, res: Response) => {
    const status = await getIndexStatus();
    return res.json(status);
  }),
);

// ── POST /api/v1/search/index/rebuild ───────────────────────────────────────

searchRouter.post(
  '/index/rebuild',
  asyncHandler(async (_req: Request, res: Response) => {
    rebuildAllIndexes().catch(() => {});
    return res.json({ message: 'Index rebuild started', status: 'rebuilding' });
  }),
);

function generateMockEmbedding(text: string, dimensions: number): number[] {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const chr = text.charCodeAt(i);
    hash = (hash << 5) - hash + chr;
    hash |= 0;
  }

  const embedding: number[] = [];
  for (let i = 0; i < dimensions; i++) {
    const val = Math.sin(hash * (i + 1)) * 10000;
    embedding.push(val - Math.floor(val / 1) * 1);
  }

  const magnitude = Math.sqrt(embedding.reduce((s, v) => s + v * v, 0));
  return magnitude > 0 ? embedding.map((v) => v / magnitude) : embedding;
}
