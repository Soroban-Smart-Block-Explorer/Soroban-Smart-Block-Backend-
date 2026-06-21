import '../config'; // load dotenv
import { prismaWrite as prisma } from '../db';
import { runIndexer } from './indexer';
import { scheduleReconciliation } from './reconciliation';
import { startProtocolMonitor } from './protocol-guard';
import { schedulePruner } from './dataPruner';
import { initWhaleWatcher } from './whaleWatcher';
import { startMicroBlockPoller } from './microBlockPoller';
import { scheduleSettlementCompactor } from './settlement-compactor';
import { scheduleDexAnalytics } from './dex/pool-processor';

async function main() {
  await prisma.$connect();

  // #51: Start protocol version monitor (checks every 10 min, warns on upgrades)
  startProtocolMonitor();

  // #50: Schedule daily reconciliation audit
  scheduleReconciliation();

  // #135: Schedule transient state data pruner
  schedulePruner();

  // #136: Initialize whale transaction watcher
  initWhaleWatcher();

  // #192: Start micro-block polling for 2.5 s block close time notifications
  startMicroBlockPoller();

  // #220: Schedule batch-settlement event compactor
  scheduleSettlementCompactor();

  // Institutional DEX Analytics: continuously recompute pool metrics, prices,
  // historical snapshots, and arbitrage opportunities.
  scheduleDexAnalytics();

  await runIndexer();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
