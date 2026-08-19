import '../config';
import { prismaWrite as prisma } from '../db';
import { indexSingleLedger, runIndexer, stopIndexerService } from './indexer';
import { scheduleReconciliation } from './reconciliation';
import { startProtocolMonitor } from './protocol-guard';
import { schedulePruner } from './dataPruner';
import { startP2pNode, stopP2pNode, wireOnTheFlyIndexer } from '../p2p';
import { logger } from '../logger';

async function main() {
  await prisma.$connect();

  wireOnTheFlyIndexer(indexSingleLedger);
  await startP2pNode();

  startProtocolMonitor();
  scheduleReconciliation();
  schedulePruner();

  await runIndexer();
}

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`[indexer] received ${signal}, shutting down...`);
  stopIndexerService();
  await stopP2pNode().catch((err) => logger.error('[indexer] error stopping p2p node:', err));
  await prisma.$disconnect().catch(() => undefined);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

main().catch((e) => {
  logger.error(e);
  process.exit(1);
});
