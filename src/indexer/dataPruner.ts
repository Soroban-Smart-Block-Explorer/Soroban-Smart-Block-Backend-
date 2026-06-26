import { prismaWrite as prisma } from '../db';
import { archiveRawXdr } from '../archival/archiver';

const PRUNE_INTERVAL_MS = parseInt(process.env.PRUNE_INTERVAL_MS ?? '86400000'); // 24h default
const FAILED_ITEM_RETENTION_DAYS = parseInt(process.env.FAILED_ITEM_RETENTION_DAYS ?? '7');

export async function schedulePruner() {
  setInterval(async () => {
    try {
      await pruneExpiredData();
    } catch (err) {
      console.error('[Pruner] Error during pruning:', err);
    }
  }, PRUNE_INTERVAL_MS);

  // Run once on startup
  await pruneExpiredData();
}

async function pruneExpiredData() {
  const startTime = Date.now();
  console.log('[Pruner] Starting data pruning cycle');

  try {
    // Archive raw XDR to S3 before pruning (only when S3 bucket is configured)
    if (process.env.ARCHIVE_S3_BUCKET) {
      await archiveRawXdr();
    }

    // Prune dead failed items older than retention period
    const failedItemCutoff = new Date(
      Date.now() - FAILED_ITEM_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    const deletedFailedItems = await prisma.failedItem.deleteMany({
      where: {
        dead: true,
        createdAt: { lt: failedItemCutoff },
      },
    });
    console.log(`[Pruner] Deleted ${deletedFailedItems.count} expired failed items`);

    // Prune verification jobs older than 90 days
    const verificationJobCutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const deletedVerificationJobs = await prisma.verificationJob.deleteMany({
      where: {
        status: { in: ['verified', 'failed'] },
        createdAt: { lt: verificationJobCutoff },
      },
    });
    console.log(`[Pruner] Deleted ${deletedVerificationJobs.count} expired verification jobs`);

    const elapsed = Date.now() - startTime;
    console.log(`[Pruner] Pruning cycle completed in ${elapsed}ms`);
  } catch (err) {
    console.error('[Pruner] Fatal error during pruning:', err);
    throw err;
  }
}
