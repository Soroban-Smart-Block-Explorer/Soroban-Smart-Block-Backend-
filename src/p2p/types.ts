import type { NetworkName } from '../profiles';

export type { NetworkName };

/** Locally-observed record of a peer, kept in the in-process MembershipView. */
export interface PeerRecord {
  peerId: string;
  network: NetworkName;
  multiaddrs: string[];
  lastSeenAt: number; // epoch ms
  reputationScore: number; // 0-100
}

/** A fixed ledger_seq bucket, e.g. `testnet:0-10000`. */
export interface RangeBounds {
  rangeId: string;
  network: NetworkName;
  startLedger: number;
  endLedger: number;
}

export type ChallengeResultKind = 'match' | 'mismatch' | 'tiebreak_resolved';

export interface ChallengeResult {
  network: NetworkName;
  ledgerSequence: number;
  challengerPeerId: string;
  challengedPeerId: string;
  challengerHash: string;
  challengedHash: string;
  tiebreakerPeerId?: string;
  tiebreakerHash?: string;
  result: ChallengeResultKind;
}

export type ReindexReason = 'challenge_mismatch' | 'read_repair';

// ── Wire message schemas (see docs/P2P_INDEXER_DESIGN.md §6) ────────────────

export interface LedgerHeaderGossipMessage {
  v: 1;
  type: 'ledger_header';
  network: NetworkName;
  ledgerSeq: number;
  hash: string;
  previousLedgerHash: string | null;
  closeTimeUnix: number;
  publisherPeerId: string;
}

export interface MembershipHeartbeatMessage {
  v: 1;
  type: 'heartbeat';
  network: NetworkName;
  peerId: string;
  multiaddrs: string[];
  ledgerCursor: number;
  timestamp: number;
}

export interface ReputationUpdateMessage {
  v: 1;
  type: 'reputation_update';
  network: NetworkName;
  aboutPeerId: string;
  reputationScore: number;
  challengesPassed: number;
  challengesFailed: number;
  latencyMsEwma: number | null;
  reporterPeerId: string;
}

export interface ChallengeRequestMessage {
  v: 1;
  type: 'challenge_request';
  ledgerSeq: number;
  nonce: string;
  challengerPeerId: string;
}

export interface ChallengeResponseMessage {
  v: 1;
  type: 'challenge_response';
  ledgerSeq: number;
  nonce: string;
  indexHash: string;
  computedAt: number;
  challengedPeerId: string;
}

export interface QueryLedgerRequestMessage {
  v: 1;
  type: 'query_ledger';
  ledgerSeq: number;
  includeEvents: boolean;
}

export interface QueryLedgerResponseMessage {
  v: 1;
  type: 'query_ledger_response';
  found: boolean;
  ledger?: unknown;
  transactions?: unknown[];
  events?: unknown[];
  indexHash: string | null;
  servedByPeerId: string;
}

/** Canonical input to computeIndexHash — sorting is the caller's responsibility upstream. */
export interface IndexHashInput {
  ledgerHash: string;
  txHashesSorted: string[];
  eventIdsSorted: string[];
  eventPayloadHashesSorted: string[];
}
