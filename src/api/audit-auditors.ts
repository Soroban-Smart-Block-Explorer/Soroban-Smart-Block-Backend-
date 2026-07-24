/**
 * Auditor Registry API
 * Mounted at /api/v1/audit/auditors
 *
 * GET  /                         list verified auditors (public)
 * GET  /:slug                    auditor profile + audit history
 * GET  /:slug/badge.svg          verified auditor SVG badge (embeddable)
 * POST /register                 register a new auditor firm
 * POST /:id/verify               admin — verify an auditor and assign badge
 * POST /:id/suspend              admin — suspend an auditor
 * PUT  /:id/key                  update verification key
 *
 * External audit review (admin):
 * PUT  /submissions/:id/review   accept or reject a pending submission
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prismaRead, prismaWrite } from '../db';
import { cacheGet, cacheSet } from '../cache';
import {
  registerAuditor,
  verifyAuditor,
  suspendAuditor,
  updateAuditorTrustScore,
  toSlug,
} from '../lib/auditor-service';

export const auditAuditorsRouter = Router();

// ── Shared badge tier colours ──────────────────────────────────────────────────

const TIER_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  platinum: { bg: '#e2e8f0', text: '#1e293b', label: 'Platinum' },
  gold: { bg: '#fef3c7', text: '#92400e', label: 'Gold' },
  silver: { bg: '#f1f5f9', text: '#475569', label: 'Silver' },
  bronze: { bg: '#fef0e7', text: '#9a3412', label: 'Bronze' },
};

function renderAuditorBadge(
  name: string,
  tier: string | null,
  isVerified: boolean,
  trustScore: number,
  slug: string,
  baseUrl: string,
): string {
  const tierInfo = tier ? TIER_COLORS[tier] : null;
  const bg = tierInfo?.bg ?? '#f3f4f6';
  const tc = tierInfo?.text ?? '#6b7280';
  const label = tierInfo
    ? `${tierInfo.label} Auditor`
    : isVerified
      ? 'Verified Auditor'
      : 'Auditor';
  const w = Math.max(160, name.length * 6.5 + 90);
  const h = 24;
  const verifyMark = isVerified ? '✓ ' : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
  width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img"
  aria-label="${label}: ${name}">
  <title>${label}: ${name} (Trust: ${trustScore}/100)</title>
  <defs>
    <linearGradient id="g" x2="0" y2="100%">
      <stop offset="0" stop-color="#fff" stop-opacity=".2"/>
      <stop offset="1"                   stop-opacity=".1"/>
    </linearGradient>
    <clipPath id="r"><rect width="${w}" height="${h}" rx="4" fill="#fff"/></clipPath>
  </defs>
  <g clip-path="url(#r)">
    <rect width="70"          height="${h}" fill="#1e3a8a"/>
    <rect x="70" width="${w - 70}" height="${h}" fill="${bg}"/>
    <rect width="${w}"        height="${h}" fill="url(#g)"/>
  </g>
  <g font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="105">
    <text x="350" y="155" fill="#fff" text-anchor="middle" transform="scale(.1)"
      textLength="600">${label}</text>
    <text x="${(70 + (w - 70) / 2) * 10}" y="155" fill="${tc}"
      text-anchor="middle" transform="scale(.1)"
      textLength="${(w - 80) * 10}">${verifyMark}${name}</text>
  </g>
  <a xlink:href="${baseUrl}/api/v1/audit/auditors/${slug}" target="_blank">
    <rect width="${w}" height="${h}" fill-opacity="0"/>
  </a>
</svg>`;
}

// ── GET / — list verified auditors ────────────────────────────────────────────

const listSchema = z.object({
  verified: z.enum(['true', 'false', 'all']).default('true'),
  tier: z.enum(['platinum', 'gold', 'silver', 'bronze', 'all']).default('all'),
  sort: z.enum(['trustScore', 'totalAudits', 'name']).default('trustScore'),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  specialization: z.string().optional(),
});

auditAuditorsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const q = listSchema.parse(req.query);
    const skip = (q.page - 1) * q.limit;
    const cacheKey = `audit:auditors:${JSON.stringify(q)}`;

    const cached = await cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const where: Record<string, unknown> = { isActive: true };
    if (q.verified === 'true') where.isVerified = true;
    if (q.verified === 'false') where.isVerified = false;
    if (q.tier !== 'all') where.badgeTier = q.tier;
    if (q.specialization) {
      where.specializations = { has: q.specialization };
    }

    const orderBy =
      q.sort === 'name'
        ? { name: 'asc' as const }
        : q.sort === 'totalAudits'
          ? { totalAudits: 'desc' as const }
          : { trustScore: 'desc' as const };

    const [auditors, total] = await Promise.all([
      prismaRead.auditorRegistry.findMany({
        where,
        orderBy,
        skip,
        take: q.limit,
        select: {
          id: true,
          name: true,
          slug: true,
          website: true,
          logoUrl: true,
          description: true,
          isVerified: true,
          trustScore: true,
          badgeTier: true,
          specializations: true,
          twitterHandle: true,
          githubOrg: true,
          totalAudits: true,
          acceptedAudits: true,
          verifiedAt: true,
          createdAt: true,
        },
      }),
      prismaRead.auditorRegistry.count({ where }),
    ]);

    const baseUrl = process.env.PUBLIC_API_BASE_URL ?? 'https://explorer.soroban.network';

    const result = {
      total,
      page: q.page,
      limit: q.limit,
      pages: Math.ceil(total / q.limit),
      auditors: auditors.map((a) => ({
        ...a,
        badgeUrl: `/api/v1/audit/auditors/${a.slug}/badge.svg`,
        profileUrl: `/api/v1/audit/auditors/${a.slug}`,
      })),
    };

    await cacheSet(cacheKey, result, 120);
    res.json(result);
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /:slug — auditor profile ──────────────────────────────────────────────

auditAuditorsRouter.get('/:slug', async (req: Request, res: Response) => {
  try {
    const auditor = await prismaRead.auditorRegistry.findUnique({
      where: { slug: req.params.slug },
    });
    if (!auditor) return res.status(404).json({ error: 'Auditor not found.' });
    if (!auditor.isActive) return res.status(410).json({ error: 'Auditor account is suspended.' });

    // Recent verified audits
    const recentAudits = await prismaRead.externalAudit.findMany({
      where: { auditorId: auditor.id, verificationStatus: 'verified', isPublic: true },
      orderBy: { submittedAt: 'desc' },
      take: 10,
      select: {
        id: true,
        contractAddress: true,
        reportType: true,
        overallGrade: true,
        submittedAt: true,
        verifiedAt: true,
        summary: true,
        reportUrl: true,
      },
    });

    const baseUrl = process.env.PUBLIC_API_BASE_URL ?? 'https://explorer.soroban.network';

    res.json({
      id: auditor.id,
      name: auditor.name,
      slug: auditor.slug,
      website: auditor.website,
      logoUrl: auditor.logoUrl,
      description: auditor.description,
      contactEmail: auditor.contactEmail,
      twitterHandle: auditor.twitterHandle,
      githubOrg: auditor.githubOrg,
      isVerified: auditor.isVerified,
      verifiedAt: auditor.verifiedAt,
      trustScore: auditor.trustScore,
      badgeTier: auditor.badgeTier,
      specializations: auditor.specializations,
      metrics: {
        totalAudits: auditor.totalAudits,
        acceptedAudits: auditor.acceptedAudits,
        rejectedAudits: auditor.rejectedAudits,
        acceptanceRate:
          auditor.totalAudits > 0
            ? ((auditor.acceptedAudits / auditor.totalAudits) * 100).toFixed(1) + '%'
            : 'N/A',
      },
      recentAudits,
      badgeUrl: `/api/v1/audit/auditors/${auditor.slug}/badge.svg`,
      embedHtml: `<img src="${baseUrl}/api/v1/audit/auditors/${auditor.slug}/badge.svg" alt="${auditor.name} Verified Auditor"/>`,
      createdAt: auditor.createdAt,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /:slug/badge.svg — embeddable auditor badge ───────────────────────────

auditAuditorsRouter.get('/:slug/badge.svg', async (req: Request, res: Response) => {
  try {
    const { slug } = req.params;
    const cacheKey = `auditor-badge:${slug}`;

    const cached = await cacheGet<string>(cacheKey);
    if (cached) {
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
      return res.send(cached);
    }

    const auditor = await prismaRead.auditorRegistry.findUnique({
      where: { slug },
      select: {
        name: true,
        slug: true,
        badgeTier: true,
        isVerified: true,
        trustScore: true,
        isActive: true,
      },
    });

    const baseUrl = process.env.PUBLIC_API_BASE_URL ?? 'https://explorer.soroban.network';

    const svg = auditor
      ? renderAuditorBadge(
          auditor.name,
          auditor.badgeTier,
          auditor.isVerified,
          auditor.trustScore,
          auditor.slug,
          baseUrl,
        )
      : renderAuditorBadge('Unknown', null, false, 0, slug, baseUrl);

    await cacheSet(cacheKey, svg, 3600);
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(svg);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── POST /register ────────────────────────────────────────────────────────────

const registerSchema = z.object({
  name: z.string().min(2).max(200),
  website: z.string().url().optional(),
  logoUrl: z.string().url().optional(),
  description: z.string().max(1000).optional(),
  contactEmail: z.string().email().optional(),
  twitterHandle: z.string().optional(),
  githubOrg: z.string().optional(),
  verificationKey: z.string().min(20).optional(),
  verificationKeyAlgo: z.enum(['hmac-sha256', 'ed25519', 'ecdsa-p256']).default('hmac-sha256'),
  specializations: z.array(z.string()).default([]),
});

auditAuditorsRouter.post('/register', async (req: Request, res: Response) => {
  try {
    const data = registerSchema.parse(req.body);
    const { auditor, created } = await registerAuditor(data);

    const status = created ? 201 : 200;
    res.status(status).json({
      auditor,
      created,
      message: created
        ? 'Registration submitted. Pending admin verification. Submit audits to build your trust score.'
        : 'Auditor already registered with this name.',
      profileUrl: `/api/v1/audit/auditors/${toSlug(data.name)}`,
    });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

// ── POST /:id/verify — admin verify ───────────────────────────────────────────

const verifySchema = z.object({
  verifiedBy: z.string().min(1),
  adminKey: z.string().optional(),
});

auditAuditorsRouter.post('/:id/verify', async (req: Request, res: Response) => {
  try {
    const data = verifySchema.parse(req.body);

    // Simple admin key check — use AUDIT_ADMIN_KEY env var in production
    const adminKey = process.env.AUDIT_ADMIN_KEY;
    if (adminKey && data.adminKey !== adminKey) {
      return res.status(403).json({ error: 'Invalid admin key.' });
    }

    const result = await verifyAuditor(req.params.id, data.verifiedBy);
    if (!result.ok) return res.status(404).json({ error: result.message });

    // Invalidate badge cache
    const auditor = await prismaRead.auditorRegistry.findUnique({
      where: { id: req.params.id },
      select: { slug: true },
    });
    if (auditor) {
      const { cacheDelete } = await import('../cache');
      await cacheDelete(`auditor-badge:${auditor.slug}`);
    }

    res.json({ success: true, message: result.message });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

// ── POST /:id/suspend — admin suspend ─────────────────────────────────────────

const suspendSchema = z.object({
  reason: z.string().min(1),
  adminKey: z.string().optional(),
});

auditAuditorsRouter.post('/:id/suspend', async (req: Request, res: Response) => {
  try {
    const data = suspendSchema.parse(req.body);

    const adminKey = process.env.AUDIT_ADMIN_KEY;
    if (adminKey && data.adminKey !== adminKey) {
      return res.status(403).json({ error: 'Invalid admin key.' });
    }

    const { ok } = await suspendAuditor(req.params.id, data.reason);
    if (!ok) return res.status(404).json({ error: 'Auditor not found.' });
    res.json({ success: true });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

// ── PUT /:id/key — update verification key ────────────────────────────────────

const keyUpdateSchema = z.object({
  verificationKey: z.string().min(20),
  verificationKeyAlgo: z.enum(['hmac-sha256', 'ed25519', 'ecdsa-p256']).default('hmac-sha256'),
  adminKey: z.string().optional(),
});

auditAuditorsRouter.put('/:id/key', async (req: Request, res: Response) => {
  try {
    const data = keyUpdateSchema.parse(req.body);

    const adminKey = process.env.AUDIT_ADMIN_KEY;
    if (adminKey && data.adminKey !== adminKey) {
      return res.status(403).json({ error: 'Invalid admin key.' });
    }

    const auditor = await prismaRead.auditorRegistry.findUnique({
      where: { id: req.params.id },
      select: { id: true },
    });
    if (!auditor) return res.status(404).json({ error: 'Auditor not found.' });

    await prismaWrite.auditorRegistry.update({
      where: { id: req.params.id },
      data: {
        verificationKey: data.verificationKey,
        verificationKeyAlgo: data.verificationKeyAlgo,
      },
    });

    res.json({ success: true, message: 'Verification key updated.' });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

// ── PUT /submissions/:id/review — admin review pending submission ──────────────

const reviewSchema = z.object({
  decision: z.enum(['verified', 'rejected']),
  reviewedBy: z.string().min(1),
  rejectionReason: z.string().optional(),
  adminKey: z.string().optional(),
});

auditAuditorsRouter.put('/submissions/:id/review', async (req: Request, res: Response) => {
  try {
    const data = reviewSchema.parse(req.body);

    const adminKey = process.env.AUDIT_ADMIN_KEY;
    if (adminKey && data.adminKey !== adminKey) {
      return res.status(403).json({ error: 'Invalid admin key.' });
    }

    const submission = await prismaRead.externalAudit.findUnique({
      where: { id: req.params.id },
      select: { id: true, verificationStatus: true, auditorId: true, contractAddress: true },
    });
    if (!submission) return res.status(404).json({ error: 'Submission not found.' });
    if (submission.verificationStatus !== 'pending') {
      return res.status(409).json({
        error: `Submission is already ${submission.verificationStatus}.`,
      });
    }

    const accepted = data.decision === 'verified';

    await prismaWrite.externalAudit.update({
      where: { id: req.params.id },
      data: {
        verificationStatus: data.decision,
        verifiedAt: accepted ? new Date() : null,
        rejectionReason: accepted ? null : data.rejectionReason,
      },
    });

    // Update auditor trust score
    if (submission.auditorId) {
      await updateAuditorTrustScore(submission.auditorId, accepted);
    }

    // Write audit event
    await prismaWrite.auditEvent.create({
      data: {
        contractAddress: submission.contractAddress,
        eventType: 'external_audit_submitted',
        triggerSource: 'manual',
        timestamp: new Date(),
        details: {
          submissionId: submission.id,
          decision: data.decision,
          reviewedBy: data.reviewedBy,
          reason: data.rejectionReason ?? null,
        } as import('@prisma/client').Prisma.InputJsonValue,
      },
    });

    res.json({
      id: req.params.id,
      verificationStatus: data.decision,
      reviewedBy: data.reviewedBy,
      auditorTrustUpdated: !!submission.auditorId,
    });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
    res.status(500).json({ error: String(e) });
  }
});
