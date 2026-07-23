import { SorobanRpc, xdr } from '@stellar/stellar-sdk';
import { prismaWrite as prisma } from '../db';
import { fetchEvents, getTransaction } from './rpc';
import { decodeTransaction } from './decoder';
import { ingestEvents } from './eventIngestor';
import { enqueueFailure } from './errorQueue';

function getSourceAccountFromEnvelope(env: xdr.TransactionEnvelope): string {
  try {
    if (env.switch().name === 'envelopeTypeTx') {
      const muxed = env.v1().tx().sourceAccount();
      const buf = muxed.switch().name === 'keyTypeEd25519' ? muxed.ed25519() : muxed.med25519().ed25519();
      return Buffer.from(buf).toString('hex');
    }
    return Buffer.from(env.v0().tx().sourceAccountEd25519()).toString('hex');
  } catch {
    return 'unknown';
  }
}

/**
 * Fetch, decode, and persist all transactions and events for [start, end].
 * Safe to call concurrently for non-overlapping ranges — all DB writes use
 * upsert so duplicate execution is idempotent.
 */
export async function processLedgerRange(start: number, end: number): Promise<void> {
  console.log(`[worker] Indexing ledgers ${start} → ${end}`);
  const events = await fetchEvents(start, end);

  for (const event of events) {
    await prisma.contract.upsert({
      where: { address: event.contractId },
      update: {},
      create: {
        address: event.contractId,
        name: `Unknown Contract (${event.contractId.slice(0, 8)}…)`,
      },
    });

    const existingTx = await prisma.transaction.findUnique({ where: { hash: event.transactionHash } });
    if (!existingTx) {
      const txResult = await getTransaction(event.transactionHash).catch(() => null);
      const txRecord = txResult as SorobanRpc.Api.GetSuccessfulTransactionResponse | SorobanRpc.Api.GetFailedTransactionResponse | null | undefined;
      const envelopeXdr = txRecord?.envelopeXdr;
      const rawXdr = envelopeXdr?.toXDR?.('base64') ?? '';
      const sourceAccount = envelopeXdr ? getSourceAccountFromEnvelope(envelopeXdr) : 'unknown';
      const decoded = rawXdr
        ? await decodeTransaction(rawXdr).catch(async (err) => {
            await enqueueFailure({
              itemType: 'transaction',
              itemId: event.transactionHash,
              ledger: event.ledger,
              rawXdr,
              error: err,
            });
            return { contractAddress: event.contractId, functionName: null, functionArgs: null, humanReadable: null };
          })
        : { contractAddress: event.contractId, functionName: null, functionArgs: null, humanReadable: null };

      await prisma.transaction.upsert({
        where: { hash: event.transactionHash },
        update: {},
        create: {
          hash: event.transactionHash,
          ledger: event.ledger,
          ledgerCloseTime: event.ledgerCloseTime,
          sourceAccount,
          contractAddress: decoded.contractAddress,
          functionName: decoded.functionName,
          functionArgs: decoded.functionArgs as object | undefined ?? undefined,
          rawXdr,
          status:
            txResult?.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS
              ? 'success'
              : 'failed',
          humanReadable: decoded.humanReadable,
          feeCharged: String(envelopeXdr?.v1()?.tx()?.fee()?.toString() ?? envelopeXdr?.v0()?.tx()?.fee()?.toString() ?? ''),
        },
      });
    }
  }

  const stored = await ingestEvents(start, end);
  console.log(`[worker] ledgers ${start}–${end}: ${events.length} txs, ${stored} events`);
}
