/**
 * Auditor Service
 *
 * Handles auditor registry operations and external audit submission logic:
 *   - Auditor registration, verification, badge assignment
 *   - Report hash verification (SHA-256 tamper detection)
 *   - Signature verification for authenticated submissions
 *   - Trust-score updates after accept/reject decisions
 *   - Badge tier computation (platinum/gold/silver/bronze)
 */

import crypto from 'crypto';
import { prismaRead, prismaWrite } from '../db';
import { logger } from '../logger';

// ── Badge tier thresholds ──────────────────────────────────────────────────────

export type BadgeTier = 'platinum' | 'gold' | 'silver' | 'bronze' | null;

function computeBadgeTier(
  trustScore: number,
  acceptedAudits: number,
  isVerified: boolean,
): BadgeTier {
  if (!isVerified) return null;
  if (trustScore >= 90 && acceptedAudits >= 50) return 'platinum';
  if (trustScore >= 80 && acceptedAudits >= 20) return 'gold';
  if (trustScore >= 70 && acceptedAudits >= 5) return 'silver';
  if (trustScore >= 60 && acceptedAudits >= 1) return 'bronze';
  return null;
}

// ── Report hash verification ──────────────────────────────────────────────────

/**
 * Verifies that the submitted reportHash matches the canonical format:
 * "sha256:<64-char-hex>" and optionally re-checks it against a raw hash value.
 */
export function parseReportHash(raw: string): {
  valid: boolean;
  algorithm: string;
  hex: string;
} {
  const match = raw.match(/^(sha256|sha512):([a-f0-9]+)$/i);
  if (!match) {
    // Accept plain 64-char hex as sha256
    if (/^[a-f0-9]{64}$/i.test(raw)) {
      return { valid: true, algorithm: 'sha256', hex: raw.toLowerCase() };
    }
    return { valid: false, algorithm: '', hex: '' };
  }
  const algo = match[1].toLowerCase();
  const hex = match[2].toLowerCase();
  const expectedLen = algo === 'sha256' ? 64 : 128;
  return { valid: hex.length === expectedLen, algorithm: algo, hex };
}

/**
 * Verify an auditor's signature over the reportHash using their stored
 * verificationKey. Currently supports HMAC-SHA256 (symmetric, for registered
 * auditors whose key is a shared secret) — extend to Ed25519 when asymmetric
 * key infrastructure is added.
 */
export function verifyReportSignature(
  reportHash: string,
  signature: string,
  verificationKey: string,
): boolean {
  try {
    const expected = crypto
      .createHmac('sha256', verificationKey)
      .update(reportHash)
      .digest('base64');
    const expBuf = Buffer.from(expected, 'base64');
    const sigBuf = Buffer.from(signature, 'base64');
    if (expBuf.length !== sigBuf.length) return false;
    return crypto.timingSafeEqual(expBuf, sigBuf);
  } catch {
    return false;
  }
}

// ── Slug helpers ──────────────────────────────────────────────────────────────

export function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

// ── Auditor CRUD ──────────────────────────────────────────────────────────────

export interface RegisterAuditorInput {
  name: string;
  website?: string;
  logoUrl?: string;
  description?: string;
  contactEmail?: string;
  twitterHandle?: string;
  githubOrg?: string;
  verificationKey?: string;
  verificationKeyAlgo?: string;
  specializations?: string[];
}

export async function registerAuditor(input: RegisterAuditorInput) {
  const slug = toSlug(input.name);

  // Idempotent: return existing if slug already taken
  const existing = await prismaRead.auditorRegistry.findUnique({
    where: { slug },
    select: { id: true, name: true, isVerified: true },
  });
  if (existing) {
    return { auditor: existing, created: false };
  }

  const auditor = await prismaWrite.auditorRegistry.create({
    data: {
      name: input.name,
      slug,
      website: input.website,
      logoUrl: input.logoUrl,
      description: input.description,
      contactEmail: input.contactEmail,
      twitterHandle: input.twitterHandle,
      githubOrg: input.githubOrg,
      verificationKey: input.verificationKey,
      verificationKeyAlgo: input.verificationKeyAlgo ?? 'hmac-sha256',
      specializations: input.specializations ?? [],
      isVerified: false,
      isActive: true,
    },
  });

  logger.info('Auditor registered', { id: auditor.id, name: auditor.name, slug });
  return { auditor, created: true };
}

export async function verifyAuditor(
  id: string,
  verifiedBy: string,
): Promise<{ ok: boolean; message: string }> {
  const auditor = await prismaRead.auditorRegistry.findUnique({
    where: { id },
    select: { id: true, isVerified: true, name: true, acceptedAudits: true, trustScore: true },
  });
  if (!auditor) return { ok: false, message: 'Auditor not found.' };
  if (auditor.isVerified) return { ok: true, message: 'Auditor already verified.' };

  const badge = computeBadgeTier(auditor.trustScore, auditor.acceptedAudits, true);

  await prismaWrite.auditorRegistry.update({
    where: { id },
    data: {
      isVerified: true,
      verifiedAt: new Date(),
      verifiedBy,
      badgeTier: badge,
    },
  });

  logger.info('Auditor verified', { id, name: auditor.name, badge });
  return {
    ok: true,
    message: `Auditor "${auditor.name}" verified. Badge: ${badge ?? 'none yet'}.`,
  };
}

export async function suspendAuditor(id: string, reason: string): Promise<{ ok: boolean }> {
  const auditor = await prismaRead.auditorRegistry.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!auditor) return { ok: false };

  await prismaWrite.auditorRegistry.update({
    where: { id },
    data: { isActive: false, suspendedAt: new Date(), suspendReason: reason },
  });
  logger.info('Auditor suspended', { id, reason });
  return { ok: true };
}

// ── Trust score update (called after accept/reject) ───────────────────────────

export async function updateAuditorTrustScore(auditorId: string, accepted: boolean): Promise<void> {
  const auditor = await prismaRead.auditorRegistry.findUnique({
    where: { id: auditorId },
    select: {
      trustScore: true,
      totalAudits: true,
      acceptedAudits: true,
      rejectedAudits: true,
      isVerified: true,
    },
  });
  if (!auditor) return;

  const totalAudits = auditor.totalAudits + 1;
  const acceptedAudits = accepted ? auditor.acceptedAudits + 1 : auditor.acceptedAudits;
  const rejectedAudits = accepted ? auditor.rejectedAudits : auditor.rejectedAudits + 1;

  // Trust score: acceptance rate * 100, clamped 10-100, smoothed with decay
  const acceptRate = totalAudits > 0 ? acceptedAudits / totalAudits : 0.5;
  const rawScore = Math.round(acceptRate * 100);
  // Weighted average: 80% history, 20% new signal
  const newScore = Math.round(auditor.trustScore * 0.8 + rawScore * 0.2);
  const clamped = Math.max(10, Math.min(100, newScore));

  const badge = computeBadgeTier(clamped, acceptedAudits, auditor.isVerified);

  await prismaWrite.auditorRegistry.update({
    where: { id: auditorId },
    data: {
      trustScore: clamped,
      totalAudits,
      acceptedAudits,
      rejectedAudits,
      badgeTier: badge,
    },
  });
}

// ── External audit submission (authenticated) ─────────────────────────────────

export interface SubmitExternalAuditInput {
  contractAddress: string;
  auditorName: string;
  verificationKey?: string;
  reportType: string;
  reportUrl?: string;
  reportHash?: string;
  reportSignature?: string;
  findings?: unknown[];
  overallGrade?: string;
  summary?: string;
  submittedAt: Date;
  isPublic?: boolean;
}

export interface SubmissionResult {
  id: string;
  verificationStatus: string;
  signatureVerified: boolean;
  hashValid: boolean;
  auditorId: string | null;
  auditorVerified: boolean;
  message: string;
}

export async function submitExternalAudit(
  input: SubmitExternalAuditInput,
): Promise<SubmissionResult> {
  // ── 1. Resolve auditor from registry ──────────────────────────────────────
  const auditor = await prismaRead.auditorRegistry.findFirst({
    where: {
      name: input.auditorName,
      isActive: true,
    },
    select: {
      id: true,
      name: true,
      verificationKey: true,
      isVerified: true,
      trustScore: true,
    },
  });

  // ── 2. Validate report hash format ────────────────────────────────────────
  let hashValid = true;
  if (input.reportHash) {
    const parsed = parseReportHash(input.reportHash);
    hashValid = parsed.valid;
  }

  // ── 3. Verify signature (if auditor is registered and has a key) ──────────
  let signatureVerified = false;
  const keyToUse = auditor?.verificationKey ?? input.verificationKey;

  if (keyToUse && input.reportHash && input.reportSignature) {
    signatureVerified = verifyReportSignature(input.reportHash, input.reportSignature, keyToUse);
  }

  // ── 4. Determine initial verification status ──────────────────────────────
  // Verified auditors with valid signatures auto-verify;
  // unregistered or unsigned submissions go to 'pending'.
  let verificationStatus: 'pending' | 'verified' = 'pending';
  if (auditor?.isVerified && signatureVerified && hashValid) {
    verificationStatus = 'verified';
  }

  // ── 5. Persist ────────────────────────────────────────────────────────────
  const record = await prismaWrite.externalAudit.create({
    data: {
      contractAddress: input.contractAddress,
      auditorId: auditor?.id ?? null,
      auditorName: input.auditorName,
      auditorVerificationKey: input.verificationKey,
      reportType: input.reportType,
      reportUrl: input.reportUrl,
      reportHash: input.reportHash,
      reportSignature: input.reportSignature,
      findings: (input.findings ?? []) as import('@prisma/client').Prisma.InputJsonValue,
      overallGrade: input.overallGrade,
      summary: input.summary,
      submittedAt: input.submittedAt,
      verificationStatus,
      verifiedAt: verificationStatus === 'verified' ? new Date() : null,
      isPublic: input.isPublic ?? true,
    },
  });

  // ── 6. Update auditor metrics for verified submissions ────────────────────
  if (auditor?.id && verificationStatus === 'verified') {
    await updateAuditorTrustScore(auditor.id, true);
  }

  const message =
    verificationStatus === 'verified'
      ? 'Submission auto-verified — registered auditor with valid signature.'
      : auditor?.isVerified
        ? 'Registered auditor, but signature verification failed. Queued for manual review.'
        : 'Unregistered auditor. Queued for manual verification.';

  logger.info('External audit submitted', {
    id: record.id,
    contractAddress: input.contractAddress,
    auditorName: input.auditorName,
    verificationStatus,
    signatureVerified,
  });

  return {
    id: record.id,
    verificationStatus,
    signatureVerified,
    hashValid,
    auditorId: auditor?.id ?? null,
    auditorVerified: auditor?.isVerified ?? false,
    message,
  };
}
