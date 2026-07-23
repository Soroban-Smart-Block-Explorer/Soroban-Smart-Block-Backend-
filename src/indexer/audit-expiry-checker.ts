/**
 * Certificate Expiry Checker
 *
 * Runs on a configurable interval (default: every 6 hours) and checks for
 * published AuditCertificates approaching their expiry date. Fires:
 *
 *   - 30-day warning  (urgency: "warning")
 *   - 14-day warning  (urgency: "urgent")
 *   - 7-day warning   (urgency: "critical")
 *
 * Each threshold fires at most once per certificate per window (tracked via
 * AuditEvent rows so restarts don't re-fire). Sends to:
 *   - WebSocket subscribers (broadcastCertExpiry)
 *   - Email / webhook / Slack subscribers (notifyCertificateExpiry)
 *   - Writes an AuditEvent row per fire for the audit trail
 *
 * Also triggers an automatic re-audit 7 days before expiry so a fresh cert
 * is ready before the current one expires.
 */

import { prismaRead, prismaWrite } from '../db';
import { logger } from '../logger';
import { broadcastCertExpiry } from '../ws/auditBroadcaster';
import { notifyCertificateExpiry } from '../lib/audit-notifier';
import { runAuditPipeline } from './audit-pipeline';

// ── Configuration ─────────────────────────────────────────────────────────────

const CHECK_INTERVAL_MS = parseInt(
  process.env.AUDIT_EXPIRY_CHECK_INTERVAL_MS ?? String(6 * 60 * 60 * 1000), // 6 hours
);

// Days-before-expiry thresholds that trigger notifications
const THRESHOLDS = [30, 14, 7] as const;
type ThresholdDays = (typeof THRESHOLDS)[number];

// ── Deduplication via AuditEvent ──────────────────────────────────────────────

async function hasExpiryEventBeenFired(certId: string, daysThreshold: number): Promise<boolean> {
  const existing = await prismaRead.auditEvent.findFirst({
    where: {
      certificateId: certId,
      eventType: 'certificate_published',
      details: {
        path: ['action'],
        equals: `expiry_warning_${daysThreshold}d`,
      },
    },
    select: { id: true },
  });
  return !!existing;
}

async function markExpiryEventFired(
  contractAddress: string,
  certId: string,
  daysThreshold: number,
  daysRemaining: number,
): Promise<void> {
  await prismaWrite.auditEvent.create({
    data: {
      contractAddress,
      certificateId: certId,
      eventType: 'certificate_published',
      triggerSource: 'automatic',
      timestamp: new Date(),
      details: {
        action: `expiry_warning_${daysThreshold}d`,
        daysRemaining,
        threshold: daysThreshold,
      } as import('@prisma/client').Prisma.InputJsonValue,
    },
  });
}

// ── Single check cycle ────────────────────────────────────────────────────────

async function runExpiryCheckCycle(): Promise<void> {
  const now = new Date();
  // Look ahead 31 days to catch all three thresholds in one query
  const lookAhead = new Date(now.getTime() + 31 * 86400000);

  const expiring = await prismaRead.auditCertificate.findMany({
    where: {
      status: 'published',
      expiresAt: { gte: now, lte: lookAhead },
    },
    select: {
      id: true,
      contractAddress: true,
      version: true,
      overallScore: true,
      certificateHash: true,
      expiresAt: true,
    },
  });

  if (expiring.length === 0) return;

  logger.info('Expiry checker: certs approaching expiry', { count: expiring.length });

  for (const cert of expiring) {
    if (!cert.expiresAt) continue;

    const msRemaining = cert.expiresAt.getTime() - now.getTime();
    const daysRemaining = Math.ceil(msRemaining / 86400000);

    // Determine which thresholds apply and haven't fired yet
    for (const threshold of THRESHOLDS) {
      if (daysRemaining > threshold) continue; // not yet at this threshold

      const alreadyFired = await hasExpiryEventBeenFired(cert.id, threshold);
      if (alreadyFired) continue;

      const urgency: 'warning' | 'urgent' | 'critical' =
        threshold === 7 ? 'critical' : threshold === 14 ? 'urgent' : 'warning';

      // ── WS broadcast ───────────────────────────────────────────────────────
      broadcastCertExpiry({
        contractAddress: cert.contractAddress,
        certId: cert.id,
        certificateHash: cert.certificateHash,
        version: cert.version,
        expiresAt: cert.expiresAt.toISOString(),
        daysRemaining,
        urgency,
        renewUrl: `/api/v1/contracts/${cert.contractAddress}/audit/refresh`,
      });

      // ── Push notifications (email / webhook / Slack) ─────────────────────
      notifyCertificateExpiry(
        cert.contractAddress,
        cert.id,
        cert.version,
        cert.overallScore,
        cert.certificateHash,
        cert.expiresAt,
        daysRemaining,
      ).catch((e) =>
        logger.warn('Expiry push notification failed', {
          certId: cert.id,
          error: String(e),
        }),
      );

      // ── Persist deduplication event ───────────────────────────────────────
      await markExpiryEventFired(cert.contractAddress, cert.id, threshold, daysRemaining);

      // ── Auto re-audit at 7-day threshold ──────────────────────────────────
      // Fire a full re-audit so a fresh cert is ready before the current expires
      if (threshold === 7) {
        runAuditPipeline({
          contractAddress: cert.contractAddress,
          trigger: 'scheduled',
          mode: 'full',
          calledBy: 'expiry-checker',
        }).catch((e) =>
          logger.warn('Expiry-triggered re-audit failed', {
            address: cert.contractAddress,
            error: String(e),
          }),
        );

        logger.info('Auto re-audit triggered (7-day expiry)', {
          contractAddress: cert.contractAddress,
          certId: cert.id,
        });
      }

      logger.info('Certificate expiry alert fired', {
        contractAddress: cert.contractAddress,
        certId: cert.id,
        daysRemaining,
        threshold,
        urgency,
      });
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

let expiryTimer: ReturnType<typeof setInterval> | null = null;

export function startAuditExpiryChecker(): void {
  if (expiryTimer) return;

  // First run after 2-minute startup grace
  setTimeout(
    () => {
      runExpiryCheckCycle().catch((e) =>
        logger.error('Expiry check cycle error', { error: String(e) }),
      );
    },
    2 * 60 * 1000,
  );

  expiryTimer = setInterval(() => {
    runExpiryCheckCycle().catch((e) =>
      logger.error('Expiry check cycle error', { error: String(e) }),
    );
  }, CHECK_INTERVAL_MS);

  logger.info('Certificate expiry checker started', {
    intervalHours: CHECK_INTERVAL_MS / 3600000,
    thresholdDays: THRESHOLDS,
  });
}

export function stopAuditExpiryChecker(): void {
  if (expiryTimer) {
    clearInterval(expiryTimer);
    expiryTimer = null;
  }
}

/** Expose for testing / manual trigger */
export { runExpiryCheckCycle };
