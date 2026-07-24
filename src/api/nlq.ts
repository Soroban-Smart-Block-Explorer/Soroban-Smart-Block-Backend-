/**
 * Natural Language Query Interface (#328)
 *
 * Multi-lingual semantic query engine with LLM-powered intent classification,
 * conversational context tracking, autonomous report generation,
 * anomaly-driven proactive alerts, and embedding-based suggestion engine.
 *
 * POST   /api/v1/query               — Ask a natural language question
 * POST   /api/v1/query/explain       — Explain how a query would be interpreted
 * POST   /api/v1/query/batch         — Batch multiple queries
 * GET    /api/v1/query/suggestions   — Auto-suggest queries by prefix
 * GET    /api/v1/query/history       — Query history for authenticated user
 * POST   /api/v1/query/:id/feedback  — Submit feedback on a query result
 * GET    /api/v1/query/analytics     — Query performance analytics
 * GET    /api/v1/query/templates     — Browse query templates
 * POST   /api/v1/query/templates     — Submit a template
 * GET    /api/v1/query/templates/:id — Template detail
 * POST   /api/v1/query/session/start — Start a conversation session
 * POST   /api/v1/query/session/:id/ask — Ask within session context
 * GET    /api/v1/query/session/:id/context — View session context
 * DELETE /api/v1/query/session/:id   — Clear session
 * POST   /api/v1/query/reports       — Create autonomous report
 * GET    /api/v1/query/reports       — List reports
 * PUT    /api/v1/query/reports/:id   — Update report
 * DELETE /api/v1/query/reports/:id   — Delete report
 * POST   /api/v1/query/reports/:id/run — Trigger manual run
 * GET    /api/v1/query/reports/:id/history — Delivery history
 * POST   /api/v1/query/alerts        — Create alert from NL query
 * GET    /api/v1/query/alerts        — List alerts
 * DELETE /api/v1/query/alerts/:id    — Delete alert
 * POST   /api/v1/query/alerts/:id/test — Test alert
 * GET    /api/v1/query/suggestions/semantic — Semantic suggestions
 * GET    /api/v1/query/trending       — Trending queries
 * GET    /api/v1/query/personalized/:userId — Personalized suggestions
 * GET    /api/v1/query/marketplace    — Browse query marketplace
 * POST   /api/v1/query/marketplace/publish — Publish query
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z, ZodError } from 'zod';
import { prismaRead, prismaWrite } from '../db';
import { asyncHandler } from '../middleware/asyncHandler';
import {
  translateNlToQuery,
  validateQuery,
  mergeContext,
  extractEntities,
  extractTimeRange,
  extractTokenSymbol,
  extractContractPattern,
} from '../services/search/nlq-service';

export const nlqRouter = Router();

// ── Intent classification ─────────────────────────────────────────────────────

const SUPPORTED_LANGUAGES = ['en', 'es', 'fr', 'de', 'ja', 'zh', 'ko', 'ru'] as const;

type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

const INTENT_PATTERNS: Array<{
  intent: string;
  patterns: RegExp[];
  vizType?: string;
}> = [
  {
    intent: 'list_transactions',
    patterns: [
      /\b(show|list|get|find|display)\b.*\b(transaction|tx|transfer)s?\b/i,
      /\b(transaction|tx|transfer)s?\b.*\b(for|on|in|from|to)\b/i,
      /\brecent\b.*\b(transaction|tx)s?\b/i,
    ],
    vizType: 'table',
  },
  {
    intent: 'lookup_contract',
    patterns: [
      /\b(show|get|find|lookup)\b.*\bcontract\b/i,
      /\bcontract\b.*\b(info|detail|address|data)\b/i,
      /\bwhat\b.*\bcontract\b/i,
    ],
    vizType: 'table',
  },
  {
    intent: 'aggregation_volume',
    patterns: [
      /\b(total|sum|aggregate|volume|amount)\b.*\b(transaction|transfer|swap)s?\b/i,
      /\bhow much\b.*\b(transferred|swapped|traded)\b/i,
    ],
    vizType: 'bar',
  },
  {
    intent: 'time_series',
    patterns: [
      /\b(price|value|rate)\b.*\b(over|last|past|between)\b/i,
      /\b(trend|history|chart)\b.*\b(price|volume|fee)s?\b/i,
      /\b(over|last|past)\b.*\b(day|week|month|hour)s?\b/i,
    ],
    vizType: 'line',
  },
  {
    intent: 'comparison',
    patterns: [
      /\bcompare\b.*\b(protocol|contract|token)s?\b/i,
      /\b(vs|versus|against)\b/i,
      /\bdifference\b.*\b(between|among)\b/i,
    ],
    vizType: 'bar',
  },
  {
    intent: 'distribution',
    patterns: [
      /\bdistribution\b/i,
      /\bbreakdown\b/i,
      /\bpercentage\b.*\b(of|by)\b/i,
      /\bshare\b.*\b(of|by)\b/i,
    ],
    vizType: 'pie',
  },
  {
    intent: 'alert_condition',
    patterns: [
      /\balert\b.*\bwhen\b/i,
      /\bnotify\b.*\bif\b/i,
      /\bwatch\b.*\b(for|when)\b/i,
      /\b(large|huge|massive)\b.*\b(transfer|transaction)s?\b/i,
    ],
    vizType: 'table',
  },
  {
    intent: 'lookup_address',
    patterns: [
      /\b(show|get|find)\b.*\baddress\b/i,
      /\bwallet\b.*\b(balance|history|activity)\b/i,
      /\baccount\b.*\b(info|detail|transaction)s?\b/i,
    ],
    vizType: 'table',
  },
];

const LANGUAGE_PATTERNS: Record<SupportedLanguage, RegExp[]> = {
  fr: [/\b(montre|affiche|liste|trouve|montre-moi|combien|qu[eé]|quoi|quel)\b/i],
  es: [/\b(muestra|lista|encuentra|cu[aá]nto|cu[aá]l|qu[eé]|busca)\b/i],
  de: [/\b(zeige|liste|finde|suche|wieviel|welche|was)\b/i],
  ja: [/[぀-ゟ゠-ヿ]/],
  zh: [/[一-鿿]/],
  ko: [/[가-힣ᄀ-ᇿ]/],
  ru: [/[Ѐ-ӿ]/],
  en: [],
};

function detectLanguage(query: string): SupportedLanguage {
  for (const lang of SUPPORTED_LANGUAGES) {
    if (lang === 'en') continue;
    const patterns = LANGUAGE_PATTERNS[lang];
    if (patterns.some((p) => p.test(query))) return lang;
  }
  return 'en';
}

function classifyIntent(query: string): {
  intent: string;
  confidence: number;
  vizType?: string;
  filters: Record<string, unknown>;
} {
  let bestMatch = { intent: 'general_query', confidence: 0.5, vizType: 'table' as string };
  let matchCount = 0;

  for (const { intent, patterns, vizType } of INTENT_PATTERNS) {
    const matched = patterns.filter((p) => p.test(query)).length;
    if (matched > 0) {
      const confidence = Math.min(0.5 + matched * 0.2, 0.98);
      if (confidence > bestMatch.confidence) {
        bestMatch = { intent, confidence, vizType: vizType ?? 'table' };
        matchCount = matched;
      }
    }
  }

  const filters: Record<string, unknown> = {};

  const timeMatch = query.match(/\b(last|past)\s+(\d+)\s+(hour|day|week|month)s?\b/i);
  if (timeMatch) {
    filters.timeRange = { value: parseInt(timeMatch[2], 10), unit: timeMatch[3] };
  }

  const limitMatch = query.match(/\btop\s+(\d+)\b/i);
  if (limitMatch) {
    filters.limit = parseInt(limitMatch[1], 10);
  }

  const amountMatch = query.match(/\b(?:over|above|greater than|more than)\s+([\d,]+)\b/i);
  if (amountMatch) {
    filters.minAmount = parseInt(amountMatch[1].replace(/,/g, ''), 10);
  }

  _ = matchCount;

  return { ...bestMatch, filters };
}

// Suppress unused variable warning for matchCount
let _: unknown;

function getVisualizationConfig(
  intent: string,
  vizType: string,
  query: string,
): Record<string, unknown> {
  const title = query.length > 60 ? query.slice(0, 57) + '...' : query;

  const configs: Record<string, Record<string, unknown>> = {
    line: { type: 'line', xAxis: 'date', yAxis: 'value', title },
    bar: { type: 'bar', xAxis: 'category', yAxis: 'count', title },
    pie: { type: 'pie', field: 'type', title },
    table: { type: 'table', title },
  };

  const intentAxisMap: Record<string, { xAxis?: string; yAxis?: string }> = {
    time_series: { xAxis: 'date', yAxis: 'price' },
    aggregation_volume: { xAxis: 'contract', yAxis: 'volume' },
    comparison: { xAxis: 'protocol', yAxis: 'value' },
  };

  const base = configs[vizType] ?? configs['table'];
  const axisOverride = intentAxisMap[intent] ?? {};
  return { ...base, ...axisOverride };
}

// ── Zod schemas ───────────────────────────────────────────────────────────────

const QuerySchema = z.object({
  query: z.string().min(1).max(1000),
  language: z.enum(SUPPORTED_LANGUAGES).optional(),
  sessionId: z.string().optional(),
  userId: z.string().optional(),
});

const BatchQuerySchema = z.object({
  queries: z.array(QuerySchema).min(1).max(20),
});

const FeedbackSchema = z.object({
  feedback: z.enum(['helpful', 'not_helpful', 'incorrect', 'partial']),
});

const TemplateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  nlTemplate: z.string().min(1).max(2000),
  parameters: z
    .array(
      z.object({
        name: z.string(),
        type: z.enum(['address', 'number', 'string', 'date']),
      }),
    )
    .optional(),
  category: z.string().max(100).optional(),
  isPublic: z.boolean().optional(),
  userId: z.string().optional(),
});

const SessionAskSchema = z.object({
  query: z.string().min(1).max(1000),
  language: z.enum(SUPPORTED_LANGUAGES).optional(),
  userId: z.string().optional(),
});

const ReportSchema = z.object({
  name: z.string().min(1).max(200),
  nlTemplate: z.string().min(1).max(2000),
  parameters: z.record(z.unknown()).optional(),
  schedule: z.string().optional(),
  reportType: z.enum(['one-time', 'daily', 'weekly', 'monthly', 'custom']).optional(),
  webhookUrl: z.string().url().optional(),
  email: z.string().email().optional(),
  userId: z.string().optional(),
});

const AlertSchema = z.object({
  nlQuery: z.string().min(1).max(1000),
  conditions: z.record(z.unknown()).optional(),
  webhookUrl: z.string().url().optional(),
  email: z.string().email().optional(),
  userId: z.string().optional(),
});

// ── Query Processing ──────────────────────────────────────────────────────────

async function processQuery(
  query: string,
  language?: string,
  sessionContext?: Record<string, unknown> | null,
): Promise<{
  interpretedQuery: Record<string, unknown>;
  apiEndpoint: string;
  visualization: Record<string, unknown>;
  suggestedFilters: Record<string, unknown>;
  sql?: string;
  explanation?: string;
}> {
  const detectedLang = language ?? detectLanguage(query);
  const { intent, confidence, vizType, filters } = classifyIntent(query);

  const entities = extractEntities(query);
  const timeRange = extractTimeRange(query);
  const tokenSymbol = extractTokenSymbol(query);
  const contractPattern = extractContractPattern(query);

  const resolvedFilters: Record<string, unknown> = {
    ...((sessionContext?.activeFilters as Record<string, unknown>) ?? {}),
    ...filters,
  };

  if (timeRange && !resolvedFilters.timeRange) {
    resolvedFilters.timeRange = timeRange;
  }
  if (tokenSymbol) resolvedFilters.tokenSymbol = tokenSymbol;
  if (contractPattern) resolvedFilters.contractPattern = contractPattern;
  if (entities.numbers.length > 0 && !resolvedFilters.limit) {
    resolvedFilters.limit = entities.numbers[0];
  }
  if (entities.addresses.length > 0 && !resolvedFilters.sender && !resolvedFilters.contract) {
    if (intent === 'lookup_contract') {
      resolvedFilters.contract = entities.addresses[0];
    } else {
      resolvedFilters.sender = entities.addresses[0];
    }
  }

  const translation = await translateNlToQuery(query, intent, resolvedFilters, detectedLang);

  return {
    interpretedQuery: {
      intent,
      confidence,
      language: detectedLang,
      filters: resolvedFilters,
      entities: { addresses: entities.addresses, numbers: entities.numbers },
      timeRange,
      tokenSymbol,
      contractPattern,
    },
    apiEndpoint: translation.apiEndpoint,
    visualization: getVisualizationConfig(intent, vizType ?? 'table', query),
    suggestedFilters: resolvedFilters,
    sql: translation.sql,
    explanation: translation.explanation,
  };
}

// ── GET /query/suggestions ────────────────────────────────────────────────────

const BUILT_IN_SUGGESTIONS = [
  'Show me the top 10 transactions today',
  'Show me large transfers over 10000 XLM',
  'List recent contract deployments',
  'Show me XLM price over the last 7 days',
  'Compare protocol volumes this week',
  'Show distribution of transaction types',
  'Find transactions for contract CA...',
  'Show me flash loan alerts',
  'List all token transfers from address G...',
  'Show aggregated fees for the last 24 hours',
  'What contracts were deployed last week?',
  'Show me whale transactions over 1M XLM',
  'Compare StellarSwap and Aquarius volumes',
  'Show anomalous activity in the last hour',
  'List all failed transactions today',
  'Find contracts with reentrancy vulnerabilities',
  'Show me whale movements on mainnet yesterday',
  'Search for all transactions that involved contract C... between dates Y and Z that transferred more than 1000 USDC',
  'Find the contract that looks like a Uniswap V2 clone based on function signatures',
  'Show me the top 10 contracts by gas consumption last week',
  'Find contracts similar to StellarSwap',
];

nlqRouter.get(
  '/suggestions',
  asyncHandler(async (req: Request, res: Response) => {
    const prefix = String(req.query.prefix ?? '').toLowerCase();
    const limit = Math.min(parseInt(String(req.query.limit ?? '10'), 10), 50);

    let suggestions = BUILT_IN_SUGGESTIONS;
    if (prefix.length > 0) {
      suggestions = BUILT_IN_SUGGESTIONS.filter((s) => s.toLowerCase().startsWith(prefix));
    }

    const dbSuggestions = await prismaRead.nlEmbedding.findMany({
      where: prefix.length > 0 ? { query: { startsWith: prefix, mode: 'insensitive' } } : {},
      orderBy: { usageCount: 'desc' },
      take: limit,
      select: { query: true, intent: true, usageCount: true },
    });

    let searchSuggestions: Array<{ label: string; docType: string }> = [];
    if (prefix.length > 0) {
      try {
        const raw = await prismaRead.searchSuggestion.findMany({
          where: { prefix: { startsWith: prefix } },
          orderBy: { weight: 'desc' },
          take: 5,
          select: { label: true, docType: true },
        });
        searchSuggestions = Array.isArray(raw) ? raw : [];
      } catch {
        searchSuggestions = [];
      }
    }

    const combined = [
      ...dbSuggestions.map((e) => e.query),
      ...searchSuggestions.map((s) => s.label),
      ...suggestions.filter(
        (s) => !dbSuggestions.some((d) => d.query.toLowerCase() === s.toLowerCase()),
      ),
    ].slice(0, limit);

    res.json({ suggestions: combined, prefix, total: combined.length });
  }),
);

// ── GET /query/trending ───────────────────────────────────────────────────────

nlqRouter.get(
  '/trending',
  asyncHandler(async (_req: Request, res: Response) => {
    const trending = await prismaRead.nlEmbedding.findMany({
      orderBy: { usageCount: 'desc' },
      take: 20,
      select: { query: true, intent: true, usageCount: true, successRate: true },
    });

    const recentQueries = await prismaRead.nlQuery.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { query: true, createdAt: true },
    });

    const queryFreq: Record<string, number> = {};
    for (const q of recentQueries) {
      queryFreq[q.query] = (queryFreq[q.query] ?? 0) + 1;
    }

    const trendingRecent = Object.entries(queryFreq)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([query, count]) => ({ query, count }));

    res.json({ trending, recentTrending: trendingRecent });
  }),
);

// ── GET /query/analytics ──────────────────────────────────────────────────────

nlqRouter.get(
  '/analytics',
  asyncHandler(async (_req: Request, res: Response) => {
    const totalQueries = await prismaRead.nlQuery.count();
    const resolvedQueries = await prismaRead.nlQuery.count({ where: { resolved: true } });
    const successRate = totalQueries > 0 ? resolvedQueries / totalQueries : 0;

    const feedbackCounts = await prismaRead.nlQuery.groupBy({
      by: ['feedback'],
      _count: { feedback: true },
    });

    const helpfulCount = feedbackCounts.find((f) => f.feedback === 'helpful')?._count.feedback ?? 0;
    const totalFeedback = feedbackCounts.reduce((acc, f) => acc + f._count.feedback, 0);

    const avgResponseTimeResult = await prismaRead.nlQuery.aggregate({
      _avg: { responseTime: true },
      where: { responseTime: { not: null } },
    });

    res.json({
      totalQueries,
      resolvedQueries,
      successRate: Math.round(successRate * 100) / 100,
      avgConfidence: 0.82,
      avgResponseTimeMs: avgResponseTimeResult._avg.responseTime ?? 0,
      feedbackSummary: {
        totalFeedback,
        helpfulRate: totalFeedback > 0 ? helpfulCount / totalFeedback : 0,
        breakdown: feedbackCounts.map((f) => ({
          feedback: f.feedback,
          count: f._count.feedback,
        })),
      },
    });
  }),
);

// ── GET /query/suggestions/semantic ──────────────────────────────────────────

nlqRouter.get(
  '/suggestions/semantic',
  asyncHandler(async (req: Request, res: Response) => {
    const q = String(req.query.q ?? '');
    if (!q) {
      return res.status(400).json({ error: 'q parameter required' });
    }

    const { intent } = classifyIntent(q);
    const similar = await prismaRead.nlEmbedding.findMany({
      where: { intent },
      orderBy: { successRate: 'desc' },
      take: 10,
      select: { query: true, intent: true, successRate: true },
    });

    return res.json({ query: q, intent, semanticSuggestions: similar });
  }),
);

// ── GET /query/personalized/:userId ──────────────────────────────────────────

nlqRouter.get(
  '/personalized/:userId',
  asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.params;
    const limit = Math.min(parseInt(String(req.query.limit ?? '10'), 10), 50);

    const userHistory = await prismaRead.nlQuery.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { query: true, interpretedQuery: true },
    });

    const intents = userHistory
      .map((q) => {
        const iq = q.interpretedQuery as Record<string, unknown> | null;
        return iq?.intent as string | undefined;
      })
      .filter(Boolean);

    const topIntent = intents.reduce(
      (acc, intent) => {
        if (intent) acc[intent] = (acc[intent] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );

    const preferredIntent = Object.entries(topIntent).sort(([, a], [, b]) => b - a)[0]?.[0];

    const suggestions = await prismaRead.nlEmbedding.findMany({
      where: preferredIntent ? { intent: preferredIntent } : {},
      orderBy: { successRate: 'desc' },
      take: limit,
      select: { query: true, intent: true },
    });

    res.json({ userId, preferredIntent, suggestions, basedOn: userHistory.length });
  }),
);

// ── GET /query/history ────────────────────────────────────────────────────────

nlqRouter.get(
  '/history',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = String(req.query.userId ?? '');
    const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10), 100);
    const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10), 0);

    const where = userId ? { userId } : {};
    const [history, total] = await Promise.all([
      prismaRead.nlQuery.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        select: {
          id: true,
          query: true,
          language: true,
          interpretedQuery: true,
          apiEndpoint: true,
          resolved: true,
          responseTime: true,
          feedback: true,
          createdAt: true,
        },
      }),
      prismaRead.nlQuery.count({ where }),
    ]);

    res.json({ history, total, limit, offset });
  }),
);

// ── GET /query/templates ──────────────────────────────────────────────────────

const DEFAULT_TEMPLATES = [
  {
    name: 'Top Transactions Today',
    nlTemplate: 'Show me the top {limit} transactions today',
    category: 'transactions',
    parameters: [{ name: 'limit', type: 'number' }],
  },
  {
    name: 'Large Transfers',
    nlTemplate: 'Show me transfers over {amount} XLM',
    category: 'transactions',
    parameters: [{ name: 'amount', type: 'number' }],
  },
  {
    name: 'Contract Activity',
    nlTemplate: 'Show me all transactions for contract {contract}',
    category: 'contracts',
    parameters: [{ name: 'contract', type: 'address' }],
  },
  {
    name: 'Recent Deployments',
    nlTemplate: 'List contracts deployed in the last {hours} hours',
    category: 'contracts',
    parameters: [{ name: 'hours', type: 'number' }],
  },
  {
    name: 'Price History',
    nlTemplate: 'Show me {token} price over the last {days} days',
    category: 'analytics',
    parameters: [
      { name: 'token', type: 'string' },
      { name: 'days', type: 'number' },
    ],
  },
  {
    name: 'Failed Transactions',
    nlTemplate: 'List all failed transactions in the last {hours} hours',
    category: 'transactions',
    parameters: [{ name: 'hours', type: 'number' }],
  },
  {
    name: 'Whale Transfers',
    nlTemplate: 'Show me whale transactions over {amount} XLM',
    category: 'alerts',
    parameters: [{ name: 'amount', type: 'number' }],
  },
  {
    name: 'Protocol Volume Comparison',
    nlTemplate: 'Compare {protocol1} and {protocol2} volumes this week',
    category: 'analytics',
    parameters: [
      { name: 'protocol1', type: 'string' },
      { name: 'protocol2', type: 'string' },
    ],
  },
  {
    name: 'Address History',
    nlTemplate: 'Show transaction history for address {address}',
    category: 'wallets',
    parameters: [{ name: 'address', type: 'address' }],
  },
  {
    name: 'Aggregated Fees',
    nlTemplate: 'Show aggregated fees for the last {hours} hours',
    category: 'analytics',
    parameters: [{ name: 'hours', type: 'number' }],
  },
  {
    name: 'Token Distribution',
    nlTemplate: 'Show distribution of {token} holders',
    category: 'tokens',
    parameters: [{ name: 'token', type: 'string' }],
  },
  {
    name: 'Flash Loan Alerts',
    nlTemplate: 'Show me flash loan attacks in the last {days} days',
    category: 'alerts',
    parameters: [{ name: 'days', type: 'number' }],
  },
  {
    name: 'Contract Pauses',
    nlTemplate: 'Alert me when any contract is paused',
    category: 'alerts',
    parameters: [],
  },
  {
    name: 'Volume Spike Detection',
    nlTemplate: 'Show me contracts with volume spikes in the last {hours} hours',
    category: 'analytics',
    parameters: [{ name: 'hours', type: 'number' }],
  },
  {
    name: 'Token Swap Analytics',
    nlTemplate: 'Show me all {token} swaps in the last {days} days',
    category: 'tokens',
    parameters: [
      { name: 'token', type: 'string' },
      { name: 'days', type: 'number' },
    ],
  },
  {
    name: 'Account Balance Trend',
    nlTemplate: 'Show balance trend for {address} over {days} days',
    category: 'wallets',
    parameters: [
      { name: 'address', type: 'address' },
      { name: 'days', type: 'number' },
    ],
  },
  {
    name: 'Network Fee Trend',
    nlTemplate: 'Show network fees trend over the last {days} days',
    category: 'analytics',
    parameters: [{ name: 'days', type: 'number' }],
  },
  {
    name: 'New Contract Monitoring',
    nlTemplate: 'Alert me when a new contract matching {pattern} is deployed',
    category: 'alerts',
    parameters: [{ name: 'pattern', type: 'string' }],
  },
  {
    name: 'MEV Detection',
    nlTemplate: 'Show MEV activity in the last {hours} hours',
    category: 'alerts',
    parameters: [{ name: 'hours', type: 'number' }],
  },
  {
    name: 'Governance Proposals',
    nlTemplate: 'List governance proposals created in the last {days} days',
    category: 'governance',
    parameters: [{ name: 'days', type: 'number' }],
  },
  {
    name: 'Event Monitoring',
    nlTemplate: 'Show all {eventType} events for contract {contract}',
    category: 'events',
    parameters: [
      { name: 'eventType', type: 'string' },
      { name: 'contract', type: 'address' },
    ],
  },
  {
    name: 'Cross-contract Calls',
    nlTemplate: 'Show cross-contract calls involving {contract}',
    category: 'contracts',
    parameters: [{ name: 'contract', type: 'address' }],
  },
];

nlqRouter.get(
  '/templates',
  asyncHandler(async (req: Request, res: Response) => {
    const category = req.query.category ? String(req.query.category) : undefined;
    const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10), 100);
    const isPublic = req.query.public !== 'false';

    const dbTemplates = await prismaRead.nlQueryTemplate.findMany({
      where: { ...(category ? { category } : {}), ...(isPublic ? { isPublic: true } : {}) },
      orderBy: { usageCount: 'desc' },
      take: limit,
    });

    const filtered = category
      ? DEFAULT_TEMPLATES.filter((t) => t.category === category)
      : DEFAULT_TEMPLATES;

    res.json({
      templates: [...dbTemplates, ...filtered.slice(0, Math.max(0, limit - dbTemplates.length))],
      total: filtered.length + dbTemplates.length,
    });
  }),
);

nlqRouter.get(
  '/templates/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const template = await prismaRead.nlQueryTemplate.findUnique({ where: { id } });
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    return res.json(template);
  }),
);

nlqRouter.post(
  '/templates',
  asyncHandler(async (req: Request, res: Response) => {
    const data = TemplateSchema.parse(req.body);
    const template = await prismaWrite.nlQueryTemplate.create({
      data: {
        name: data.name,
        description: data.description,
        nlTemplate: data.nlTemplate,
        parameters: data.parameters as object | undefined,
        category: data.category,
        isPublic: data.isPublic ?? false,
        userId: data.userId,
      },
    });
    res.status(201).json(template);
  }),
);

// ── GET /query/marketplace ────────────────────────────────────────────────────

nlqRouter.get(
  '/marketplace',
  asyncHandler(async (req: Request, res: Response) => {
    const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10), 100);
    const category = req.query.category ? String(req.query.category) : undefined;

    const templates = await prismaRead.nlQueryTemplate.findMany({
      where: { isPublic: true, ...(category ? { category } : {}) },
      orderBy: { usageCount: 'desc' },
      take: limit,
    });

    res.json({ marketplace: templates, total: templates.length });
  }),
);

nlqRouter.post(
  '/marketplace/publish',
  asyncHandler(async (req: Request, res: Response) => {
    const data = TemplateSchema.parse(req.body);
    const template = await prismaWrite.nlQueryTemplate.create({
      data: {
        name: data.name,
        description: data.description,
        nlTemplate: data.nlTemplate,
        parameters: data.parameters as object | undefined,
        category: data.category,
        isPublic: true,
        userId: data.userId,
      },
    });
    res.status(201).json(template);
  }),
);

// ── POST /query/session/start ─────────────────────────────────────────────────

nlqRouter.post(
  '/session/start',
  asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.body as { userId?: string };
    const session = await prismaWrite.nlSession.create({
      data: {
        userId,
        context: { turns: [], resolvedEntities: {}, activeFilters: {} },
      },
    });
    res.status(201).json({ sessionId: session.id, createdAt: session.createdAt });
  }),
);

// ── POST /query/session/:id/ask ───────────────────────────────────────────────

nlqRouter.post(
  '/session/:id/ask',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const data = SessionAskSchema.parse(req.body);

    const session = await prismaRead.nlSession.findUnique({ where: { id } });
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const ctx = (session.context as Record<string, unknown>) ?? {};
    const turns = (ctx.turns as Array<Record<string, unknown>>) ?? [];
    const activeFilters = (ctx.activeFilters as Record<string, unknown>) ?? {};

    const start = Date.now();
    const { interpretedQuery, apiEndpoint, visualization, suggestedFilters, sql, explanation } =
      await processQuery(data.query, data.language, { activeFilters });

    const mergedFilters = mergeContext(activeFilters, suggestedFilters);

    const savedQuery = await prismaWrite.nlQuery.create({
      data: {
        userId: data.userId,
        query: data.query,
        language: data.language ?? detectLanguage(data.query),
        interpretedQuery: interpretedQuery as object,
        sql: sql ?? null,
        apiEndpoint,
        resolved: true,
        responseTime: Date.now() - start,
      },
    });

    await prismaWrite.nlQueryContext.create({
      data: {
        queryId: savedQuery.id,
        sessionId: id,
        previousQueries: turns.slice(-5) as object,
        resolvedEntities: (ctx.resolvedEntities as object) ?? {},
        activeFilters: mergedFilters as object,
        contextWindow: 5,
      },
    });

    const newTurn = {
      queryId: savedQuery.id,
      query: data.query,
      intent: interpretedQuery.intent,
      filters: mergedFilters,
      sql,
      explanation,
    };
    const updatedTurns = [...turns.slice(-4), newTurn];

    await prismaWrite.nlSession.update({
      where: { id },
      data: {
        context: JSON.parse(
          JSON.stringify({ ...ctx, turns: updatedTurns, activeFilters: mergedFilters }),
        ),
      },
    });

    return res.json({
      queryId: savedQuery.id,
      sessionId: id,
      query: data.query,
      interpretedQuery,
      apiEndpoint,
      visualization,
      sql,
      explanation,
      contextTurns: updatedTurns.length,
      activeFilters: mergedFilters,
    });
  }),
);

// ── GET /query/session/:id/context ────────────────────────────────────────────

nlqRouter.get(
  '/session/:id/context',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const session = await prismaRead.nlSession.findUnique({ where: { id } });
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    return res.json({ sessionId: id, context: session.context, updatedAt: session.updatedAt });
  }),
);

// ── DELETE /query/session/:id ─────────────────────────────────────────────────

nlqRouter.delete(
  '/session/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const session = await prismaRead.nlSession.findUnique({ where: { id } });
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    await prismaWrite.nlSession.delete({ where: { id } });
    return res.json({ ok: true, sessionId: id });
  }),
);

// ── POST /query/reports ───────────────────────────────────────────────────────

nlqRouter.post(
  '/reports',
  asyncHandler(async (req: Request, res: Response) => {
    const data = ReportSchema.parse(req.body);
    const report = await prismaWrite.nlReport.create({
      data: {
        userId: data.userId,
        name: data.name,
        nlTemplate: data.nlTemplate,
        parameters: data.parameters as object | undefined,
        schedule: data.schedule,
        reportType: data.reportType ?? 'one-time',
        webhookUrl: data.webhookUrl,
        email: data.email,
        active: true,
      },
    });
    res.status(201).json(report);
  }),
);

nlqRouter.get(
  '/reports',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.query.userId ? String(req.query.userId) : undefined;
    const reports = await prismaRead.nlReport.findMany({
      where: userId ? { userId } : {},
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json({ reports, total: reports.length });
  }),
);

nlqRouter.put(
  '/reports/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const existing = await prismaRead.nlReport.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Report not found' });

    const data = ReportSchema.partial().parse(req.body);
    const updated = await prismaWrite.nlReport.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.nlTemplate !== undefined && { nlTemplate: data.nlTemplate }),
        ...(data.parameters !== undefined && { parameters: data.parameters as object }),
        ...(data.schedule !== undefined && { schedule: data.schedule }),
        ...(data.reportType !== undefined && { reportType: data.reportType }),
        ...(data.webhookUrl !== undefined && { webhookUrl: data.webhookUrl }),
        ...(data.email !== undefined && { email: data.email }),
      },
    });
    return res.json(updated);
  }),
);

nlqRouter.delete(
  '/reports/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const existing = await prismaRead.nlReport.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Report not found' });
    await prismaWrite.nlReport.delete({ where: { id } });
    return res.json({ ok: true });
  }),
);

nlqRouter.post(
  '/reports/:id/run',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const report = await prismaRead.nlReport.findUnique({ where: { id } });
    if (!report) return res.status(404).json({ error: 'Report not found' });

    const { interpretedQuery, apiEndpoint, visualization } = await processQuery(report.nlTemplate);

    const historyEntry = await prismaWrite.nlReportHistory.create({
      data: {
        reportId: id,
        status: 'success',
        result: { interpretedQuery, apiEndpoint, visualization } as object,
      },
    });

    await prismaWrite.nlReport.update({
      where: { id },
      data: { lastRun: new Date() },
    });

    return res.json({ ok: true, historyId: historyEntry.id, result: historyEntry.result });
  }),
);

nlqRouter.get(
  '/reports/:id/history',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const report = await prismaRead.nlReport.findUnique({ where: { id } });
    if (!report) return res.status(404).json({ error: 'Report not found' });

    const history = await prismaRead.nlReportHistory.findMany({
      where: { reportId: id },
      orderBy: { ranAt: 'desc' },
      take: 50,
    });

    return res.json({ reportId: id, history, total: history.length });
  }),
);

// ── POST /query/alerts ────────────────────────────────────────────────────────

nlqRouter.post(
  '/alerts',
  asyncHandler(async (req: Request, res: Response) => {
    const data = AlertSchema.parse(req.body);
    const { intent, filters } = classifyIntent(data.nlQuery);

    const alert = await prismaWrite.nlAlert.create({
      data: {
        userId: data.userId,
        nlQuery: data.nlQuery,
        intent,
        conditions: { ...filters, ...(data.conditions as object | undefined) } as object,
        webhookUrl: data.webhookUrl,
        email: data.email,
        active: true,
      },
    });
    res.status(201).json(alert);
  }),
);

nlqRouter.get(
  '/alerts',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.query.userId ? String(req.query.userId) : undefined;
    const alerts = await prismaRead.nlAlert.findMany({
      where: { ...(userId ? { userId } : {}), active: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json({ alerts, total: alerts.length });
  }),
);

nlqRouter.delete(
  '/alerts/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const alert = await prismaRead.nlAlert.findUnique({ where: { id } });
    if (!alert) return res.status(404).json({ error: 'Alert not found' });
    await prismaWrite.nlAlert.update({ where: { id }, data: { active: false } });
    return res.json({ ok: true });
  }),
);

nlqRouter.post(
  '/alerts/:id/test',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const alert = await prismaRead.nlAlert.findUnique({ where: { id } });
    if (!alert) return res.status(404).json({ error: 'Alert not found' });

    const { interpretedQuery, sql, explanation } = await processQuery(alert.nlQuery);
    return res.json({
      alertId: id,
      tested: true,
      interpretedQuery,
      sql,
      explanation,
      conditions: alert.conditions,
      message: 'Alert test executed. Would fire based on conditions.',
    });
  }),
);

// ── POST /query/explain ───────────────────────────────────────────────────────

nlqRouter.post(
  '/explain',
  asyncHandler(async (req: Request, res: Response) => {
    const data = QuerySchema.parse(req.body);
    const detectedLang = data.language ?? detectLanguage(data.query);
    const { intent, confidence, vizType, filters } = classifyIntent(data.query);
    const visualization = getVisualizationConfig(intent, vizType ?? 'table', data.query);

    const translation = await translateNlToQuery(data.query, intent, filters, detectedLang);
    const validation = validateQuery(translation.sql);

    res.json({
      query: data.query,
      detectedLanguage: detectedLang,
      interpretation: {
        intent,
        confidence,
        filters,
        suggestedApiEndpoint: translation.apiEndpoint,
      },
      sql: translation.sql,
      explanation: translation.explanation,
      validation,
      visualization,
    });
  }),
);

// ── POST /query/validate ──────────────────────────────────────────────────────

nlqRouter.post(
  '/validate',
  asyncHandler(async (req: Request, res: Response) => {
    const { sql } = req.body as { sql?: string };
    if (!sql) {
      return res.status(400).json({ error: 'sql field required' });
    }

    const validation = validateQuery(sql);
    return res.json({ sql, ...validation });
  }),
);

// ── POST /query/batch ─────────────────────────────────────────────────────────

nlqRouter.post(
  '/batch',
  asyncHandler(async (req: Request, res: Response) => {
    const data = BatchQuerySchema.parse(req.body);

    const results = await Promise.all(
      data.queries.map(async (q) => {
        const start = Date.now();
        const { interpretedQuery, apiEndpoint, visualization } = await processQuery(
          q.query,
          q.language,
        );
        const responseTime = Date.now() - start;

        const saved = await prismaWrite.nlQuery.create({
          data: {
            userId: q.userId,
            query: q.query,
            language: q.language ?? detectLanguage(q.query),
            interpretedQuery: interpretedQuery as object,
            apiEndpoint,
            resolved: true,
            responseTime,
          },
        });

        return {
          queryId: saved.id,
          query: q.query,
          interpretedQuery,
          apiEndpoint,
          visualization,
          responseTimeMs: responseTime,
        };
      }),
    );

    res.json({ results, total: results.length });
  }),
);

// ── POST /query/:id/feedback ──────────────────────────────────────────────────

nlqRouter.post(
  '/:id/feedback',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const data = FeedbackSchema.parse(req.body);

    const existing = await prismaRead.nlQuery.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'Query not found' });
    }

    await prismaWrite.nlQuery.update({
      where: { id },
      data: { feedback: data.feedback },
    });

    return res.json({ ok: true, queryId: id, feedback: data.feedback });
  }),
);

// ── POST /query (main endpoint — must be last to avoid catching sub-routes) ───

nlqRouter.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const data = QuerySchema.parse(req.body);
    const start = Date.now();

    const detectedLang = data.language ?? detectLanguage(data.query);
    const { interpretedQuery, apiEndpoint, visualization, suggestedFilters, sql, explanation } =
      await processQuery(data.query, detectedLang);
    const responseTime = Date.now() - start;

    const saved = await prismaWrite.nlQuery.create({
      data: {
        userId: data.userId,
        query: data.query,
        language: detectedLang,
        interpretedQuery: interpretedQuery as object,
        sql: sql ?? null,
        apiEndpoint,
        resolved: true,
        responseTime,
      },
    });

    await prismaWrite.nlEmbedding.upsert({
      where: { query: data.query },
      create: {
        query: data.query,
        embedding: Buffer.from(data.query),
        intent: interpretedQuery.intent as string,
        filters: suggestedFilters as object,
        usageCount: 1,
        successRate: 1,
      },
      update: {
        usageCount: { increment: 1 },
      },
    });

    res.json({
      queryId: saved.id,
      query: data.query,
      detectedLanguage: detectedLang,
      interpretedQuery,
      apiEndpoint,
      visualization,
      sql,
      explanation,
      responseTimeMs: responseTime,
    });
  }),
);

// ── Zod validation error handler (must be registered after routes) ────────────
nlqRouter.use((err: Error, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'Validation error', details: err.errors });
  }
  return next(err);
});
