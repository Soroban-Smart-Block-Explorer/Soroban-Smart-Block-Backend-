import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';
import { prismaRead } from '../db';
import * as compliance from '../services/compliance';

export const complianceRouter = Router();

// ── GET / ─────────────────────────────────────────────────────────────────────

complianceRouter.get('/', (_req: Request, res: Response) => {
  res.json({
    service: 'Enterprise Compliance & Sanctions Screening Engine',
    version: '2.0.0',
    capabilities: [
      'Multi-jurisdiction sanctions screening (OFAC SDN, OFAC CAP, EU, UN, UK OFSI)',
      'Real-time transaction screening (10K+ TPS)',
      'Three-tier matching (exact, fuzzy address, fuzzy name)',
      'Multi-factor risk scoring engine',
      'Travel Rule compliance (FATF Recommendation 16)',
      'Webhook alerts with exponential backoff',
      'Automated report generation (daily, weekly, monthly)',
      'PEP & adverse media screening',
      'Address clustering & entity analysis',
      'Real-time transaction blocking',
      'Regulatory reporting (SAR, FinCEN, FCA)',
      'AI-powered anomaly detection',
      'Full audit trail',
      'PagerDuty / Slack / Email / SIEM integration',
    ],
    endpoints: [
      'GET    /api/v1/compliance',
      'GET    /api/v1/compliance/screen/:address',
      'POST   /api/v1/compliance/screen/batch',
      'GET    /api/v1/compliance/status/:address',
      'GET    /api/v1/compliance/alerts',
      'PUT    /api/v1/compliance/alerts/:id/review',
      'GET    /api/v1/compliance/summary',
      'GET    /api/v1/compliance/stats',
      'GET    /api/v1/compliance/risk/:address',
      'POST   /api/v1/compliance/risk/batch',
      'GET    /api/v1/compliance/lists',
      'POST   /api/v1/compliance/lists/refresh',
      'GET    /api/v1/compliance/lists/:source/versions',
      'POST   /api/v1/compliance/lists/custom',
      'DELETE /api/v1/compliance/lists/custom/:id',
      'GET    /api/v1/compliance/lists/changelog',
      'GET    /api/v1/compliance/travel-rule/:txHash',
      'GET    /api/v1/compliance/travel-rule/pending',
      'POST   /api/v1/compliance/travel-rule/submit',
      'GET    /api/v1/compliance/travel-rule/summary',
      'POST   /api/v1/compliance/webhooks',
      'GET    /api/v1/compliance/webhooks',
      'DELETE /api/v1/compliance/webhooks/:id',
      'POST   /api/v1/compliance/reports/daily',
      'POST   /api/v1/compliance/reports/weekly',
      'POST   /api/v1/compliance/reports/monthly',
      'POST   /api/v1/compliance/reports/address/:address',
      'GET    /api/v1/compliance/reports',
      'GET    /api/v1/compliance/reports/:id',
      'GET    /api/v1/compliance/pep/:address',
      'GET    /api/v1/compliance/adverse-media/:address',
      'GET    /api/v1/compliance/cluster/:address',
      'GET    /api/v1/compliance/clusters/high-risk',
      'POST   /api/v1/compliance/blocking/rules',
      'GET    /api/v1/compliance/blocking/rules',
      'PUT    /api/v1/compliance/blocking/rules/:id',
      'DELETE /api/v1/compliance/blocking/rules/:id',
      'GET    /api/v1/compliance/blocking/actions',
      'POST   /api/v1/compliance/reports/sar',
      'POST   /api/v1/compliance/reports/regulatory',
      'GET    /api/v1/compliance/anomalies',
      'POST   /api/v1/compliance/anomalies/:id/review',
      'GET    /api/v1/compliance/audit-log',
    ],
  });
});

// ── Screening Endpoints ───────────────────────────────────────────────────────

complianceRouter.get(
  '/screen/:address',
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    const txHash = req.query.txHash as string | undefined;

    const result = await compliance.screenAddress(address, {
      method: 'manual',
      txHash,
    });

    res.json(result);
  }),
);

complianceRouter.post(
  '/screen/batch',
  asyncHandler(async (req: Request, res: Response) => {
    const schema = z.object({
      addresses: z.array(z.string().min(10)).min(1).max(1000),
      txHashes: z.array(z.string()).optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const result = await compliance.batchScreen(parsed.data.addresses, {
      method: 'batch',
    });

    res.json(result);
  }),
);

complianceRouter.get(
  '/status/:address',
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    const result = await compliance.getScreeningStatus(address);
    res.json(result);
  }),
);

// ── Alerts Endpoints ──────────────────────────────────────────────────────────

complianceRouter.get(
  '/alerts',
  asyncHandler(async (req: Request, res: Response) => {
    const limit = Math.min(200, parseInt((req.query.limit as string) ?? '50', 10));
    const offset = parseInt((req.query.offset as string) ?? '0', 10);
    const status = req.query.status as string | undefined;

    const result = await compliance.getAlerts(limit, offset, status);
    res.json(result);
  }),
);

complianceRouter.put(
  '/alerts/:id/review',
  asyncHandler(async (req: Request, res: Response) => {
    const schema = z.object({
      action: z.enum(['confirmed_positive', 'false_positive', 'escalated']),
      reviewerId: z.string().optional(),
      notes: z.string().optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const result = await compliance.reviewAlert(
      req.params.id,
      parsed.data.action,
      parsed.data.reviewerId,
      parsed.data.notes,
    );

    res.json(result);
  }),
);

// ── Summary & Stats ───────────────────────────────────────────────────────────

complianceRouter.get(
  '/summary',
  asyncHandler(async (_req: Request, res: Response) => {
    const result = await compliance.getScreeningSummary();
    res.json(result);
  }),
);

complianceRouter.get(
  '/stats',
  asyncHandler(async (_req: Request, res: Response) => {
    const result = await compliance.getStats();
    res.json(result);
  }),
);

// ── Risk Scoring ──────────────────────────────────────────────────────────────

complianceRouter.get(
  '/risk/:address',
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    const result = await compliance.assessAddressRisk(address);
    res.json(result);
  }),
);

complianceRouter.post(
  '/risk/batch',
  asyncHandler(async (req: Request, res: Response) => {
    const schema = z.object({
      addresses: z.array(z.string().min(10)).min(1).max(1000),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const result = await compliance.batchRiskAssessment(parsed.data.addresses);
    res.json({ results: result, count: result.length });
  }),
);

// ── Sanctions List Management ─────────────────────────────────────────────────

complianceRouter.get(
  '/lists',
  asyncHandler(async (req: Request, res: Response) => {
    const lists = await prismaRead.sanctionsList.groupBy({
      by: ['source', 'listVersion', 'listName'],
      where: { isActive: true },
      _count: { id: true },
    });

    const enriched = await Promise.all(
      lists.map(async (l: any) => {
        const importedAt = await prismaRead.sanctionsList.findFirst({
          where: { source: l.source, listVersion: l.listVersion },
          orderBy: { importedAt: 'desc' },
          select: { importedAt: true },
        });
        return {
          source: l.source,
          listVersion: l.listVersion,
          listName: l.listName,
          entryCount: l._count.id,
          lastUpdated: importedAt?.importedAt?.toISOString() ?? null,
        };
      }),
    );

    res.json({ lists: enriched });
  }),
);

complianceRouter.post(
  '/lists/refresh',
  asyncHandler(async (_req: Request, res: Response) => {
    const results = await compliance.refreshAllLists();
    res.json({
      message: 'Sanctions lists refresh initiated',
      results,
      completedAt: new Date().toISOString(),
    });
  }),
);

complianceRouter.get(
  '/lists/:source/versions',
  asyncHandler(async (req: Request, res: Response) => {
    const { source } = req.params;
    const result = await compliance.getListVersions(source);
    res.json({ source, versions: result });
  }),
);

complianceRouter.post(
  '/lists/custom',
  asyncHandler(async (req: Request, res: Response) => {
    const schema = z.object({
      listName: z.string().min(1).max(200),
      entries: z.array(z.object({
        entityType: z.string().default('individual'),
        name: z.string().optional(),
        address: z.string().optional(),
        addressPattern: z.string().optional(),
        aliases: z.array(z.string()).default([]),
        program: z.string().optional(),
        country: z.string().optional(),
      })).min(1).max(10000),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const result = await compliance.importCustomList(
      parsed.data.entries.map(e => ({
        source: 'custom' as const,
        entityType: e.entityType,
        name: e.name,
        address: e.address,
        addressPattern: e.addressPattern,
        aliases: e.aliases,
        program: e.program,
        country: e.country,
        citizenship: [],
        addedToListAt: new Date(),
        listVersion: new Date().toISOString().split('T')[0],
        title: undefined,
        birthDate: undefined,
        placeOfBirth: undefined,
        idDocument: undefined,
      })),
      parsed.data.listName,
    );

    res.status(201).json(result);
  }),
);

complianceRouter.delete(
  '/lists/custom/:id',
  asyncHandler(async (req: Request, res: Response) => {
    await compliance.deleteCustomList(req.params.id);
    res.status(204).send();
  }),
);

complianceRouter.get(
  '/lists/changelog',
  asyncHandler(async (req: Request, res: Response) => {
    const days = parseInt((req.query.days as string) ?? '30', 10);
    const result = await compliance.getChangelog(days);
    res.json({ changes: result });
  }),
);

// ── Travel Rule ───────────────────────────────────────────────────────────────

complianceRouter.get(
  '/travel-rule/:txHash',
  asyncHandler(async (req: Request, res: Response) => {
    const { txHash } = req.params;
    const result = await compliance.getTravelRule(txHash);
    res.json(result);
  }),
);

complianceRouter.get(
  '/travel-rule/pending',
  asyncHandler(async (req: Request, res: Response) => {
    const limit = Math.min(200, parseInt((req.query.limit as string) ?? '50', 10));
    const offset = parseInt((req.query.offset as string) ?? '0', 10);
    const result = await compliance.getPendingTravelRules(limit, offset);
    res.json(result);
  }),
);

complianceRouter.post(
  '/travel-rule/submit',
  asyncHandler(async (req: Request, res: Response) => {
    const schema = z.object({
      txHash: z.string().min(1),
      originatorVasp: z.string().optional(),
      beneficiaryVasp: z.string().optional(),
      originatorInfo: z.record(z.unknown()).optional(),
      beneficiaryInfo: z.record(z.unknown()).optional(),
      transferValue: z.string().min(1),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const result = await compliance.submitTravelRule(parsed.data);
    res.status(201).json(result);
  }),
);

complianceRouter.get(
  '/travel-rule/summary',
  asyncHandler(async (_req: Request, res: Response) => {
    const result = await compliance.getTravelRuleSummary();
    res.json(result);
  }),
);

// ── Webhook Management ────────────────────────────────────────────────────────

complianceRouter.post(
  '/webhooks',
  asyncHandler(async (req: Request, res: Response) => {
    const schema = z.object({
      url: z.string().url(),
      events: z.array(
        z.enum(['match.found', 'list.updated', 'address.status_changed', 'match.reviewed']),
      ).min(1),
      secret: z.string().optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const webhook = compliance.registerWebhook(
      parsed.data.url,
      parsed.data.events,
      parsed.data.secret,
    );

    res.status(201).json(webhook);
  }),
);

complianceRouter.get(
  '/webhooks',
  asyncHandler(async (_req: Request, res: Response) => {
    const webhooks = compliance.listWebhooks();
    res.json({ webhooks, total: webhooks.length });
  }),
);

complianceRouter.delete(
  '/webhooks/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const removed = compliance.unregisterWebhook(req.params.id);
    if (!removed) {
      return res.status(404).json({ error: 'Webhook not found' });
    }
    res.status(204).send();
  }),
);

// ── Reports ───────────────────────────────────────────────────────────────────

complianceRouter.post(
  '/reports/daily',
  asyncHandler(async (_req: Request, res: Response) => {
    const report = await compliance.generateDailyReport();
    res.status(201).json(report);
  }),
);

complianceRouter.post(
  '/reports/weekly',
  asyncHandler(async (_req: Request, res: Response) => {
    const report = await compliance.generateWeeklyReport();
    res.status(201).json(report);
  }),
);

complianceRouter.post(
  '/reports/monthly',
  asyncHandler(async (_req: Request, res: Response) => {
    const report = await compliance.generateMonthlyReport();
    res.status(201).json(report);
  }),
);

complianceRouter.post(
  '/reports/address/:address',
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    const report = await compliance.generateAddressReport(address);
    res.status(201).json(report);
  }),
);

complianceRouter.get(
  '/reports',
  asyncHandler(async (req: Request, res: Response) => {
    const limit = Math.min(100, parseInt((req.query.limit as string) ?? '20', 10));
    const offset = parseInt((req.query.offset as string) ?? '0', 10);
    const reportType = req.query.type as string | undefined;
    const result = await compliance.listReports(limit, offset, reportType);
    res.json(result);
  }),
);

complianceRouter.get(
  '/reports/:id',
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const report = await compliance.getReport(req.params.id);
      res.json(report);
    } catch (err) {
      return res.status(404).json({ error: (err as Error).message });
    }
  }),
);

// ── PEP & Adverse Media ───────────────────────────────────────────────────────

complianceRouter.get(
  '/pep/:address',
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    const result = await compliance.checkPep(address);
    res.json(result);
  }),
);

complianceRouter.get(
  '/adverse-media/:address',
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    const result = await compliance.checkAdverseMedia(address);
    res.json(result);
  }),
);

// ── Address Clustering ────────────────────────────────────────────────────────

complianceRouter.get(
  '/cluster/:address',
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    const result = await compliance.getCluster(address);
    res.json(result);
  }),
);

complianceRouter.get(
  '/clusters/high-risk',
  asyncHandler(async (req: Request, res: Response) => {
    const limit = Math.min(100, parseInt((req.query.limit as string) ?? '20', 10));
    const offset = parseInt((req.query.offset as string) ?? '0', 10);
    const result = await compliance.getHighRiskClusters(limit, offset);
    res.json(result);
  }),
);

// ── Transaction Blocking ──────────────────────────────────────────────────────

complianceRouter.post(
  '/blocking/rules',
  asyncHandler(async (req: Request, res: Response) => {
    const schema = z.object({
      name: z.string().min(1).max(200),
      description: z.string().optional(),
      matchThreshold: z.number().min(0).max(100),
      sources: z.array(z.string()).min(1),
      action: z.enum(['block', 'flag', 'escalate']),
      createdBy: z.string().optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const rule = compliance.createBlockingRule(parsed.data);
    res.status(201).json(rule);
  }),
);

complianceRouter.get(
  '/blocking/rules',
  asyncHandler(async (_req: Request, res: Response) => {
    const rules = compliance.listBlockingRules();
    res.json({ rules, total: rules.length });
  }),
);

complianceRouter.put(
  '/blocking/rules/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const schema = z.object({
      name: z.string().optional(),
      description: z.string().optional(),
      matchThreshold: z.number().min(0).max(100).optional(),
      action: z.enum(['block', 'flag', 'escalate']).optional(),
      enabled: z.boolean().optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const rule = compliance.updateBlockingRule(req.params.id, parsed.data);
    if (!rule) {
      return res.status(404).json({ error: 'Blocking rule not found' });
    }
    res.json(rule);
  }),
);

complianceRouter.delete(
  '/blocking/rules/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const removed = compliance.deleteBlockingRule(req.params.id);
    if (!removed) {
      return res.status(404).json({ error: 'Blocking rule not found' });
    }
    res.status(204).send();
  }),
);

complianceRouter.get(
  '/blocking/actions',
  asyncHandler(async (req: Request, res: Response) => {
    const limit = Math.min(200, parseInt((req.query.limit as string) ?? '50', 10));
    const offset = parseInt((req.query.offset as string) ?? '0', 10);
    const result = compliance.getBlockingActions(limit, offset);
    res.json(result);
  }),
);

// ── SAR & Regulatory Reporting ────────────────────────────────────────────────

complianceRouter.post(
  '/reports/sar',
  asyncHandler(async (req: Request, res: Response) => {
    const schema = z.object({
      subjectAddress: z.string().min(1),
      activityType: z.enum([
        'money_laundering',
        'sanctions_evasion',
        'fraud',
        'market_manipulation',
        'structuring',
        'terrorist_financing',
        'other',
      ]),
      description: z.string().min(20),
      relatedTxHashes: z.array(z.string()).default([]),
      reportedBy: z.string().optional(),
      filingType: z.string().optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const report = await compliance.generateSarReport(parsed.data);
    res.status(201).json(report);
  }),
);

complianceRouter.post(
  '/reports/regulatory',
  asyncHandler(async (req: Request, res: Response) => {
    const schema = z.object({
      jurisdiction: z.string().min(1),
      reportType: z.string().min(1),
      periodStart: z.string().datetime(),
      periodEnd: z.string().datetime(),
      template: z.string().min(1),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const report = await compliance.generateRegulatoryReport({
      jurisdiction: parsed.data.jurisdiction,
      reportType: parsed.data.reportType,
      periodStart: new Date(parsed.data.periodStart),
      periodEnd: new Date(parsed.data.periodEnd),
      template: parsed.data.template,
    });

    res.status(201).json(report);
  }),
);

// ── Anomaly Detection ─────────────────────────────────────────────────────────

complianceRouter.get(
  '/anomalies',
  asyncHandler(async (req: Request, res: Response) => {
    const limit = Math.min(200, parseInt((req.query.limit as string) ?? '50', 10));
    const offset = parseInt((req.query.offset as string) ?? '0', 10);
    const status = req.query.status as string | undefined;

    if (req.query.detect === 'true') {
      const address = req.query.address as string | undefined;
      await compliance.detectAnomalies(address);
    }

    const result = compliance.listAnomalies(limit, offset, status);
    res.json(result);
  }),
);

complianceRouter.post(
  '/anomalies/:id/review',
  asyncHandler(async (req: Request, res: Response) => {
    const schema = z.object({
      status: z.enum(['investigating', 'resolved', 'false_positive']),
      reviewedBy: z.string().optional(),
      notes: z.string().optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const result = compliance.reviewAnomaly(
      req.params.id,
      parsed.data.status,
      parsed.data.reviewedBy,
      parsed.data.notes,
    );

    if (!result) {
      return res.status(404).json({ error: 'Anomaly not found' });
    }

    res.json(result);
  }),
);

// ── Audit Log ─────────────────────────────────────────────────────────────────

complianceRouter.get(
  '/audit-log',
  asyncHandler(async (req: Request, res: Response) => {
    const limit = Math.min(500, parseInt((req.query.limit as string) ?? '100', 10));
    const offset = parseInt((req.query.offset as string) ?? '0', 10);
    const action = req.query.action as any;
    const actor = req.query.actor as string | undefined;

    const logs = compliance.getAuditLogs({ action, actor, limit, offset });
    res.json({ logs, total: logs.length });
  }),
);
