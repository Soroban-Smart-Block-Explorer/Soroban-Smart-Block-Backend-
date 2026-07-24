/**
 * Audit Incident Management API
 * Mounted at /api/v1/audit/incidents
 *
 * GET  /                     — list recent incident dispatches (from AuditEvent trail)
 * GET  /contracts/:address   — incident history for a specific contract
 * POST /test                 — fire a test incident (admin, dev only)
 * GET  /config               — show current incident configuration (thresholds, platforms)
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prismaRead } from '../db';
import { dispatchIncident, type IncidentTrigger } from '../lib/incident-dispatcher';

export const auditIncidentsRouter = Router();

// ── GET / — recent incident dispatches ────────────────────────────────────────

const listSchema = z.object({
  limit: z.coerce.number().min(1).max(200).default(50),
  trigger: z
    .enum(['CRITICAL_FINDING_HIGH_TVL', 'SCORE_BELOW_THRESHOLD', 'CERT_SIGNATURE_FAILURE', 'all'])
    .default('all'),
  since: z.string().optional(),
});

auditIncidentsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const q = listSchema.parse(req.query);

    const where: Record<string, unknown> = {
      eventType: 'vulnerability_discovered',
      details: {
        path: ['action'],
        equals: 'incident_dispatched',
      },
    };

    if (q.trigger !== 'all') {
      where.details = {
        path: ['trigger'],
        equals: q.trigger,
      };
    }

    if (q.since) {
      where.timestamp = { gte: new Date(q.since) };
    }

    const events = await prismaRead.auditEvent.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      take: q.limit,
      select: {
        id: true,
        contractAddress: true,
        certificateId: true,
        timestamp: true,
        details: true,
      },
    });

    // Shape the raw AuditEvent details into a clean incident record
    const incidents = events.map((e) => {
      const d = e.details as Record<string, unknown>;
      return {
        id: e.id,
        contractAddress: e.contractAddress,
        certificateId: e.certificateId,
        timestamp: e.timestamp,
        trigger: d.trigger,
        dedupKey: d.dedupKey,
        overallScore: d.overallScore ?? null,
        tvlUsd: d.tvlUsd ?? null,
        findingId: d.findingId ?? null,
        findingTitle: d.findingTitle ?? null,
        pagerduty: d.pagerduty,
        opsgenie: d.opsgenie,
      };
    });

    // Aggregate stats
    const triggered = incidents.filter((i) => {
      const pd = i.pagerduty as Record<string, unknown>;
      const og = i.opsgenie as Record<string, unknown>;
      return pd?.sent || og?.sent;
    }).length;

    res.json({
      total: incidents.length,
      triggered,
      skipped: incidents.length - triggered,
      incidents,
    });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /contracts/:address — incident history for a contract ─────────────────

auditIncidentsRouter.get('/contracts/:address', async (req: Request, res: Response) => {
  try {
    const { address } = req.params;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);

    const events = await prismaRead.auditEvent.findMany({
      where: {
        contractAddress: address,
        eventType: 'vulnerability_discovered',
        details: {
          path: ['action'],
          equals: 'incident_dispatched',
        },
      },
      orderBy: { timestamp: 'desc' },
      take: limit,
      select: {
        id: true,
        certificateId: true,
        timestamp: true,
        details: true,
      },
    });

    const incidents = events.map((e) => {
      const d = e.details as Record<string, unknown>;
      return {
        id: e.id,
        certificateId: e.certificateId,
        timestamp: e.timestamp,
        trigger: d.trigger,
        dedupKey: d.dedupKey,
        overallScore: d.overallScore ?? null,
        tvlUsd: d.tvlUsd ?? null,
        findingTitle: d.findingTitle ?? null,
        pagerdutyFired: !!(d.pagerduty as Record<string, unknown>)?.sent,
        opsgenieFired: !!(d.opsgenie as Record<string, unknown>)?.sent,
      };
    });

    res.json({ contractAddress: address, count: incidents.length, incidents });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── POST /test — fire a test incident ─────────────────────────────────────────

const testSchema = z.object({
  trigger: z.enum([
    'CRITICAL_FINDING_HIGH_TVL',
    'SCORE_BELOW_THRESHOLD',
    'CERT_SIGNATURE_FAILURE',
  ] as const),
  contractAddress: z.string().min(1),
  adminKey: z.string().optional(),
  // Optional context overrides
  overallScore: z.coerce.number().min(0).max(100).default(25),
  tvlUsd: z.coerce.number().default(2000000),
  findingTitle: z.string().default('Test: critical vulnerability'),
  certId: z.string().default('test-cert-id'),
  certHash: z.string().default('test-cert-hash-000000000000000000000000000000'),
});

auditIncidentsRouter.post('/test', async (req: Request, res: Response) => {
  try {
    const data = testSchema.parse(req.body);

    // Require admin key in production
    const envKey = process.env.AUDIT_ADMIN_KEY;
    if (envKey && data.adminKey !== envKey) {
      return res.status(403).json({ error: 'Invalid admin key.' });
    }

    // Only allow in non-production or when TEST_INCIDENTS_ENABLED is set
    const isProd = process.env.NODE_ENV === 'production';
    const allowed = !isProd || process.env.TEST_INCIDENTS_ENABLED === 'true';
    if (!allowed) {
      return res.status(403).json({
        error: 'Test incidents are disabled in production.',
        hint: 'Set TEST_INCIDENTS_ENABLED=true to allow test incidents in production.',
      });
    }

    const result = await dispatchIncident({
      trigger: data.trigger as IncidentTrigger,
      contractAddress: data.contractAddress,
      certId: data.certId,
      certHash: data.certHash,
      overallScore: data.overallScore,
      tvlUsd: data.tvlUsd,
      findingId: 'test-finding-id',
      findingTitle: data.findingTitle,
      findingSeverity: 'critical',
      detail: `TEST INCIDENT — trigger: ${data.trigger}`,
    });

    res.json({
      message: 'Test incident dispatched.',
      result,
      note: result.alreadyOpen
        ? 'Incident was deduplicated (already open within 6 hours). Pass a different contractAddress to bypass.'
        : `Fired to ${[result.pagerduty.sent && 'PagerDuty', result.opsgenie.sent && 'Opsgenie'].filter(Boolean).join(' + ') || 'no configured platform'}.`,
    });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /config — show current incident configuration ─────────────────────────

auditIncidentsRouter.get('/config', (_req: Request, res: Response) => {
  const pdKey = process.env.PAGERDUTY_ROUTING_KEY;
  const ogKey = process.env.OPSGENIE_API_KEY;

  res.json({
    platforms: {
      pagerduty: {
        configured: !!pdKey,
        keyPrefix: pdKey ? pdKey.slice(0, 8) + '...' : null,
        eventsUrl: 'https://events.pagerduty.com/v2/enqueue',
      },
      opsgenie: {
        configured: !!ogKey,
        keyPrefix: ogKey ? ogKey.slice(0, 6) + '...' : null,
        region: process.env.OPSGENIE_REGION ?? 'us',
        alertUrl:
          process.env.OPSGENIE_REGION === 'eu'
            ? 'https://api.eu.opsgenie.com/v2/alerts'
            : 'https://api.opsgenie.com/v2/alerts',
      },
    },
    triggers: [
      {
        name: 'CRITICAL_FINDING_HIGH_TVL',
        description: 'New critical finding in a contract with TVL above threshold',
        severity: 'P1 / critical',
        condition: `finding.severity === "critical" AND tvl > $${parseInt(process.env.INCIDENT_TVL_THRESHOLD ?? '1000000').toLocaleString()}`,
        tvlThreshold: parseInt(process.env.INCIDENT_TVL_THRESHOLD ?? '1000000'),
      },
      {
        name: 'SCORE_BELOW_THRESHOLD',
        description: 'Audit overall score drops below critical threshold',
        severity: 'P1 / critical',
        condition: `overallScore < ${parseInt(process.env.CRITICAL_SCORE_THRESHOLD ?? '30')}`,
        scoreThreshold: parseInt(process.env.CRITICAL_SCORE_THRESHOLD ?? '30'),
      },
      {
        name: 'CERT_SIGNATURE_FAILURE',
        description: 'Certificate HMAC-SHA256 signature fails verification (possible tampering)',
        severity: 'P2 / error',
        condition: 'verifyCertificateSignature() returns false',
      },
    ],
    deduplication: {
      windowHours: 6,
      keyStrategy: 'SHA-256(trigger:contractAddress:certId)',
    },
    testEndpoint: 'POST /api/v1/audit/incidents/test',
  });
});
