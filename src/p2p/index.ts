import { join } from 'path';
import { logger } from '../logger';
import { markNotReady, markReady } from '../readiness';
import { getP2pConfig, recordPeerHeartbeat, setSelfPeerId } from './responsibility';
import {
  answerChallenge,
  setChallengeTransport,
  startChallengeScheduler,
  stopChallengeScheduler,
} from './challenge-scheduler';
import { resolveLedgerLocation, setOnTheFlyIndexer, setQueryForwarder } from './resolve-location';
import { protocolId, topicId } from './config';
import type { QueryLedgerResponseMessage } from './types';

export {
  amIResponsibleFor,
  getRangeCursor,
  getSelfPeerId,
  isP2pEnabled,
  ownersOf,
  refreshOwnedRangeClaims,
  setRangeCursor,
} from './responsibility';
export { getP2pStatusSnapshot } from './status-snapshot';
export { resolveLedgerLocation } from './resolve-location';

/**
 * dist-esm/node-factory.mjs is built by a separate ESM-targeted tsconfig
 * (tsconfig.p2p.json) because the current libp2p ecosystem is ESM-only while
 * this project is CommonJS (see docs/P2P_INDEXER_DESIGN.md §5).
 *
 * TypeScript unconditionally rewrites `import(x)` to a `require(x)`-based
 * shim when compiling under `module: commonjs` — even when `x` is a runtime
 * value rather than a string literal (verified empirically: it downleveled
 * to `Promise.resolve().then(() => require(x))`, which throws
 * ERR_REQUIRE_ESM against a genuine ESM target). The only reliable escape
 * hatch is constructing the `import()` call inside `new Function(...)`,
 * which TypeScript cannot see into and therefore cannot transform — this is
 * a real dynamic import at runtime, not a require() in disguise.
 */
const dynamicImport: (specifier: string) => Promise<unknown> = new Function(
  'specifier',
  'return import(specifier)',
) as (specifier: string) => Promise<unknown>;

async function loadEsmNodeFactory(): Promise<typeof import('./esm/node-factory.mjs')> {
  const modulePath = join(__dirname, '..', '..', 'dist-esm', 'node-factory.mjs');
  return dynamicImport(modulePath) as Promise<typeof import('./esm/node-factory.mjs')>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let nodeHandle: any = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

export async function startP2pNode(): Promise<void> {
  const cfg = getP2pConfig();
  if (!cfg.enabled) {
    logger.info('[p2p] disabled (P2P_ENABLED is not true) — running in single-node mode');
    return;
  }

  markNotReady('p2p');
  const { createP2pNode } = await loadEsmNodeFactory();

  nodeHandle = await createP2pNode({
    listenAddr: cfg.listenAddr,
    announceAddr: cfg.announceAddr,
    bootstrapPeers: cfg.bootstrapPeers,
    identityPath: cfg.identityPath,
    mdnsEnabled: cfg.mdnsEnabled,
    isRelayServer: cfg.isRelayServer,
    gossipTopics: {
      heartbeat: topicId(cfg.network, 'membership'),
      ledgerHeader: topicId(cfg.network, 'ledger-headers'),
      reputation: topicId(cfg.network, 'peer-reputation'),
    },
    streamProtocols: {
      challenge: protocolId(cfg.network, 'challenge'),
      query: protocolId(cfg.network, 'query'),
    },
    gossipCallbacks: {
      onHeartbeat: (msg) => recordPeerHeartbeat(msg.peerId, msg.multiaddrs, msg.timestamp),
      onLedgerHeader: () => {
        // Existence/liveness signal only (design doc §6.1) — actual content always
        // comes from RPC via the normal indexer path, never trusted from gossip.
      },
      onReputationUpdate: () => {
        // Blended into local PeerNode scores by the challenge-scheduler's own
        // bookkeeping; the gossiped value is advisory (design doc §1.4/§6.3).
      },
    },
    streamCallbacks: {
      answerChallenge: (ledgerSeq: number) => answerChallenge(ledgerSeq),
      answerQuery: async (ledgerSeq: number, includeEvents: boolean) =>
        (await resolveLedgerLocation(
          cfg.network,
          ledgerSeq,
          includeEvents,
        )) as QueryLedgerResponseMessage,
    },
  });

  setSelfPeerId(nodeHandle.peerId);
  setChallengeTransport((peerId, ledgerSeq) => nodeHandle.sendChallenge(peerId, ledgerSeq));
  setQueryForwarder((peerId, ledgerSeq, includeEvents) =>
    nodeHandle.sendQuery(peerId, ledgerSeq, includeEvents),
  );

  startChallengeScheduler();

  heartbeatTimer = setInterval(() => {
    nodeHandle
      ?.publishHeartbeat({
        network: cfg.network,
        peerId: nodeHandle.peerId,
        multiaddrs: [],
        ledgerCursor: 0,
      })
      .catch(() => undefined);
  }, cfg.heartbeatIntervalMs);

  markReady('p2p');
  logger.info('[p2p] node started', { network: cfg.network, peerId: nodeHandle.peerId });
}

export async function stopP2pNode(): Promise<void> {
  stopChallengeScheduler();
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (nodeHandle) {
    await nodeHandle.stop();
    nodeHandle = null;
    markNotReady('p2p');
  }
}

export function getConnectedPeerCount(): number {
  return nodeHandle ? nodeHandle.connectedPeerCount() : 0;
}

/** Wires the indexer's own single-ledger indexing function as the graceful-degradation fallback. */
export function wireOnTheFlyIndexer(indexSingleLedger: (ledgerSeq: number) => Promise<void>): void {
  setOnTheFlyIndexer(indexSingleLedger);
}
