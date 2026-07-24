import { prismaWrite as prisma } from '../db';
import { logger } from '../logger';
import type { NetworkName, ReindexReason } from './types';

/**
 * Persists a re-index task triggered by a challenge mismatch or query
 * read-repair. Actual reindexing is driven by src/indexer/indexer.ts polling
 * pending tasks for its own network (see wiring in responsibility.ts).
 */
export async function enqueueReindex(
  network: NetworkName,
  ledgerSequence: number,
  reason: ReindexReason,
  sourcePeerId?: string,
): Promise<void> {
  await prisma.reindexTask.create({
    data: { network, ledgerSequence, reason, sourcePeerId: sourcePeerId ?? null },
  });
  logger.warn('[p2p:reindex] task enqueued', { network, ledgerSequence, reason, sourcePeerId });
}

export async function claimNextPendingReindex(network: NetworkName) {
  const task = await prisma.reindexTask.findFirst({
    where: { network, status: 'pending' },
    orderBy: { createdAt: 'asc' },
  });
  if (!task) return null;
  await prisma.reindexTask.update({ where: { id: task.id }, data: { status: 'in_progress' } });
  return task;
}

export async function completeReindex(taskId: string, status: 'done' | 'failed'): Promise<void> {
  await prisma.reindexTask.update({
    where: { id: taskId },
    data: { status, completedAt: new Date() },
  });
}
