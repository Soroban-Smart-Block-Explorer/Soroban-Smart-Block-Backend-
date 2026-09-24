/**
 * Post-audit alert emission
 *
 * After a new certificate is published, compares against the previous version
 * and fires WebSocket + subscription alerts if the score dropped by the
 * threshold, plus individual alerts for each new critical/high finding.
 *
 * Extracted from audit-monitor.ts so that both audit-monitor.ts and
 * audit-pipeline.ts can depend on it without importing each other (this
 * breaks the module-initialization cycle between the two).
 */

import { prismaRead, prismaWrite } from '../db';
import { logger } from '../logger';
import {
  broadcastScoreAlert,
  broadcastFindingAlert,
  broadcastCertificateUpdate,
} from '../ws/auditBroadcaster';
import { notifyScoreDrop, notifyNewFinding, notifyCertificateUpdate } from '../lib/audit-notifier';
import {
  incidentCriticalFinding,
  incidentScoreDropBelowThreshold,
} from '../lib/incident-dispatcher';

export const SCORE_ALERT_DROP = parseInt(process.env.AUDIT_SCORE_ALERT_DROP ?? '10'); // 10 point drop

export async function emitPostAuditAlerts(
  contractAddress: string,
  newCertId: string,
): Promise<void> {
  const [newCert, prevCert] = await Promise.all([
    prismaRead.auditCertificate.findUnique({
      where: { id: newCertId },
      select: {
        id: true,
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
        generatedAt: true,
        certificateHash: true,
      },
    }),
    prismaRead.auditCertificate.findFirst({
      where: { contractAddress, status: 'superseded' },
      orderBy: { version: 'desc' },
      select: { overallScore: true, version: true },
    }),
  ]);

  if (!newCert) return;

  const grade =
    newCert.overallScore >= 85
      ? 'A'
      : newCert.overallScore >= 70
        ? 'B'
        : newCert.overallScore >= 55
          ? 'C'
          : newCert.overallScore >= 40
            ? 'D'
            : 'F';
  const risk =
    newCert.overallScore >= 85
      ? 'low'
      : newCert.overallScore >= 70
        ? 'medium'
        : newCert.overallScore >= 55
          ? 'high'
          : 'critical';

  // ── Always broadcast certificate update ──────────────────────────────────
  broadcastCertificateUpdate({
    contractAddress,
    certId: newCert.id,
    version: newCert.version,
    overallScore: newCert.overallScore,
    grade,
    riskLevel: risk,
    totalFindings: newCert.totalFindings,
    criticalFindings: newCert.criticalFindings,
    trigger: 'audit_complete',
    generatedAt: newCert.generatedAt.toISOString(),
    verifyUrl: `/api/v1/audit/verify/${newCert.id}`,
  });

  // ── Score drop alert ──────────────────────────────────────────────────────
  if (prevCert) {
    const drop = prevCert.overallScore - newCert.overallScore;
    if (drop >= SCORE_ALERT_DROP) {
      broadcastScoreAlert({
        contractAddress,
        previousScore: prevCert.overallScore,
        newScore: newCert.overallScore,
        drop,
        trigger: 'audit_complete',
        certId: newCert.id,
        version: newCert.version,
        riskLevel: risk,
        detectedAt: new Date().toISOString(),
      });

      // Deliver to email/webhook/Slack subscribers
      notifyScoreDrop(
        contractAddress,
        newCert.id,
        newCert.version,
        prevCert.overallScore,
        newCert.overallScore,
        newCert.certificateHash,
      ).catch((e) => logger.warn('notifyScoreDrop failed', { error: String(e) }));

      // PagerDuty/Opsgenie: P1 if score drops below critical threshold
      incidentScoreDropBelowThreshold(contractAddress, newCert.id, newCert.overallScore).catch(
        (e) => logger.warn('incidentScoreDropBelowThreshold failed', { error: String(e) }),
      );

      // Write AuditEvent for persistent record
      await prismaWrite.auditEvent.create({
        data: {
          contractAddress,
          certificateId: newCert.id,
          eventType: 'score_change',
          previousScore: prevCert.overallScore,
          newScore: newCert.overallScore,
          triggerSource: 'automatic',
          timestamp: new Date(),
          details: {
            drop,
            threshold: SCORE_ALERT_DROP,
            alerted: true,
          } as import('@prisma/client').Prisma.InputJsonValue,
        },
      });
    }
  }

  // ── New critical/high finding alerts ────────────────────────────────────
  const newFindings = await prismaRead.auditFinding.findMany({
    where: {
      certificateId: newCertId,
      severity: { in: ['critical', 'high'] },
      status: 'open',
    },
  });

  for (const f of newFindings) {
    broadcastFindingAlert({
      contractAddress,
      certId: newCert.id,
      findingId: f.id,
      severity: f.severity,
      category: f.category,
      title: f.title,
      cweId: f.cweId,
      cvssScore: f.cvssScore,
      detectedAt: f.createdAt.toISOString(),
    });

    // Deliver to email/webhook/Slack subscribers
    notifyNewFinding(
      contractAddress,
      newCert.id,
      f.severity,
      f.title,
      newCert.criticalFindings + newCert.highFindings,
      newCert.certificateHash,
    ).catch((e) => logger.warn('notifyNewFinding failed', { error: String(e) }));

    // PagerDuty/Opsgenie: P1 for critical findings in high-TVL contracts
    if (f.severity === 'critical') {
      incidentCriticalFinding(contractAddress, newCert.id, f.id, f.title).catch((e) =>
        logger.warn('incidentCriticalFinding failed', { error: String(e) }),
      );
    }

    // Write vulnerability_discovered event for each critical finding
    if (f.severity === 'critical') {
      await prismaWrite.auditEvent.create({
        data: {
          contractAddress,
          certificateId: newCert.id,
          eventType: 'vulnerability_discovered',
          triggerSource: 'automatic',
          timestamp: new Date(),
          details: {
            findingId: f.id,
            severity: f.severity,
            title: f.title,
            cweId: f.cweId,
          } as import('@prisma/client').Prisma.InputJsonValue,
        },
      });
    }
  }

  // Notify certificate_update subscribers for every new cert
  notifyCertificateUpdate(
    contractAddress,
    newCert.id,
    newCert.version,
    newCert.overallScore,
    newCert.certificateHash,
    'audit_complete',
  ).catch((e) => logger.warn('notifyCertificateUpdate failed', { error: String(e) }));
}
