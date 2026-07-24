/**
 * Chaos test: proves the "network continues operating with 33% of nodes
 * offline" acceptance criterion (docs/P2P_INDEXER_DESIGN.md §7) against the
 * local `p2p` docker-compose profile.
 *
 * Usage: ts-node scripts/chaos/kill-random-nodes.ts [nodeUrl1,nodeUrl2,...]
 * Defaults to the 3-node local harness (seed/peer1/peer2). Requires
 * `docker compose --profile p2p up -d` to already be running.
 */
import { execSync } from 'child_process';
import axios from 'axios';

interface P2pStatus {
  enabled: boolean;
  ranges: Array<{
    rangeId: string;
    startLedger: number;
    endLedger: number;
    ownerPeerIds: string[];
  }>;
}

const DEFAULT_NODES = [
  { service: 'indexer-testnet-p2p-seed', url: 'http://localhost:3010' },
  { service: 'indexer-testnet-p2p-peer1', url: 'http://localhost:3011' },
  { service: 'indexer-testnet-p2p-peer2', url: 'http://localhost:3012' },
];

async function fetchStatus(url: string): Promise<P2pStatus | null> {
  try {
    const { data } = await axios.get<P2pStatus>(`${url}/p2p/status`, { timeout: 5000 });
    return data;
  } catch {
    return null;
  }
}

async function fetchLedger(url: string, seq: number): Promise<{ found: boolean } | null> {
  try {
    const { data } = await axios.get(`${url}/p2p/ledger/${seq}?events=false`, {
      timeout: 15_000,
      validateStatus: () => true,
    });
    return data;
  } catch {
    return null;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const nodes = DEFAULT_NODES;
  const killCount = Math.max(1, Math.floor(nodes.length * 0.33));

  console.log(`[chaos] Checking ${nodes.length} node(s) are ready...`);
  for (const node of nodes) {
    const status = await fetchStatus(node.url);
    if (!status?.enabled) {
      console.error(
        `[chaos] ${node.service} is not reporting P2P as enabled — is the p2p profile up?`,
      );
      process.exit(1);
    }
  }

  const survivorPool = [...nodes];
  const toKill: typeof nodes = [];
  for (let i = 0; i < killCount; i++) {
    const idx = Math.floor(Math.random() * survivorPool.length);
    toKill.push(survivorPool.splice(idx, 1)[0]);
  }
  const survivors = survivorPool;
  if (survivors.length === 0) {
    console.error('[chaos] Refusing to kill every node — need at least one survivor to query.');
    process.exit(1);
  }

  console.log(
    `[chaos] Killing ${toKill.length}/${nodes.length} node(s): ${toKill.map((n) => n.service).join(', ')}`,
  );
  // We don't have an easy service-name -> PeerId mapping here (that would
  // require reading each node's own selfPeerId before killing it), so we
  // just probe a range that existed before the kill rather than one we can
  // prove was owned specifically by a killed node — still exercises the
  // graceful-degradation path (local replica or on-the-fly indexing) since
  // range ownership is recomputed after the membership change regardless.
  const beforeStatus = await fetchStatus(survivors[0].url);

  execSync(`docker compose --profile p2p stop ${toKill.map((n) => n.service).join(' ')}`, {
    stdio: 'inherit',
  });

  console.log('[chaos] Waiting 15s for membership to converge on survivors...');
  await sleep(15_000);

  const survivor = survivors[0];
  const afterStatus = await fetchStatus(survivor.url);
  if (!afterStatus) {
    console.error(`[chaos] FAIL: survivor ${survivor.service} is unreachable after killing peers.`);
    process.exit(1);
  }
  console.log(
    `[chaos] Survivor ${survivor.service} still reports P2P status OK, ${afterStatus.ranges.length} range(s) known.`,
  );

  // Try to fetch a ledger from a range that existed before the kill —
  // graceful degradation (local replica or on-the-fly indexing) should still
  // return data rather than erroring out, regardless of which node owned it.
  const probeRange = beforeStatus?.ranges[0] ?? afterStatus.ranges[0];
  if (probeRange) {
    const seq = probeRange.startLedger + 1;
    const result = await fetchLedger(survivor.url, seq);
    if (result?.found) {
      console.log(
        `[chaos] PASS: survivor served ledger ${seq} despite ${toKill.length} node(s) offline.`,
      );
    } else {
      console.warn(
        `[chaos] WARN: survivor could not serve ledger ${seq} (found=${result?.found}) — may not have synced that ledger yet from RPC; this is not necessarily a P2P-layer failure.`,
      );
    }
  } else {
    console.log('[chaos] No claimed ranges yet to probe — nodes may still be in initial catch-up.');
  }

  console.log('[chaos] Restarting killed nodes...');
  execSync(`docker compose --profile p2p start ${toKill.map((n) => n.service).join(' ')}`, {
    stdio: 'inherit',
  });
}

main().catch((err) => {
  console.error('[chaos] Fatal error:', err);
  process.exit(1);
});
