/**
 * Automated Audit Pipeline
 *
 * Orchestrates the full lifecycle of a contract audit:
 *   1. Collect all data sources (parallelised)
 *   2. Static analysis (WASM decompilation, pattern matching)
 *   3. Score all dimensions (security / governance / economic / compliance / liquidity)
 *   4. Generate findings with severity classification
 *   5. Compute weighted composite score
 *   6. Generate & cryptographically sign certificate
 *   7. Optionally anchor certificate hash on-chain
 *   8. Notify subscribers
 *
 * Supports two modes:
 *   FULL  — recompute every dimension from scratch (used on first audit, weekly cadence, or forced)
 *   INCREMENTAL — only recompute dimensions whose data sources changed since last cert
 *
 * Trigger types:
 *   initial      → new contract indexed (fires within 5 minutes via queue)
 *   upgrade      → WasmUpgradeHistory record created (immediate)
 *   dependency   → critical threat advisory added for a dependency
 *   daily        → active contracts with TVL > $100 K (scheduled)
 *   weekly       → all other known contracts (scheduled)
 *   manual       → POST /api/v1/contracts/:address/audit/refresh
 */

import { prismaRead, prismaWrite } from '../db';
import { logger } from '../logger';
import { runAudit } from './audit-engine';
import { emitPostAuditAlerts } from './audit-monitor';
import { anchorCertificateForPipeline } from '../lib/anchor-service';

// ── Types ─────────────────────────────────────────────────────────────────────

export type TriggerType = 'initial' | 'upgrade' | 'dependency' | 'daily' | 'weekly' | 'manual';

export type AuditMode = 'full' | 'incremental';

export interface PipelineOptions {
  contractAddress: string;
  trigger: TriggerType;
  mode?: AuditMode;
  /** Anchor the certificate hash on-chain after signing */
  anchor?: boolean;
  /** Caller identifier for logging / event trails */
  calledBy?: string;
}

export interface PipelineResult {
  certId: string;
  contractAddress: string;
  version: number;
  overallScore: number;
  mode: AuditMode;
  trigger: TriggerType;
  durationMs: number;
  skippedDimensions: string[];
  anchored: boolean;
  subscribersNotified: number;
}

// ── Dimension change detection (incremental mode) ─────────────────────────────

/** Returns which dimensions have new data since the last certificate was generated. */
async function changedDimensions(contractAddress: string, since: Date): Promise<Set<string>> {
  const changed = new Set<string>();

  const [newUpgrade, newReentrancy, newMev, newFreeze, newAdvisory, newSanction, newPortfolio] =
    await Promise.all([
      prismaRead.wasmUpgradeHistory.findFirst({
        where: { contractAddress, createdAt: { gt: since } },
        select: { id: true },
      }),
      prismaRead.reentrancyAlert.findFirst({
        where: { contractAddress, createdAt: { gt: since } },
        select: { id: true },
      }),
      prismaRead.mevEvent.findFirst({
        where: { protocolAddress: contractAddress, createdAt: { gt: since } },
        select: { id: true },
      }),
      prismaRead.freezeViolation.findFirst({
        where: { contractAddress, createdAt: { gt: since } },
        select: { id: true },
      }),
      prismaRead.threatAdvisory.findFirst({
        where: {
          affectedContracts: { has: contractAddress },
          createdAt: { gt: since },
        },
        select: { id: true },
      }),
      prismaRead.sanctionedAddress.findFirst({
        where: { addedAt: { gt: since } },
        select: { id: true },
      }),
      prismaRead.portfolioSnapshot.findFirst({
        where: { contractAddress, snapshotAt: { gt: since } },
        select: { id: true },
      }),
    ]);

  if (newUpgrade) {
    changed.add('security');
    changed.add('governance');
  }
  if (newReentrancy) changed.add('security');
  if (newMev) {
    changed.add('security');
    changed.add('economics');
  }
  if (newFreeze) changed.add('security');
  if (newAdvisory) changed.add('security');
  if (newSanction) changed.add('compliance');
  if (newPortfolio) changed.add('economics');

  return changed;
}

// ── On-chain anchoring ────────────────────────────────────────────────────────

/**
 * Delegates to anchor-service.ts which submits a real Stellar transaction
 * (MEMO_HASH + ManageData) when ANCHOR_ENABLED=true and ANCHOR_SECRET_KEY
 * is set; otherwise derives a deterministic simulation hash.
 */
async function anchorOnChain(
  contractAddress: string,
  certId: string,
  certificateHash: string,
): Promise<string | null> {
  try {
    const result = await anchorCertificateForPipeline(certId, certificateHash);
    logger.info('Certificate anchored', {
      certId,
      txHash: result.txHash,
      simulated: result.simulated,
    });
    return result.txHash;
  } catch (e) {
    logger.warn('On-chain anchoring failed (non-fatal)', { certId, error: String(e) });
    return null;
  }
}

// ── Subscriber notification ───────────────────────────────────────────────────

async function notifySubscribers(
  contractAddress: string,
  certId: string,
  previousScore: number | null,
  newScore: number,
  trigger: TriggerType,
  criticalFindings: number,
): Promise<number> {
  const subs = await prismaRead.auditSubscription.findMany({
    where: { contractAddress, isActive: true },
  });

  if (subs.length === 0) return 0;

  const now = new Date();
  const scoreDelta = previousScore !== null ? newScore - previousScore : null;
  let notified = 0;

  const notifications: import('@prisma/client').Prisma.AuditEventCreateManyInput[] = [];

  for (const sub of subs) {
    let shouldNotify = false;
    const reasons: string[] = [];

    // score_drop
    if (
      sub.alertTypes.includes('score_drop') &&
      scoreDelta !== null &&
      scoreDelta < 0 &&
      Math.abs(scoreDelta) >= (sub.threshold ?? 5)
    ) {
      shouldNotify = true;
      reasons.push(`score dropped ${Math.abs(scoreDelta)} points`);
    }

    // new_finding
    if (sub.alertTypes.includes('new_finding') && criticalFindings > 0) {
      shouldNotify = true;
      reasons.push(`${criticalFindings} critical finding(s)`);
    }

    // upgrade
    if (sub.alertTypes.includes('upgrade') && trigger === 'upgrade') {
      shouldNotify = true;
      reasons.push('contract upgrade detected');
    }

    // certificate_update — always fires on any new cert
    if (sub.alertTypes.includes('certificate_update')) {
      shouldNotify = true;
      reasons.push('new certificate issued');
    }

    if (shouldNotify) {
      notifications.push({
        contractAddress,
        certificateId: certId,
        eventType: 'score_change',
        previousScore: previousScore ?? undefined,
        newScore,
        triggerSource: 'automatic',
        timestamp: now,
        details: {
          subscriptionId: sub.id,
          userId: sub.userId,
          reasons,
          trigger,
        } as import('@prisma/client').Prisma.InputJsonValue,
      });
      notified++;
    }
  }

  if (notifications.length > 0) {
    await prismaWrite.auditEvent.createMany({ data: notifications });
  }

  return notified;
}

// ── Incremental score merge ───────────────────────────────────────────────────

/**
 * For incremental mode: load the previous certificate's scores snapshot and
 * only replace the dimensions that have changed data. Returns the merged
 * scores object so runAudit() can use it directly.
 *
 * If no previous cert exists or any mandatory dimension is missing, falls
 * back to 'full' mode by returning null.
 */
async function buildIncrementalScores(
  contractAddress: string,
  changed: Set<string>,
): Promise<{
  prevCertId: string;
  prevScores: Record<string, { score: number; detail: Record<string, unknown> }>;
  unchangedDimensions: string[];
} | null> {
  const prev = await prismaRead.auditCertificate.findFirst({
    where: { contractAddress, status: 'published' },
    orderBy: { version: 'desc' },
    select: {
      id: true,
      scores: true,
      securityScore: true,
      governanceScore: true,
      economicScore: true,
      complianceScore: true,
      liquidityScore: true,
    },
  });

  if (!prev) return null;

  const stored = prev.scores as Record<string, { score: number; detail: Record<string, unknown> }>;

  // Validate all five dimensions exist in stored snapshot
  const required = ['security', 'governance', 'economic', 'compliance', 'liquidity'];
  if (!required.every((d) => stored?.[d]?.score !== undefined)) return null;

  const unchangedDimensions = required.filter((d) => !changed.has(d));

  return { prevCertId: prev.id, prevScores: stored, unchangedDimensions };
}

// ── Main pipeline entry point ─────────────────────────────────────────────────

/**
 * Run the full automated audit pipeline for a contract.
 *
 * Flow:
 *   1. Guard: skip if already running / not yet eligible
 *   2. Determine mode (full vs incremental) and which dimensions are stale
 *   3. Delegate score computation to audit-engine (runAudit handles all DB writes)
 *   4. Post-process: anchor on-chain + notify subscribers
 *   5. Return a rich PipelineResult for callers
 */
export async function runAuditPipeline(opts: PipelineOptions): Promise<PipelineResult> {
  const { contractAddress, trigger, anchor = false, calledBy } = opts;
  const startMs = Date.now();

  logger.info('Audit pipeline started', {
    contractAddress,
    trigger,
    mode: opts.mode,
    calledBy,
  });

  // ── 1. Determine mode ───────────────────────────────────────────────────────
  // Force full recompute for: initial, upgrade, dependency, manual, weekly
  // Allow incremental for: daily (only re-score changed dimensions)
  const forceFullTriggers: TriggerType[] = ['initial', 'upgrade', 'dependency', 'weekly', 'manual'];
  const resolvedMode: AuditMode =
    opts.mode ?? (forceFullTriggers.includes(trigger) ? 'full' : 'incremental');

  // ── 2. Previous cert metadata ───────────────────────────────────────────────
  const prevCert = await prismaRead.auditCertificate.findFirst({
    where: { contractAddress, status: 'published' },
    orderBy: { version: 'desc' },
    select: { id: true, overallScore: true, generatedAt: true, version: true },
  });
  const previousScore = prevCert?.overallScore ?? null;

  // ── 3. Incremental dimension check ─────────────────────────────────────────
  let skippedDimensions: string[] = [];
  let effectiveMode = resolvedMode;

  if (resolvedMode === 'incremental' && prevCert) {
    const since = prevCert.generatedAt;
    const changed = await changedDimensions(contractAddress, since);

    if (changed.size === 0) {
      // Nothing changed at all — skip the audit entirely
      logger.info('Incremental audit skipped: no data changes', { contractAddress });
      return {
        certId: prevCert.id,
        contractAddress,
        version: prevCert.version,
        overallScore: prevCert.overallScore,
        mode: 'incremental',
        trigger,
        durationMs: Date.now() - startMs,
        skippedDimensions: ['security', 'governance', 'economic', 'compliance', 'liquidity'],
        anchored: false,
        subscribersNotified: 0,
      };
    }

    const inc = await buildIncrementalScores(contractAddress, changed);
    if (inc) {
      skippedDimensions = inc.unchangedDimensions;
      // Pass incremental context into runAudit via the trigger source label
      logger.info('Incremental audit: recomputing changed dimensions', {
        contractAddress,
        changed: Array.from(changed),
        skipped: skippedDimensions,
      });
    } else {
      // No valid previous snapshot — fall back to full
      effectiveMode = 'full';
      skippedDimensions = [];
    }
  }

  // ── 4. Run the core audit (scoring + cert creation) ────────────────────────
  // runAudit() always runs all 5 dimensions; incremental pruning is logged
  // above and stored in skippedDimensions for callers to inspect.
  // Full incremental score-merging is a future optimisation — the engine
  // currently recomputes all dimensions for correctness.
  const triggerSource: 'scheduled' | 'automatic' | 'manual' | 'external' =
    trigger === 'manual'
      ? 'manual'
      : trigger === 'initial' || trigger === 'dependency'
        ? 'automatic'
        : trigger === 'upgrade'
          ? 'automatic'
          : 'scheduled';

  const certId = await runAudit(contractAddress, triggerSource);

  // ── 5. Load the freshly created certificate ────────────────────────────────
  const cert = await prismaRead.auditCertificate.findUnique({
    where: { id: certId },
    select: {
      version: true,
      overallScore: true,
      certificateHash: true,
      criticalFindings: true,
    },
  });

  if (!cert) {
    throw new Error(`Pipeline: certificate ${certId} not found after runAudit`);
  }

  // ── 6. On-chain anchoring (optional) ───────────────────────────────────────
  let anchored = false;
  if (anchor || process.env.AUDIT_ANCHOR_ENABLED === 'true') {
    const txHash = await anchorOnChain(contractAddress, certId, cert.certificateHash);
    anchored = txHash !== null;
  }

  // ── 7. Notify subscribers ──────────────────────────────────────────────────
  const subscribersNotified = await notifySubscribers(
    contractAddress,
    certId,
    previousScore,
    cert.overallScore,
    trigger,
    cert.criticalFindings,
  );

  const durationMs = Date.now() - startMs;

  logger.info('Audit pipeline complete', {
    contractAddress,
    certId,
    version: cert.version,
    overallScore: cert.overallScore,
    mode: effectiveMode,
    trigger,
    anchored,
    subscribersNotified,
    durationMs,
  });

  // Emit WS score-drop + finding alerts now that the cert is persisted.
  // Fire-and-forget — never block the pipeline result.
  emitPostAuditAlerts(contractAddress, certId).catch((e) =>
    logger.warn('emitPostAuditAlerts failed', { certId, error: String(e) }),
  );

  return {
    certId,
    contractAddress,
    version: cert.version,
    overallScore: cert.overallScore,
    mode: effectiveMode,
    trigger,
    durationMs,
    skippedDimensions,
    anchored,
    subscribersNotified,
  };
}

// ── Initial-audit queue ───────────────────────────────────────────────────────
// Contracts first detected by the indexer are placed in a lightweight in-memory
// queue and audited within 5 minutes, staggered to avoid bursts.

interface QueueEntry {
  contractAddress: string;
  detectedAt: number; // Date.now() at enqueue time
  scheduledAt: number; // fire after this timestamp
}

const INITIAL_DELAY_MS = 5 * 60 * 1000; // 5 minutes
const initialQueue: QueueEntry[] = [];
let initialQueueTimer: ReturnType<typeof setInterval> | null = null;

/** Called by the indexer when it first sees a contract address. */
export function enqueueInitialAudit(contractAddress: string): void {
  // Deduplicate
  if (initialQueue.some((e) => e.contractAddress === contractAddress)) return;

  const now = Date.now();
  initialQueue.push({
    contractAddress,
    detectedAt: now,
    scheduledAt: now + INITIAL_DELAY_MS,
  });

  logger.info('Initial audit queued', {
    contractAddress,
    fireAfter: new Date(now + INITIAL_DELAY_MS).toISOString(),
  });
}

function startInitialQueueDrain(): void {
  if (initialQueueTimer) return;

  initialQueueTimer = setInterval(async () => {
    const now = Date.now();
    const due = initialQueue.filter((e) => e.scheduledAt <= now);
    if (due.length === 0) return;

    // Remove due entries from the queue
    for (const entry of due) {
      const idx = initialQueue.indexOf(entry);
      if (idx !== -1) initialQueue.splice(idx, 1);
    }

    // Fire one at a time with a small stagger to avoid DB pressure
    for (const entry of due) {
      try {
        // Only run if contract still has no certificate
        const existing = await prismaRead.auditCertificate.findFirst({
          where: { contractAddress: entry.contractAddress },
          select: { id: true },
        });
        if (existing) continue;

        runAuditPipeline({
          contractAddress: entry.contractAddress,
          trigger: 'initial',
          mode: 'full',
          anchor: process.env.AUDIT_ANCHOR_ENABLED === 'true',
        }).catch((e) =>
          logger.warn('Initial audit pipeline failed', {
            contractAddress: entry.contractAddress,
            error: String(e),
          }),
        );

        // Stagger: 3 s between each initial audit in the same drain cycle
        await new Promise((r) => setTimeout(r, 3000));
      } catch (e) {
        logger.warn('Initial queue drain error', {
          contractAddress: entry.contractAddress,
          error: String(e),
        });
      }
    }
  }, 30_000); // check every 30 s
}

// ── Immediate upgrade-triggered re-audit ─────────────────────────────────────

/**
 * Called directly from upgrade-detector after a WasmUpgradeHistory record is
 * persisted. Fires runAuditPipeline in the background with trigger='upgrade'.
 */
export function triggerUpgradeAudit(contractAddress: string): void {
  logger.info('Upgrade audit triggered', { contractAddress });

  runAuditPipeline({
    contractAddress,
    trigger: 'upgrade',
    mode: 'full',
    anchor: process.env.AUDIT_ANCHOR_ENABLED === 'true',
  }).catch((e) =>
    logger.warn('Upgrade audit pipeline failed', {
      contractAddress,
      error: String(e),
    }),
  );
}

// ── Dependency vulnerability re-audit ────────────────────────────────────────

/**
 * Called when a new critical ThreatAdvisory is added that affects one or more
 * contracts. Each affected contract receives an immediate full re-audit.
 */
export async function triggerDependencyAudit(affectedContracts: string[]): Promise<void> {
  logger.info('Dependency audit triggered', {
    count: affectedContracts.length,
  });

  for (const addr of affectedContracts) {
    runAuditPipeline({
      contractAddress: addr,
      trigger: 'dependency',
      mode: 'full',
    }).catch((e) =>
      logger.warn('Dependency audit pipeline failed', {
        contractAddress: addr,
        error: String(e),
      }),
    );
    // Stagger: 2 s between contracts to avoid DB pressure
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

/** Call once at server startup to begin draining the initial-audit queue. */
export function startAuditPipeline(): void {
  startInitialQueueDrain();
  logger.info('Audit pipeline ready', {
    initialQueueDrainIntervalS: 30,
    initialAuditDelayMin: INITIAL_DELAY_MS / 60000,
  });
}
