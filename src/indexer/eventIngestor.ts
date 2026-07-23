import { xdr } from '@stellar/stellar-sdk';
import { prismaWrite as prisma } from '../db';
import { decodeEvent } from './decoder';
import { fetchEvents, LedgerEvent } from './rpc';

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

  const sorobanMeta = meta.v3().sorobanMeta();
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
      const bodyV0 = ev.body().v0();
      const topics = bodyV0.topics().map((t: xdr.ScVal) => t.toXDR('base64'));
      const data: string = bodyV0.data().toXDR('base64');
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
  ledger: number,
  ledgerCloseTime: Date,
  metaXdr: string
): Promise<number> {
  const raw = extractEventsFromMeta(metaXdr);
  let stored = 0;

  for (const ev of raw) {
    const ledgerEvent: LedgerEvent = {
      contractId: ev.contractId,
      transactionHash: txHash,
      ledger,
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

  // Ensure the contract row exists before inserting the event (FK constraint)
  await prisma.contract.upsert({
    where: { address: event.contractId },
    update: {},
    create: {
      address: event.contractId,
      name: `Unknown Contract (${event.contractId.slice(0, 8)}…)`,
    },
  });

  // Ensure the transaction row exists (Event has a required FK to Transaction)
  const txExists = await prisma.transaction.findUnique({
    where: { hash: event.transactionHash },
    select: { hash: true },
  });
  if (!txExists) return 0; // transaction not yet indexed; skip

  const { eventType, decoded } = decodeEvent(event.topics, event.data);

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
      topics: event.topics,
      data: { raw: event.data },
      decoded: decoded as object,
      ledger: event.ledger,
      ledgerCloseTime: event.ledgerCloseTime,
    },
  });

  return 1;
}
