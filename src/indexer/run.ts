import '../config';
import { prismaWrite as prisma } from '../db';
import { runIndexer } from './indexer';
import { scheduleReconciliation } from './reconciliation';
import { startProtocolMonitor } from './protocol-guard';
import { schedulePruner } from './dataPruner';

async function main() {
  await prisma.$connect();

  startProtocolMonitor();
  scheduleReconciliation();
  schedulePruner();

  await runIndexer();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
