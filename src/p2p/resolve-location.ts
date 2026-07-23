import { prismaRead } from '../db';
import { logger } from '../logger';
import { computeIndexHashFromRaw } from './index-hash';
import { getCachedQueryResult, setCachedQueryResult } from './distributed-cache';
import { getP2pConfig, getSelfPeerId, ownersOf } from './responsibility';
import { enqueueReindex } from './reindex-queue';
import type { NetworkName, QueryLedgerResponseMessage } from './types';

export type QueryForwarder = (
  peerId: string,
  ledgerSeq: number,
  includeEvents: boolean,
) => Promise<QueryLedgerResponseMessage | null>;

export type OnTheFlyIndexer = (ledgerSeq: number) => Promise<void>;

let queryForwarder: QueryForwarder | null = null;
let onTheFlyIndexer: OnTheFlyIndexer | null = null;

/** Wired by src/p2p/index.ts once the ESM node is up / by the indexer at startup. */
export function setQueryForwarder(fn: QueryForwarder): void {
  queryForwarder = fn;
}

export function setOnTheFlyIndexer(fn: OnTheFlyIndexer): void {
  onTheFlyIndexer = fn;
}

/**
 * Test-only fault injection for the chaos harness (scripts/chaos/inject-bad-hash.ts):
 * flips the last hex character of the computed hash for ledgers in
 * P2P_TEST_CORRUPT_HASH_RANGE, simulating a node that reports incorrect index
 * data. Must never fire outside a compose profile that sets that env var.
 */
function maybeCorruptForTesting(ledgerSeq: number, hash: string): string {
  const range = getP2pConfig().testCorruptHashRange;
  if (!range || ledgerSeq < range.start || ledgerSeq > range.end) return hash;
  const lastChar = hash.at(-1) ?? '0';
  const flipped = lastChar === '0' ? '1' : '0';
  return hash.slice(0, -1) + flipped;
}

/** Exposed for challenge-scheduler.ts, which only needs the hash, not the rows. */
export async function computeLocalIndexHash(ledgerSeq: number): Promise<string | null> {
  const local = await loadLocal(ledgerSeq, false);
  return local?.indexHash ?? null;
}

async function loadLocal(ledgerSeq: number, includeEvents: boolean) {
  const ledger = await prismaRead.ledger.findUnique({ where: { sequence: ledgerSeq } });
  if (!ledger) return null;
  const transactions = await prismaRead.transaction.findMany({
    where: { ledgerSequence: ledgerSeq },
  });
  const events = includeEvents
    ? await prismaRead.event.findMany({ where: { ledgerSequence: ledgerSeq } })
    : [];
  let indexHash = computeIndexHashFromRaw(
    ledger.hash,
    transactions.map((t) => t.hash),
    events.map((e) => e.id),
    events.map((e) => JSON.stringify(e.decoded ?? e.data)),
  );
  indexHash = maybeCorruptForTesting(ledgerSeq, indexHash);
  return { ledger, transactions, events, indexHash };
}

/**
 * Coordinator-less query resolution (design doc §1.3): local DB first, then
 * DHT-forward to a live range owner, then on-the-fly indexing as a last
 * resort (graceful degradation). Opportunistically read-repairs when a
 * forwarded response's hash disagrees with what we already have cached.
 */
export async function resolveLedgerLocation(
  network: NetworkName,
  ledgerSeq: number,
  includeEvents: boolean,
): Promise<QueryLedgerResponseMessage> {
  const selfPeerId = getSelfPeerId() ?? 'local';

  const local = await loadLocal(ledgerSeq, includeEvents);
  if (local) {
    return {
      v: 1,
      type: 'query_ledger_response',
      found: true,
      ledger: local.ledger,
      transactions: local.transactions,
      events: local.events,
      indexHash: local.indexHash,
      servedByPeerId: selfPeerId,
    };
  }

  const cached = await getCachedQueryResult(network, ledgerSeq);

  if (getP2pConfig().enabled && queryForwarder) {
    const owners = ownersOf(ledgerSeq).filter((p) => p !== selfPeerId);
    for (const ownerPeerId of owners) {
      const response = await queryForwarder(ownerPeerId, ledgerSeq, includeEvents).catch(
        () => null,
      );
      if (response?.found) {
        if (cached && cached.indexHash !== response.indexHash) {
          logger.warn(
            '[p2p:query] read-repair triggered: cached hash disagrees with forwarded response',
            {
              network,
              ledgerSeq,
              cachedFrom: cached.servedByPeerId,
              servedBy: ownerPeerId,
            },
          );
          await enqueueReindex(network, ledgerSeq, 'read_repair', ownerPeerId);
        }
        await setCachedQueryResult(
          network,
          ledgerSeq,
          { payload: response, indexHash: response.indexHash ?? '', servedByPeerId: ownerPeerId },
          getP2pConfig().queryCacheTtlMs,
        );
        return response;
      }
    }
  }

  // Graceful degradation: no reachable owner had it — index it ourselves.
  if (onTheFlyIndexer) {
    logger.info('[p2p:query] no reachable owner had ledger, indexing on the fly', {
      network,
      ledgerSeq,
    });
    await onTheFlyIndexer(ledgerSeq);
    const afterIndex = await loadLocal(ledgerSeq, includeEvents);
    if (afterIndex) {
      return {
        v: 1,
        type: 'query_ledger_response',
        found: true,
        ledger: afterIndex.ledger,
        transactions: afterIndex.transactions,
        events: afterIndex.events,
        indexHash: afterIndex.indexHash,
        servedByPeerId: selfPeerId,
      };
    }
  }

  return {
    v: 1,
    type: 'query_ledger_response',
    found: false,
    indexHash: null,
    servedByPeerId: selfPeerId,
  };
}
