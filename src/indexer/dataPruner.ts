import { prismaWrite as prisma } from '../db';
import { archiveRawXdr } from '../archival/archiver';
import { logger } from '../logger';

// =============================================================================
// Issue #1118 — Add the missing radix argument to parseInt calls in
// indexer/env parsing
// https://github.com/Soroban-Smart-Block-Explorer/Soroban-Smart-Block-Backend-/issues/1118
//
// ─── SITES IN THIS FILE ──────────────────────────────────────────────────────
//
// Line ~4: PRUNE_INTERVAL_MS
//   parseInt(process.env.PRUNE_INTERVAL_MS ?? '86400000')
//
// Line ~41 (getRetentionPolicies): FAILED_ITEM_RETENTION_DAYS
//   parseInt(process.env.FAILED_ITEM_RETENTION_DAYS ?? '7')
//
// Line ~44: VERIFICATION_JOB_RETENTION_DAYS
//   parseInt(process.env.VERIFICATION_JOB_RETENTION_DAYS ?? '90')
//
// Line ~47: DEAD_LETTER_RETENTION_DAYS
//   parseInt(process.env.DEAD_LETTER_RETENTION_DAYS ?? '30')
//
// Line ~50: EVENT_RETENTION_DAYS
//   parseInt(process.env.EVENT_RETENTION_DAYS ?? '180')
//
// ─── RISK ─────────────────────────────────────────────────────────────────────
//
// All five values are retention-day counts read from environment variables.
// Without a radix argument, parseInt uses base 10 by default in modern JS
// engines, EXCEPT when the string starts with "0" — in that case it may be
// interpreted as octal (base 8) in legacy environments. A value of "07" would
// parse as 7 in base-10 mode but as 7 also (octal 7 = decimal 7). However:
//
//   - "08" would parse as 0 in strict octal mode (8 is not a valid octal digit)
//   - An operator who sets FAILED_ITEM_RETENTION_DAYS=08 expecting 8 days
//     would get 0 days, causing ALL failed items to be immediately pruned.
//
// This is a real data-loss risk. The radix argument also makes intent
// unambiguous for future readers and satisfies the ESLint `radix: error` rule
// that this issue requires.
//
// ─── FIX ─────────────────────────────────────────────────────────────────────
//
// PREFERRED: use the typed config module (see issue #1120) once env vars are
// centralized there. The zod schema already handles coercion correctly:
//   z.coerce.number().int().positive().default(86400000)
// avoids parseInt entirely.
//
// IMMEDIATE FIX: Add `, 10` to each parseInt call here:
//
//   // BEFORE:
//   const PRUNE_INTERVAL_MS = parseInt(process.env.PRUNE_INTERVAL_MS ?? '86400000');
//
//   // AFTER:
//   const PRUNE_INTERVAL_MS = parseInt(process.env.PRUNE_INTERVAL_MS ?? '86400000', 10);
//
//   // Also in getRetentionPolicies():
//   parseInt(process.env.FAILED_ITEM_RETENTION_DAYS ?? '7', 10)
//   parseInt(process.env.VERIFICATION_JOB_RETENTION_DAYS ?? '90', 10)
//   parseInt(process.env.DEAD_LETTER_RETENTION_DAYS ?? '30', 10)
//   parseInt(process.env.EVENT_RETENTION_DAYS ?? '180', 10)
//
// ─── ESLINT CONFIG ────────────────────────────────────────────────────────────
//
// Add to .eslintrc.js / .eslintrc.json:
//   "rules": {
//     "radix": "error"
//   }
//
// This makes any future parseInt without a radix a hard CI failure.
//
// ─── FILES TO MODIFY ─────────────────────────────────────────────────────────
//
//   src/indexer/dataPruner.ts         ← (THIS FILE) 5 sites
//   src/indexer/audit-monitor.ts      ← 1 site (POLL_INTERVAL_MS)
//   src/indexer/graceful-degradation.ts ← 2 sites (skipped_events, backfill_queue)
//   .eslintrc.js / .eslintrc.json     ← add "radix": "error"
//
// =============================================================================

const PRUNE_INTERVAL_MS = parseInt(process.env.PRUNE_INTERVAL_MS ?? '86400000'); // 24h default

/** Compliance and audit tables that must NEVER be pruned under any circumstances */
export const COMPLIANCE_PROTECTED_TABLES = [
  'SanctionsList',
  'ScreeningResult',
  'TravelRuleRecord',
  'ComplianceReport',
  'AuditCertificate',
  'AuditEvent',
] as const;

export interface ModelRetentionPolicy {
  retentionDays: number;
  maxRecordsCap?: number;
  protected?: boolean;
}

export interface PruneOptions {
  dryRun?: boolean;
  overridePolicies?: Record<string, ModelRetentionPolicy>;
}

export interface PruneBatchAudit {
  modelName: string;
  retentionDays: number;
  cutoffDate: Date;
  deletedCount: number;
  dryRun: boolean;
  protected: boolean;
}

/** Get configured retention policies */
export function getRetentionPolicies(): Record<string, ModelRetentionPolicy> {
  return {
    failedItem: {
      retentionDays: parseInt(process.env.FAILED_ITEM_RETENTION_DAYS ?? '7'),
    },
    verificationJob: {
      retentionDays: parseInt(process.env.VERIFICATION_JOB_RETENTION_DAYS ?? '90'),
    },
    deadLetterItem: {
      retentionDays: parseInt(process.env.DEAD_LETTER_RETENTION_DAYS ?? '30'),
    },
    event: {
      retentionDays: parseInt(process.env.EVENT_RETENTION_DAYS ?? '180'),
    },
  };
}

/** Verify that compliance tables are strictly excluded from pruning */
export function assertComplianceTableProtection(tableName: string): void {
  if ((COMPLIANCE_PROTECTED_TABLES as readonly string[]).includes(tableName)) {
    throw new Error(
      `🚨 [SECURITY CRITICAL] Attempted to prune protected compliance table '${tableName}'. Pruning compliance tables is strictly prohibited.`,
    );
  }
}

export async function schedulePruner() {
  setInterval(async () => {
    try {
      await pruneExpiredData();
    } catch (err) {
      logger.error('[Pruner] Error during pruning:', err);
    }
  }, PRUNE_INTERVAL_MS);

  // Run once on startup
  await pruneExpiredData();
}

export async function pruneExpiredData(opts: PruneOptions = {}): Promise<PruneBatchAudit[]> {
  const dryRun = opts.dryRun ?? process.env.PRUNER_DRY_RUN === 'true';
  const policies = { ...getRetentionPolicies(), ...opts.overridePolicies };
  const auditLogs: PruneBatchAudit[] = [];

  const startTime = Date.now();
  logger.info(`[Pruner] Starting data pruning cycle (dryRun=${dryRun})`);

  try {
    // Archive raw XDR to S3 before pruning (only when S3 bucket is configured)
    if (process.env.ARCHIVE_S3_BUCKET && !dryRun) {
      await archiveRawXdr();
    }

    // 1. Prune dead failed items
    const failedPolicy = policies.failedItem;
    const failedCutoff = new Date(Date.now() - failedPolicy.retentionDays * 24 * 60 * 60 * 1000);
    assertComplianceTableProtection('FailedItem');

    let deletedFailedCount = 0;
    if (dryRun) {
      deletedFailedCount = await prisma.failedItem.count({
        where: { dead: true, createdAt: { lt: failedCutoff } },
      });
    } else {
      const res = await prisma.failedItem.deleteMany({
        where: { dead: true, createdAt: { lt: failedCutoff } },
      });
      deletedFailedCount = res.count;
    }

    const failedAudit: PruneBatchAudit = {
      modelName: 'FailedItem',
      retentionDays: failedPolicy.retentionDays,
      cutoffDate: failedCutoff,
      deletedCount: deletedFailedCount,
      dryRun,
      protected: false,
    };
    auditLogs.push(failedAudit);
    logger.info(
      `[Pruner Audit] FailedItem batch: ${deletedFailedCount} record(s) ${dryRun ? 'eligible' : 'deleted'} (cutoff: ${failedCutoff.toISOString()})`,
    );

    // 2. Prune verification jobs
    const verifPolicy = policies.verificationJob;
    const verifCutoff = new Date(Date.now() - verifPolicy.retentionDays * 24 * 60 * 60 * 1000);
    assertComplianceTableProtection('VerificationJob');

    let deletedVerifCount = 0;
    if (dryRun) {
      deletedVerifCount = await prisma.verificationJob.count({
        where: { status: { in: ['verified', 'failed'] }, createdAt: { lt: verifCutoff } },
      });
    } else {
      const res = await prisma.verificationJob.deleteMany({
        where: { status: { in: ['verified', 'failed'] }, createdAt: { lt: verifCutoff } },
      });
      deletedVerifCount = res.count;
    }

    const verifAudit: PruneBatchAudit = {
      modelName: 'VerificationJob',
      retentionDays: verifPolicy.retentionDays,
      cutoffDate: verifCutoff,
      deletedCount: deletedVerifCount,
      dryRun,
      protected: false,
    };
    auditLogs.push(verifAudit);
    logger.info(
      `[Pruner Audit] VerificationJob batch: ${deletedVerifCount} record(s) ${dryRun ? 'eligible' : 'deleted'} (cutoff: ${verifCutoff.toISOString()})`,
    );

    // 3. Prune dead letter items
    const dlPolicy = policies.deadLetterItem;
    const dlCutoff = new Date(Date.now() - dlPolicy.retentionDays * 24 * 60 * 60 * 1000);
    assertComplianceTableProtection('DeadLetterItem');

    let deletedDlCount = 0;
    if (dryRun) {
      deletedDlCount = await prisma.deadLetterItem.count({
        where: { createdAt: { lt: dlCutoff } },
      });
    } else {
      const res = await prisma.deadLetterItem.deleteMany({
        where: { createdAt: { lt: dlCutoff } },
      });
      deletedDlCount = res.count;
    }

    const dlAudit: PruneBatchAudit = {
      modelName: 'DeadLetterItem',
      retentionDays: dlPolicy.retentionDays,
      cutoffDate: dlCutoff,
      deletedCount: deletedDlCount,
      dryRun,
      protected: false,
    };
    auditLogs.push(dlAudit);
    logger.info(
      `[Pruner Audit] DeadLetterItem batch: ${deletedDlCount} record(s) ${dryRun ? 'eligible' : 'deleted'} (cutoff: ${dlCutoff.toISOString()})`,
    );

    // Assert compliance tables are audited as protected
    for (const complianceTable of COMPLIANCE_PROTECTED_TABLES) {
      auditLogs.push({
        modelName: complianceTable,
        retentionDays: Infinity,
        cutoffDate: new Date(0),
        deletedCount: 0,
        dryRun,
        protected: true,
      });
    }

    const elapsed = Date.now() - startTime;
    logger.info(
      `[Pruner] Pruning cycle completed in ${elapsed}ms. Total audited items: ${auditLogs.length}`,
    );
    return auditLogs;
  } catch (err) {
    logger.error('[Pruner] Fatal error during pruning:', err);
    throw err;
  }
}
