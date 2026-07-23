/**
 * CLI entry point for the indexer repair tool.
 *
 * Usage:
 *   npm run repair                         # one-shot sweep over full indexed range
 *   npm run repair -- --dry-run            # scan for gaps without writing anything
 *   npm run repair -- --from 1000 --to 2000  # sweep a specific ledger range
 *   npm run repair -- --loop              # continuous background repair loop
 *
 * Safe production usage:
 *   - Always run --dry-run first to inspect gaps before committing writes.
 *   - Use --from/--to to scope repairs to a known-bad range.
 *   - --loop is intended for long-running sidecar processes, not one-off ops.
 *   - The repair process never touches IndexerState, so the live indexer cursor
 *     is unaffected regardless of which mode is used.
 */

import { runRepairSweep, startRepairLoop } from './repair';

const args = process.argv.slice(2);

const dryRun = args.includes('--dry-run');
const loop = args.includes('--loop');

const fromIdx = args.indexOf('--from');
const toIdx = args.indexOf('--to');

const fromSeq = fromIdx !== -1 ? parseInt(args[fromIdx + 1], 10) : undefined;
const toSeq = toIdx !== -1 ? parseInt(args[toIdx + 1], 10) : undefined;

if (fromSeq !== undefined && isNaN(fromSeq)) {
  console.error('[repair] --from requires a numeric ledger sequence');
  process.exit(1);
}

if (toSeq !== undefined && isNaN(toSeq)) {
  console.error('[repair] --to requires a numeric ledger sequence');
  process.exit(1);
}

if (fromSeq !== undefined && toSeq !== undefined && fromSeq > toSeq) {
  console.error('[repair] --from must be less than or equal to --to');
  process.exit(1);
}

if (loop && (fromSeq !== undefined || toSeq !== undefined)) {
  console.error('[repair] --loop cannot be combined with --from/--to');
  process.exit(1);
}

if (dryRun) {
  console.log('[repair] DRY-RUN mode — no data will be written to the database');
}

async function main() {
  if (loop) {
    await startRepairLoop();
  } else {
    const result = await runRepairSweep({ dryRun, fromSeq, toSeq });
    console.log(`[repair] Done. Hard gaps: ${result.hardGaps}, soft gaps: ${result.softGaps}`);
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('[repair] Fatal error:', err);
  process.exit(1);
});
