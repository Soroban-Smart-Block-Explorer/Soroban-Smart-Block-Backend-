import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { kadDHT } from '@libp2p/kad-dht';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { bootstrap } from '@libp2p/bootstrap';
import { mdns } from '@libp2p/mdns';
import { circuitRelayTransport, circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { dcutr } from '@libp2p/dcutr';
import { ping } from '@libp2p/ping';
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromString } from '@libp2p/peer-id';
import type { PrivateKey } from '@libp2p/interface';
import { wireGossip, type GossipCallbacks, type GossipHandle, type GossipTopics } from './protocols/gossip.mjs';
import {
  wireStreamProtocols,
  type StreamCallbacks,
  type StreamProtocols,
  type StreamsHandle,
} from './protocols/streams.mjs';

export interface P2pNodeOptions {
  listenAddr: string;
  announceAddr: string | null;
  bootstrapPeers: string[];
  identityPath: string;
  mdnsEnabled: boolean;
  isRelayServer: boolean;
  gossipTopics: GossipTopics;
  streamProtocols: StreamProtocols;
  gossipCallbacks: GossipCallbacks;
  streamCallbacks: StreamCallbacks;
}

export interface P2pNodeHandle extends GossipHandle, StreamsHandle {
  peerId: string;
  connectedPeerCount(): number;
  /** Round-trip latency to a peer in ms, or null if unreachable — feeds reputation-scorer's latencyMsEwma. */
  pingPeer(peerIdStr: string): Promise<number | null>;
  stop(): Promise<void>;
}

/**
 * Ed25519 identity is persisted to disk so a restarted node keeps its PeerId
 * (needed for reputation continuity and DHT/rendezvous stability — a fresh
 * PeerId on every restart would make a node look "new" to rendezvous hashing
 * every time, churning range ownership for no reason).
 */
async function loadOrCreateIdentity(identityPath: string): Promise<PrivateKey> {
  try {
    const raw = await readFile(identityPath);
    return privateKeyFromProtobuf(raw);
  } catch {
    const key = await generateKeyPair('Ed25519');
    await mkdir(dirname(identityPath), { recursive: true });
    await writeFile(identityPath, privateKeyToProtobuf(key));
    return key;
  }
}

/**
 * Constructs and starts a per-network libp2p node: TCP transport, circuit
 * relay (client always, server role only for designated relay nodes),
 * dcutr for hole-punching upgrade, Kademlia DHT + optional bootstrap/mDNS for
 * peer discovery, and gossipsub for the three gossip topics. See
 * docs/P2P_INDEXER_DESIGN.md §1.1 for the full rationale.
 */
export async function createP2pNode(opts: P2pNodeOptions): Promise<P2pNodeHandle> {
  const privateKey = await loadOrCreateIdentity(opts.identityPath);

  const node = await createLibp2p({
    privateKey,
    addresses: {
      listen: [opts.listenAddr],
      ...(opts.announceAddr ? { announce: [opts.announceAddr] } : {}),
    },
    transports: [tcp(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    peerDiscovery: [
      ...(opts.bootstrapPeers.length > 0 ? [bootstrap({ list: opts.bootstrapPeers })] : []),
      ...(opts.mdnsEnabled ? [mdns()] : []),
    ],
    services: {
      identify: identify(),
      ping: ping(),
      dht: kadDHT({ clientMode: false }),
      pubsub: gossipsub({ emitSelf: false, allowPublishToZeroTopicPeers: true }),
      dcutr: dcutr(),
      ...(opts.isRelayServer ? { relay: circuitRelayServer() } : {}),
    },
  });

  await node.start();

  const selfPeerId = node.peerId.toString();
  const gossip = wireGossip(node, opts.gossipTopics, opts.gossipCallbacks);
  const streams = wireStreamProtocols(node, opts.streamProtocols, selfPeerId, opts.streamCallbacks);

  return {
    peerId: selfPeerId,
    ...gossip,
    ...streams,
    connectedPeerCount: () => node.getPeers().length,
    pingPeer: async (peerIdStr: string) => {
      try {
        const rtt = await node.services.ping.ping(peerIdFromString(peerIdStr));
        return rtt;
      } catch {
        return null;
      }
    },
    stop: async () => {
      await node.stop();
    },
  };
}
