import { xdr } from '@stellar/stellar-sdk';
import { prismaWrite as prisma } from '../db';
import { decodeEvent } from './decoder';
import { fetchEvents, LedgerEvent } from './rpc';
import { trackTrustlineEvent } from './sac-trustline-mapper';
import { broadcastEvent } from '../ws/eventBroadcaster';
import { broadcastSSEEvent } from '../api/sse';
import { barrierUpsertContract, barrierUpsertEvent } from './writeBarrier';
import { getWhaleWatcher } from './whaleWatcher';
import { processYieldEvent } from './yield-distribution';
import { dispatchWebhooks } from '../webhooks/dispatcher';
import { maybeActivateFromTransferEvent } from './sac-account-activator';

/**
 * Parse DiagnosticEvents from a raw TransactionMeta XDR (base64).
 * Falls back to an empty array if the meta lacks diagnostic events.
 */
export function extractEventsFromMeta(metaXdr: string): Array<{
  contractId: string;
  topics: string[];
  data: string;
}> {
  let meta: xdr.TransactionMeta;
  try {
    meta = xdr.TransactionMeta.fromXDR(metaXdr, 'base64');
  } catch {
    return [];
  }

  // TransactionMeta v3 carries sorobanMeta with events
  if (meta.switch() !== 3) return [];

  const sorobanMeta = (meta as any).v3().sorobanMeta();
  if (!sorobanMeta) return [];

  const diagnosticEvents: xdr.DiagnosticEvent[] = sorobanMeta.diagnosticEvents?.() ?? [];

  return diagnosticEvents
    .filter((de) => {
      // Only include contract events (not system/diagnostic noise)
      const ev = de.event();
      return ev.type().name === 'contract';
    })
    .map((de) => {
      const ev = de.event();
      // contractId() returns null | Buffer — encode as hex string
      const contractIdBuf: Buffer | null = ev.contractId();
      const contractId = contractIdBuf ? contractIdBuf.toString('hex') : '';
      const topics = (ev.body() as any).v0().topics().map((t: xdr.ScVal) => t.toXDR('base64'));
      const data: string = (ev.body() as any).v0().data().toXDR('base64');
      return { contractId, topics, data };
    });
}

/**
 * Ingest events for a ledger range:
 *  1. Fetch events from the RPC events endpoint (primary source).
 *  2. Decode topics/data vectors via the decoder.
 *  3. Upsert into the Event table, skipping duplicates.
 */
export async function ingestEvents(startLedger: number, endLedger: number): Promise<number> {
  const events = await fetchEvents(startLedger, endLedger);
  let stored = 0;

  for (const event of events) {
    stored += await storeEvent(event);
  }

  return stored;
}

/**
 * Ingest events extracted directly from a transaction's meta XDR.
 * Used when you already have the raw meta and want richer diagnostic data.
 */
export async function ingestEventsFromMeta(
  txHash: string,
  ledgerSequence: number,
  ledgerCloseTime: Date,
  metaXdr: string
): Promise<number> {
  const raw = extractEventsFromMeta(metaXdr);
  let stored = 0;

  for (const ev of raw) {
    const ledgerEvent: LedgerEvent = {
      contractId: ev.contractId,
      transactionHash: txHash,
      ledgerSequence,
      ledgerCloseTime,
      topics: ev.topics,
      data: ev.data,
    };
    stored += await storeEvent(ledgerEvent);
  }

  return stored;
}

async function storeEvent(event: LedgerEvent): Promise<number> {
  if (!event.contractId || !event.transactionHash) return 0;

  // Serialised upsert — prevents duplicate-key races from parallel workers
  await barrierUpsertContract(event.contractId);

  // Ensure the transaction row exists (Event has a required FK to Transaction)
  const txExists = await prisma.transaction.findUnique({
    where: { hash: event.transactionHash },
    select: { hash: true, sourceAccount: true },
  });
  if (!txExists) return 0; // transaction not yet indexed; skip

  const { eventType, topicSymbol, decoded } = decodeEvent(event.topics, event.data);

  // Stable dedup key: hash + first topic (mirrors existing indexer logic)
  const id = `${event.transactionHash}-${event.topics[0] ?? '0'}`;

  await prisma.event.upsert({
    where: { id },
    update: {},
    create: {
      id,
      transactionHash: event.transactionHash,
      contractAddress: event.contractId,
      eventType,
      topicSymbol,
      topics: event.topics,
      data: { raw: event.data },
      decoded: decoded as object,
      ledgerSequence: event.ledgerSequence,
      ledgerCloseTime: event.ledgerCloseTime,
    },
  });

  // CAP-0073: Track trustline events from SAC contracts (non-blocking)
  trackTrustlineEvent(
    event.transactionHash,
    event.contractId,
    txExists.sourceAccount,
    eventType,
    topicSymbol,
    decoded as Record<string, unknown> | null,
    event.ledgerSequence,
    event.ledgerCloseTime,
    null,
  ).catch((err) =>
    console.warn(`[sac-trustline/event] tracking failed for ${event.transactionHash}:`, err),
  );

  // #136: Monitor for whale transactions
  const whaleWatcher = getWhaleWatcher();
  await whaleWatcher.monitorEvent({
    transactionHash: event.transactionHash,
    contractAddress: event.contractId,
    eventType,
    decoded,
    sourceAccount: txExists.sourceAccount,
    ledgerSequence: event.ledgerSequence,
    ledgerCloseTime: event.ledgerCloseTime,
  });

  // #168: Evaluate XLM SAC transfers for destination account activation
  if (eventType === 'transfer' && decoded && typeof decoded === 'object') {
    maybeActivateFromTransferEvent(
      decoded as Record<string, unknown>,
      event.contractId,
      event.transactionHash,
      event.ledgerSequence,
      event.ledgerCloseTime,
    ).catch((err) => console.error('[sac-activator] evaluation error:', err));
  }

  // Track RWA yield/distribution events
  await processYieldEvent(
    event.transactionHash,
    event.contractId,
    topicSymbol,
    decoded as Record<string, unknown> | null,
    event.ledgerSequence,
    event.ledgerCloseTime,
  );

  const broadcastPayload = {
    id,
    contractAddress: event.contractId,
    eventType,
    decoded,
    ledger: event.ledgerSequence,
    ledgerCloseTime: event.ledgerCloseTime,
    transactionHash: event.transactionHash,
  };

  broadcastEvent(broadcastPayload);
  broadcastSSEEvent(broadcastPayload);

  dispatchWebhooks({ ...broadcastPayload, topicSymbol }).catch((err) =>
    console.error('[webhook] dispatch error:', err),
  );

  return 1;
}
