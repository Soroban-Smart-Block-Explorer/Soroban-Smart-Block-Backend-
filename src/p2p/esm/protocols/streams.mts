import type { Libp2p, Stream } from '@libp2p/interface';
import type { IncomingStreamData } from '@libp2p/interface';
import { peerIdFromString } from '@libp2p/peer-id';
import { pipe } from 'it-pipe';
import { encode, decode } from 'it-length-prefixed';
import { fromString as u8FromString, toString as u8ToString } from 'uint8arrays';

export interface StreamProtocols {
  challenge: string;
  query: string;
}

export interface ChallengeRequest {
  v: 1;
  type: 'challenge_request';
  ledgerSeq: number;
  nonce: string;
  challengerPeerId: string;
}

export interface ChallengeResponse {
  v: 1;
  type: 'challenge_response';
  ledgerSeq: number;
  nonce: string;
  indexHash: string | null;
  computedAt: number;
  challengedPeerId: string;
}

export interface QueryRequest {
  v: 1;
  type: 'query_ledger';
  ledgerSeq: number;
  includeEvents: boolean;
}

export interface QueryResponse {
  v: 1;
  type: 'query_ledger_response';
  found: boolean;
  ledger?: unknown;
  transactions?: unknown[];
  events?: unknown[];
  indexHash: string | null;
  servedByPeerId: string;
}

export interface StreamCallbacks {
  answerChallenge(ledgerSeq: number): Promise<string | null>;
  answerQuery(ledgerSeq: number, includeEvents: boolean): Promise<QueryResponse>;
}

export interface StreamsHandle {
  sendChallenge(peerIdStr: string, ledgerSeq: number): Promise<{ indexHash: string } | null>;
  sendQuery(peerIdStr: string, ledgerSeq: number, includeEvents: boolean): Promise<QueryResponse | null>;
}

const REQUEST_TIMEOUT_MS = 5000;

/** Reads exactly one length-prefixed JSON message off a stream's source. */
async function readJson<T>(stream: Stream): Promise<T | null> {
  let result: T | null = null;
  await pipe(stream.source, decode, async (source) => {
    for await (const msg of source) {
      result = JSON.parse(u8ToString(msg.subarray())) as T;
      return;
    }
  });
  return result;
}

async function writeJson(stream: Stream, obj: unknown): Promise<void> {
  await pipe([u8FromString(JSON.stringify(obj))], encode, stream.sink);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('p2p stream timeout')), ms)),
  ]);
}

/**
 * Registers the two request/response stream protocols (design doc §6.2/§6.5)
 * and returns client functions to issue them against a given peer. Both
 * protocols are length-prefixed JSON over a single bidirectional stream —
 * intentionally simple (no protobuf/codegen) since payloads are small and
 * infrequent relative to the gossip topics.
 */
export function wireStreamProtocols(
  node: Libp2p,
  protocols: StreamProtocols,
  selfPeerId: string,
  callbacks: StreamCallbacks,
): StreamsHandle {
  node.handle(protocols.challenge, async ({ stream }: IncomingStreamData) => {
    const request = await readJson<ChallengeRequest>(stream);
    if (!request) return;
    const indexHash = await callbacks.answerChallenge(request.ledgerSeq);
    const response: ChallengeResponse = {
      v: 1,
      type: 'challenge_response',
      ledgerSeq: request.ledgerSeq,
      nonce: request.nonce,
      indexHash,
      computedAt: Date.now(),
      challengedPeerId: selfPeerId,
    };
    await writeJson(stream, response);
  });

  node.handle(protocols.query, async ({ stream }: IncomingStreamData) => {
    const request = await readJson<QueryRequest>(stream);
    if (!request) return;
    const response = await callbacks.answerQuery(request.ledgerSeq, request.includeEvents);
    await writeJson(stream, response);
  });

  return {
    async sendChallenge(peerIdStr, ledgerSeq) {
      try {
        const peerId = peerIdFromString(peerIdStr);
        const stream = await withTimeout(node.dialProtocol(peerId, protocols.challenge), REQUEST_TIMEOUT_MS);
        const request: ChallengeRequest = {
          v: 1,
          type: 'challenge_request',
          ledgerSeq,
          nonce: Math.random().toString(36).slice(2),
          challengerPeerId: selfPeerId,
        };
        await writeJson(stream, request);
        const response = await withTimeout(readJson<ChallengeResponse>(stream), REQUEST_TIMEOUT_MS);
        await stream.close();
        if (!response?.indexHash) return null;
        return { indexHash: response.indexHash };
      } catch {
        return null;
      }
    },

    async sendQuery(peerIdStr, ledgerSeq, includeEvents) {
      try {
        const peerId = peerIdFromString(peerIdStr);
        const stream = await withTimeout(node.dialProtocol(peerId, protocols.query), REQUEST_TIMEOUT_MS);
        const request: QueryRequest = { v: 1, type: 'query_ledger', ledgerSeq, includeEvents };
        await writeJson(stream, request);
        const response = await withTimeout(readJson<QueryResponse>(stream), REQUEST_TIMEOUT_MS);
        await stream.close();
        return response;
      } catch {
        return null;
      }
    },
  };
}
