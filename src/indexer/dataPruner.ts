import { prismaWrite as prisma } from '../db';
import { archiveRawXdr } from '../archival/archiver';
import { logger } from '../logger';

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
  const dryRun = opts.dryRun ?? (process.env.PRUNER_DRY_RUN === 'true');
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

