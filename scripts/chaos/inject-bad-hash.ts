/**
 * Chaos test: proves the "malicious node providing false data is detected
 * within 3 ledger closes" acceptance criterion
 * (docs/P2P_INDEXER_DESIGN.md §7).
 *
 * Restarts one node with P2P_TEST_CORRUPT_HASH_RANGE set (see
 * src/p2p/resolve-location.ts's maybeCorruptForTesting), which flips one hex
 * character of the computed index hash for ledgers in that range — a stand-in
 * for "this node returns a wrong hash." Then polls a SURVIVING node's
 * `/p2p/status` endpoint (recentChallenges, sourced from VerificationChallenge
 * rows — see src/p2p/status-snapshot.ts) until a mismatch/tiebreak_resolved
 * entry appears for the corrupted node.
 *
 * Usage: ts-node scripts/chaos/inject-bad-hash.ts
 * Requires `docker compose --profile p2p up -d` already running, and that
 * P2P_CHALLENGE_INTERVAL_MS is set low enough (the compose profile defaults
 * it to 15s) to have a realistic chance of detecting within a short window —
 * see the design doc's note that hitting the literal "3 ledger closes"
 * (~15s at Stellar's ~5s close time) requires the challenge interval to be
 * on that same order, not the 60s production default.
 */
import { execSync } from 'child_process';
import axios from 'axios';

const TARGET_SERVICE = 'indexer-testnet-p2p-peer1';
const OBSERVER_URLS = ['http://localhost:3010', 'http://localhost:3012']; // seed, peer2 — not the corrupted node
const STELLAR_LEDGER_CLOSE_SECONDS = 5;
const DETECTION_BOUND_SECONDS = STELLAR_LEDGER_CLOSE_SECONDS * 3;
const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 45; // ~90s ceiling, generous vs the 15s bound to avoid flaking on slow hosts

interface P2pStatus {
  recentChallenges: Array<{
    ledgerSequence: number;
    challengerPeerId: string;
    challengedPeerId: string;
    result: string;
    createdAt: string;
  }>;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findMismatch(): Promise<P2pStatus['recentChallenges']> {
  for (const url of OBSERVER_URLS) {
    try {
      const { data } = await axios.get<P2pStatus>(`${url}/p2p/status`, { timeout: 5000 });
      const mismatches = data.recentChallenges.filter(
        (c) => c.result === 'mismatch' || c.result === 'tiebreak_resolved',
      );
      if (mismatches.length > 0) return mismatches;
    } catch {
      // observer unreachable this round — try the next one / next poll
    }
  }
  return [];
}

async function main() {
  console.log(`[chaos] Injecting a corrupt index hash on ${TARGET_SERVICE} (ledgers 0-1000)...`);
  execSync(`docker compose --profile p2p stop ${TARGET_SERVICE}`, { stdio: 'inherit' });
  execSync(
    `docker compose --profile p2p run -d --rm ` +
      `-e P2P_TEST_CORRUPT_HASH_RANGE=0-1000 --name ${TARGET_SERVICE}-corrupt ${TARGET_SERVICE} ` +
      `sh -c "npx prisma migrate deploy && node dist/index.js"`,
    { stdio: 'inherit' },
  );

  console.log(
    `[chaos] Polling observer nodes' /p2p/status (target: detect within ${DETECTION_BOUND_SECONDS}s)...`,
  );
  const startedAt = Date.now();
  let mismatches: P2pStatus['recentChallenges'] = [];

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    mismatches = await findMismatch();
    if (mismatches.length > 0) break;
    await sleep(POLL_INTERVAL_MS);
  }

  const detected = mismatches.length > 0;
  if (detected) {
    const elapsedSeconds = (Date.now() - startedAt) / 1000;
    console.log(
      `[chaos] Detected ${mismatches.length} mismatch/tiebreak entr(ies) after ${elapsedSeconds.toFixed(1)}s:`,
    );
    console.table(mismatches);
    if (elapsedSeconds <= DETECTION_BOUND_SECONDS) {
      console.log(
        `[chaos] PASS: detected within the ${DETECTION_BOUND_SECONDS}s (~3 ledger closes) bound.`,
      );
    } else {
      console.warn(
        `[chaos] Detected, but after ${elapsedSeconds.toFixed(1)}s > ${DETECTION_BOUND_SECONDS}s bound — ` +
          `tune P2P_CHALLENGE_INTERVAL_MS lower to tighten detection latency.`,
      );
    }
  } else {
    console.error(
      `[chaos] FAIL: no mismatch detected after ${(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s. ` +
        `Check that the corrupted node actually owns a range being challenged by peers, and that observers are reachable.`,
    );
  }

  console.log('[chaos] Cleaning up corrupt test container...');
  execSync(`docker rm -f ${TARGET_SERVICE}-corrupt`, { stdio: 'ignore' });
  execSync(`docker compose --profile p2p start ${TARGET_SERVICE}`, { stdio: 'inherit' });

  process.exit(detected ? 0 : 1);
}

main().catch((err) => {
  console.error('[chaos] Fatal error:', err);
  process.exit(1);
});
