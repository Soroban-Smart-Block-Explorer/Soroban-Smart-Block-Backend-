import WebSocket from 'ws';
import { xdr } from '@stellar/stellar-sdk';
import { prismaWrite as prisma } from '../db';
import { config } from '../config';
import {
  fetchEvents,
  getLatestLedger,
  getRpcWebsocketUrl,
  getTransaction,
  getTransactionFromHorizon,
  type LedgerEvent,
  fetchLedgerMetadata,
} from './rpc';
import { decodeTransaction, decodeEvent } from './decoder';
import { decodeZkpVerification, recordZkpVerification } from './zkp-verifier';
import { processAaTransaction } from './aa-indexer';
import { feedOrchestrator } from '../feed/orchestrator';
import { enqueueInitialAudit } from './audit-pipeline';
import { amIResponsibleFor, getRangeCursor, isP2pEnabled, setRangeCursor } from '../p2p';

const BATCH = config.indexerBatchSize;
const WORKERS = config.indexerCatchupWorkers;

// ---------------------------------------------------------------------------
// IndexerState helpers
//
// In single-node mode (P2P_ENABLED unset/false — the default, zero behavior
// change) these delegate to the singleton IndexerState row exactly as
// before. In P2P mode they delegate to per-range cursors (IndexerRangeClaim)
// instead: getLastIndexedLedger() returns the furthest-behind cursor among
// ranges this node currently owns, and setLastIndexedLedger(ledger) advances
// the cursor of whichever range `ledger` falls in. See
// docs/P2P_INDEXER_DESIGN.md §3.
// ---------------------------------------------------------------------------

export async function getLastIndexedLedger(): Promise<number> {
  if (isP2pEnabled()) {
    return getLastIndexedLedgerP2p();
  }
  const state = await prisma.indexerState.upsert({
    where: { id: 'singleton' },
    update: {},
    create: { id: 'singleton', lastLedger: config.indexerStartLedger },
  });
  return state.lastLedger;
}

async function getLastIndexedLedgerP2p(): Promise<number> {
  // Probe from the configured start ledger: the cursor of whichever range it
  // falls in tells us where this node last left off for that range. Ranges
  // this node doesn't own report their own cursor too (harmless — the
  // per-ledger responsibility check in processLedgerRange skips them), so we
  // simply use the probe range's cursor as the resume point for the main
  // sequential loop, same shape as the single-node singleton cursor.
  return getRangeCursor(config.indexerStartLedger);
}

export async function setLastIndexedLedger(ledger: number): Promise<void> {
  if (isP2pEnabled()) {
    await setRangeCursor(ledger, ledger);
    return;
  }
  await prisma.indexerState.upsert({
    where: { id: 'singleton' },
    update: { lastLedger: ledger },
    create: { id: 'singleton', lastLedger: ledger },
  });
}

export async function rollbackLedgers(sequences: number[]) {
  console.log(`⚠️ Rollback triggered for ledgers: ${sequences.join(', ')}`);

  await prisma.$transaction([
    // Delete SessionAuthorizations related to these ledgers
    prisma.sessionAuthorization.deleteMany({
      where: {
        startLedger: { in: sequences },
      },
    }),

    // Delete Events for these ledgers
    prisma.event.deleteMany({
      where: {
        ledgerSequence: { in: sequences },
      },
    }),

    // Delete Transactions for these ledgers
    prisma.transaction.deleteMany({
      where: {
        ledgerSequence: { in: sequences },
      },
    }),

    // Delete WasmUpgradeHistory for these ledgers
    prisma.wasmUpgradeHistory.deleteMany({
      where: {
        ledgerSequence: { in: sequences },
      },
    }),

    // Delete Ledgers themselves
    prisma.ledger.deleteMany({
      where: {
        sequence: { in: sequences },
      },
    }),
  ]);
}

export async function processLedgerRange(
  start: number,
  end: number,
  opts: { force?: boolean } = {},
) {
  console.log(`Indexing ledgers ${start} → ${end}`);

  // 1. Fetch metadata and check reorgs sequentially for all ledgers in the range first
  for (let seq = start; seq <= end; seq++) {
    if (!opts.force && !(await amIResponsibleFor(seq))) {
      // Not one of this range's rendezvous-hash owners (P2P mode only — see
      // docs/P2P_INDEXER_DESIGN.md §1.2/§3). Another replica indexes it;
      // skip without writing so we don't do redundant RPC/DB work outside
      // our assigned ranges. opts.force bypasses this for on-the-fly
      // graceful-degradation indexing (indexSingleLedger below), where we
      // explicitly want to index a ledger regardless of steady-state
      // ownership because no reachable owner had it.
      continue;
    }
    const ledgerMeta = await fetchLedgerMetadata(seq);

    // Reorg check
    const prevSeq = seq - 1;
    const prevLedger = await prisma.ledger.findUnique({ where: { sequence: prevSeq } });
    if (prevLedger && prevLedger.hash !== ledgerMeta.previousLedgerHash) {
      console.warn(
        `🚨 REORG DETECTED at ledger ${seq}! Expected prev hash ${prevLedger.hash}, but network says ${ledgerMeta.previousLedgerHash}`,
      );

      await prisma.reorgEvent.create({
        data: {
          ledgerSequence: seq,
          expectedHash: prevLedger.hash,
          actualHash: ledgerMeta.previousLedgerHash,
          previousHash: prevLedger.previousLedgerHash ?? '',
          rolledBackLedgers: [prevSeq],
        },
      });

      await rollbackLedgers([prevSeq]);
      await setLastIndexedLedger(prevSeq - 1);

      throw new Error(`Reorg detected at ledger ${seq}. Rolled back ${prevSeq}.`);
    }

    // Save/upsert Ledger record
    await prisma.ledger.upsert({
      where: { sequence: seq },
      update: {
        hash: ledgerMeta.hash,
        previousLedgerHash: ledgerMeta.previousLedgerHash,
        closeTime: ledgerMeta.closeTime,
        txCount: ledgerMeta.txCount,
      },
      create: {
        sequence: seq,
        hash: ledgerMeta.hash,
        previousLedgerHash: ledgerMeta.previousLedgerHash,
        closeTime: ledgerMeta.closeTime,
        txCount: ledgerMeta.txCount,
      },
    });
  }

  // 2. Fetch events for the range and process them normally
  const events = await fetchEvents(start, end);

  for (const event of events) {
    await prisma.contract.upsert({
      where: { address: event.contractId },
      update: {},
      create: { address: event.contractId },
    });

    // Queue an initial audit for newly discovered contracts (fires after 5 min)
    enqueueInitialAudit(event.contractId);

    const existingTx = await prisma.transaction.findUnique({
      where: { hash: event.transactionHash },
    });
    const existingTx = await prisma.transaction.findUnique({
      where: { hash: event.transactionHash },
    });
    if (!existingTx) {
      const txResult = await getTransaction(event.transactionHash).catch(() =>
        getTransactionFromHorizon(event.transactionHash).catch(() => null),
      );
      const rawXdr = (txResult as any)?.envelopeXdr?.toXDR('base64') ?? '';
      const decoded = rawXdr
        ? await decodeTransaction(rawXdr)
        : {
            contractAddress: event.contractId,
            functionName: null,
            functionArgs: null,
            humanReadable: null,
          };

      const transaction = await prisma.transaction.upsert({
        where: { hash: event.transactionHash },
        update: {},
        create: {
          hash: event.transactionHash,
          ledgerSequence: event.ledgerSequence,
          ledgerCloseTime: event.ledgerCloseTime,
          sourceAccount: (txResult as any)?.sourceAccount ?? 'unknown',
          contractAddress: decoded.contractAddress,
          functionName: decoded.functionName,
          functionArgs: (decoded.functionArgs as object) ?? undefined,
          rawXdr,
          status: (txResult as any)?.status === 'SUCCESS' ? 'success' : 'failed',
          humanReadable: decoded.humanReadable,
          feeCharged: String((txResult as any)?.feeCharged ?? ''),
        },
      });

      // Record ZKP verifier invocations when the invoked function looks like
      // a proof verification entry point (verify_proof / verify_snark /
      // verify_stark / verify_groth16). Best-effort: a failure here must
      // never disrupt the main indexing loop.
      try {
        if (rawXdr && decoded.functionName && decoded.contractAddress) {
          const envelope = xdr.TransactionEnvelope.fromXDR(rawXdr, 'base64');
          const ops =
            envelope.switch().name === 'envelopeTypeTx'
              ? envelope.v1().tx().operations()
              : envelope.v0().tx().operations();
          const invokeOp = ops.find((op) => op.body().switch().name === 'invokeHostFunction');
          const scArgs = invokeOp
            ? invokeOp.body().invokeHostFunctionOp().hostFunction().invokeContract().args()
            : [];
          const zkpData = decodeZkpVerification(decoded.functionName, scArgs);
          if (zkpData) {
            await recordZkpVerification(
              transaction.hash,
              decoded.contractAddress,
              zkpData,
              transaction.ledgerSequence,
              transaction.ledgerCloseTime,
            );
          }
        }
      } catch (zkpErr) {
        console.error('ZKP recording error:', zkpErr);
      }

      // Trigger Account Abstraction processing (non-blocking)
      try {
        void processAaTransaction(
          transaction.hash,
          transaction.sourceAccount,
          rawXdr,
          transaction.ledgerSequence,
          transaction.ledgerCloseTime,
          transaction.feeCharged ?? undefined,
        );
      } catch (err) {
        console.error('AA processing error:', err);
      }

      // Publish to feed
      await feedOrchestrator.publishTransaction(transaction).catch(console.error);
    }

    const { eventType, decoded } = decodeEvent(event.topics, event.data);
    // Include paging token (unique per event position) to prevent ID collisions
    // when a single transaction emits multiple events with the same first topic.
    const positionKey = event.pagingToken || `${event.ledgerSequence}-${events.indexOf(event)}`;
    const eventId = `${event.transactionHash}-${positionKey}`;
    const savedEvent = await prisma.event.upsert({
      where: { id: eventId },
      update: {},
      create: {
        id: eventId,
        transactionHash: event.transactionHash,
        contractAddress: event.contractId,
        eventType,
        topics: event.topics,
        data: { raw: event.data },
        decoded: decoded as object,
        ledgerSequence: event.ledgerSequence,
        ledgerCloseTime: event.ledgerCloseTime,
      },
    });

    // Publish event to feed
    await feedOrchestrator.publishEvent(savedEvent).catch(console.error);

    await processSessionAuthorization(event, eventType, decoded, eventId);
  }
}

/**
 * Indexes exactly one ledger regardless of range ownership — used as the
 * P2P "graceful degradation" on-the-fly indexing fallback (design doc §1.3)
 * when a query's range owners are all unreachable.
 */
export async function indexSingleLedger(ledgerSeq: number): Promise<void> {
  await processLedgerRange(ledgerSeq, ledgerSeq, { force: true });
}

// ---------------------------------------------------------------------------
// Parallel catch-up
// ---------------------------------------------------------------------------

/**
 * Split [from, to] into at most `n` equal-sized chunks.
 */
function chunkRange(from: number, to: number, n: number): Array<[number, number]> {
  const total = to - from + 1;
  const size = Math.ceil(total / n);
  const chunks: Array<[number, number]> = [];
  for (let start = from; start <= to; start += size) {
    chunks.push([start, Math.min(start + size - 1, to)]);
  }
  return chunks;
}

/**
 * Run parallel workers over [from, to], then advance IndexerState to `to`.
 * Workers process non-overlapping chunks concurrently; the state write is
 * serialised after all workers succeed so a partial failure leaves the
 * cursor unchanged and the whole round retries safely (upserts are idempotent).
 */
async function catchUp(from: number, to: number): Promise<void> {
  const chunks = chunkRange(from, to, WORKERS);
  console.log(
    `[catch-up] ${chunks.length} worker(s) covering ledgers ${from}–${to} ` +
      `(chunk size ~${chunks[0][1] - chunks[0][0] + 1})`,
  );
  await Promise.all(chunks.map(([s, e]) => processLedgerRange(s, e)));
  await setLastIndexedLedger(to);
  console.log(`[catch-up] done — cursor advanced to ${to}`);
}

async function processSessionAuthorization(
  event: LedgerEvent,
  eventType: string,
  decoded: Record<string, unknown>,
  eventId: string,
) {
  const knownAuthEvents = new Set([
    'session_authorization',
    'authorize_session',
    'hot_signer_authorized',
    'ephemeral_key_auth',
    'authorization_window',
  ]);
  if (!knownAuthEvents.has(eventType)) {
    return;
  }

  const hotSigner = extractHotSigner(decoded, event.topics);
  const startLedger = extractStartLedger(decoded, event.ledgerSequence);
  const expiryLedger = extractExpiryLedger(decoded, startLedger);
  if (!hotSigner || expiryLedger === undefined || expiryLedger <= startLedger) {
    return;
  }

  const allocatedBlocks = Math.max(0, expiryLedger - startLedger);

  await prisma.sessionAuthorization.upsert({
    where: { eventId },
    update: {
      hotSigner,
      authorizationType: eventType,
      startLedger,
      expiryLedger,
      allocatedBlocks,
      contractAddress: event.contractId,
    },
    create: {
      eventId,
      contractAddress: event.contractId,
      hotSigner,
      authorizationType: eventType,
      startLedger,
      expiryLedger,
      allocatedBlocks,
    },
  });
}

function extractHotSigner(decoded: Record<string, unknown>, topics: string[]) {
  if (decoded?.hotSigner) {
    return String(decoded.hotSigner);
  }
  if (decoded?.authorizedSigner) {
    return String(decoded.authorizedSigner);
  }
  if (decoded?.data && typeof decoded.data === 'object' && decoded.data !== null) {
    const candidate = getNumericOrStringField(decoded.data as Record<string, unknown>, [
      'hotSigner',
      'authorizedSigner',
      'signer',
      'address',
    ]);
    if (candidate) {
      return String(candidate);
    }
  }
  if (Array.isArray(decoded.topics) && decoded.topics[1] != null) {
    return String(decoded.topics[1]);
  }
  if (topics[1]) {
    return topics[1];
  }
  return undefined;
}

function extractStartLedger(decoded: Record<string, unknown>, defaultLedger: number) {
  const rawStart =
    decoded?.data && typeof decoded.data === 'object'
      ? getNumericOrStringField(decoded.data as Record<string, unknown>, [
          'startLedger',
          'start_block',
          'fromLedger',
        ])
      : undefined;
  const parsed = rawStart !== undefined ? Number(rawStart) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultLedger;
}

function extractExpiryLedger(decoded: Record<string, unknown>, startLedger: number) {
  const data = decoded?.data;
  const rawExpiry =
    typeof data === 'object' && data !== null
      ? getNumericOrStringField(data as Record<string, unknown>, [
          'expiryLedger',
          'expiresAtLedger',
          'expires_at_ledger',
          'expirationLedger',
          'validUntilLedger',
          'expiresAtBlock',
          'expiryBlock',
        ])
      : undefined;

  if (rawExpiry !== undefined) {
    const expiry = Number(rawExpiry);
    if (Number.isFinite(expiry) && expiry > 0) {
      return expiry;
    }
  }

  const duration =
    typeof data === 'object' && data !== null
      ? getNumericOrStringField(data as Record<string, unknown>, [
          'durationBlocks',
          'allocatedBlocks',
          'windowBlocks',
          'expiresInBlocks',
        ])
      : undefined;
  const parsedDuration = duration !== undefined ? Number(duration) : NaN;
  if (Number.isFinite(parsedDuration) && parsedDuration > 0) {
    return startLedger + parsedDuration;
  }

  return undefined;
}

function getNumericOrStringField(source: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return undefined;
}
// ---------------------------------------------------------------------------
// Worker class (live tail + catch-up orchestration)
// ---------------------------------------------------------------------------

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

let currentWorker: SorobanEventWorker | null = null;

export async function runIndexer() {
  await startIndexerService();
}

export async function startIndexerService() {
  const worker = new SorobanEventWorker();
  currentWorker = worker;
  await worker.start();
}

export function stopIndexerService(): void {
  if (currentWorker) {
    currentWorker.stop();
    currentWorker = null;
  }
}

export class SorobanEventWorker {
  private websocket?: WebSocket;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectDelayMs = 1000;
  private isProcessing = false;
  private shouldStop = false;

  stop(): void {
    this.shouldStop = true;
    if (this.websocket) {
      this.websocket.close();
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  async start() {
    console.log('🔍 Soroban event worker starting...');
    this.connectWebsocket();

    while (!this.shouldStop) {
      try {
        if (this.isProcessing) {
          await sleep(config.indexerPollIntervalMs);
          continue;
        }

        const latest = await getLatestLedger();
        await this.syncToLatest(latest);
      } catch (err) {
        console.error('Indexer error:', err);
        await sleep(config.indexerPollIntervalMs);
      }
    }
  }

  private async syncToLatest(targetLedger: number) {
    if (this.isProcessing) return;
    this.isProcessing = true;
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const last = await getLastIndexedLedger();
        if (last >= targetLedger) return;

        // --- GAP DETECTION & BACKFILL ---
        if (last < targetLedger - 1) {
          const gapStart = last + 1;
          const gapEnd = targetLedger - 1;
          console.warn(
            `⚠️ Ledger gap detected: expected next ledger to be ${targetLedger}, but last indexed is ${last}. Gap range: ${gapStart} → ${gapEnd}`,
          );

          // Record LedgerGap in the database
          await prisma.ledgerGap.create({
            data: {
              startSequence: gapStart,
              endSequence: gapEnd,
              resolved: false,
            },
          });

          // Attempt to backfill the gap
          try {
            console.log(`🔄 Attempting to backfill gap ${gapStart} → ${gapEnd}...`);
            if (gapEnd - gapStart >= BATCH && WORKERS > 1) {
              await catchUp(gapStart, gapEnd);
            } else {
              await processLedgerRange(gapStart, gapEnd);
              await setLastIndexedLedger(gapEnd);
            }

            // Mark the gap as resolved
            await prisma.ledgerGap.updateMany({
              where: {
                startSequence: gapStart,
                endSequence: gapEnd,
                resolved: false,
              },
              data: { resolved: true },
            });
            console.log(
              `✅ Ledger gap ${gapStart} → ${gapEnd} successfully backfilled and resolved.`,
            );
          } catch (backfillErr) {
            console.error(`❌ Failed to backfill ledger gap ${gapStart} → ${gapEnd}:`, backfillErr);
            throw backfillErr;
          }

          // Refresh last indexed ledger after backfill
          continue;
        }

        const gap = targetLedger - last;
        if (gap > BATCH && WORKERS > 1) {
          await catchUp(last + 1, targetLedger);
          return;
        }

        const end = Math.min(last + BATCH, targetLedger);
        await processLedgerRange(last + 1, end);
        await setLastIndexedLedger(end);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  // -------------------------------------------------------------------------
  // WebSocket live-tail (triggers onLedgerClose for real-time updates)
  // -------------------------------------------------------------------------

  private connectWebsocket() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    const url = getRpcWebsocketUrl();
    console.log(`Connecting Soroban RPC websocket to ${url}`);
    try {
      this.websocket = new WebSocket(url);
      this.websocket.on('open', () => this.handleWsOpen());
      this.websocket.on('message', (data) => this.handleWsMessage(data));
      this.websocket.on('close', (code, reason) => this.handleWsClose(code, reason.toString()));
      this.websocket.on('error', (error) => this.handleWsError(error));
    } catch (error) {
      console.error('Failed to establish websocket connection:', error);
      this.scheduleReconnect();
    }
  }

  private handleWsOpen() {
    console.log('Soroban RPC websocket connected');
    this.reconnectDelayMs = 1000;
    this.subscribeLedgerClose();
  }

  private subscribeLedgerClose() {
    if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) return;
    this.websocket.send(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'subscribe',
        params: { topic: 'ledger' },
        id: 1,
      }),
    );
  }

  private handleWsMessage(data: WebSocket.Data) {
    const payload = this.dataToString(data);
    if (!payload) return;
    try {
      const message = JSON.parse(payload) as any;
      const ledgerNumber = this.extractLedgerNumber(message);
      if (typeof ledgerNumber === 'number') {
        this.onLedgerClose(ledgerNumber).catch((err) =>
          console.error('Ledger close handler failed:', err),
        );
      }
    } catch (error) {
      console.warn('Failed to parse websocket event payload:', error);
    }
  }

  private extractLedgerNumber(message: any): number | undefined {
    const candidate =
      message?.params?.ledger?.sequence ??
      message?.params?.ledger_sequence ??
      message?.params?.sequence ??
      message?.result?.sequence ??
      message?.result?.ledger?.sequence ??
      message?.ledger;
    const ledger = Number(candidate);
    return Number.isFinite(ledger) && ledger > 0 ? ledger : undefined;
  }

  private async onLedgerClose(ledger: number) {
    if (this.isProcessing) return;
    console.log(`Ledger close event received for ledger ${ledger}`);
    await this.syncToLatest(ledger);
  }

  private handleWsClose(code: number, reason: string) {
    console.warn(`Soroban RPC websocket closed (${code}) ${reason}`);
    this.scheduleReconnect();
  }

  private handleWsError(error: Error) {
    console.error('Soroban RPC websocket error:', error.message ?? error);
    this.websocket?.close();
  }

  private scheduleReconnect() {
    if (this.shouldStop) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.reconnectTimer = setTimeout(() => {
      this.connectWebsocket();
      this.reconnectTimer = undefined;
    }, this.reconnectDelayMs);
    this.reconnectDelayMs = Math.min(30000, this.reconnectDelayMs * 2);
  }

  private dataToString(raw: WebSocket.Data): string {
    if (typeof raw === 'string') return raw;
    if (raw instanceof Buffer) return raw.toString('utf8');
    if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
    if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
    return '';
  }
}
