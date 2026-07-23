import type { Libp2p } from 'libp2p';
import type { PubSub } from '@libp2p/interface';
import { fromString as u8FromString, toString as u8ToString } from 'uint8arrays';

export interface GossipTopics {
  heartbeat: string;
  ledgerHeader: string;
  reputation: string;
}

export interface HeartbeatPayload {
  v: 1;
  type: 'heartbeat';
  network: string;
  peerId: string;
  multiaddrs: string[];
  ledgerCursor: number;
  timestamp: number;
}

export interface LedgerHeaderPayload {
  v: 1;
  type: 'ledger_header';
  network: string;
  ledgerSeq: number;
  hash: string;
  previousLedgerHash: string | null;
  closeTimeUnix: number;
  publisherPeerId: string;
}

export interface ReputationPayload {
  v: 1;
  type: 'reputation_update';
  network: string;
  aboutPeerId: string;
  reputationScore: number;
  challengesPassed: number;
  challengesFailed: number;
  latencyMsEwma: number | null;
  reporterPeerId: string;
}

export interface GossipCallbacks {
  onHeartbeat(msg: HeartbeatPayload): void;
  onLedgerHeader(msg: LedgerHeaderPayload): void;
  onReputationUpdate(msg: ReputationPayload): void;
}

export interface GossipHandle {
  publishHeartbeat(payload: Omit<HeartbeatPayload, 'v' | 'type'>): Promise<void>;
  publishLedgerHeader(payload: Omit<LedgerHeaderPayload, 'v' | 'type'>): Promise<void>;
  publishReputation(payload: Omit<ReputationPayload, 'v' | 'type'>): Promise<void>;
}

function safeParse<T>(bytes: Uint8Array): T | null {
  try {
    return JSON.parse(u8ToString(bytes)) as T;
  } catch {
    return null;
  }
}

/**
 * Subscribes to the three gossip topics used by the P2P indexer network (see
 * docs/P2P_INDEXER_DESIGN.md §6.1/§6.3/§6.4) and returns publish functions.
 * Every message is namespaced per-network via the topic string itself
 * (config.ts's topicId()), so a testnet and mainnet swarm never cross-pollute
 * even if their transports happen to be reachable from each other.
 */
export function wireGossip(node: Libp2p, topics: GossipTopics, callbacks: GossipCallbacks): GossipHandle {
  const pubsub = node.services.pubsub as PubSub;

  pubsub.subscribe(topics.heartbeat);
  pubsub.subscribe(topics.ledgerHeader);
  pubsub.subscribe(topics.reputation);

  pubsub.addEventListener('message', (evt) => {
    const { topic, data } = evt.detail;
    if (topic === topics.heartbeat) {
      const msg = safeParse<HeartbeatPayload>(data);
      if (msg?.type === 'heartbeat') callbacks.onHeartbeat(msg);
    } else if (topic === topics.ledgerHeader) {
      const msg = safeParse<LedgerHeaderPayload>(data);
      if (msg?.type === 'ledger_header') callbacks.onLedgerHeader(msg);
    } else if (topic === topics.reputation) {
      const msg = safeParse<ReputationPayload>(data);
      if (msg?.type === 'reputation_update') callbacks.onReputationUpdate(msg);
    }
  });

  const publish = async (topic: string, payload: unknown) => {
    try {
      await pubsub.publish(topic, u8FromString(JSON.stringify(payload)));
    } catch {
      // No mesh peers on this topic yet — normal during startup/isolated tests, not fatal.
    }
  };

  return {
    publishHeartbeat: (payload) => publish(topics.heartbeat, { v: 1, type: 'heartbeat', ...payload }),
    publishLedgerHeader: (payload) =>
      publish(topics.ledgerHeader, { v: 1, type: 'ledger_header', ...payload }),
    publishReputation: (payload) =>
      publish(topics.reputation, { v: 1, type: 'reputation_update', ...payload }),
  };
}
