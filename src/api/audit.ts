/**
 * Smart Contract Audit Trail & Certificate API
 * All routes mounted at /api/v1/audit
 *
 * Certificate endpoints
 * ─────────────────────────────────────────────────────────────────
 * GET  /contracts/:address/certificate        latest published certificate
 * GET  /contracts/:address/certificate/history all versions
 * POST /contracts/:address/audit              trigger a new audit
 * GET  /contracts/:address/audit/status       check in-progress audit status
 * GET  /contracts/:address/report.txt         regulatory-grade text report download
 *
 * Findings
 * ─────────────────────────────────────────────────────────────────
 * GET  /certificates/:id/findings             list findings for a certificate
 * GET  /findings/:id                          single finding detail
 * PUT  /findings/:id                          update finding status (resolve/wont_fix)
 *
 * Events & trail
 * ─────────────────────────────────────────────────────────────────
 * GET  /contracts/:address/events             append-only event trail
 *
 * Public verification
 * ─────────────────────────────────────────────────────────────────
 * GET  /verify/:hash                          verify a certificate hash (public API)
 *
 * Platform analytics
 * ─────────────────────────────────────────────────────────────────
 * GET  /leaderboard                           ranked by overallScore
 * GET  /stats                                 platform-wide statistics
 *
 * External audits
 * ─────────────────────────────────────────────────────────────────
 * POST /external                              submit an external audit report
 * GET  /external/:contractAddress             list external audits for a contract
 * PUT  /external/:id/verify                   verify / reject a submission
 *
 * Subscriptions
 * ─────────────────────────────────────────────────────────────────
 * POST /subscriptions                         create alert subscription
 * GET  /subscriptions/:userId                 list user's subscriptions
 * DELETE /subscriptions/:id                   cancel subscription
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prismaRead, prismaWrite } from '../db';
import { cacheGet, cacheSet } from '../cache';
import { runAudit, generateReportText, needsReaudit } from '../indexer/audit-engine';
import { auditVerifyRouter } from './audit-verify';
import { auditAuditorsRouter } from './audit-auditors';
import { platformAnchorRouter } from './audit-anchor';
import { getCategoryBenchmark } from '../lib/audit-benchmark';
import { auditBotRouter } from './audit-bot-router';
import { auditIncidentsRouter } from './audit-incidents';
import { auditEmbedRouter } from './audit-embed';

export const auditRouter = Router();

// ── Shared helpers ────────────────────────────────────────────────────────────

function scoreGrade(s: number): string {
  return s >= 85 ? 'A' : s >= 70 ? 'B' : s >= 55 ? 'C' : s >= 40 ? 'D' : 'F';
}

function scoreRisk(s: number): string {
  return s >= 85 ? 'low' : s >= 70 ? 'medium' : s >= 55 ? 'high' : 'critical';
}

function certStatus(cert: { status: string; expiresAt: Date | null }): string {
  if (cert.status === 'revoked') return 'revoked';
  if (cert.status === 'superseded') return 'superseded';
  if (cert.expiresAt && cert.expiresAt < new Date()) return 'expired';
  return cert.status; // "published" | "draft"
}

function formatCert(cert: Record<string, unknown>) {
  const score = cert.overallScore as number;
  return {
    id: cert.id,
    contractAddress: cert.contractAddress,
    version: cert.version,
    status: certStatus(cert as { status: string; expiresAt: Date | null }),
    grade: scoreGrade(score),
    riskLevel: scoreRisk(score),
    scores: {
      overall: cert.overallScore,
      security: cert.securityScore,
      governance: cert.governanceScore,
      economic: cert.economicScore,
      compliance: cert.complianceScore,
      liquidity: cert.liquidityScore,
    },
    findings: {
      total: cert.totalFindings,
      open: cert.openFindings,
      critical: cert.criticalFindings,
      high: cert.highFindings,
      medium: cert.mediumFindings,
      low: cert.lowFindings,
      resolved: cert.resolvedFindings,
    },
    cryptography: {
      algorithm: cert.signatureAlgorithm,
      publicKey: cert.publicKey,
      certificateHash: cert.certificateHash,
      anchorTxHash: cert.anchorTxHash,
      verifyUrl: `/api/v1/audit/verify/${cert.certificateHash}`,
    },
    generatedAt: cert.generatedAt,
    expiresAt: cert.expiresAt,
    createdAt: cert.createdAt,
    metadata: cert.metadata,
  };
}

// ── GET /contracts/:address/certificate ───────────────────────────────────────

auditRouter.get('/contracts/:address/certificate', async (req: Request, res: Response) => {
  try {
    const { address } = req.params;
    const cacheKey = `audit:cert:latest:${address}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const cert = await prismaRead.auditCertificate.findFirst({
      where: { contractAddress: address, status: 'published' },
      orderBy: { version: 'desc' },
    });

    if (!cert) {
      // Check if there's a non-published one
      const any = await prismaRead.auditCertificate.findFirst({
        where: { contractAddress: address },
        orderBy: { version: 'desc' },
        select: { id: true, status: true, version: true },
      });

      return res.status(404).json({
        error: 'No published audit certificate found for this contract.',
        existingStatus: any?.status ?? null,
        hint: `POST /api/v1/audit/contracts/${address}/audit to trigger one.`,
      });
    }

    const result = formatCert(cert as unknown as Record<string, unknown>);
    await cacheSet(cacheKey, result, 300);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /contracts/:address/certificate/history ───────────────────────────────

auditRouter.get('/contracts/:address/certificate/history', async (req: Request, res: Response) => {
  try {
    const { address } = req.params;
    const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);

    const certs = await prismaRead.auditCertificate.findMany({
      where: { contractAddress: address },
      orderBy: { version: 'desc' },
      take: limit,
      select: {
        id: true,
        version: true,
        status: true,
        generatedAt: true,
        expiresAt: true,
        overallScore: true,
        securityScore: true,
        governanceScore: true,
        economicScore: true,
        complianceScore: true,
        liquidityScore: true,
        totalFindings: true,
        criticalFindings: true,
        highFindings: true,
        certificateHash: true,
        anchorTxHash: true,
        createdAt: true,
      },
    });

    res.json({
      contractAddress: address,
      count: certs.length,
      history: certs.map((c) => ({
        ...c,
        grade: scoreGrade(c.overallScore),
        riskLevel: scoreRisk(c.overallScore),
        status: certStatus(c as { status: string; expiresAt: Date | null }),
        verifyUrl: `/api/v1/audit/verify/${c.certificateHash}`,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── POST /contracts/:address/audit — trigger a new audit ──────────────────────

const triggerSchema = z.object({
  force: z.boolean().default(false),
  triggerSource: z.enum(['manual', 'external']).default('manual'),
});

auditRouter.post('/contracts/:address/audit', async (req: Request, res: Response) => {
  try {
    const { address } = req.params;
    const { force, triggerSource } = triggerSchema.parse(req.body);

    // Guard against auditing unknown contracts
    const contract = await prismaRead.contract.findUnique({
      where: { address },
      select: { address: true },
    });
    if (!contract) {
      return res.status(404).json({ error: 'Contract not found in explorer index.' });
    }

    if (!force) {
      const alreadyNeeded = await needsReaudit(address);
      if (!alreadyNeeded) {
        const latest = await prismaRead.auditCertificate.findFirst({
          where: { contractAddress: address, status: 'published' },
          orderBy: { version: 'desc' },
          select: {
            id: true,
            version: true,
            overallScore: true,
            expiresAt: true,
            certificateHash: true,
          },
        });
        if (latest) {
          return res.status(200).json({
            message: 'Certificate is up-to-date. Pass force=true to re-audit anyway.',
            certificate: {
              id: latest.id,
              version: latest.version,
              overallScore: latest.overallScore,
              expiresAt: latest.expiresAt,
              verifyUrl: `/api/v1/audit/verify/${latest.certificateHash}`,
            },
          });
        }
      }
    }

    // Fire audit asynchronously — respond with 202 immediately
    const nextVersion =
      (await prismaRead.auditCertificate.count({
        where: { contractAddress: address },
      })) + 1;

    res.status(202).json({
      message: 'Audit triggered. Certificate will be available shortly.',
      contractAddress: address,
      expectedVersion: nextVersion,
      statusUrl: `/api/v1/audit/contracts/${address}/certificate`,
      eventsUrl: `/api/v1/audit/contracts/${address}/events`,
    });

    // Background execution
    runAudit(address, triggerSource).catch((e) =>
      logger.error('Manual audit failed', { address, error: String(e) }),
    );
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

// Lazy import logger to avoid circular deps in the route file
import { logger } from '../logger';

// ── GET /contracts/:address/audit/status ─────────────────────────────────────

auditRouter.get('/contracts/:address/audit/status', async (req: Request, res: Response) => {
  try {
    const { address } = req.params;

    const [latest, eventCount, lastEvent] = await Promise.all([
      prismaRead.auditCertificate.findFirst({
        where: { contractAddress: address },
        orderBy: { version: 'desc' },
        select: {
          id: true,
          version: true,
          status: true,
          overallScore: true,
          generatedAt: true,
          expiresAt: true,
          certificateHash: true,
        },
      }),
      prismaRead.auditEvent.count({ where: { contractAddress: address } }),
      prismaRead.auditEvent.findFirst({
        where: { contractAddress: address },
        orderBy: { timestamp: 'desc' },
        select: { eventType: true, timestamp: true, triggerSource: true },
      }),
    ]);

    if (!latest) {
      return res.json({
        contractAddress: address,
        audited: false,
        message: 'No audit has been run for this contract yet.',
        hint: `POST /api/v1/audit/contracts/${address}/audit to start one.`,
      });
    }

    const resolvedStatus = certStatus(latest as { status: string; expiresAt: Date | null });

    res.json({
      contractAddress: address,
      audited: true,
      latestVersion: latest.version,
      status: resolvedStatus,
      overallScore: latest.overallScore,
      grade: scoreGrade(latest.overallScore),
      riskLevel: scoreRisk(latest.overallScore),
      generatedAt: latest.generatedAt,
      expiresAt: latest.expiresAt,
      needsReaudit: await needsReaudit(address),
      certificateHash: latest.certificateHash,
      verifyUrl: `/api/v1/audit/verify/${latest.certificateHash}`,
      auditEventCount: eventCount,
      lastEvent,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /contracts/:address/report.txt ────────────────────────────────────────

auditRouter.get('/contracts/:address/report.txt', async (req: Request, res: Response) => {
  try {
    const { address } = req.params;

    const cert = await prismaRead.auditCertificate.findFirst({
      where: { contractAddress: address, status: 'published' },
      orderBy: { version: 'desc' },
    });

    if (!cert) {
      return res.status(404).send('No published audit certificate found for this contract.');
    }

    const text = generateReportText({
      contractAddress: cert.contractAddress,
      version: cert.version,
      status: cert.status,
      generatedAt: cert.generatedAt,
      expiresAt: cert.expiresAt,
      overallScore: cert.overallScore,
      securityScore: cert.securityScore,
      governanceScore: cert.governanceScore,
      economicScore: cert.economicScore,
      complianceScore: cert.complianceScore,
      liquidityScore: cert.liquidityScore,
      certificateHash: cert.certificateHash,
      anchorTxHash: cert.anchorTxHash,
      totalFindings: cert.totalFindings,
      criticalFindings: cert.criticalFindings,
      highFindings: cert.highFindings,
      mediumFindings: cert.mediumFindings,
      lowFindings: cert.lowFindings,
      openFindings: cert.openFindings,
      resolvedFindings: cert.resolvedFindings,
      scores: cert.scores,
    });

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="audit-${address.slice(0, 12)}-v${cert.version}.txt"`,
    );
    res.send(text);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /certificates/:id/findings ───────────────────────────────────────────

const findingsQuerySchema = z.object({
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).optional(),
  category: z
    .enum(['vulnerability', 'code_quality', 'governance', 'economics', 'compliance', 'liquidity'])
    .optional(),
  status: z.enum(['open', 'resolved', 'wont_fix', 'false_positive']).optional(),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
});

auditRouter.get('/certificates/:id/findings', async (req: Request, res: Response) => {
  try {
    const q = findingsQuerySchema.parse(req.query);
    const skip = (q.page - 1) * q.limit;

    // Verify certificate exists
    const cert = await prismaRead.auditCertificate.findUnique({
      where: { id: req.params.id },
      select: { id: true, contractAddress: true, version: true, overallScore: true },
    });
    if (!cert) return res.status(404).json({ error: 'Certificate not found.' });

    const where: Record<string, unknown> = { certificateId: req.params.id };
    if (q.severity) where.severity = q.severity;
    if (q.category) where.category = q.category;
    if (q.status) where.status = q.status;

    const [findings, total] = await Promise.all([
      prismaRead.auditFinding.findMany({
        where,
        orderBy: [
          { severity: 'asc' }, // critical < high < medium sorts alphabetically — use raw sort below
          { createdAt: 'desc' },
        ],
        skip,
        take: q.limit,
      }),
      prismaRead.auditFinding.count({ where }),
    ]);

    // Sort critical → high → medium → low → info
    const sevOrder = ['critical', 'high', 'medium', 'low', 'info'];
    const sorted = findings.sort(
      (a, b) => sevOrder.indexOf(a.severity) - sevOrder.indexOf(b.severity),
    );

    res.json({
      certificateId: req.params.id,
      contractAddress: cert.contractAddress,
      version: cert.version,
      data: sorted,
      total,
      page: q.page,
      limit: q.limit,
      pages: Math.ceil(total / q.limit),
    });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /findings/:id ─────────────────────────────────────────────────────────

auditRouter.get('/findings/:id', async (req: Request, res: Response) => {
  try {
    const finding = await prismaRead.auditFinding.findUnique({
      where: { id: req.params.id },
      include: {
        certificate: {
          select: { contractAddress: true, version: true, overallScore: true },
        },
      },
    });
    if (!finding) return res.status(404).json({ error: 'Finding not found.' });
    res.json(finding);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── PUT /findings/:id — update status ────────────────────────────────────────

const findingUpdateSchema = z.object({
  status: z.enum(['resolved', 'wont_fix', 'false_positive']),
  resolutionNote: z.string().optional(),
});

auditRouter.put('/findings/:id', async (req: Request, res: Response) => {
  try {
    const data = findingUpdateSchema.parse(req.body);

    const finding = await prismaRead.auditFinding.findUnique({
      where: { id: req.params.id },
      select: { id: true, certificateId: true, status: true },
    });
    if (!finding) return res.status(404).json({ error: 'Finding not found.' });
    if (finding.status !== 'open') {
      return res.status(409).json({
        error: `Finding is already ${finding.status}. Only open findings can be updated.`,
      });
    }

    const updated = await prismaWrite.auditFinding.update({
      where: { id: req.params.id },
      data: {
        status: data.status,
        resolutionNote: data.resolutionNote,
        resolvedAt: data.status === 'resolved' ? new Date() : null,
      },
    });

    // Keep certificate counters consistent
    if (data.status === 'resolved') {
      await prismaWrite.auditCertificate.update({
        where: { id: finding.certificateId },
        data: {
          openFindings: { decrement: 1 },
          resolvedFindings: { increment: 1 },
        },
      });
    } else {
      // wont_fix / false_positive — close the open count
      await prismaWrite.auditCertificate.update({
        where: { id: finding.certificateId },
        data: { openFindings: { decrement: 1 } },
      });
    }

    res.json(updated);
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /contracts/:address/events ────────────────────────────────────────────

auditRouter.get('/contracts/:address/events', async (req: Request, res: Response) => {
  try {
    const { address } = req.params;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const eventType = req.query.eventType as string | undefined;

    const where: Record<string, unknown> = { contractAddress: address };
    if (eventType) where.eventType = eventType;

    const [events, total] = await Promise.all([
      prismaRead.auditEvent.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        take: limit,
      }),
      prismaRead.auditEvent.count({ where }),
    ]);

    res.json({
      contractAddress: address,
      total,
      returned: events.length,
      events,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /verify/* — full verification suite ───────────────────────────────────
auditRouter.use('/verify', auditVerifyRouter);

// ── GET|POST /auditors/* — auditor registry ───────────────────────────────────
auditRouter.use('/auditors', auditAuditorsRouter);

// ── GET|POST /anchor/* — platform-level Merkle anchoring ─────────────────────
auditRouter.use('/anchor', platformAnchorRouter);

// ── POST|GET /bot/* — Slack & Discord bot endpoints ──────────────────────────
auditRouter.use('/bot', auditBotRouter);

// ── GET|POST /incidents/* — PagerDuty/Opsgenie incident management ────────────
auditRouter.use('/incidents', auditIncidentsRouter);

// ── GET /embed/* — JavaScript widget, WordPress plugin, snippets ──────────────
auditRouter.use('/embed', auditEmbedRouter);

// ── GET /benchmarks/:category — category-level competitive benchmarks ─────────

const VALID_CATEGORIES = [
  'token',
  'dex',
  'nft',
  'lending',
  'staking',
  'bridge',
  'governance',
  'other',
] as const;

auditRouter.get('/benchmarks/:category', async (req: Request, res: Response) => {
  try {
    const { category } = req.params;

    if (!VALID_CATEGORIES.includes(category as (typeof VALID_CATEGORIES)[number])) {
      return res.status(400).json({
        error: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}`,
        valid: VALID_CATEGORIES,
      });
    }

    const result = await getCategoryBenchmark(category as (typeof VALID_CATEGORIES)[number]);

    if (!result) {
      return res.status(404).json({
        error: `No audited contracts found in category "${category}".`,
        category,
        hint: 'Run audits on contracts in this category first, or try a different category.',
        validCategories: VALID_CATEGORIES,
      });
    }

    res.json({
      ...result,
      validCategories: VALID_CATEGORIES,
      updatedAt: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /benchmarks — list all available category benchmarks (summary) ────────

auditRouter.get('/benchmarks', async (_req: Request, res: Response) => {
  try {
    const cacheKey = 'audit:benchmarks:summary';
    const cached = await cacheGet(cacheKey);
    if (cached) return res.json(cached);

    // Quick overview — just cert counts per inferred category bucket
    // (full getCategoryBenchmark is expensive; this is a lightweight summary)
    const allCerts = await prismaRead.auditCertificate.findMany({
      where: { status: 'published' },
      distinct: ['contractAddress'],
      select: {
        contractAddress: true,
        overallScore: true,
        criticalFindings: true,
      },
    });

    const totalContracts = allCerts.length;
    const avgOverall =
      totalContracts > 0
        ? +(allCerts.reduce((s, c) => s + c.overallScore, 0) / totalContracts).toFixed(1)
        : 0;
    const withCritical = allCerts.filter((c) => c.criticalFindings > 0).length;

    const result = {
      totalAuditedContracts: totalContracts,
      avgOverallScore: avgOverall,
      contractsWithCriticalFindings: withCritical,
      categories: VALID_CATEGORIES.map((cat) => ({
        category: cat,
        url: `/api/v1/audit/benchmarks/${cat}`,
        description: categoryDescription(cat),
      })),
      hint: 'GET /api/v1/audit/benchmarks/:category for full stats. GET /api/v1/contracts/:address/audit/benchmark for per-contract peer comparison.',
      updatedAt: new Date().toISOString(),
    };

    await cacheSet(cacheKey, result, 300);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

function categoryDescription(cat: string): string {
  const desc: Record<string, string> = {
    token: 'SEP-41 fungible tokens and stablecoins',
    dex: 'Decentralised exchanges and AMM pools',
    nft: 'Non-fungible token and digital collectible contracts',
    lending: 'Lending and borrowing protocols',
    staking: 'Staking and liquid staking contracts',
    bridge: 'Cross-chain bridge and messaging contracts',
    governance: 'DAO governance and voting contracts',
    other: 'General-purpose and utility contracts',
  };
  return desc[cat] ?? cat;
}

// ── GET /leaderboard ──────────────────────────────────────────────────────────

auditRouter.get('/leaderboard', async (req: Request, res: Response) => {
  try {
    const order = req.query.order === 'asc' ? 'asc' : 'desc';
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const cacheKey = `audit:leaderboard:${order}:${limit}`;

    const cached = await cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const certs = await prismaRead.auditCertificate.findMany({
      where: { status: 'published' },
      orderBy: { overallScore: order },
      take: limit,
      select: {
        id: true,
        contractAddress: true,
        version: true,
        overallScore: true,
        securityScore: true,
        governanceScore: true,
        economicScore: true,
        complianceScore: true,
        liquidityScore: true,
        totalFindings: true,
        criticalFindings: true,
        highFindings: true,
        certificateHash: true,
        generatedAt: true,
      },
    });

    const result = {
      order: order === 'desc' ? 'riskiest_first' : 'safest_first',
      count: certs.length,
      contracts: certs.map((c, idx) => ({
        rank: idx + 1,
        contractAddress: c.contractAddress,
        version: c.version,
        overallScore: c.overallScore,
        grade: scoreGrade(c.overallScore),
        riskLevel: scoreRisk(c.overallScore),
        scores: {
          security: c.securityScore,
          governance: c.governanceScore,
          economic: c.economicScore,
          compliance: c.complianceScore,
          liquidity: c.liquidityScore,
        },
        totalFindings: c.totalFindings,
        criticalFindings: c.criticalFindings,
        highFindings: c.highFindings,
        certificateHash: c.certificateHash,
        verifyUrl: `/api/v1/audit/verify/${c.certificateHash}`,
        auditedAt: c.generatedAt,
      })),
    };

    await cacheSet(cacheKey, result, 600);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /stats ────────────────────────────────────────────────────────────────
// Returns the exact shape specified in the API contract.

auditRouter.get('/stats', async (_req: Request, res: Response) => {
  try {
    const cacheKey = 'audit:stats:v2';
    const cached = await cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const sevList = ['critical', 'high', 'medium', 'low', 'info'] as const;

    const [
      totalAudited,
      totalCertificates,
      avgScores,
      findingsOpen,
      findingsResolved,
      certsByScore,
      topCategories,
      verificationCount,
      externalAuditCount,
      since30dEvents,
    ] = await Promise.all([
      // unique contracts with at least one published cert
      prismaRead.auditCertificate
        .groupBy({
          by: ['contractAddress'],
          where: { status: 'published' },
        })
        .then((r) => r.length),

      prismaRead.auditCertificate.count(),

      prismaRead.auditCertificate.aggregate({
        where: { status: 'published' },
        _avg: {
          overallScore: true,
          securityScore: true,
          governanceScore: true,
          economicScore: true,
          complianceScore: true,
          liquidityScore: true,
        },
        _min: { overallScore: true },
        _max: { overallScore: true },
      }),

      // open finding counts per severity
      prismaRead.auditFinding.groupBy({
        by: ['severity'],
        where: { status: 'open' },
        _count: { id: true },
      }),

      // resolved finding counts per severity
      prismaRead.auditFinding.groupBy({
        by: ['severity'],
        where: { status: 'resolved' },
        _count: { id: true },
      }),

      // contracts bucketed by score band (latest cert per contract)
      prismaRead.auditCertificate.findMany({
        where: { status: 'published' },
        orderBy: { generatedAt: 'desc' },
        select: { contractAddress: true, overallScore: true },
        distinct: ['contractAddress'],
      }),

      // open findings grouped by category
      prismaRead.auditFinding.groupBy({
        by: ['category'],
        where: { status: 'open' },
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
        take: 6,
      }),

      prismaRead.auditVerificationRecord.count(),
      prismaRead.externalAudit.count(),

      prismaRead.auditEvent.groupBy({
        by: ['eventType'],
        where: { timestamp: { gte: new Date(Date.now() - 30 * 86400000) } },
        _count: { id: true },
      }),
    ]);

    // ── Build findingsBySeverity array ─────────────────────────────────────
    const openMap: Record<string, number> = {};
    const resolvedMap: Record<string, number> = {};
    for (const f of findingsOpen) openMap[f.severity] = f._count.id;
    for (const f of findingsResolved) resolvedMap[f.severity] = f._count.id;

    const totalOpen = Object.values(openMap).reduce((s, v) => s + v, 0);
    const totalResolved = Object.values(resolvedMap).reduce((s, v) => s + v, 0);
    const resolutionRate =
      totalOpen + totalResolved > 0 ? +(totalResolved / (totalOpen + totalResolved)).toFixed(4) : 0;

    const findingsBySeverity = sevList.map((sev) => ({
      severity: sev,
      open: openMap[sev] ?? 0,
      resolved: resolvedMap[sev] ?? 0,
    }));

    // ── contractsByScore buckets ────────────────────────────────────────────
    const buckets = { excellent: 0, good: 0, fair: 0, poor: 0, critical: 0 };
    for (const c of certsByScore) {
      const s = c.overallScore;
      if (s >= 85) buckets.excellent++;
      else if (s >= 70) buckets.good++;
      else if (s >= 55) buckets.fair++;
      else if (s >= 40) buckets.poor++;
      else buckets.critical++;
    }

    // ── topCategories ────────────────────────────────────────────────────────
    const topCategoriesArr = topCategories.map((c) => ({
      category: c.category,
      openFindings: c._count.id,
    }));

    // ── Event activity map ─────────────────────────────────────────────────
    const eventMap: Record<string, number> = {};
    for (const e of since30dEvents) eventMap[e.eventType] = e._count.id;

    const result = {
      totalAudited,
      totalCertificates,
      avgOverallScore: +(avgScores._avg.overallScore ?? 0).toFixed(1),
      avgSecurityScore: +(avgScores._avg.securityScore ?? 0).toFixed(1),
      avgGovernanceScore: +(avgScores._avg.governanceScore ?? 0).toFixed(1),
      avgEconomicScore: +(avgScores._avg.economicScore ?? 0).toFixed(1),
      avgComplianceScore: +(avgScores._avg.complianceScore ?? 0).toFixed(1),
      avgLiquidityScore: +(avgScores._avg.liquidityScore ?? 0).toFixed(1),
      minOverallScore: avgScores._min.overallScore ?? 0,
      maxOverallScore: avgScores._max.overallScore ?? 0,
      findingsBySeverity,
      resolutionRate,
      contractsByScore: buckets,
      topCategories: topCategoriesArr,
      publicVerifications: verificationCount,
      externalAudits: externalAuditCount,
      activityLast30d: eventMap,
      platform: {
        name: 'Soroban Smart Block Explorer — Continuous Audit Platform v2',
        signingAlgorithm: 'HMAC-SHA256',
        publicKeyId: 'soroban-explorer-audit-platform-v1',
        certificateValidity: '90 days',
        scoreWeights: {
          security: '30%',
          governance: '25%',
          economic: '20%',
          compliance: '15%',
          liquidity: '10%',
        },
      },
    };

    await cacheSet(cacheKey, result, 120); // 2-min cache — stats are cheap
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /stats/by-contract — contract rankings ────────────────────────────────

const byContractSchema = z.object({
  sort: z.enum(['score_asc', 'score_desc', 'findings', 'recent']).default('score_desc'),
  limit: z.coerce.number().min(1).max(200).default(50),
  page: z.coerce.number().min(1).default(1),
  minScore: z.coerce.number().min(0).max(100).optional(),
  maxScore: z.coerce.number().min(0).max(100).optional(),
});

auditRouter.get('/stats/by-contract', async (req: Request, res: Response) => {
  try {
    const q = byContractSchema.parse(req.query);
    const cacheKey = `audit:stats:by-contract:${JSON.stringify(q)}`;

    const cached = await cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const skip = (q.page - 1) * q.limit;

    const scoreWhere: Record<string, unknown> = {};
    if (q.minScore !== undefined) scoreWhere.gte = q.minScore;
    if (q.maxScore !== undefined) scoreWhere.lte = q.maxScore;

    const where: Record<string, unknown> = { status: 'published' };
    if (Object.keys(scoreWhere).length > 0) where.overallScore = scoreWhere;

    // One row per contract (latest published cert per address)
    const orderBy =
      q.sort === 'score_asc'
        ? { overallScore: 'asc' as const }
        : q.sort === 'score_desc'
          ? { overallScore: 'desc' as const }
          : q.sort === 'findings'
            ? { criticalFindings: 'desc' as const }
            : { generatedAt: 'desc' as const };

    const [certs, total] = await Promise.all([
      prismaRead.auditCertificate.findMany({
        where,
        orderBy,
        skip,
        take: q.limit,
        distinct: ['contractAddress'],
        select: {
          id: true,
          contractAddress: true,
          version: true,
          status: true,
          overallScore: true,
          securityScore: true,
          governanceScore: true,
          economicScore: true,
          complianceScore: true,
          liquidityScore: true,
          totalFindings: true,
          criticalFindings: true,
          highFindings: true,
          mediumFindings: true,
          lowFindings: true,
          openFindings: true,
          certificateHash: true,
          anchorTxHash: true,
          generatedAt: true,
        },
      }),
      prismaRead.auditCertificate
        .groupBy({
          by: ['contractAddress'],
          where,
        })
        .then((r) => r.length),
    ]);

    const data = certs.map((c, idx) => ({
      rank: skip + idx + 1,
      contractAddress: c.contractAddress,
      version: c.version,
      overallScore: c.overallScore,
      grade: scoreGrade(c.overallScore),
      riskLevel: scoreRisk(c.overallScore),
      scores: {
        security: c.securityScore,
        governance: c.governanceScore,
        economic: c.economicScore,
        compliance: c.complianceScore,
        liquidity: c.liquidityScore,
      },
      findings: {
        total: c.totalFindings,
        critical: c.criticalFindings,
        high: c.highFindings,
        medium: c.mediumFindings,
        low: c.lowFindings,
        open: c.openFindings,
      },
      anchored: !!c.anchorTxHash,
      certificateHash: c.certificateHash,
      auditedAt: c.generatedAt,
      verifyUrl: `/api/v1/audit/verify/${c.id}`,
    }));

    const result = {
      sort: q.sort,
      page: q.page,
      limit: q.limit,
      total,
      pages: Math.ceil(total / q.limit),
      contracts: data,
    };

    await cacheSet(cacheKey, result, 120);
    res.json(result);
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /stats/trends?days=90 — score and finding trends over time ─────────────

const trendsSchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(90),
  contractAddress: z.string().optional(),
  grain: z.enum(['day', 'week']).default('day'),
});

auditRouter.get('/stats/trends', async (req: Request, res: Response) => {
  try {
    const q = trendsSchema.parse(req.query);
    const cacheKey = `audit:stats:trends:${q.days}:${q.grain}:${q.contractAddress ?? 'all'}`;

    const cached = await cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const since = new Date(Date.now() - q.days * 86400000);

    const where: Record<string, unknown> = {
      status: 'published',
      generatedAt: { gte: since },
    };
    if (q.contractAddress) where.contractAddress = q.contractAddress;

    // Fetch all certs in window — aggregate in-memory for grain bucketing
    const certs = await prismaRead.auditCertificate.findMany({
      where,
      orderBy: { generatedAt: 'asc' },
      select: {
        generatedAt: true,
        overallScore: true,
        securityScore: true,
        governanceScore: true,
        economicScore: true,
        complianceScore: true,
        liquidityScore: true,
        totalFindings: true,
        criticalFindings: true,
        highFindings: true,
        openFindings: true,
      },
    });

    // Bucket by day or week
    const bucketKey = (date: Date): string => {
      if (q.grain === 'week') {
        const d = new Date(date);
        const day = d.getUTCDay();
        d.setUTCDate(d.getUTCDate() - day);
        return d.toISOString().slice(0, 10);
      }
      return date.toISOString().slice(0, 10);
    };

    type Bucket = {
      date: string;
      count: number;
      sumOverall: number;
      sumSec: number;
      sumGov: number;
      sumEco: number;
      sumCom: number;
      sumLiq: number;
      sumFindings: number;
      sumCritical: number;
      sumOpen: number;
    };

    const bucketsMap = new Map<string, Bucket>();

    for (const c of certs) {
      const key = bucketKey(c.generatedAt);
      const b = bucketsMap.get(key) ?? {
        date: key,
        count: 0,
        sumOverall: 0,
        sumSec: 0,
        sumGov: 0,
        sumEco: 0,
        sumCom: 0,
        sumLiq: 0,
        sumFindings: 0,
        sumCritical: 0,
        sumOpen: 0,
      };
      b.count++;
      b.sumOverall += c.overallScore;
      b.sumSec += c.securityScore;
      b.sumGov += c.governanceScore;
      b.sumEco += c.economicScore;
      b.sumCom += c.complianceScore;
      b.sumLiq += c.liquidityScore;
      b.sumFindings += c.totalFindings;
      b.sumCritical += c.criticalFindings;
      b.sumOpen += c.openFindings;
      bucketsMap.set(key, b);
    }

    const trendLine = Array.from(bucketsMap.values())
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((b) => ({
        date: b.date,
        auditCount: b.count,
        avgOverallScore: +(b.sumOverall / b.count).toFixed(1),
        avgSecurityScore: +(b.sumSec / b.count).toFixed(1),
        avgGovernanceScore: +(b.sumGov / b.count).toFixed(1),
        avgEconomicScore: +(b.sumEco / b.count).toFixed(1),
        avgComplianceScore: +(b.sumCom / b.count).toFixed(1),
        avgLiquidityScore: +(b.sumLiq / b.count).toFixed(1),
        avgTotalFindings: +(b.sumFindings / b.count).toFixed(1),
        avgCriticalFindings: +(b.sumCritical / b.count).toFixed(1),
        avgOpenFindings: +(b.sumOpen / b.count).toFixed(1),
      }));

    // Overall direction across the window
    const first = trendLine[0];
    const last = trendLine[trendLine.length - 1];
    const delta = first && last ? last.avgOverallScore - first.avgOverallScore : 0;

    // Monthly audit volume (certs per 30-day bucket)
    const monthlyVolume: Record<string, number> = {};
    for (const c of certs) {
      const month = c.generatedAt.toISOString().slice(0, 7); // YYYY-MM
      monthlyVolume[month] = (monthlyVolume[month] ?? 0) + 1;
    }

    // Finding resolution trend: open vs resolved ratio over time
    const findingEvents = await prismaRead.auditEvent.findMany({
      where: {
        eventType: 'vulnerability_discovered',
        timestamp: { gte: since },
        ...(q.contractAddress ? { contractAddress: q.contractAddress } : {}),
      },
      orderBy: { timestamp: 'asc' },
      select: { timestamp: true },
    });

    const discoveryByBucket: Record<string, number> = {};
    for (const e of findingEvents) {
      const key = bucketKey(e.timestamp);
      discoveryByBucket[key] = (discoveryByBucket[key] ?? 0) + 1;
    }

    const result = {
      days: q.days,
      grain: q.grain,
      contractAddress: q.contractAddress ?? null,
      totalDataPoints: trendLine.length,
      direction: delta > 1 ? 'improving' : delta < -1 ? 'degrading' : 'stable',
      scoreDeltaAcrossPeriod: +delta.toFixed(1),
      trendLine,
      monthlyVolume: Object.entries(monthlyVolume)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, count]) => ({ month, auditCount: count })),
      findingDiscoveryRate: Object.entries(discoveryByBucket)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, count]) => ({ date, newFindings: count })),
    };

    await cacheSet(cacheKey, result, 300);
    res.json(result);
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /recent — recently generated/updated audit certificates ───────────────

const recentSchema = z.object({
  limit: z.coerce.number().min(1).max(100).default(20),
  status: z.enum(['published', 'all']).default('published'),
  since: z.string().optional(),
});

auditRouter.get('/recent', async (req: Request, res: Response) => {
  try {
    const q = recentSchema.parse(req.query);
    const cacheKey = `audit:recent:${q.limit}:${q.status}:${q.since ?? ''}`;

    const cached = await cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const where: Record<string, unknown> = {};
    if (q.status !== 'all') where.status = q.status;
    if (q.since) where.generatedAt = { gte: new Date(q.since) };

    const certs = await prismaRead.auditCertificate.findMany({
      where,
      orderBy: { generatedAt: 'desc' },
      take: q.limit,
      select: {
        id: true,
        contractAddress: true,
        version: true,
        status: true,
        overallScore: true,
        securityScore: true,
        governanceScore: true,
        economicScore: true,
        complianceScore: true,
        liquidityScore: true,
        totalFindings: true,
        criticalFindings: true,
        highFindings: true,
        openFindings: true,
        resolvedFindings: true,
        certificateHash: true,
        anchorTxHash: true,
        generatedAt: true,
        expiresAt: true,
        metadata: true,
      },
    });

    const result = {
      count: certs.length,
      generatedAt: new Date().toISOString(),
      certificates: certs.map((c) => {
        const meta = c.metadata as Record<string, unknown> | null;
        return {
          certificateId: c.id,
          contractAddress: c.contractAddress,
          version: c.version,
          status: c.status,
          overallScore: c.overallScore,
          grade: scoreGrade(c.overallScore),
          riskLevel: scoreRisk(c.overallScore),
          scores: {
            security: c.securityScore,
            governance: c.governanceScore,
            economic: c.economicScore,
            compliance: c.complianceScore,
            liquidity: c.liquidityScore,
          },
          findings: {
            total: c.totalFindings,
            critical: c.criticalFindings,
            high: c.highFindings,
            open: c.openFindings,
            resolved: c.resolvedFindings,
          },
          anchored: !!c.anchorTxHash,
          anchorTxHash: c.anchorTxHash,
          certificateHash: c.certificateHash,
          generatedAt: c.generatedAt,
          expiresAt: c.expiresAt,
          triggeredBy: meta?.triggeredBy ?? null,
          verifyUrl: `/api/v1/audit/verify/${c.id}`,
        };
      }),
    };

    // Short TTL — "recent" should feel live
    await cacheSet(cacheKey, result, 30);
    res.json(result);
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SUBSCRIPTION & NOTIFICATION MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════
// Routes:
//   POST   /subscriptions          — create subscription (email/webhook/Slack)
//   GET    /subscriptions          — list all (filter by userId, contractAddress)
//   GET    /subscriptions/:id      — single subscription detail + recent deliveries
//   PUT    /subscriptions/:id      — update channels / alert types / threshold
//   DELETE /subscriptions/:id      — soft-delete (isActive=false)
//   POST   /subscriptions/:id/test — send a test notification to all channels
//   GET    /subscriptions/:id/deliveries — delivery history

const ALERT_TYPES = [
  'score_drop',
  'new_finding',
  'upgrade',
  'certificate_update',
  'certificate_expiry',
] as const;

const subscriptionSchema = z
  .object({
    contractAddress: z.string().min(1),
    alertTypes: z.array(z.enum(ALERT_TYPES)).min(1),
    threshold: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(10)
      .describe('Minimum score-drop (pts) to fire score_drop alert'),
    userId: z.string().optional(),
    cooldownMinutes: z.coerce.number().int().min(1).max(1440).default(60),
    // Delivery channels — at least one required
    emailAddress: z.string().email().optional(),
    webhookUrl: z.string().url().optional(),
    webhookSecret: z.string().min(8).optional(),
    slackWebhookUrl: z.string().url().optional(),
    slackChannel: z.string().optional(),
  })
  .refine(
    (d) => !!(d.emailAddress || d.webhookUrl || d.slackWebhookUrl || d.userId),
    'At least one delivery channel (emailAddress, webhookUrl, slackWebhookUrl) or userId must be provided.',
  );

function formatSub(sub: Record<string, unknown>) {
  const channels: string[] = [];
  if (sub.emailAddress) channels.push('email');
  if (sub.webhookUrl) channels.push('webhook');
  if (sub.slackWebhookUrl) channels.push('slack');
  return {
    id: sub.id,
    contractAddress: sub.contractAddress,
    userId: sub.userId,
    alertTypes: sub.alertTypes,
    threshold: sub.threshold,
    cooldownMinutes: sub.cooldownMinutes,
    channels,
    // Mask secrets in responses
    emailAddress: sub.emailAddress ?? null,
    webhookUrl: sub.webhookUrl ?? null,
    webhookSecret: sub.webhookSecret ? '***' : null,
    slackWebhookUrl: sub.slackWebhookUrl
      ? (sub.slackWebhookUrl as string).replace(/\/T[^/]+\/B[^/]+\/([^/]+)$/, '/***')
      : null,
    slackChannel: sub.slackChannel ?? null,
    isActive: sub.isActive,
    lastTriggeredAt: sub.lastTriggeredAt,
    createdAt: sub.createdAt,
    updatedAt: sub.updatedAt,
    wsEndpoint: `/ws/audit?contract=${sub.contractAddress}&minDrop=${sub.threshold ?? 10}`,
  };
}

// ── POST /subscriptions ───────────────────────────────────────────────────────

auditRouter.post('/subscriptions', async (req: Request, res: Response) => {
  try {
    const data = subscriptionSchema.parse(req.body);

    // Verify contract exists in the index
    const contract = await prismaRead.contract.findUnique({
      where: { address: data.contractAddress },
      select: { address: true },
    });
    if (!contract) {
      return res.status(404).json({ error: 'Contract not found in explorer index.' });
    }

    const sub = await prismaWrite.auditSubscription.create({
      data: {
        contractAddress: data.contractAddress,
        alertTypes: data.alertTypes,
        threshold: data.threshold,
        userId: data.userId,
        cooldownMinutes: data.cooldownMinutes,
        emailAddress: data.emailAddress,
        webhookUrl: data.webhookUrl,
        webhookSecret: data.webhookSecret,
        slackWebhookUrl: data.slackWebhookUrl,
        slackChannel: data.slackChannel,
        isActive: true,
      },
    });

    res.status(201).json({
      ...formatSub(sub as unknown as Record<string, unknown>),
      message: 'Subscription created. Notifications will be delivered to configured channels.',
    });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /subscriptions ────────────────────────────────────────────────────────

const subListSchema = z.object({
  userId: z.string().optional(),
  contractAddress: z.string().optional(),
  active: z.enum(['true', 'false', 'all']).default('true'),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
});

auditRouter.get('/subscriptions', async (req: Request, res: Response) => {
  try {
    const q = subListSchema.parse(req.query);
    const skip = (q.page - 1) * q.limit;

    const where: Record<string, unknown> = {};
    if (q.userId) where.userId = q.userId;
    if (q.contractAddress) where.contractAddress = q.contractAddress;
    if (q.active === 'true') where.isActive = true;
    if (q.active === 'false') where.isActive = false;

    const [subs, total] = await Promise.all([
      prismaRead.auditSubscription.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: q.limit,
      }),
      prismaRead.auditSubscription.count({ where }),
    ]);

    res.json({
      total,
      page: q.page,
      limit: q.limit,
      pages: Math.ceil(total / q.limit),
      subscriptions: subs.map((s) => formatSub(s as unknown as Record<string, unknown>)),
    });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /subscriptions/:id ────────────────────────────────────────────────────

auditRouter.get('/subscriptions/:id', async (req: Request, res: Response) => {
  try {
    const sub = await prismaRead.auditSubscription.findUnique({
      where: { id: req.params.id },
    });
    if (!sub) return res.status(404).json({ error: 'Subscription not found.' });

    // Recent deliveries
    const deliveries = await prismaRead.auditNotificationDelivery.findMany({
      where: { subscriptionId: sub.id },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        alertType: true,
        channel: true,
        status: true,
        httpStatus: true,
        deliveredAt: true,
        errorMsg: true,
        createdAt: true,
      },
    });

    res.json({
      ...formatSub(sub as unknown as Record<string, unknown>),
      recentDeliveries: deliveries,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── PUT /subscriptions/:id — update ──────────────────────────────────────────

const subUpdateSchema = z.object({
  alertTypes: z.array(z.enum(ALERT_TYPES)).min(1).optional(),
  threshold: z.coerce.number().int().min(1).max(100).optional(),
  cooldownMinutes: z.coerce.number().int().min(1).max(1440).optional(),
  emailAddress: z.string().email().nullable().optional(),
  webhookUrl: z.string().url().nullable().optional(),
  webhookSecret: z.string().min(8).nullable().optional(),
  slackWebhookUrl: z.string().url().nullable().optional(),
  slackChannel: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
});

auditRouter.put('/subscriptions/:id', async (req: Request, res: Response) => {
  try {
    const existing = await prismaRead.auditSubscription.findUnique({
      where: { id: req.params.id },
      select: { id: true },
    });
    if (!existing) return res.status(404).json({ error: 'Subscription not found.' });

    const data = subUpdateSchema.parse(req.body);
    const updated = await prismaWrite.auditSubscription.update({
      where: { id: req.params.id },
      data: { ...data },
    });

    res.json(formatSub(updated as unknown as Record<string, unknown>));
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

// ── DELETE /subscriptions/:id ─────────────────────────────────────────────────

auditRouter.delete('/subscriptions/:id', async (req: Request, res: Response) => {
  try {
    const sub = await prismaRead.auditSubscription.findUnique({
      where: { id: req.params.id },
      select: { id: true },
    });
    if (!sub) return res.status(404).json({ error: 'Subscription not found.' });

    await prismaWrite.auditSubscription.update({
      where: { id: req.params.id },
      data: { isActive: false },
    });
    res.json({ success: true, id: req.params.id, message: 'Subscription deactivated.' });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── POST /subscriptions/:id/test — send test notification ────────────────────

auditRouter.post('/subscriptions/:id/test', async (req: Request, res: Response) => {
  try {
    const sub = await prismaRead.auditSubscription.findUnique({
      where: { id: req.params.id },
    });
    if (!sub) return res.status(404).json({ error: 'Subscription not found.' });
    if (!sub.isActive) return res.status(409).json({ error: 'Subscription is not active.' });

    const { dispatchNotification } = await import('../lib/audit-notifier');

    // Use the first alertType in the subscription as the test type
    const alertType = (sub.alertTypes[0] ?? 'certificate_update') as
      | 'score_drop'
      | 'new_finding'
      | 'upgrade'
      | 'certificate_update';

    await dispatchNotification({
      alertType,
      contractAddress: sub.contractAddress,
      overallScore: 75,
      previousScore: 85,
      scoreDrop: 10,
      grade: 'B',
      riskLevel: 'medium',
      findingSeverity: 'high',
      findingTitle: 'Test finding — please ignore',
      certHash: 'test-cert-hash-000',
      verifyUrl: `/api/v1/audit/verify/test-cert-hash-000`,
      timestamp: new Date().toISOString(),
      platform: 'Soroban Audit Platform (TEST)',
    });

    res.json({
      success: true,
      message: 'Test notification dispatched to all configured channels.',
      channels: [
        sub.emailAddress ? 'email' : null,
        sub.webhookUrl ? 'webhook' : null,
        sub.slackWebhookUrl ? 'slack' : null,
      ].filter(Boolean),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /subscriptions/:id/deliveries — delivery history ─────────────────────

const deliveriesSchema = z.object({
  status: z.enum(['success', 'failed', 'pending', 'all']).default('all'),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
});

auditRouter.get('/subscriptions/:id/deliveries', async (req: Request, res: Response) => {
  try {
    const sub = await prismaRead.auditSubscription.findUnique({
      where: { id: req.params.id },
      select: { id: true },
    });
    if (!sub) return res.status(404).json({ error: 'Subscription not found.' });

    const q = deliveriesSchema.parse(req.query);
    const skip = (q.page - 1) * q.limit;
    const where: Record<string, unknown> = { subscriptionId: req.params.id };
    if (q.status !== 'all') where.status = q.status;

    const [deliveries, total] = await Promise.all([
      prismaRead.auditNotificationDelivery.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: q.limit,
      }),
      prismaRead.auditNotificationDelivery.count({ where }),
    ]);

    const stats = await prismaRead.auditNotificationDelivery.groupBy({
      by: ['status'],
      where: { subscriptionId: req.params.id },
      _count: { id: true },
    });
    const statMap: Record<string, number> = {};
    for (const s of stats) statMap[s.status] = s._count.id;

    res.json({
      subscriptionId: req.params.id,
      stats: {
        total: statMap['success'] ?? 0 + (statMap['failed'] ?? 0) + (statMap['pending'] ?? 0),
        success: statMap['success'] ?? 0,
        failed: statMap['failed'] ?? 0,
        pending: statMap['pending'] ?? 0,
      },
      total,
      page: q.page,
      limit: q.limit,
      pages: Math.ceil(total / q.limit),
      deliveries,
    });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /certificates/:id — fetch full certificate by id ──────────────────────

auditRouter.get('/certificates/:id', async (req: Request, res: Response) => {
  try {
    const cert = await prismaRead.auditCertificate.findUnique({
      where: { id: req.params.id },
    });
    if (!cert) return res.status(404).json({ error: 'Certificate not found.' });
    res.json(formatCert(cert as unknown as Record<string, unknown>));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── POST /contracts/:address/audit/refresh — manual trigger ──────────────────
// Canonical manual re-audit endpoint per spec.
// Alias: also handles POST /contracts/:address/audit (already defined above)
// so this adds the /refresh variant explicitly.

const refreshSchema = z.object({
  mode: z.enum(['full', 'incremental']).default('full'),
  anchor: z.boolean().default(false),
  reason: z.string().max(500).optional(),
});

auditRouter.post('/contracts/:address/audit/refresh', async (req: Request, res: Response) => {
  try {
    const { address } = req.params;
    const { mode, anchor, reason } = refreshSchema.parse(req.body);

    const contract = await prismaRead.contract.findUnique({
      where: { address },
      select: { address: true },
    });
    if (!contract) {
      return res.status(404).json({ error: 'Contract not found in explorer index.' });
    }

    // Return 202 immediately, run pipeline in background
    const nextVersion =
      (await prismaRead.auditCertificate.count({
        where: { contractAddress: address },
      })) + 1;

    res.status(202).json({
      message: 'Manual audit refresh queued.',
      contractAddress: address,
      mode,
      anchor,
      reason: reason ?? null,
      expectedVersion: nextVersion,
      statusUrl: `/api/v1/audit/contracts/${address}/audit/status`,
      resultsUrl: `/api/v1/audit/contracts/${address}/certificate`,
      eventsUrl: `/api/v1/audit/contracts/${address}/events`,
    });

    // Background pipeline execution
    import('../indexer/audit-pipeline')
      .then(({ runAuditPipeline }) =>
        runAuditPipeline({
          contractAddress: address,
          trigger: 'manual',
          mode,
          anchor,
          calledBy: (req.headers['x-api-key'] as string) ?? req.ip ?? 'anonymous',
        }).catch((e) => logger.error('Manual refresh failed', { address, error: String(e) })),
      )
      .catch((e) => logger.error('Pipeline import failed', { error: String(e) }));
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /pipeline/status — operational health of the audit pipeline ───────────

auditRouter.get('/pipeline/status', async (_req: Request, res: Response) => {
  try {
    const since24h = new Date(Date.now() - 86400000);
    const since1h = new Date(Date.now() - 3600000);

    const [totalCerts, certs24h, events1h, openCritical, pendingInitial, schedulerStatus] =
      await Promise.all([
        prismaRead.auditCertificate.count({ where: { status: 'published' } }),
        prismaRead.auditCertificate.count({ where: { createdAt: { gte: since24h } } }),
        prismaRead.auditEvent.count({ where: { timestamp: { gte: since1h } } }),
        prismaRead.auditFinding.count({
          where: { severity: 'critical', status: 'open' },
        }),
        // Contracts discovered but not yet audited
        prismaRead.contract.count({
          where: { auditCerts: { none: {} } },
        }),
        prismaRead.auditEvent.groupBy({
          by: ['triggerSource'],
          where: { timestamp: { gte: since24h } },
          _count: { id: true },
        }),
      ]);

    const schedulerMap: Record<string, number> = {};
    for (const s of schedulerStatus) schedulerMap[s.triggerSource] = s._count.id;

    res.json({
      status: 'operational',
      pipeline: {
        activeCertificates: totalCerts,
        auditsLast24h: certs24h,
        eventsLastHour: events1h,
        openCriticalFindings: openCritical,
        contractsPendingInitialAudit: pendingInitial,
      },
      scheduler: {
        auditsBySource24h: schedulerMap,
        dailyCadence: 'active contracts (TVL > $100K) — every 24h, incremental mode',
        weeklyCadence: 'all other contracts — every 7d, full mode',
      },
      triggers: {
        initial: 'within 5 minutes of first contract detection',
        upgrade: 'immediate on WasmUpgradeHistory record creation',
        dependency: 'immediate when critical ThreatAdvisory added',
        daily: 'TVL > $100K contracts, incremental re-score',
        weekly: 'all other contracts, full recompute',
        manual: 'POST /api/v1/audit/contracts/:address/audit/refresh',
      },
      modes: {
        full: 'all 5 dimensions recomputed from scratch',
        incremental: 'only dimensions with new data since last cert recomputed',
      },
      anchoring: {
        enabled: process.env.AUDIT_ANCHOR_ENABLED === 'true',
        description: 'SHA-256 of certificate payload embedded in Stellar transaction memo',
      },
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});
