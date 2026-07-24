/**
 * Benchmark: measures p95 latency of GET /p2p/ledger/:seq when the queried
 * node does NOT own the ledger locally and must forward the request to a
 * range owner over the P2P query protocol (docs/P2P_INDEXER_DESIGN.md §1.3,
 * acceptance criterion "10+ nodes coordinate with <200ms overhead per
 * query"). Caveat (also called out in the design doc): this measures the
 * local docker-compose bridge network, which has negligible latency
 * compared to a real WAN deployment — treat this as "proven in the
 * reference harness," not a WAN guarantee.
 *
 * Usage: ts-node scripts/chaos/query-latency-bench.ts [requestCount]
 * Requires `docker compose --profile p2p up -d` already running and at
 * least partially caught up (some ledgers indexed).
 */
import axios from 'axios';

const NODE_URL = process.env.P2P_BENCH_NODE_URL ?? 'http://localhost:3010';
const REQUEST_COUNT = parseInt(process.argv[2] ?? '30', 10);

interface P2pStatus {
  ranges: Array<{
    startLedger: number;
    endLedger: number;
    lastIndexedLedger: number;
    ownerPeerIds: string[];
  }>;
  selfPeerId: string | null;
}

async function main() {
  const { data: status } = await axios.get<P2pStatus>(`${NODE_URL}/p2p/status`, { timeout: 5000 });
  if (!status.selfPeerId) {
    console.error(`[bench] ${NODE_URL} has no selfPeerId yet — is the P2P node still starting up?`);
    process.exit(1);
  }

  // Ranges this node does NOT own, but that have been indexed by someone —
  // querying these forces the forward path rather than the free local-DB path.
  const remoteRanges = status.ranges.filter(
    (r) => !r.ownerPeerIds.includes(status.selfPeerId!) && r.lastIndexedLedger > r.startLedger,
  );

  if (remoteRanges.length === 0) {
    console.error(
      '[bench] No remotely-owned, already-indexed ranges found to query yet. ' +
        'Let the harness run longer for nodes to claim and index ranges, then retry.',
    );
    process.exit(1);
  }

  const samples: number[] = [];
  for (let i = 0; i < REQUEST_COUNT; i++) {
    const range = remoteRanges[i % remoteRanges.length];
    const seq = range.startLedger + (i % Math.max(1, range.lastIndexedLedger - range.startLedger));
    const start = Date.now();
    try {
      await axios.get(`${NODE_URL}/p2p/ledger/${seq}?events=false`, { timeout: 10_000 });
      samples.push(Date.now() - start);
    } catch (err) {
      console.warn(`[bench] request for ledger ${seq} failed:`, (err as Error).message);
    }
  }

  if (samples.length === 0) {
    console.error('[bench] FAIL: every request errored.');
    process.exit(1);
  }

  samples.sort((a, b) => a - b);
  const p50 = samples[Math.floor(samples.length * 0.5)];
  const p95 = samples[Math.floor(samples.length * 0.95)] ?? samples[samples.length - 1];
  const max = samples[samples.length - 1];

  console.log(`[bench] ${samples.length}/${REQUEST_COUNT} requests succeeded.`);
  console.log(`[bench] p50=${p50}ms  p95=${p95}ms  max=${max}ms`);
  console.log(
    p95 < 200
      ? '[bench] PASS: p95 under the 200ms acceptance target (local-network measurement — see caveat above).'
      : `[bench] p95 (${p95}ms) exceeds the 200ms target on this run — rerun, and see the design doc's WAN caveat.`,
  );
}

main().catch((err) => {
  console.error('[bench] Fatal error:', err);
  process.exit(1);
});
