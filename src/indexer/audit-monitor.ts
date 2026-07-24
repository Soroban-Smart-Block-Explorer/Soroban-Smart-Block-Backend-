/**
 * Continuous Audit Monitor
 *
 * Polls for real-time signals across 7 categories that affect a contract's
 * audit score, then decides whether to (a) emit a WS signal only or (b)
 * fire a full incremental re-audit via the pipeline.
 *
 * Signal categories:
 *   reentrancy        — new ReentrancyAlert with severity high/medium
 *   mev_attack        — new MevEvent (sandwich, flash_loan_attack) targeting contract
 *   dependency_risk   — new critical/high ThreatAdvisory on an affected contract
 *   admin_change      — new WasmUpgradeHistory (admin key transfer / config change)
 *   tvl_change        — TVL moved ≥ TVL_DROP_PCT% since last audit
 *   user_change       — unique user count moved ≥ USER_DROP_PCT%
 *   sanctions         — new SanctionedAddress match for associated addresses
 *
 * Re-audit thresholds (each signal has a severity → action mapping):
 *   critical/high  → immediate incremental re-audit
 *   medium         → flag + schedule in next daily batch
 *   low            → WS signal only
 */

import { prismaRead, prismaWrite } from '../db';
import { logger } from '../logger';
import {
  broadcastScoreAlert,
  broadcastFindingAlert,
  broadcastCertificateUpdate,
  broadcastSignal,
  type SignalPayload,
} from '../ws/auditBroadcaster';
import { runAuditPipeline } from './audit-pipeline';
import {
  notifyScoreDrop,
  notifyNewFinding,
  notifyUpgrade,
  notifyCertificateUpdate,
} from '../lib/audit-notifier';
import {
  incidentCriticalFinding,
  incidentScoreDropBelowThreshold,
} from '../lib/incident-dispatcher';

// ── Configuration ─────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = parseInt(process.env.AUDIT_MONITOR_POLL_MS ?? '60000'); // 1 min
const TVL_DROP_PCT = parseFloat(process.env.AUDIT_TVL_DROP_PCT ?? '15'); // 15% drop
const USER_DROP_PCT = parseFloat(process.env.AUDIT_USER_DROP_PCT ?? '20'); // 20% drop
const SCORE_ALERT_DROP = parseInt(process.env.AUDIT_SCORE_ALERT_DROP ?? '10'); // 10 point drop

export type MonitorSignalType =
  | 'reentrancy'
  | 'mev_attack'
  | 'dependency_risk'
  | 'admin_change'
  | 'tvl_change'
  | 'user_change'
  | 'sanctions';

interface DetectedSignal {
  contractAddress: string;
  signalType: MonitorSignalType;
  severity: 'low' | 'medium' | 'high' | 'critical';
  summary: string;
  detail: Record<string, unknown>;
  triggerReaudit: boolean;
}

// ── Cursor management ─────────────────────────────────────────────────────────
// Tracks the high-water mark per signal type so we only look at new records.
// Stored in-memory; resets on restart (safe — worst case is duplicate signals).

const cursors: Record<MonitorSignalType, Date> = {
  reentrancy: new Date(0),
  mev_attack: new Date(0),
  dependency_risk: new Date(0),
  admin_change: new Date(0),
  tvl_change: new Date(0),
  user_change: new Date(0),
  sanctions: new Date(0),
};

function advanceCursor(type: MonitorSignalType, to: Date): void {
  if (to > cursors[type]) cursors[type] = to;
}

// ── Signal detectors ──────────────────────────────────────────────────────────

async function detectReentrancy(): Promise<DetectedSignal[]> {
  const since = cursors.reentrancy;
  const alerts = await prismaRead.reentrancyAlert.findMany({
    where: { createdAt: { gt: since }, severity: { in: ['high', 'medium'] } },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });

  const signals: DetectedSignal[] = [];
  for (const a of alerts) {
    signals.push({
      contractAddress: a.contractAddress,
      signalType: 'reentrancy',
      severity: a.severity === 'high' ? 'high' : 'medium',
      summary: `Reentrancy pattern detected in tx ${a.transactionHash.slice(0, 10)}…`,
      detail: {
        transactionHash: a.transactionHash,
        repeatedWithdrawCalls: a.repeatedWithdrawCalls,
        maxCallDepth: a.maxCallDepth,
        severity: a.severity,
        signals: a.signals,
      },
      triggerReaudit: a.severity === 'high',
    });
    advanceCursor('reentrancy', a.createdAt);
  }
  return signals;
}

async function detectMevAttacks(): Promise<DetectedSignal[]> {
  const since = cursors.mev_attack;
  const events = await prismaRead.mevEvent.findMany({
    where: {
      createdAt: { gt: since },
      mevType: { in: ['sandwich', 'flash_loan_attack'] },
      protocolAddress: { not: null },
    },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });

  const signals: DetectedSignal[] = [];
  for (const e of events) {
    if (!e.protocolAddress) continue;
    const isFlash = e.mevType === 'flash_loan_attack';
    const severity = isFlash ? 'high' : 'medium';
    signals.push({
      contractAddress: e.protocolAddress,
      signalType: 'mev_attack',
      severity,
      summary: `${e.mevType.replace('_', ' ')} detected — ${e.confidence.toFixed(2)} confidence`,
      detail: {
        txHash: e.txHash,
        mevType: e.mevType,
        attackerAddress: e.attackerAddress,
        lossUsd: e.lossUsd,
        profitUsd: e.profitUsd,
        confidence: e.confidence,
      },
      triggerReaudit: isFlash,
    });
    advanceCursor('mev_attack', e.createdAt);
  }
  return signals;
}

async function detectDependencyRisk(): Promise<DetectedSignal[]> {
  const since = cursors.dependency_risk;
  const advisories = await prismaRead.threatAdvisory.findMany({
    where: {
      createdAt: { gt: since },
      severity: { in: ['critical', 'high'] },
    },
    orderBy: { createdAt: 'asc' },
    take: 20,
  });

  const signals: DetectedSignal[] = [];
  for (const adv of advisories) {
    for (const addr of adv.affectedContracts) {
      signals.push({
        contractAddress: addr,
        signalType: 'dependency_risk',
        severity: adv.severity as 'high' | 'critical',
        summary: `New ${adv.severity} advisory: ${adv.title}`,
        detail: {
          advisoryId: adv.id,
          title: adv.title,
          cvssScore: adv.cvssScore,
          cveId: adv.cveId,
          mitigations: adv.mitigations,
        },
        triggerReaudit: true,
      });
    }
    advanceCursor('dependency_risk', adv.createdAt);
  }
  return signals;
}

async function detectAdminChanges(): Promise<DetectedSignal[]> {
  const since = cursors.admin_change;
  const upgrades = await prismaRead.wasmUpgradeHistory.findMany({
    where: { createdAt: { gt: since } },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });

  const signals: DetectedSignal[] = [];
  for (const u of upgrades) {
    const isSuspicious = u.isSuspicious;
    const isCritical = u.changeClassification === 'critical' || u.riskLevel === 'critical';
    const severity: 'low' | 'medium' | 'high' | 'critical' = isCritical
      ? 'critical'
      : isSuspicious
        ? 'high'
        : u.changeClassification === 'major'
          ? 'medium'
          : 'low';

    signals.push({
      contractAddress: u.contractAddress,
      signalType: 'admin_change',
      severity,
      summary: `WASM upgrade detected — ${u.changeClassification ?? 'unknown'} change by ${u.upgrader ?? 'unknown'}`,
      detail: {
        newHash: u.newHash,
        previousHash: u.previousHash,
        upgrader: u.upgrader,
        governanceType: u.governanceType,
        changeClassification: u.changeClassification,
        isSuspicious: u.isSuspicious,
        suspiciousFlags: u.suspiciousFlags,
        timelockSeconds: u.timelockSeconds,
      },
      triggerReaudit: severity === 'critical' || severity === 'high',
    });
    advanceCursor('admin_change', u.createdAt);
  }
  return signals;
}

async function detectTvlChanges(): Promise<DetectedSignal[]> {
  const since = cursors.tvl_change;
  const signals: DetectedSignal[] = [];

  // Find contracts with portfolio snapshots created since cursor
  const newSnapshots = await prismaRead.portfolioSnapshot.findMany({
    where: { snapshotAt: { gt: since } },
    orderBy: { snapshotAt: 'asc' },
    take: 100,
    distinct: ['contractAddress'],
    select: { contractAddress: true, valueUsd: true, snapshotAt: true },
  });

  for (const snap of newSnapshots) {
    // Find previous snapshot (before cursor) for comparison
    const prev = await prismaRead.portfolioSnapshot.findFirst({
      where: { contractAddress: snap.contractAddress, snapshotAt: { lte: since } },
      orderBy: { snapshotAt: 'desc' },
      select: { valueUsd: true },
    });

    if (!prev || !prev.valueUsd || !snap.valueUsd) {
      advanceCursor('tvl_change', snap.snapshotAt);
      continue;
    }

    const prevVal = prev.valueUsd;
    const newVal = snap.valueUsd;
    const changePct = prevVal > 0 ? ((newVal - prevVal) / prevVal) * 100 : 0;

    if (Math.abs(changePct) >= TVL_DROP_PCT) {
      const isDropping = changePct < 0;
      signals.push({
        contractAddress: snap.contractAddress,
        signalType: 'tvl_change',
        severity: Math.abs(changePct) >= 40 ? 'high' : 'medium',
        summary: `TVL ${isDropping ? 'dropped' : 'surged'} ${Math.abs(changePct).toFixed(1)}% (${prevVal.toFixed(0)} → ${newVal.toFixed(0)} USD)`,
        detail: { previousTvl: prevVal, currentTvl: newVal, changePct: changePct.toFixed(2) },
        triggerReaudit: Math.abs(changePct) >= 30,
      });
    }
    advanceCursor('tvl_change', snap.snapshotAt);
  }
  return signals;
}

async function detectUserChanges(): Promise<DetectedSignal[]> {
  const since = cursors.user_change;
  const signals: DetectedSignal[] = [];
  const now = new Date();
  const prev7d = new Date(now.getTime() - 7 * 86400000);
  const prev14d = new Date(now.getTime() - 14 * 86400000);

  // Only check contracts that had new transactions since cursor
  const activeContracts = await prismaRead.transaction.findMany({
    where: { ledgerCloseTime: { gt: since } },
    distinct: ['contractAddress'],
    select: { contractAddress: true },
    take: 200,
  });

  for (const { contractAddress } of activeContracts) {
    if (!contractAddress) continue;

    const [currentWeek, prevWeek] = await Promise.all([
      prismaRead.transaction.groupBy({
        by: ['sourceAccount'],
        where: { contractAddress, ledgerCloseTime: { gte: prev7d } },
        _count: { id: true },
      }),
      prismaRead.transaction.groupBy({
        by: ['sourceAccount'],
        where: { contractAddress, ledgerCloseTime: { gte: prev14d, lt: prev7d } },
        _count: { id: true },
      }),
    ]);

    const curr = currentWeek.length;
    const prev = prevWeek.length;
    if (prev < 5) continue; // too few users for meaningful signal

    const changePct = ((curr - prev) / prev) * 100;
    if (Math.abs(changePct) >= USER_DROP_PCT && curr < prev) {
      signals.push({
        contractAddress,
        signalType: 'user_change',
        severity: changePct < -40 ? 'high' : 'medium',
        summary: `Unique users dropped ${Math.abs(changePct).toFixed(1)}% week-over-week (${prev} → ${curr})`,
        detail: {
          previousWeekUsers: prev,
          currentWeekUsers: curr,
          changePct: changePct.toFixed(2),
        },
        triggerReaudit: changePct < -30,
      });
    }
  }

  advanceCursor('user_change', now);
  return signals;
}

async function detectSanctions(): Promise<DetectedSignal[]> {
  const since = cursors.sanctions;
  const signals: DetectedSignal[] = [];

  const newSanctions = await prismaRead.sanctionedAddress.findMany({
    where: { addedAt: { gt: since } },
    orderBy: { addedAt: 'asc' },
    take: 50,
    select: { address: true, listSource: true, jurisdiction: true, addedAt: true },
  });

  for (const sanction of newSanctions) {
    // Check if this address is a deployer or admin for any tracked contract
    const [asDeploy, asAdmin] = await Promise.all([
      prismaRead.transaction.findFirst({
        where: { sourceAccount: sanction.address },
        select: { contractAddress: true },
      }),
      prismaRead.wasmUpgradeHistory.findFirst({
        where: { upgrader: sanction.address },
        select: { contractAddress: true },
      }),
    ]);

    const affectedAddr = asDeploy?.contractAddress ?? asAdmin?.contractAddress;
    if (!affectedAddr) {
      advanceCursor('sanctions', sanction.addedAt);
      continue;
    }

    signals.push({
      contractAddress: affectedAddr,
      signalType: 'sanctions',
      severity: 'critical',
      summary: `Associated address ${sanction.address.slice(0, 10)}… added to ${sanction.listSource}`,
      detail: {
        sanctionedAddress: sanction.address,
        listSource: sanction.listSource,
        jurisdiction: sanction.jurisdiction,
        role: asDeploy ? 'deployer' : 'admin',
      },
      triggerReaudit: true,
    });
    advanceCursor('sanctions', sanction.addedAt);
  }
  return signals;
}

// ── Score-drop detection (post-audit) ─────────────────────────────────────────

/**
 * After a new certificate is published, compare against the previous version
 * and fire WS + subscription alerts if the score dropped by the threshold.
 * Also broadcasts individual alerts for each new critical/high finding.
 */
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

// ── Main monitor poll cycle ───────────────────────────────────────────────────

async function runMonitorCycle(): Promise<void> {
  // Run all 7 detectors in parallel
  const [
    reentrancySignals,
    mevSignals,
    depSignals,
    adminSignals,
    tvlSignals,
    userSignals,
    sanctionSignals,
  ] = await Promise.all([
    detectReentrancy().catch((e) => {
      logger.warn('Reentrancy detector error', { error: String(e) });
      return [];
    }),
    detectMevAttacks().catch((e) => {
      logger.warn('MEV detector error', { error: String(e) });
      return [];
    }),
    detectDependencyRisk().catch((e) => {
      logger.warn('Dependency detector error', { error: String(e) });
      return [];
    }),
    detectAdminChanges().catch((e) => {
      logger.warn('Admin change detector error', { error: String(e) });
      return [];
    }),
    detectTvlChanges().catch((e) => {
      logger.warn('TVL detector error', { error: String(e) });
      return [];
    }),
    detectUserChanges().catch((e) => {
      logger.warn('User change detector error', { error: String(e) });
      return [];
    }),
    detectSanctions().catch((e) => {
      logger.warn('Sanctions detector error', { error: String(e) });
      return [];
    }),
  ]);

  const allSignals: DetectedSignal[] = [
    ...reentrancySignals,
    ...mevSignals,
    ...depSignals,
    ...adminSignals,
    ...tvlSignals,
    ...userSignals,
    ...sanctionSignals,
  ];

  if (allSignals.length === 0) return;

  logger.info('Audit monitor: signals detected', { count: allSignals.length });

  // Deduplicate: one re-audit per contract address per cycle regardless of
  // how many signals fired for it
  const reauditSet = new Set<string>();

  for (const signal of allSignals) {
    // Broadcast to WS clients immediately
    broadcastSignal({
      contractAddress: signal.contractAddress,
      signalType: signal.signalType,
      severity: signal.severity,
      summary: signal.summary,
      detail: signal.detail,
      willTriggerAudit: signal.triggerReaudit,
      detectedAt: new Date().toISOString(),
    } satisfies SignalPayload);

    // Write to AuditEvent for persistent trail
    await prismaWrite.auditEvent
      .create({
        data: {
          contractAddress: signal.contractAddress,
          eventType: 'vulnerability_discovered',
          triggerSource: 'automatic',
          timestamp: new Date(),
          details: {
            signalType: signal.signalType,
            severity: signal.severity,
            summary: signal.summary,
            ...signal.detail,
          } as import('@prisma/client').Prisma.InputJsonValue,
        },
      })
      .catch(() => {
        /* non-fatal */
      });

    if (signal.triggerReaudit) {
      reauditSet.add(signal.contractAddress);
    }
  }

  // Fire re-audits — staggered to avoid DB spikes
  for (const addr of reauditSet) {
    const trigger = allSignals.find(
      (s) => s.contractAddress === addr && s.signalType === 'admin_change',
    )
      ? 'upgrade'
      : allSignals.find((s) => s.contractAddress === addr && s.signalType === 'dependency_risk')
        ? 'dependency'
        : 'daily';

    runAuditPipeline({
      contractAddress: addr,
      trigger: trigger as import('./audit-pipeline').TriggerType,
      mode: 'incremental',
    })
      .then((result) => {
        emitPostAuditAlerts(addr, result.certId);
        // Fire upgrade notification if triggered by an admin change
        if (trigger === 'upgrade') {
          notifyUpgrade(
            addr,
            result.certId,
            result.version,
            result.overallScore,
            '', // certHash will be fetched inside the delivery
          ).catch((e) => logger.warn('notifyUpgrade failed', { addr, error: String(e) }));
        }
      })
      .catch((e) => logger.warn('Monitor-triggered audit failed', { addr, error: String(e) }));

    await new Promise((r) => setTimeout(r, 2000)); // 2 s stagger
  }
}

// ── Public: start monitor ─────────────────────────────────────────────────────

let monitorTimer: ReturnType<typeof setInterval> | null = null;

export function startContinuousAuditMonitor(): void {
  if (monitorTimer) return; // already running

  // Initialise cursors to "now minus one poll interval" so we don't flood on startup
  const startFrom = new Date(Date.now() - POLL_INTERVAL_MS);
  for (const key of Object.keys(cursors) as MonitorSignalType[]) {
    cursors[key] = startFrom;
  }

  // First cycle after 30 s startup grace
  setTimeout(() => {
    runMonitorCycle().catch((e) => logger.error('Audit monitor cycle error', { error: String(e) }));
  }, 30_000);

  monitorTimer = setInterval(() => {
    runMonitorCycle().catch((e) => logger.error('Audit monitor cycle error', { error: String(e) }));
  }, POLL_INTERVAL_MS);

  logger.info('Continuous audit monitor started', {
    pollIntervalMs: POLL_INTERVAL_MS,
    tvlDropThresholdPct: TVL_DROP_PCT,
    userDropThresholdPct: USER_DROP_PCT,
    scoreAlertDrop: SCORE_ALERT_DROP,
  });
}

export function stopContinuousAuditMonitor(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
}
