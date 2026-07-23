/**
 * NLQ (Natural Language Query Interface) API tests (#328)
 *
 * Covers:
 *  POST /api/v1/query              — intent classification, language detection, persistence
 *  POST /api/v1/query/explain      — dry-run intent explanation
 *  POST /api/v1/query/batch        — batch processing
 *  GET  /api/v1/query/suggestions  — prefix-based auto-suggest
 *  GET  /api/v1/query/history      — query history
 *  POST /api/v1/query/:id/feedback — feedback recording
 *  GET  /api/v1/query/analytics    — performance analytics
 *  GET  /api/v1/query/templates    — template library (20+ built-in)
 *  POST /api/v1/query/templates    — template creation
 *  POST /api/v1/query/session/start    — session management
 *  POST /api/v1/query/session/:id/ask  — session-aware querying
 *  GET  /api/v1/query/session/:id/context — view context
 *  DELETE /api/v1/query/session/:id    — clear session
 *  POST /api/v1/query/reports      — report creation
 *  GET  /api/v1/query/reports      — list reports
 *  POST /api/v1/query/reports/:id/run — manual run
 *  GET  /api/v1/query/reports/:id/history — delivery history
 *  POST /api/v1/query/alerts       — alert creation from NL
 *  GET  /api/v1/query/alerts       — list alerts
 *  DELETE /api/v1/query/alerts/:id — delete alert
 *  POST /api/v1/query/alerts/:id/test — test alert
 *  GET  /api/v1/query/suggestions/semantic — semantic suggestions
 *  GET  /api/v1/query/trending     — trending queries
 *  GET  /api/v1/query/personalized/:userId — personalized suggestions
 *  GET  /api/v1/query/marketplace  — marketplace
 *  POST /api/v1/query/marketplace/publish — publish to marketplace
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// ── Mock Prisma — vi.fn() must be inline in the factory (hoisting) ────────────

vi.mock('../../src/db', () => ({
  prismaRead: {
    nlQuery: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
      groupBy: vi.fn(),
      aggregate: vi.fn(),
    },
    nlEmbedding: {
      findMany: vi.fn(),
      upsert: vi.fn(),
    },
    nlSession: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    nlQueryContext: {
      create: vi.fn(),
    },
    nlQueryTemplate: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    nlReport: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    nlReportHistory: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
    nlAlert: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    searchSuggestion: {
      findMany: vi.fn(),
    },
  },
  prismaWrite: {
    nlQuery: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
      groupBy: vi.fn(),
      aggregate: vi.fn(),
    },
    nlEmbedding: {
      findMany: vi.fn(),
      upsert: vi.fn(),
    },
    nlSession: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    nlQueryContext: {
      create: vi.fn(),
    },
    nlQueryTemplate: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    nlReport: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    nlReportHistory: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
    nlAlert: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

import { prismaRead, prismaWrite } from '../../src/db';
import { nlqRouter } from '../../src/api/nlq';

// ── App setup ─────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use('/api/v1/query', nlqRouter);

// ── Helpers to access mocked fns ──────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const r = prismaRead as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const w = prismaWrite as any;

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

const QUERY_FIXTURE = {
  id: 'cuid-nlq-1',
  userId: 'user-1',
  query: 'Show me the top 10 transactions today',
  language: 'en',
  interpretedQuery: { intent: 'list_transactions', confidence: 0.9, filters: { limit: 10 } },
  apiEndpoint: '/api/v1/transactions',
  resolved: true,
  responseTime: 42,
  feedback: null,
  createdAt: new Date('2024-01-01T00:00:00Z'),
};

const SESSION_FIXTURE = {
  id: 'session-1',
  userId: 'user-1',
  context: { turns: [], resolvedEntities: {}, activeFilters: {} },
  createdAt: new Date('2024-01-01T00:00:00Z'),
  updatedAt: new Date('2024-01-01T00:00:00Z'),
};

const REPORT_FIXTURE = {
  id: 'report-1',
  userId: 'user-1',
  name: 'Daily Volume Report',
  nlTemplate: 'Show me total volume for the last 24 hours',
  reportType: 'daily',
  active: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const ALERT_FIXTURE = {
  id: 'alert-1',
  userId: 'user-1',
  nlQuery: 'Alert me when a transfer exceeds 10000 XLM',
  intent: 'alert_condition',
  conditions: { minAmount: 10000 },
  active: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

// ── POST /api/v1/query ────────────────────────────────────────────────────────

describe('POST /api/v1/query', () => {
  it('classifies intent and returns interpreted query', async () => {
    w.nlQuery.create.mockResolvedValue(QUERY_FIXTURE);
    w.nlEmbedding.upsert.mockResolvedValue({});

    const res = await request(app)
      .post('/api/v1/query')
      .send({ query: 'Show me the top 10 transactions today' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('queryId');
    expect(res.body).toHaveProperty('interpretedQuery');
    expect(res.body.interpretedQuery).toHaveProperty('intent');
    expect(res.body.interpretedQuery).toHaveProperty('confidence');
    expect(res.body).toHaveProperty('apiEndpoint');
    expect(res.body).toHaveProperty('visualization');
  });

  it('detects English by default', async () => {
    w.nlQuery.create.mockResolvedValue({ ...QUERY_FIXTURE, language: 'en' });
    w.nlEmbedding.upsert.mockResolvedValue({});

    const res = await request(app)
      .post('/api/v1/query')
      .send({ query: 'List recent contract deployments' });

    expect(res.status).toBe(200);
    expect(res.body.detectedLanguage).toBe('en');
  });

  it('detects French language', async () => {
    w.nlQuery.create.mockResolvedValue({ ...QUERY_FIXTURE, language: 'fr' });
    w.nlEmbedding.upsert.mockResolvedValue({});

    const res = await request(app)
      .post('/api/v1/query')
      .send({ query: "Montre-moi les 10 plus grandes transactions aujourd'hui" });

    expect(res.status).toBe(200);
    expect(res.body.detectedLanguage).toBe('fr');
  });

  it('detects Spanish language', async () => {
    w.nlQuery.create.mockResolvedValue({ ...QUERY_FIXTURE, language: 'es' });
    w.nlEmbedding.upsert.mockResolvedValue({});

    const res = await request(app)
      .post('/api/v1/query')
      .send({ query: 'Muestra las transacciones recientes' });

    expect(res.status).toBe(200);
    expect(res.body.detectedLanguage).toBe('es');
  });

  it('returns 400 for empty query', async () => {
    const res = await request(app).post('/api/v1/query').send({ query: '' });
    expect(res.status).toBe(400);
  });

  it('classifies time_series intent and returns line chart visualization', async () => {
    w.nlQuery.create.mockResolvedValue(QUERY_FIXTURE);
    w.nlEmbedding.upsert.mockResolvedValue({});

    const res = await request(app)
      .post('/api/v1/query')
      .send({ query: 'Show me XLM price over the last 7 days' });

    expect(res.status).toBe(200);
    expect(res.body.visualization.type).toBe('line');
  });

  it('classifies list_transactions intent', async () => {
    w.nlQuery.create.mockResolvedValue(QUERY_FIXTURE);
    w.nlEmbedding.upsert.mockResolvedValue({});

    const res = await request(app)
      .post('/api/v1/query')
      .send({ query: 'Show me the top 10 transactions today' });

    expect(res.status).toBe(200);
    expect(res.body.interpretedQuery.intent).toBe('list_transactions');
  });

  it('classifies comparison intent and returns bar chart', async () => {
    w.nlQuery.create.mockResolvedValue(QUERY_FIXTURE);
    w.nlEmbedding.upsert.mockResolvedValue({});

    const res = await request(app)
      .post('/api/v1/query')
      .send({ query: 'Compare protocol volumes this week' });

    expect(res.status).toBe(200);
    expect(res.body.visualization.type).toBe('bar');
  });

  it('extracts time range filter from query', async () => {
    w.nlQuery.create.mockResolvedValue(QUERY_FIXTURE);
    w.nlEmbedding.upsert.mockResolvedValue({});

    const res = await request(app)
      .post('/api/v1/query')
      .send({ query: 'Show transactions in the last 24 hours' });

    expect(res.status).toBe(200);
    expect(res.body.interpretedQuery.filters).toHaveProperty('timeRange');
  });

  it('respects explicit language parameter', async () => {
    w.nlQuery.create.mockResolvedValue({ ...QUERY_FIXTURE, language: 'de' });
    w.nlEmbedding.upsert.mockResolvedValue({});

    const res = await request(app)
      .post('/api/v1/query')
      .send({ query: 'Zeige mir Transaktionen', language: 'de' });

    expect(res.status).toBe(200);
    expect(res.body.detectedLanguage).toBe('de');
  });

  it('includes confidence score between 0 and 1', async () => {
    w.nlQuery.create.mockResolvedValue(QUERY_FIXTURE);
    w.nlEmbedding.upsert.mockResolvedValue({});

    const res = await request(app)
      .post('/api/v1/query')
      .send({ query: 'List all failed transactions today' });

    expect(res.status).toBe(200);
    const confidence = res.body.interpretedQuery.confidence as number;
    expect(confidence).toBeGreaterThan(0);
    expect(confidence).toBeLessThanOrEqual(1);
  });
});

// ── POST /api/v1/query/explain ────────────────────────────────────────────────

describe('POST /api/v1/query/explain', () => {
  it('returns explanation without persisting', async () => {
    const res = await request(app)
      .post('/api/v1/query/explain')
      .send({ query: 'Show me large transfers over 10000 XLM' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('interpretation');
    expect(res.body.interpretation).toHaveProperty('intent');
    expect(res.body.interpretation).toHaveProperty('confidence');
    expect(res.body).toHaveProperty('explanation');
    expect(w.nlQuery.create).not.toHaveBeenCalled();
  });

  it('includes language detection in explanation', async () => {
    const res = await request(app)
      .post('/api/v1/query/explain')
      .send({ query: 'Compare protocol volumes' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('detectedLanguage');
    expect(res.body).toHaveProperty('visualization');
  });

  it('returns 400 for empty query', async () => {
    const res = await request(app).post('/api/v1/query/explain').send({ query: '' });
    expect(res.status).toBe(400);
  });
});

// ── POST /api/v1/query/batch ──────────────────────────────────────────────────

describe('POST /api/v1/query/batch', () => {
  it('processes multiple queries and returns all results', async () => {
    w.nlQuery.create
      .mockResolvedValueOnce({ ...QUERY_FIXTURE, id: 'cuid-1' })
      .mockResolvedValueOnce({ ...QUERY_FIXTURE, id: 'cuid-2' });
    w.nlEmbedding.upsert.mockResolvedValue({});

    const res = await request(app)
      .post('/api/v1/query/batch')
      .send({
        queries: [
          { query: 'Show me transactions today' },
          { query: 'List recent contract deployments' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
    expect(res.body.total).toBe(2);
    expect(res.body.results[0]).toHaveProperty('interpretedQuery');
    expect(res.body.results[0]).toHaveProperty('visualization');
  });

  it('returns 400 for empty queries array', async () => {
    const res = await request(app).post('/api/v1/query/batch').send({ queries: [] });
    expect(res.status).toBe(400);
  });

  it('rejects batches over 20 queries', async () => {
    const queries = Array.from({ length: 21 }, (_, i) => ({ query: `Query number ${i}` }));
    const res = await request(app).post('/api/v1/query/batch').send({ queries });
    expect(res.status).toBe(400);
  });
});

// ── GET /api/v1/query/suggestions ────────────────────────────────────────────

describe('GET /api/v1/query/suggestions', () => {
  it('returns built-in suggestions without prefix', async () => {
    r.nlEmbedding.findMany.mockResolvedValue([]);

    const res = await request(app).get('/api/v1/query/suggestions');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('suggestions');
    expect(Array.isArray(res.body.suggestions)).toBe(true);
    expect(res.body.suggestions.length).toBeGreaterThan(0);
  });

  it('filters suggestions by prefix', async () => {
    r.nlEmbedding.findMany.mockResolvedValue([
      { query: 'Show me large transfers', intent: 'list_transactions', usageCount: 5 },
    ]);

    const res = await request(app).get('/api/v1/query/suggestions?prefix=show');

    expect(res.status).toBe(200);
    expect(res.body.suggestions.every((s: string) => s.toLowerCase().startsWith('show'))).toBe(
      true,
    );
  });

  it('respects limit parameter', async () => {
    r.nlEmbedding.findMany.mockResolvedValue([]);

    const res = await request(app).get('/api/v1/query/suggestions?limit=5');

    expect(res.status).toBe(200);
    expect(res.body.suggestions.length).toBeLessThanOrEqual(5);
  });

  it('combines DB and built-in suggestions', async () => {
    r.nlEmbedding.findMany.mockResolvedValue([
      { query: 'Show fees breakdown', intent: 'distribution', usageCount: 10 },
    ]);

    const res = await request(app).get('/api/v1/query/suggestions?limit=20');

    expect(res.status).toBe(200);
    expect(res.body.suggestions.length).toBeGreaterThan(0);
  });
});

// ── GET /api/v1/query/history ─────────────────────────────────────────────────

describe('GET /api/v1/query/history', () => {
  it('returns query history with pagination info', async () => {
    r.nlQuery.findMany.mockResolvedValue([QUERY_FIXTURE]);
    r.nlQuery.count.mockResolvedValue(1);

    const res = await request(app).get('/api/v1/query/history');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('history');
    expect(res.body).toHaveProperty('total', 1);
    expect(res.body).toHaveProperty('limit');
    expect(res.body).toHaveProperty('offset');
  });

  it('filters history by userId', async () => {
    r.nlQuery.findMany.mockResolvedValue([QUERY_FIXTURE]);
    r.nlQuery.count.mockResolvedValue(1);

    const res = await request(app).get('/api/v1/query/history?userId=user-1');

    expect(res.status).toBe(200);
    expect(r.nlQuery.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1' } }),
    );
  });
});

// ── POST /api/v1/query/:id/feedback ──────────────────────────────────────────

describe('POST /api/v1/query/:id/feedback', () => {
  it('records helpful feedback', async () => {
    r.nlQuery.findUnique.mockResolvedValue(QUERY_FIXTURE);
    w.nlQuery.update.mockResolvedValue({ ...QUERY_FIXTURE, feedback: 'helpful' });

    const res = await request(app)
      .post('/api/v1/query/cuid-nlq-1/feedback')
      .send({ feedback: 'helpful' });

    expect(res.status).toBe(200);
    expect(res.body.feedback).toBe('helpful');
    expect(res.body.ok).toBe(true);
  });

  it('records not_helpful feedback', async () => {
    r.nlQuery.findUnique.mockResolvedValue(QUERY_FIXTURE);
    w.nlQuery.update.mockResolvedValue({ ...QUERY_FIXTURE, feedback: 'not_helpful' });

    const res = await request(app)
      .post('/api/v1/query/cuid-nlq-1/feedback')
      .send({ feedback: 'not_helpful' });

    expect(res.status).toBe(200);
    expect(res.body.feedback).toBe('not_helpful');
  });

  it('records incorrect feedback', async () => {
    r.nlQuery.findUnique.mockResolvedValue(QUERY_FIXTURE);
    w.nlQuery.update.mockResolvedValue({ ...QUERY_FIXTURE, feedback: 'incorrect' });

    const res = await request(app)
      .post('/api/v1/query/cuid-nlq-1/feedback')
      .send({ feedback: 'incorrect' });

    expect(res.status).toBe(200);
    expect(res.body.feedback).toBe('incorrect');
  });

  it('records partial feedback', async () => {
    r.nlQuery.findUnique.mockResolvedValue(QUERY_FIXTURE);
    w.nlQuery.update.mockResolvedValue({ ...QUERY_FIXTURE, feedback: 'partial' });

    const res = await request(app)
      .post('/api/v1/query/cuid-nlq-1/feedback')
      .send({ feedback: 'partial' });

    expect(res.status).toBe(200);
    expect(res.body.feedback).toBe('partial');
  });

  it('returns 404 for unknown query', async () => {
    r.nlQuery.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/v1/query/nonexistent/feedback')
      .send({ feedback: 'helpful' });

    expect(res.status).toBe(404);
  });

  it('rejects invalid feedback value', async () => {
    const res = await request(app)
      .post('/api/v1/query/cuid-nlq-1/feedback')
      .send({ feedback: 'amazing' });

    expect(res.status).toBe(400);
  });
});

// ── GET /api/v1/query/analytics ───────────────────────────────────────────────

describe('GET /api/v1/query/analytics', () => {
  it('returns analytics summary with success rate', async () => {
    r.nlQuery.count.mockResolvedValueOnce(1000).mockResolvedValueOnce(870);
    r.nlQuery.groupBy.mockResolvedValue([
      { feedback: 'helpful', _count: { feedback: 600 } },
      { feedback: 'not_helpful', _count: { feedback: 100 } },
    ]);
    r.nlQuery.aggregate.mockResolvedValue({ _avg: { responseTime: 120 } });

    const res = await request(app).get('/api/v1/query/analytics');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('totalQueries', 1000);
    expect(res.body).toHaveProperty('successRate');
    expect(res.body.successRate).toBeLessThanOrEqual(1);
    expect(res.body).toHaveProperty('feedbackSummary');
    expect(res.body).toHaveProperty('avgConfidence');
  });
});

// ── GET/POST /api/v1/query/templates ─────────────────────────────────────────

describe('Templates', () => {
  it('GET /templates returns at least 20 built-in templates', async () => {
    r.nlQueryTemplate.findMany.mockResolvedValue([]);

    const res = await request(app).get('/api/v1/query/templates');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('templates');
    expect(res.body.templates.length).toBeGreaterThanOrEqual(20);
  });

  it('GET /templates filters by category', async () => {
    r.nlQueryTemplate.findMany.mockResolvedValue([]);

    const res = await request(app).get('/api/v1/query/templates?category=transactions');

    expect(res.status).toBe(200);
    expect(
      res.body.templates.every((t: { category: string }) => t.category === 'transactions'),
    ).toBe(true);
  });

  it('POST /templates creates a new template', async () => {
    const template = {
      id: 'tpl-1',
      name: 'My Template',
      nlTemplate: 'Show me {contract} activity',
      isPublic: false,
      usageCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    w.nlQueryTemplate.create.mockResolvedValue(template);

    const res = await request(app)
      .post('/api/v1/query/templates')
      .send({
        name: 'My Template',
        nlTemplate: 'Show me {contract} activity',
        parameters: [{ name: 'contract', type: 'address' }],
      });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
  });

  it('GET /templates/:id returns template detail', async () => {
    r.nlQueryTemplate.findUnique.mockResolvedValue({
      id: 'tpl-1',
      name: 'My Template',
      nlTemplate: 'Show me activity',
    });

    const res = await request(app).get('/api/v1/query/templates/tpl-1');

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('tpl-1');
  });

  it('GET /templates/:id returns 404 for unknown template', async () => {
    r.nlQueryTemplate.findUnique.mockResolvedValue(null);

    const res = await request(app).get('/api/v1/query/templates/nonexistent');

    expect(res.status).toBe(404);
  });

  it('POST /templates returns 400 for missing required fields', async () => {
    const res = await request(app).post('/api/v1/query/templates').send({
      description: 'missing name and template',
    });
    expect(res.status).toBe(400);
  });
});

// ── Session management ────────────────────────────────────────────────────────

describe('Session management', () => {
  it('POST /session/start creates a new session', async () => {
    w.nlSession.create.mockResolvedValue(SESSION_FIXTURE);

    const res = await request(app).post('/api/v1/query/session/start').send({ userId: 'user-1' });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('sessionId');
    expect(res.body).toHaveProperty('createdAt');
  });

  it('POST /session/:id/ask processes a query in session context', async () => {
    r.nlSession.findUnique.mockResolvedValue(SESSION_FIXTURE);
    w.nlQuery.create.mockResolvedValue(QUERY_FIXTURE);
    w.nlQueryContext.create.mockResolvedValue({});
    w.nlSession.update.mockResolvedValue({});

    const res = await request(app)
      .post('/api/v1/query/session/session-1/ask')
      .send({ query: 'Show me transactions for contract CA123', userId: 'user-1' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('sessionId', 'session-1');
    expect(res.body).toHaveProperty('queryId');
    expect(res.body).toHaveProperty('contextTurns');
    expect(res.body).toHaveProperty('activeFilters');
  });

  it('POST /session/:id/ask accumulates context turns', async () => {
    const sessionWithTurns = {
      ...SESSION_FIXTURE,
      context: {
        turns: [
          {
            queryId: 'old-1',
            query: 'Show StellarSwap transactions',
            intent: 'list_transactions',
            filters: {},
          },
        ],
        resolvedEntities: {},
        activeFilters: {},
      },
    };
    r.nlSession.findUnique.mockResolvedValue(sessionWithTurns);
    w.nlQuery.create.mockResolvedValue(QUERY_FIXTURE);
    w.nlQueryContext.create.mockResolvedValue({});
    w.nlSession.update.mockResolvedValue({});

    const res = await request(app)
      .post('/api/v1/query/session/session-1/ask')
      .send({ query: 'Only those over 1000 XLM' });

    expect(res.status).toBe(200);
    expect(res.body.contextTurns).toBeGreaterThanOrEqual(1);
  });

  it('POST /session/:id/ask returns 404 for unknown session', async () => {
    r.nlSession.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/v1/query/session/nonexistent/ask')
      .send({ query: 'Show me transactions' });

    expect(res.status).toBe(404);
  });

  it('GET /session/:id/context returns session context', async () => {
    r.nlSession.findUnique.mockResolvedValue(SESSION_FIXTURE);

    const res = await request(app).get('/api/v1/query/session/session-1/context');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('sessionId', 'session-1');
    expect(res.body).toHaveProperty('context');
  });

  it('GET /session/:id/context returns 404 for unknown session', async () => {
    r.nlSession.findUnique.mockResolvedValue(null);

    const res = await request(app).get('/api/v1/query/session/nonexistent/context');

    expect(res.status).toBe(404);
  });

  it('DELETE /session/:id clears the session', async () => {
    r.nlSession.findUnique.mockResolvedValue(SESSION_FIXTURE);
    w.nlSession.delete.mockResolvedValue({});

    const res = await request(app).delete('/api/v1/query/session/session-1');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.sessionId).toBe('session-1');
  });

  it('DELETE /session/:id returns 404 for unknown session', async () => {
    r.nlSession.findUnique.mockResolvedValue(null);

    const res = await request(app).delete('/api/v1/query/session/nonexistent');

    expect(res.status).toBe(404);
  });
});

// ── Reports ───────────────────────────────────────────────────────────────────

describe('Reports', () => {
  it('POST /reports creates a report', async () => {
    w.nlReport.create.mockResolvedValue(REPORT_FIXTURE);

    const res = await request(app).post('/api/v1/query/reports').send({
      name: 'Daily Volume Report',
      nlTemplate: 'Show me total volume for the last 24 hours',
      reportType: 'daily',
      userId: 'user-1',
    });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(res.body.name).toBe('Daily Volume Report');
  });

  it('GET /reports lists reports', async () => {
    r.nlReport.findMany.mockResolvedValue([REPORT_FIXTURE]);

    const res = await request(app).get('/api/v1/query/reports');

    expect(res.status).toBe(200);
    expect(res.body.reports).toHaveLength(1);
    expect(res.body.total).toBe(1);
  });

  it('PUT /reports/:id updates a report', async () => {
    r.nlReport.findUnique.mockResolvedValue(REPORT_FIXTURE);
    w.nlReport.update.mockResolvedValue({ ...REPORT_FIXTURE, name: 'Updated Report' });

    const res = await request(app)
      .put('/api/v1/query/reports/report-1')
      .send({ name: 'Updated Report' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Updated Report');
  });

  it('PUT /reports/:id returns 404 for unknown report', async () => {
    r.nlReport.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .put('/api/v1/query/reports/nonexistent')
      .send({ name: 'New Name' });

    expect(res.status).toBe(404);
  });

  it('DELETE /reports/:id deletes a report', async () => {
    r.nlReport.findUnique.mockResolvedValue(REPORT_FIXTURE);
    w.nlReport.delete.mockResolvedValue({});

    const res = await request(app).delete('/api/v1/query/reports/report-1');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('POST /reports/:id/run triggers a manual run', async () => {
    r.nlReport.findUnique.mockResolvedValue(REPORT_FIXTURE);
    w.nlReportHistory.create.mockResolvedValue({ id: 'hist-1', status: 'success', result: {} });
    w.nlReport.update.mockResolvedValue({});

    const res = await request(app).post('/api/v1/query/reports/report-1/run');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body).toHaveProperty('historyId');
  });

  it('POST /reports/:id/run returns 404 for unknown report', async () => {
    r.nlReport.findUnique.mockResolvedValue(null);

    const res = await request(app).post('/api/v1/query/reports/nonexistent/run');

    expect(res.status).toBe(404);
  });

  it('GET /reports/:id/history returns delivery history', async () => {
    r.nlReport.findUnique.mockResolvedValue(REPORT_FIXTURE);
    r.nlReportHistory.findMany.mockResolvedValue([
      { id: 'hist-1', status: 'success', ranAt: new Date() },
    ]);

    const res = await request(app).get('/api/v1/query/reports/report-1/history');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('reportId', 'report-1');
    expect(res.body.history).toHaveLength(1);
  });
});

// ── Alerts ────────────────────────────────────────────────────────────────────

describe('Alerts', () => {
  it('POST /alerts creates an alert from NL query', async () => {
    w.nlAlert.create.mockResolvedValue(ALERT_FIXTURE);

    const res = await request(app).post('/api/v1/query/alerts').send({
      nlQuery: 'Alert me when a transfer exceeds 10000 XLM',
      userId: 'user-1',
    });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(res.body).toHaveProperty('intent');
  });

  it('POST /alerts classifies intent automatically', async () => {
    w.nlAlert.create.mockResolvedValue(ALERT_FIXTURE);

    const res = await request(app).post('/api/v1/query/alerts').send({
      nlQuery: 'Alert me when a large transfer over 10000 XLM occurs',
    });

    expect(res.status).toBe(201);
    expect(w.nlAlert.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ intent: 'alert_condition' }),
      }),
    );
  });

  it('GET /alerts lists active alerts', async () => {
    r.nlAlert.findMany.mockResolvedValue([ALERT_FIXTURE]);

    const res = await request(app).get('/api/v1/query/alerts');

    expect(res.status).toBe(200);
    expect(res.body.alerts).toHaveLength(1);
    expect(res.body.total).toBe(1);
  });

  it('DELETE /alerts/:id deactivates an alert', async () => {
    r.nlAlert.findUnique.mockResolvedValue(ALERT_FIXTURE);
    w.nlAlert.update.mockResolvedValue({ ...ALERT_FIXTURE, active: false });

    const res = await request(app).delete('/api/v1/query/alerts/alert-1');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(w.nlAlert.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { active: false } }),
    );
  });

  it('DELETE /alerts/:id returns 404 for unknown alert', async () => {
    r.nlAlert.findUnique.mockResolvedValue(null);

    const res = await request(app).delete('/api/v1/query/alerts/nonexistent');

    expect(res.status).toBe(404);
  });

  it('POST /alerts/:id/test tests the alert conditions', async () => {
    r.nlAlert.findUnique.mockResolvedValue(ALERT_FIXTURE);

    const res = await request(app).post('/api/v1/query/alerts/alert-1/test');

    expect(res.status).toBe(200);
    expect(res.body.tested).toBe(true);
    expect(res.body).toHaveProperty('interpretedQuery');
    expect(res.body).toHaveProperty('conditions');
  });

  it('POST /alerts/:id/test returns 404 for unknown alert', async () => {
    r.nlAlert.findUnique.mockResolvedValue(null);

    const res = await request(app).post('/api/v1/query/alerts/nonexistent/test');

    expect(res.status).toBe(404);
  });
});

// ── Semantic suggestions & trending ──────────────────────────────────────────

describe('Semantic suggestions and trending', () => {
  it('GET /suggestions/semantic returns semantically similar suggestions', async () => {
    r.nlEmbedding.findMany.mockResolvedValue([
      { query: 'Show me transactions today', intent: 'list_transactions', successRate: 0.95 },
    ]);

    const res = await request(app).get('/api/v1/query/suggestions/semantic?q=show+me+txs');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('semanticSuggestions');
    expect(res.body).toHaveProperty('intent');
    expect(res.body).toHaveProperty('query');
  });

  it('GET /suggestions/semantic requires q parameter', async () => {
    const res = await request(app).get('/api/v1/query/suggestions/semantic');
    expect(res.status).toBe(400);
  });

  it('GET /trending returns trending queries from DB and recent', async () => {
    r.nlEmbedding.findMany.mockResolvedValue([
      {
        query: 'Show me transactions today',
        intent: 'list_transactions',
        usageCount: 100,
        successRate: 0.9,
      },
    ]);
    r.nlQuery.findMany.mockResolvedValue([
      { query: 'Show me transactions today', createdAt: new Date() },
      { query: 'Show me transactions today', createdAt: new Date() },
    ]);

    const res = await request(app).get('/api/v1/query/trending');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('trending');
    expect(res.body).toHaveProperty('recentTrending');
    expect(Array.isArray(res.body.trending)).toBe(true);
  });
});

// ── Marketplace ───────────────────────────────────────────────────────────────

describe('Marketplace', () => {
  it('GET /marketplace lists public templates', async () => {
    r.nlQueryTemplate.findMany.mockResolvedValue([
      {
        id: 'tpl-1',
        name: 'Whale Watcher',
        nlTemplate: 'Show me whale transfers',
        isPublic: true,
        usageCount: 50,
      },
    ]);

    const res = await request(app).get('/api/v1/query/marketplace');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('marketplace');
    expect(res.body.marketplace).toHaveLength(1);
  });

  it('POST /marketplace/publish creates a public template', async () => {
    w.nlQueryTemplate.create.mockResolvedValue({
      id: 'tpl-2',
      name: 'Community Template',
      nlTemplate: 'Show me {token} transfers',
      isPublic: true,
    });

    const res = await request(app).post('/api/v1/query/marketplace/publish').send({
      name: 'Community Template',
      nlTemplate: 'Show me {token} transfers',
      userId: 'user-1',
    });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(w.nlQueryTemplate.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isPublic: true }) }),
    );
  });
});

// ── Personalized suggestions ──────────────────────────────────────────────────

describe('Personalized suggestions', () => {
  it('GET /personalized/:userId returns suggestions based on user history', async () => {
    r.nlQuery.findMany.mockResolvedValue([QUERY_FIXTURE]);
    r.nlEmbedding.findMany.mockResolvedValue([
      { query: 'Show me top transactions', intent: 'list_transactions' },
    ]);

    const res = await request(app).get('/api/v1/query/personalized/user-1');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('userId', 'user-1');
    expect(res.body).toHaveProperty('suggestions');
    expect(res.body).toHaveProperty('basedOn');
  });
});
