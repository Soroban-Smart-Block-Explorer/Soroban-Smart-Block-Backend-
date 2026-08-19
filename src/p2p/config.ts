import { config as appConfig } from '../config';
import type { NetworkName } from './types';

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === '') return fallback;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid value for ${name}: "${raw}" is not an integer`);
  }
  return parsed;
}

function parseBoolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.trim().toLowerCase() === 'true';
}

function parseListEnv(name: string): string[] {
  const raw = process.env[name];
  if (!raw || raw.trim() === '') return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface P2pConfig {
  enabled: boolean;
  network: NetworkName;
  listenAddr: string;
  announceAddr: string | null;
  bootstrapPeers: string[];
  identityPath: string;
  rangeSize: number;
  replicationFactor: number;
  challengeIntervalMs: number;
  heartbeatIntervalMs: number;
  heartbeatMissedIntervalsBeforeStale: number;
  reputationGossipIntervalMs: number;
  queryCacheTtlMs: number;
  mdnsEnabled: boolean;
  isRelayServer: boolean;
  /** Test-only: corrupts the computed index hash for the given ledger range to
   * exercise the malicious-node-detection path in the chaos test harness. Must
   * never be set outside test/dev compose profiles. */
  testCorruptHashRange: { start: number; end: number } | null;
}

function parseCorruptRange(): { start: number; end: number } | null {
  const raw = process.env.P2P_TEST_CORRUPT_HASH_RANGE;
  if (!raw) return null;
  const [start, end] = raw.split('-').map((s) => parseInt(s.trim(), 10));
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return { start, end };
}

export function loadP2pConfig(): P2pConfig {
  const heartbeatIntervalMs = parseIntEnv('P2P_HEARTBEAT_INTERVAL_MS', 10_000);
  return {
    enabled: parseBoolEnv('P2P_ENABLED', false),
    network: appConfig.stellarNetwork,
    listenAddr: process.env.P2P_LISTEN_ADDR ?? '/ip4/0.0.0.0/tcp/0',
    announceAddr: process.env.P2P_ANNOUNCE_ADDR ?? null,
    bootstrapPeers: parseListEnv('P2P_BOOTSTRAP_PEERS'),
    identityPath:
      process.env.P2P_IDENTITY_PATH ?? `./data/p2p/${appConfig.stellarNetwork}/identity.key`,
    rangeSize: parseIntEnv('P2P_RANGE_SIZE', 10_000),
    replicationFactor: parseIntEnv('P2P_REPLICATION_FACTOR', 3),
    challengeIntervalMs: parseIntEnv('P2P_CHALLENGE_INTERVAL_MS', 60_000),
    heartbeatIntervalMs,
    heartbeatMissedIntervalsBeforeStale: parseIntEnv('P2P_HEARTBEAT_MISSED_BEFORE_STALE', 3),
    reputationGossipIntervalMs: parseIntEnv('P2P_REPUTATION_GOSSIP_INTERVAL_MS', 5 * 60_000),
    queryCacheTtlMs: parseIntEnv('P2P_QUERY_CACHE_TTL_MS', 10_000),
    mdnsEnabled: parseBoolEnv('P2P_MDNS_ENABLED', false),
    isRelayServer: parseBoolEnv('P2P_IS_RELAY_SERVER', false),
    testCorruptHashRange: parseCorruptRange(),
  };
}

/** Namespaces every libp2p protocol/topic string by network (see design doc §1.1). */
export function protocolId(network: NetworkName, name: string): string {
  return `/soroban-indexer/${network}/${name}/1.0.0`;
}

export function topicId(network: NetworkName, name: string): string {
  return `/soroban-indexer/${network}/gossip/${name}/1.0.0`;
}
