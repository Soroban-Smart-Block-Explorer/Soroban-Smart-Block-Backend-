/**
 * Contract Audit Sub-Router
 * Mounted at /api/v1/contracts/:address/audit
 *
 * GET  /                           latest published certificate + full findings
 * GET  /history                    all versions (paginated, summary)
 * GET  /:version                   specific version by number
 * GET  /delta?fromVersion=N&toVersion=M   score + finding delta between two versions
 * GET  /pdf                        downloadable professional PDF report
 * GET  /score-history?days=90      score trend, radar data, category breakdown
 * GET  /alerts                     list alert subscriptions
 * POST /alerts                     create alert subscription
 * DELETE /alerts/:id               cancel subscription
 * POST /refresh                    trigger manual re-audit
 * GET  /badge.svg                  embeddable SVG audit badge
 *
 * On-chain anchoring (sub-router at /:version/anchor):
 * GET  /:version/anchor            anchor status + on-chain verification
 * POST /:version/anchor            anchor certificate on Stellar
 * GET  /:version/anchor/proof      Merkle proof for this certificate
 * GET  /:version/anchor/estimate   gas/fee estimate before anchoring
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prismaRead, prismaWrite } from '../db';
import { cacheGet, cacheSet } from '../cache';
import { logger } from '../logger';
import { validateAddressParam } from '../middleware/sanitize';
import { generateBadgeSvg, type BadgeStyle } from './audit-badge';
import { generateAuditPdf } from '../lib/audit-pdf-report';
import { loadAuditReportData } from '../lib/audit-pdf-loader';
import { contractAnchorRouter } from './audit-anchor';
import { runFormalVerification } from '../lib/formal-verifier';
import { benchmarkContract } from '../lib/audit-benchmark';
import { generateRemediation } from '../lib/audit-remediation';

export const contractAuditRouter = Router({ mergeParams: true });

// Mount anchor sub-router: handles /:version/anchor, /:version/anchor/proof, etc.
// Must be registered before any /:version wildcard GET to avoid shadowing.
contractAuditRouter.use('/:version/anchor', contractAnchorRouter);

// ── Shared helpers ─────────────────────────────────────────────────────────────

const SEV_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

function sortFindings<T extends { severity: string }>(findings: T[]): T[] {
  return [...findings].sort((a, b) => (SEV_ORDER[a.severity] ?? 5) - (SEV_ORDER[b.severity] ?? 5));
}

function scoreGrade(s: number): string {
  return s >= 85 ? 'A' : s >= 70 ? 'B' : s >= 55 ? 'C' : s >= 40 ? 'D' : 'F';
}

function riskLabel(s: number): string {
  return s >= 85 ? 'low' : s >= 70 ? 'medium' : s >= 55 ? 'high' : 'critical';
}

function resolveStatus(cert: { status: string; expiresAt: Date | null }): string {
  if (cert.status === 'revoked' || cert.status === 'superseded') return cert.status;
  if (cert.expiresAt && cert.expiresAt < new Date()) return 'expired';
  return cert.status;
}

/**
 * Shape a certificate + its live findings into the canonical API response
 * matching the spec exactly.
 */
function formatFull(cert: Record<string, unknown>, findings: Array<Record<string, unknown>>) {
  const score = cert.overallScore as number;
  return {
    certificateId: cert.id,
    contractAddress: cert.contractAddress,
    version: cert.version,
    status: resolveStatus(cert as { status: string; expiresAt: Date | null }),
    grade: scoreGrade(score),
    riskLevel: riskLabel(score),
    generatedAt: cert.generatedAt,
    expiresAt: cert.expiresAt,
    overallScore: score,
    scores: {
      security: cert.securityScore,
      governance: cert.governanceScore,
      economic: cert.economicScore,
      compliance: cert.complianceScore,
      liquidity: cert.liquidityScore,
    },
    findingSummary: {
      total: cert.totalFindings,
      open: cert.openFindings,
      critical: cert.criticalFindings,
      high: cert.highFindings,
      medium: cert.mediumFindings,
      low: cert.lowFindings,
      resolved: cert.resolvedFindings,
    },
    findings: sortFindings(findings).map((f) => ({
      id: f.id,
      category: f.category,
      severity: f.severity,
      title: f.title,
      detail: f.detail ?? f.description,
      description: f.description,
      recommendation: f.recommendation,
      status: f.status,
      cweId: f.cweId,
      cvssScore: f.cvssScore,
      txHash: f.txHash,
      resolvedAt: f.resolvedAt,
      createdAt: f.createdAt,
    })),
    signature: cert.signature,
    publicKey: cert.publicKey,
    signatureAlgorithm: cert.signatureAlgorithm,
    anchorTxHash: cert.anchorTxHash,
    verificationUrl: `/api/v1/audit/verify/${cert.certificateHash}`,
    certificateHash: cert.certificateHash,
    metadata: cert.metadata,
    createdAt: cert.createdAt,
  };
}

/** Lightweight row used in history / delta endpoints. */
function formatSummary(cert: Record<string, unknown>) {
  const score = cert.overallScore as number;
  return {
    certificateId: cert.id,
    version: cert.version,
    status: resolveStatus(cert as { status: string; expiresAt: Date | null }),
    grade: scoreGrade(score),
    riskLevel: riskLabel(score),
    generatedAt: cert.generatedAt,
    expiresAt: cert.expiresAt,
    overallScore: score,
    scores: {
      security: cert.securityScore,
      governance: cert.governanceScore,
      economic: cert.economicScore,
      compliance: cert.complianceScore,
      liquidity: cert.liquidityScore,
    },
    findingSummary: {
      total: cert.totalFindings,
      critical: cert.criticalFindings,
      high: cert.highFindings,
      medium: cert.mediumFindings,
      low: cert.lowFindings,
      open: cert.openFindings,
      resolved: cert.resolvedFindings,
    },
    verificationUrl: `/api/v1/audit/verify/${cert.certificateHash}`,
    certificateHash: cert.certificateHash,
  };
}

// ── GET /:address/audit — latest published certificate + full findings ─────────

contractAuditRouter.get(
  '/',
  validateAddressParam('address'),
  async (req: Request, res: Response) => {
    try {
      const { address } = req.params;
      const cacheKey = `contract-audit:latest:${address}`;

      const cached = await cacheGet(cacheKey);
      if (cached) return res.json(cached);

      // Fetch the latest published certificate
      const cert = await prismaRead.auditCertificate.findFirst({
        where: { contractAddress: address, status: 'published' },
        orderBy: { version: 'desc' },
      });

      if (!cert) {
        // Check for any in-progress or non-published state
        const any = await prismaRead.auditCertificate.findFirst({
          where: { contractAddress: address },
          orderBy: { version: 'desc' },
          select: { status: true, version: true, createdAt: true },
        });

        return res.status(404).json({
          contractAddress: address,
          audited: false,
          latestStatus: any?.status ?? null,
          latestVersion: any?.version ?? null,
          lastAttempt: any?.createdAt ?? null,
          message: 'No published audit certificate found for this contract.',
          hint: `POST /api/v1/contracts/${address}/audit/refresh to trigger one.`,
        });
      }

      // Fetch live findings (may differ from the snapshot if any were resolved)
      const findings = await prismaRead.auditFinding.findMany({
        where: { certificateId: cert.id },
        orderBy: { createdAt: 'asc' },
      });

      const result = formatFull(
        cert as unknown as Record<string, unknown>,
        findings as unknown as Array<Record<string, unknown>>,
      );

      await cacheSet(cacheKey, result, 120); // 2-minute cache
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  },
);

// ── GET /:address/audit/history — all versions ────────────────────────────────

const historyQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(50).default(10),
  includeRevoked: z.enum(['true', 'false']).default('false'),
});

contractAuditRouter.get(
  '/history',
  validateAddressParam('address'),
  async (req: Request, res: Response) => {
    try {
      const { address } = req.params;
      const q = historyQuerySchema.parse(req.query);
      const skip = (q.page - 1) * q.limit;

      const statusFilter = q.includeRevoked === 'true' ? undefined : { not: 'revoked' };

      const [certs, total] = await Promise.all([
        prismaRead.auditCertificate.findMany({
          where: {
            contractAddress: address,
            ...(statusFilter ? { status: statusFilter } : {}),
          },
          orderBy: { version: 'desc' },
          skip,
          take: q.limit,
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
            mediumFindings: true,
            lowFindings: true,
            openFindings: true,
            resolvedFindings: true,
            certificateHash: true,
            anchorTxHash: true,
          },
        }),
        prismaRead.auditCertificate.count({
          where: {
            contractAddress: address,
            ...(statusFilter ? { status: statusFilter } : {}),
          },
        }),
      ]);

      res.json({
        contractAddress: address,
        total,
        page: q.page,
        limit: q.limit,
        pages: Math.ceil(total / q.limit),
        history: certs.map((c) => formatSummary(c as unknown as Record<string, unknown>)),
      });
    } catch (e) {
      if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
      res.status(500).json({ error: String(e) });
    }
  },
);

// ── GET /:address/audit/delta?fromVersion=N&toVersion=M ──────────────────────

const deltaQuerySchema = z.object({
  fromVersion: z.coerce.number().int().min(1),
  toVersion: z.coerce.number().int().min(1),
});

contractAuditRouter.get(
  '/delta',
  validateAddressParam('address'),
  async (req: Request, res: Response) => {
    try {
      const { address } = req.params;
      const { fromVersion, toVersion } = deltaQuerySchema.parse(req.query);

      if (fromVersion >= toVersion) {
        return res.status(400).json({
          error: 'fromVersion must be less than toVersion.',
        });
      }

      const [fromCert, toCert] = await Promise.all([
        prismaRead.auditCertificate.findFirst({
          where: { contractAddress: address, version: fromVersion },
        }),
        prismaRead.auditCertificate.findFirst({
          where: { contractAddress: address, version: toVersion },
        }),
      ]);

      if (!fromCert) {
        return res.status(404).json({
          error: `Version ${fromVersion} not found for contract ${address}.`,
        });
      }
      if (!toCert) {
        return res.status(404).json({
          error: `Version ${toVersion} not found for contract ${address}.`,
        });
      }

      // Score deltas
      const scoreDelta = {
        overall: toCert.overallScore - fromCert.overallScore,
        security: toCert.securityScore - fromCert.securityScore,
        governance: toCert.governanceScore - fromCert.governanceScore,
        economic: toCert.economicScore - fromCert.economicScore,
        compliance: toCert.complianceScore - fromCert.complianceScore,
        liquidity: toCert.liquidityScore - fromCert.liquidityScore,
      };

      // Findings diff: load findings for both certs
      const [fromFindings, toFindings] = await Promise.all([
        prismaRead.auditFinding.findMany({
          where: { certificateId: fromCert.id },
          select: {
            id: true,
            title: true,
            severity: true,
            category: true,
            status: true,
            cweId: true,
          },
        }),
        prismaRead.auditFinding.findMany({
          where: { certificateId: toCert.id },
          select: {
            id: true,
            title: true,
            severity: true,
            category: true,
            status: true,
            cweId: true,
          },
        }),
      ]);

      // Match by title+category as stable key (id changes per cert version)
      const fromKeys = new Map(fromFindings.map((f) => [`${f.category}::${f.title}`, f]));
      const toKeys = new Map(toFindings.map((f) => [`${f.category}::${f.title}`, f]));

      const introduced: typeof fromFindings = [];
      const resolved: typeof fromFindings = [];
      const unchanged: typeof fromFindings = [];
      const improved: Array<{ title: string; category: string; from: string; to: string }> = [];
      const worsened: Array<{ title: string; category: string; from: string; to: string }> = [];

      for (const [key, finding] of toKeys) {
        if (!fromKeys.has(key)) {
          introduced.push(finding);
        } else {
          const prev = fromKeys.get(key)!;
          const sevChange = (SEV_ORDER[prev.severity] ?? 5) - (SEV_ORDER[finding.severity] ?? 5);
          if (sevChange > 0) {
            worsened.push({
              title: finding.title,
              category: finding.category,
              from: prev.severity,
              to: finding.severity,
            });
          } else if (sevChange < 0) {
            improved.push({
              title: finding.title,
              category: finding.category,
              from: prev.severity,
              to: finding.severity,
            });
          } else {
            unchanged.push(finding);
          }
        }
      }

      for (const [key, finding] of fromKeys) {
        if (!toKeys.has(key)) resolved.push(finding);
      }

      // Finding count deltas
      const findingCountDelta = {
        total: toCert.totalFindings - fromCert.totalFindings,
        critical: toCert.criticalFindings - fromCert.criticalFindings,
        high: toCert.highFindings - fromCert.highFindings,
        medium: toCert.mediumFindings - fromCert.mediumFindings,
        low: toCert.lowFindings - fromCert.lowFindings,
        open: toCert.openFindings - fromCert.openFindings,
        resolved: toCert.resolvedFindings - fromCert.resolvedFindings,
      };

      const overallDirection =
        scoreDelta.overall > 0 ? 'improved' : scoreDelta.overall < 0 ? 'degraded' : 'unchanged';

      res.json({
        contractAddress: address,
        fromVersion,
        toVersion,
        fromGeneratedAt: fromCert.generatedAt,
        toGeneratedAt: toCert.generatedAt,
        overallDirection,
        scoreDelta,
        scores: {
          from: {
            overall: fromCert.overallScore,
            security: fromCert.securityScore,
            governance: fromCert.governanceScore,
            economic: fromCert.economicScore,
            compliance: fromCert.complianceScore,
            liquidity: fromCert.liquidityScore,
          },
          to: {
            overall: toCert.overallScore,
            security: toCert.securityScore,
            governance: toCert.governanceScore,
            economic: toCert.economicScore,
            compliance: toCert.complianceScore,
            liquidity: toCert.liquidityScore,
          },
        },
        findingCountDelta,
        findingsDiff: {
          introduced: sortFindings(introduced),
          resolved: sortFindings(resolved),
          worsenedSeverity: worsened,
          improvedSeverity: improved,
          unchanged: unchanged.length, // count only to keep response lean
        },
        certificates: {
          from: {
            certificateId: fromCert.id,
            certificateHash: fromCert.certificateHash,
            verificationUrl: `/api/v1/audit/verify/${fromCert.certificateHash}`,
          },
          to: {
            certificateId: toCert.id,
            certificateHash: toCert.certificateHash,
            verificationUrl: `/api/v1/audit/verify/${toCert.certificateHash}`,
          },
        },
      });
    } catch (e) {
      if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
      res.status(500).json({ error: String(e) });
    }
  },
);

// ── GET /:address/audit/pdf — downloadable professional PDF report ────────────
//
// Query params:
//   version  (optional) — specific audit version; defaults to latest published
//   lang     en (default) | es | ko

const pdfQuerySchema = z.object({
  version: z.coerce.number().int().min(1).optional(),
  lang: z.enum(['en', 'es', 'ko']).default('en'),
});

contractAuditRouter.get(
  '/pdf',
  validateAddressParam('address'),
  async (req: Request, res: Response) => {
    try {
      const { address } = req.params;
      const { version, lang } = pdfQuerySchema.parse(req.query);

      // Load all report data from DB
      const reportData = await loadAuditReportData(address, version, lang);

      if (!reportData) {
        return res.status(404).json({
          error: 'No published audit certificate found for this contract.',
          hint: `POST /api/v1/contracts/${address}/audit/refresh to trigger one.`,
        });
      }

      // Generate PDF — synchronous CPU work, typically < 50 ms
      const pdfBytes = generateAuditPdf(reportData);

      const filename = `audit-${address.slice(0, 12)}-v${reportData.version}-${lang}.pdf`;

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', pdfBytes.length);
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.setHeader('X-Audit-Version', String(reportData.version));
      res.setHeader('X-Certificate-Hash', reportData.certificateHash);

      logger.info('Audit PDF generated', {
        contractAddress: address,
        version: reportData.version,
        lang,
        sizeBytes: pdfBytes.length,
      });

      res.send(pdfBytes);
    } catch (e) {
      if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
      logger.error('PDF generation failed', { error: String(e) });
      res.status(500).json({ error: 'PDF generation failed. ' + String(e) });
    }
  },
);

// ── GET /:address/audit/:version — specific version ───────────────────────────

contractAuditRouter.get(
  '/:version',
  validateAddressParam('address'),
  async (req: Request, res: Response) => {
    try {
      const { address } = req.params;
      const version = parseInt(req.params.version, 10);

      if (isNaN(version) || version < 1) {
        return res.status(400).json({
          error: 'Version must be a positive integer.',
        });
      }

      const cert = await prismaRead.auditCertificate.findFirst({
        where: { contractAddress: address, version },
      });

      if (!cert) {
        return res.status(404).json({
          error: `Audit version ${version} not found for contract ${address}.`,
        });
      }

      const findings = await prismaRead.auditFinding.findMany({
        where: { certificateId: cert.id },
        orderBy: { createdAt: 'asc' },
      });

      res.json(
        formatFull(
          cert as unknown as Record<string, unknown>,
          findings as unknown as Array<Record<string, unknown>>,
        ),
      );
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  },
);

// ── POST /:address/audit/refresh — manual re-audit trigger ────────────────────

const refreshSchema = z.object({
  mode: z.enum(['full', 'incremental']).default('full'),
  anchor: z.boolean().default(false),
  reason: z.string().max(500).optional(),
});

contractAuditRouter.post(
  '/refresh',
  validateAddressParam('address'),
  async (req: Request, res: Response) => {
    try {
      const { address } = req.params;
      const { mode, anchor, reason } = refreshSchema.parse(req.body);

      // Ensure the contract exists in the index
      const contract = await prismaRead.contract.findUnique({
        where: { address },
        select: { address: true },
      });
      if (!contract) {
        return res.status(404).json({
          error: 'Contract not found in explorer index.',
        });
      }

      // Determine the expected next version for the response
      const nextVersion =
        (await prismaRead.auditCertificate.count({
          where: { contractAddress: address },
        })) + 1;

      // Invalidate cache so the next GET reflects fresh data immediately
      // (the cache will be repopulated once the audit completes)
      const { cacheDelete } = await import('../cache');
      await cacheDelete(`contract-audit:latest:${address}`);

      // Return 202 before firing — never block the caller
      res.status(202).json({
        message: 'Audit refresh queued.',
        contractAddress: address,
        mode,
        anchor,
        reason: reason ?? null,
        expectedVersion: nextVersion,
        statusUrl: `/api/v1/contracts/${address}/audit`,
        historyUrl: `/api/v1/contracts/${address}/audit/history`,
        eventsUrl: `/api/v1/audit/contracts/${address}/events`,
      });

      // Fire the pipeline in the background
      import('../indexer/audit-pipeline')
        .then(({ runAuditPipeline }) =>
          runAuditPipeline({
            contractAddress: address,
            trigger: 'manual',
            mode,
            anchor,
            calledBy: (req.headers['x-api-key'] as string) ?? req.ip ?? 'anonymous',
          }),
        )
        .catch((e) =>
          logger.error('Manual audit refresh failed', {
            address,
            error: String(e),
          }),
        );
    } catch (e) {
      if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
      res.status(500).json({ error: String(e) });
    }
  },
);

// ── GET /:address/audit/badge.svg — embeddable SVG badge ─────────────────────
//
// Returns a shields.io-style badge with the contract's audit score.
// Cache-Control is set for browser/CDN caching (5 min live, 1 hr stale-ok).
//
// Query params:
//   style    flat (default) | flat-square | plastic
//   compact  true | false (default) — single-line pill variant
//
// Embed in markdown:
//   ![Audit](https://explorer.soroban.network/api/v1/contracts/C.../audit/badge.svg)

const badgeStyleSchema = z.object({
  style: z.enum(['flat', 'flat-square', 'plastic']).default('flat'),
  compact: z.enum(['true', 'false']).default('false'),
});

contractAuditRouter.get(
  '/badge.svg',
  validateAddressParam('address'),
  async (req: Request, res: Response) => {
    try {
      const { address } = req.params;
      const { style, compact } = badgeStyleSchema.parse(req.query);
      const cacheKey = `badge:${address}:${style}:${compact}`;

      const cached = await cacheGet<string>(cacheKey);
      if (cached) {
        res.setHeader('Content-Type', 'image/svg+xml');
        res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
        return res.send(cached);
      }

      // Fetch the latest published certificate for this contract
      const cert = await prismaRead.auditCertificate.findFirst({
        where: { contractAddress: address, status: 'published' },
        orderBy: { version: 'desc' },
        select: {
          id: true,
          contractAddress: true,
          overallScore: true,
          securityScore: true,
          governanceScore: true,
          economicScore: true,
          complianceScore: true,
          liquidityScore: true,
          generatedAt: true,
          expiresAt: true,
          certificateHash: true,
        },
      });

      const svg = generateBadgeSvg(cert, address, {
        style: style as BadgeStyle,
        compact: compact === 'true',
      });

      // Cache for 5 minutes — fresh enough for live display, avoids hammering DB
      await cacheSet(cacheKey, svg, 300);

      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(svg);
    } catch (e) {
      if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
      res.status(500).json({ error: String(e) });
    }
  },
);

// ── GET /:address/audit/score-history?days=90 ─────────────────────────────────
//
// Returns every audit certificate score point for the contract within the
// requested window, shaped for direct consumption by:
//   - trend line charts (time-series)
//   - radar charts (latest score breakdown)
//   - category breakdown tables
//
// Response:
//   trendLine[]        — [{date, overall, security, governance, economic, compliance, liquidity}]
//   radarChart         — latest scores keyed by dimension (for recharts RadarChart)
//   categoryBreakdown  — per-dimension stats: current, min, max, avg, trend
//   scoreEvents[]      — AuditEvent rows of type "score_change" for annotations
//   summary            — first/latest/best/worst overall scores + direction

const scoreHistorySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(90),
  grain: z.enum(['day', 'version']).default('version'),
});

contractAuditRouter.get(
  '/score-history',
  validateAddressParam('address'),
  async (req: Request, res: Response) => {
    try {
      const { address } = req.params;
      const { days, grain } = scoreHistorySchema.parse(req.query);
      const cacheKey = `score-history:${address}:${days}:${grain}`;

      const cached = await cacheGet(cacheKey);
      if (cached) return res.json(cached);

      const since = new Date(Date.now() - days * 86400000);

      // All certificates in the window (all statuses — want full history)
      const certs = await prismaRead.auditCertificate.findMany({
        where: { contractAddress: address, generatedAt: { gte: since } },
        orderBy: { generatedAt: 'asc' },
        select: {
          id: true,
          version: true,
          status: true,
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

      // Score change events for annotations on the trend line
      const scoreEvents = await prismaRead.auditEvent.findMany({
        where: {
          contractAddress: address,
          eventType: { in: ['score_change', 'vulnerability_discovered', 'certificate_published'] },
          timestamp: { gte: since },
        },
        orderBy: { timestamp: 'asc' },
        select: {
          id: true,
          eventType: true,
          previousScore: true,
          newScore: true,
          triggerSource: true,
          timestamp: true,
          details: true,
        },
      });

      if (certs.length === 0) {
        return res.status(404).json({
          contractAddress: address,
          message: 'No audit history found in the requested window.',
          hint: `POST /api/v1/contracts/${address}/audit/refresh to create the first audit.`,
        });
      }

      // ── Trend line ─────────────────────────────────────────────────────────
      // grain=version → one point per certificate version
      // grain=day     → deduplicate to latest cert per calendar day
      let trendPoints = certs.map((c) => ({
        date: c.generatedAt.toISOString(),
        version: c.version,
        status: resolveStatus(c),
        overall: c.overallScore,
        security: c.securityScore,
        governance: c.governanceScore,
        economic: c.economicScore,
        compliance: c.complianceScore,
        liquidity: c.liquidityScore,
        openFindings: c.openFindings,
        criticalFindings: c.criticalFindings,
      }));

      if (grain === 'day') {
        // Keep only the last cert per UTC day
        const byDay = new Map<string, (typeof trendPoints)[0]>();
        for (const pt of trendPoints) {
          const day = pt.date.slice(0, 10);
          byDay.set(day, pt); // later version overwrites earlier for same day
        }
        trendPoints = Array.from(byDay.values());
      }

      // ── Radar chart (latest cert) ──────────────────────────────────────────
      const latest = certs[certs.length - 1];
      const radarChart = [
        { dimension: 'Security', score: latest.securityScore, fullMark: 100, weight: 30 },
        { dimension: 'Governance', score: latest.governanceScore, fullMark: 100, weight: 25 },
        { dimension: 'Economic', score: latest.economicScore, fullMark: 100, weight: 20 },
        { dimension: 'Compliance', score: latest.complianceScore, fullMark: 100, weight: 15 },
        { dimension: 'Liquidity', score: latest.liquidityScore, fullMark: 100, weight: 10 },
      ];

      // ── Category breakdown ─────────────────────────────────────────────────
      const dims = [
        'securityScore',
        'governanceScore',
        'economicScore',
        'complianceScore',
        'liquidityScore',
      ] as const;
      const dimLabels: Record<string, string> = {
        securityScore: 'Security',
        governanceScore: 'Governance',
        economicScore: 'Economic',
        complianceScore: 'Compliance',
        liquidityScore: 'Liquidity',
      };

      const categoryBreakdown = dims.map((dim) => {
        const scores = certs.map((c) => c[dim]);
        const curr = scores[scores.length - 1];
        const prev = scores.length >= 2 ? scores[scores.length - 2] : curr;
        const min = Math.min(...scores);
        const max = Math.max(...scores);
        const avg = Math.round(scores.reduce((s, v) => s + v, 0) / scores.length);
        const trend = curr > prev ? 'improving' : curr < prev ? 'degrading' : 'stable';

        return {
          dimension: dimLabels[dim],
          current: curr,
          previous: prev,
          min,
          max,
          avg,
          trend,
          delta: curr - prev,
          grade: scoreGrade(curr),
          riskLevel: riskLabel(curr),
        };
      });

      // ── Summary ────────────────────────────────────────────────────────────
      const overallScores = certs.map((c) => c.overallScore);
      const firstScore = overallScores[0];
      const latestScore = overallScores[overallScores.length - 1];
      const bestScore = Math.max(...overallScores);
      const worstScore = Math.min(...overallScores);
      const periodDelta = latestScore - firstScore;
      const direction = periodDelta > 0 ? 'improving' : periodDelta < 0 ? 'degrading' : 'stable';

      const result = {
        contractAddress: address,
        days,
        grain,
        certificateCount: certs.length,
        summary: {
          first: firstScore,
          latest: latestScore,
          best: bestScore,
          worst: worstScore,
          delta: periodDelta,
          direction,
          grade: scoreGrade(latestScore),
          riskLevel: riskLabel(latestScore),
          firstAuditAt: certs[0].generatedAt,
          latestAuditAt: latest.generatedAt,
        },
        trendLine: trendPoints,
        radarChart,
        categoryBreakdown,
        scoreEvents: scoreEvents.map((e) => ({
          id: e.id,
          type: e.eventType,
          previousScore: e.previousScore,
          newScore: e.newScore,
          delta:
            e.newScore !== null && e.previousScore !== null ? e.newScore - e.previousScore : null,
          triggerSource: e.triggerSource,
          timestamp: e.timestamp,
          details: e.details,
        })),
      };

      await cacheSet(cacheKey, result, 120); // 2-min cache
      res.json(result);
    } catch (e) {
      if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
      res.status(500).json({ error: String(e) });
    }
  },
);

// ── GET /:address/audit/alerts — list active alert subscriptions ──────────────

contractAuditRouter.get(
  '/alerts',
  validateAddressParam('address'),
  async (req: Request, res: Response) => {
    try {
      const { address } = req.params;
      const userId = req.query.userId as string | undefined;

      const subs = await prismaRead.auditSubscription.findMany({
        where: {
          contractAddress: address,
          isActive: true,
          ...(userId ? { userId } : {}),
        },
        orderBy: { createdAt: 'desc' },
      });

      res.json({
        contractAddress: address,
        count: subs.length,
        subscriptions: subs,
      });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  },
);

// ── POST /:address/audit/alerts — create alert subscription ──────────────────

const alertCreateSchema = z.object({
  userId: z.string().optional(),
  alertTypes: z
    .array(
      z.enum(['score_drop', 'new_finding', 'upgrade', 'certificate_update', 'certificate_expiry']),
    )
    .min(1),
  threshold: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(10)
    .describe('Minimum score drop (points) required to fire score_drop alert'),
});

contractAuditRouter.post(
  '/alerts',
  validateAddressParam('address'),
  async (req: Request, res: Response) => {
    try {
      const { address } = req.params;
      const data = alertCreateSchema.parse(req.body);

      // Ensure the contract exists
      const contract = await prismaRead.contract.findUnique({
        where: { address },
        select: { address: true },
      });
      if (!contract) {
        return res.status(404).json({ error: 'Contract not found in explorer index.' });
      }

      const sub = await prismaWrite.auditSubscription.create({
        data: {
          contractAddress: address,
          alertTypes: data.alertTypes,
          threshold: data.threshold,
          userId: data.userId,
          isActive: true,
        },
      });

      res.status(201).json({
        subscriptionId: sub.id,
        contractAddress: address,
        alertTypes: sub.alertTypes,
        threshold: sub.threshold,
        wsEndpoint: `/ws/audit?contract=${address}&minDrop=${sub.threshold}`,
        message: 'Subscription created. Connect to the WS endpoint for real-time alerts.',
      });
    } catch (e) {
      if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
      res.status(500).json({ error: String(e) });
    }
  },
);

// ── DELETE /:address/audit/alerts/:subscriptionId ─────────────────────────────

contractAuditRouter.delete(
  '/alerts/:subscriptionId',
  validateAddressParam('address'),
  async (req: Request, res: Response) => {
    try {
      const { address, subscriptionId } = req.params;

      const sub = await prismaRead.auditSubscription.findUnique({
        where: { id: subscriptionId },
        select: { id: true, contractAddress: true },
      });
      if (!sub || sub.contractAddress !== address) {
        return res.status(404).json({ error: 'Subscription not found.' });
      }

      await prismaWrite.auditSubscription.update({
        where: { id: subscriptionId },
        data: { isActive: false },
      });

      res.json({ success: true, subscriptionId });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// THIRD-PARTY AUDITOR INTEGRATION
// ═══════════════════════════════════════════════════════════════════════════

import { submitExternalAudit } from '../lib/auditor-service';

// ── POST /:address/audit/external — submit external audit ─────────────────────
//
// Body (matches spec exactly):
//   auditorName      string  — e.g. "CertiK"
//   reportUrl        string  — https://certik.com/reports/xxx
//   reportHash       string  — "sha256:<hex>" or raw 64-char hex
//   findings         array   — [{severity, title, description, recommendation}]
//   overallGrade     string  — "pass" | "conditional_pass" | "fail"
//   verificationKey  string  — auditor's key for signature verification
//   reportType       string  — "security_audit" | "formal_verification" | "economic_audit"
//   reportSignature  string  — HMAC-SHA256(reportHash, verificationKey) as base64
//   summary          string  — brief text summary
//
// Authentication: for registered auditors, signature over reportHash is
// verified against the stored verificationKey. Auto-verified on match.
// Unregistered auditors are always queued for manual review.

const externalSubmitSchema = z.object({
  auditorName: z.string().min(2).max(200),
  reportUrl: z.string().url().optional(),
  reportHash: z.string().optional(),
  reportSignature: z.string().optional(),
  reportType: z
    .enum(['security_audit', 'formal_verification', 'economic_audit'])
    .default('security_audit'),
  findings: z
    .array(
      z.object({
        severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
        title: z.string().min(1).max(300),
        description: z.string().min(1),
        recommendation: z.string().optional(),
        cweId: z.string().optional(),
        cvssScore: z.number().min(0).max(10).optional(),
        location: z.string().optional(),
      }),
    )
    .default([]),
  overallGrade: z.enum(['pass', 'conditional_pass', 'fail']).optional(),
  summary: z.string().max(2000).optional(),
  verificationKey: z.string().optional(),
  isPublic: z.boolean().default(true),
});

contractAuditRouter.post(
  '/external',
  validateAddressParam('address'),
  async (req: Request, res: Response) => {
    try {
      const { address } = req.params;
      const data = externalSubmitSchema.parse(req.body);

      // Contract must exist
      const contract = await prismaRead.contract.findUnique({
        where: { address },
        select: { address: true },
      });
      if (!contract) {
        return res.status(404).json({ error: 'Contract not found in explorer index.' });
      }

      const result = await submitExternalAudit({
        contractAddress: address,
        auditorName: data.auditorName,
        verificationKey: data.verificationKey,
        reportType: data.reportType,
        reportUrl: data.reportUrl,
        reportHash: data.reportHash,
        reportSignature: data.reportSignature,
        findings: data.findings,
        overallGrade: data.overallGrade,
        summary: data.summary,
        submittedAt: new Date(),
        isPublic: data.isPublic,
      });

      // Log audit event
      await prismaWrite.auditEvent.create({
        data: {
          contractAddress: address,
          eventType: 'external_audit_submitted',
          triggerSource: 'external',
          timestamp: new Date(),
          details: {
            submissionId: result.id,
            auditorName: data.auditorName,
            verificationStatus: result.verificationStatus,
            signatureVerified: result.signatureVerified,
            overallGrade: data.overallGrade ?? null,
            findingCount: data.findings.length,
          } as import('@prisma/client').Prisma.InputJsonValue,
        },
      });

      const statusCode = result.verificationStatus === 'verified' ? 201 : 202;
      res.status(statusCode).json({
        submissionId: result.id,
        contractAddress: address,
        auditorName: data.auditorName,
        verificationStatus: result.verificationStatus,
        signatureVerified: result.signatureVerified,
        hashValid: result.hashValid,
        auditorId: result.auditorId,
        auditorVerified: result.auditorVerified,
        message: result.message,
        viewUrl: `/api/v1/contracts/${address}/audit/external`,
      });
    } catch (e) {
      if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
      res.status(500).json({ error: String(e) });
    }
  },
);

// ── GET /:address/audit/external — list external audits for contract ──────────

const externalListSchema = z.object({
  status: z.enum(['pending', 'verified', 'rejected', 'all']).default('verified'),
  includePrivate: z.enum(['true', 'false']).default('false'),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(50).default(10),
});

contractAuditRouter.get(
  '/external',
  validateAddressParam('address'),
  async (req: Request, res: Response) => {
    try {
      const { address } = req.params;
      const q = externalListSchema.parse(req.query);
      const skip = (q.page - 1) * q.limit;

      const where: Record<string, unknown> = { contractAddress: address };
      if (q.status !== 'all') where.verificationStatus = q.status;
      if (q.includePrivate === 'false') where.isPublic = true;

      const [audits, total] = await Promise.all([
        prismaRead.externalAudit.findMany({
          where,
          orderBy: { submittedAt: 'desc' },
          skip,
          take: q.limit,
          include: {
            auditor: {
              select: {
                id: true,
                name: true,
                slug: true,
                website: true,
                logoUrl: true,
                isVerified: true,
                trustScore: true,
                badgeTier: true,
                specializations: true,
              },
            },
          },
        }),
        prismaRead.externalAudit.count({ where }),
      ]);

      // Shape for response — merge auditor badge info
      const shaped = audits.map((a) => ({
        id: a.id,
        contractAddress: a.contractAddress,
        auditorName: a.auditorName,
        auditor: a.auditor
          ? {
              id: a.auditor.id,
              name: a.auditor.name,
              slug: a.auditor.slug,
              website: a.auditor.website,
              logoUrl: a.auditor.logoUrl,
              isVerified: a.auditor.isVerified,
              trustScore: a.auditor.trustScore,
              badgeTier: a.auditor.badgeTier,
              specializations: a.auditor.specializations,
              badgeUrl: `/api/v1/audit/auditors/${a.auditor.slug}/badge.svg`,
            }
          : null,
        reportType: a.reportType,
        reportUrl: a.reportUrl,
        reportHash: a.reportHash,
        overallGrade: a.overallGrade,
        summary: a.summary,
        findingCount: Array.isArray(a.findings) ? (a.findings as unknown[]).length : 0,
        findings: a.findings,
        verificationStatus: a.verificationStatus,
        submittedAt: a.submittedAt,
        verifiedAt: a.verifiedAt,
      }));

      res.json({
        contractAddress: address,
        total,
        page: q.page,
        limit: q.limit,
        pages: Math.ceil(total / q.limit),
        audits: shaped,
      });
    } catch (e) {
      if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
      res.status(500).json({ error: String(e) });
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// FORMAL VERIFICATION
// ═══════════════════════════════════════════════════════════════════════════

// ── POST /:address/audit/formal-verification — trigger formal verification ────
//
// Supported tools: certora | scribble | halo2 | smtchecker | manual
//
// Body:
//   tool            string   — one of the above
//   specContent     string?  — tool-specific spec/annotation file content
//   specFileName    string?  — filename for the spec (e.g. "MyContract.spec")
//   toolOptions     object?  — tool-specific options or pre-run results (manual mode)
//   linkToCertId    string?  — link results to an existing AuditCertificate id
//
// Returns 202 immediately with jobId. Poll GET .../formal-verification/:jobId.

const fvTriggerSchema = z.object({
  tool: z.enum(['certora', 'scribble', 'halo2', 'smtchecker', 'manual']),
  specContent: z.string().max(100_000).optional(),
  specFileName: z.string().max(200).optional(),
  toolOptions: z.record(z.unknown()).optional(),
  linkToCertId: z.string().optional(),
  triggeredBy: z.string().default('manual'),
});

contractAuditRouter.post(
  '/formal-verification',
  validateAddressParam('address'),
  async (req: Request, res: Response) => {
    try {
      const { address } = req.params;
      const data = fvTriggerSchema.parse(req.body);

      // Contract must exist
      const contract = await prismaRead.contract.findUnique({
        where: { address },
        select: { address: true },
      });
      if (!contract) {
        return res.status(404).json({ error: 'Contract not found in explorer index.' });
      }

      // For non-manual tools: check a verified source job exists
      if (data.tool !== 'manual') {
        const srcJob = await prismaRead.verificationJob.findFirst({
          where: { contractAddress: address, status: 'verified' },
          select: { id: true },
        });
        if (!srcJob) {
          return res.status(422).json({
            error: 'No verified source code found for this contract.',
            hint: 'Upload and verify source code first via POST /api/v1/verify',
            detail:
              'Formal verification requires a reproducible build match. Manual tool can bypass this.',
          });
        }
      }

      // Determine linked cert if not explicitly provided
      let certId = data.linkToCertId ?? null;
      if (!certId) {
        const latestCert = await prismaRead.auditCertificate.findFirst({
          where: { contractAddress: address, status: 'published' },
          orderBy: { version: 'desc' },
          select: { id: true },
        });
        certId = latestCert?.id ?? null;
      }

      const jobId = await runFormalVerification(
        address,
        data.tool as import('../lib/formal-verifier').FormalVerifTool,
        data.specContent ?? null,
        data.specFileName ?? null,
        (data.toolOptions ?? null) as Record<string, unknown> | null,
        data.triggeredBy,
        certId,
      );

      res.status(202).json({
        jobId,
        contractAddress: address,
        tool: data.tool,
        status: 'running',
        linkedCertId: certId,
        statusUrl: `/api/v1/contracts/${address}/audit/formal-verification/${jobId}`,
        listUrl: `/api/v1/contracts/${address}/audit/formal-verification`,
        note:
          data.tool === 'manual'
            ? 'Manual results accepted immediately.'
            : `${data.tool} verification running. Results available in 30–120 seconds.`,
        toolAvailability: {
          certora: !!process.env.CERTORA_KEY,
          scribble: 'requires scribble CLI in PATH',
          halo2: 'requires cargo + halo2 crate',
          smtchecker: 'requires cargo in PATH',
          manual: 'always available',
        },
      });
    } catch (e) {
      if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
      res.status(500).json({ error: String(e) });
    }
  },
);

// ── GET /:address/audit/formal-verification — list all jobs for contract ───────

contractAuditRouter.get(
  '/formal-verification',
  validateAddressParam('address'),
  async (req: Request, res: Response) => {
    try {
      const { address } = req.params;
      const tool = req.query.tool as string | undefined;
      const status = req.query.status as string | undefined;
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);

      const where: Record<string, unknown> = { contractAddress: address };
      if (tool) where.tool = tool;
      if (status) where.status = status;

      const [jobs, total] = await Promise.all([
        prismaRead.formalVerificationJob.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: limit,
        }),
        prismaRead.formalVerificationJob.count({ where }),
      ]);

      // Summary: most recent result per tool
      const byTool: Record<string, unknown> = {};
      for (const j of jobs) {
        if (!byTool[j.tool]) {
          byTool[j.tool] = {
            latestStatus: j.status,
            passed: j.passed,
            provenCount: j.provenCount,
            violatedCount: j.violatedCount,
            completedAt: j.completedAt,
            jobId: j.id,
          };
        }
      }

      res.json({
        contractAddress: address,
        total,
        byTool,
        jobs: jobs.map((j) => ({
          id: j.id,
          tool: j.tool,
          status: j.status,
          passed: j.passed,
          propertyCount: j.propertyCount,
          provenCount: j.provenCount,
          violatedCount: j.violatedCount,
          unknownCount: j.unknownCount,
          coveragePercent: j.coveragePercent,
          reportUrl: j.reportUrl,
          durationSeconds: j.durationSeconds,
          triggeredBy: j.triggeredBy,
          startedAt: j.startedAt,
          completedAt: j.completedAt,
          createdAt: j.createdAt,
        })),
      });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  },
);

// ── GET /:address/audit/formal-verification/:jobId — single job detail ─────────

contractAuditRouter.get(
  '/formal-verification/:jobId',
  validateAddressParam('address'),
  async (req: Request, res: Response) => {
    try {
      const job = await prismaRead.formalVerificationJob.findUnique({
        where: { id: req.params.jobId },
      });

      if (!job || job.contractAddress !== req.params.address) {
        return res.status(404).json({ error: 'Formal verification job not found.' });
      }

      const isRunning = job.status === 'running' || job.status === 'pending';

      res.json({
        id: job.id,
        contractAddress: job.contractAddress,
        tool: job.tool,
        status: job.status,
        passed: job.passed,
        propertyCount: job.propertyCount,
        provenCount: job.provenCount,
        violatedCount: job.violatedCount,
        unknownCount: job.unknownCount,
        coveragePercent: job.coveragePercent,
        counterExamples: job.counterExamples,
        toolOutput: isRunning ? null : job.toolOutput,
        reportUrl: job.reportUrl,
        toolVersion: job.toolVersion,
        durationSeconds: job.durationSeconds,
        triggeredBy: job.triggeredBy,
        linkedCertId: job.certId,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        createdAt: job.createdAt,
        ...(isRunning && {
          pollUrl: `/api/v1/contracts/${job.contractAddress}/audit/formal-verification/${job.id}`,
          pollAfterMs: 5000,
        }),
      });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// COMPETITIVE BENCHMARKING
// ═══════════════════════════════════════════════════════════════════════════

// ── GET /:address/audit/benchmark — benchmark against peer contracts ───────────

contractAuditRouter.get(
  '/benchmark',
  validateAddressParam('address'),
  async (req: Request, res: Response) => {
    try {
      const { address } = req.params;

      // Must have at least one published cert
      const cert = await prismaRead.auditCertificate.findFirst({
        where: { contractAddress: address, status: 'published' },
        orderBy: { version: 'desc' },
        select: { id: true, overallScore: true, certificateHash: true },
      });
      if (!cert) {
        return res.status(404).json({
          error: 'No published audit certificate found.',
          hint: `POST /api/v1/contracts/${address}/audit/refresh to trigger one first.`,
        });
      }

      const result = await benchmarkContract(address);
      if (!result) {
        return res.status(404).json({ error: 'Benchmark computation returned no data.' });
      }

      res.json({
        ...result,
        // Convenience links
        categoryBenchmarkUrl: `/api/v1/audit/benchmarks/${result.category}`,
        verifyUrl: `/api/v1/audit/verify/${cert.certificateHash}`,
        updatedAt: new Date().toISOString(),
      });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// AUTOMATED REMEDIATION
// ═══════════════════════════════════════════════════════════════════════════

// ── POST /:address/audit/:findingId/remediate ─────────────────────────────────
//
// Generate (and optionally apply) automated remediation for an AuditFinding.
//
// Path params:
//   address   — contract address
//   findingId — AuditFinding.id
//
// Body:
//   applyPatch  bool   — if true, mark the finding as "remediated" in DB
//   funcName    string — override the inferred function name for code generation
//
// Returns:
//   isAutoFixable, remediationType, patchFiles[], unifiedDiff, PR metadata,
//   explanation, steps, estimatedEffort, references, warnings

const remediateSchema = z.object({
  applyPatch: z.boolean().default(false),
  funcName: z.string().optional(),
});

contractAuditRouter.post(
  '/:findingId/remediate',
  validateAddressParam('address'),
  async (req: Request, res: Response) => {
    try {
      const { address, findingId } = req.params;
      const { applyPatch, funcName } = remediateSchema.parse(req.body);

      // Load the finding
      const finding = await prismaRead.auditFinding.findUnique({
        where: { id: findingId },
        include: {
          certificate: { select: { contractAddress: true, version: true } },
        },
      });

      if (!finding) {
        return res.status(404).json({ error: 'Finding not found.' });
      }
      if (finding.certificate.contractAddress !== address) {
        return res.status(404).json({ error: 'Finding does not belong to this contract.' });
      }
      if (finding.status !== 'open') {
        return res.status(409).json({
          error: `Finding is already ${finding.status}. Only open findings can be remediated.`,
          status: finding.status,
        });
      }

      // Generate the remediation
      const result = generateRemediation({
        id: finding.id,
        title: finding.title,
        severity: finding.severity,
        category: finding.category,
        description: finding.description,
        detail: finding.detail,
        cweId: finding.cweId,
        txHash: finding.txHash,
        contractAddress: address,
        // Override function name if caller specified one
        ...(funcName ? { title: `${finding.title} [${funcName}]` } : {}),
      });

      // If caller requests patch application, mark the finding as resolved
      if (applyPatch && result.isAutoFixable) {
        await prismaWrite.auditFinding.update({
          where: { id: findingId },
          data: {
            status: 'resolved',
            resolvedAt: new Date(),
            resolutionNote: `Automated remediation applied: ${result.remediationType}`,
          },
        });

        // Decrement openFindings, increment resolvedFindings on the cert
        await prismaWrite.auditCertificate.update({
          where: { id: finding.certificateId },
          data: {
            openFindings: { decrement: 1 },
            resolvedFindings: { increment: 1 },
          },
        });

        // Write audit event
        await prismaWrite.auditEvent.create({
          data: {
            contractAddress: address,
            certificateId: finding.certificateId,
            eventType: 'vulnerability_discovered',
            triggerSource: 'manual',
            timestamp: new Date(),
            details: {
              action: 'remediation_applied',
              findingId,
              remediationType: result.remediationType,
              patchedFiles: result.patchFiles.map((p) => p.path),
            } as import('@prisma/client').Prisma.InputJsonValue,
          },
        });
      }

      res.status(applyPatch && result.isAutoFixable ? 200 : 200).json({
        ...result,
        applied: applyPatch && result.isAutoFixable,
        findingStatus: applyPatch && result.isAutoFixable ? 'resolved' : finding.status,
        note: !result.isAutoFixable
          ? 'This finding has no automated patch. Follow the manual steps provided.'
          : applyPatch
            ? 'Patch applied — finding marked as resolved. Re-audit to confirm.'
            : 'Patch generated. Review carefully before applying. POST with applyPatch=true to mark resolved.',
      });
    } catch (e) {
      if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
      res.status(500).json({ error: String(e) });
    }
  },
);
