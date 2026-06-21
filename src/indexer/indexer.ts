import WebSocket from 'ws';
import { prismaWrite as prisma } from '../db';
import { config } from '../config';
import {
  fetchEvents,
  getLatestLedger,
  getRpcWebsocketUrl,
  getTransaction,
  getTransactionFromHorizon,
  type LedgerEvent,
} from './rpc';
import { decodeTransaction, decodeEvent } from './decoder';
import { feedOrchestrator } from '../feed/orchestrator';

const BATCH = config.indexerBatchSize;
const WORKERS = config.indexerCatchupWorkers;

// ---------------------------------------------------------------------------
// IndexerState helpers
// ---------------------------------------------------------------------------

async function getLastIndexedLedger(): Promise<number> {
  const state = await prisma.indexerState.upsert({
    where: { id: 'singleton' },
    update: {},
    create: { id: 'singleton', lastLedger: config.indexerStartLedger },
  });
  return state.lastLedger;
}

async function setLastIndexedLedger(ledger: number): Promise<void> {
  await prisma.indexerState.upsert({
    where: { id: 'singleton' },
    update: { lastLedger: ledger },
    create: { id: 'singleton', lastLedger: ledger },
  });
}

async function processLedgerRange(start: number, end: number) {
  console.log(`Indexing ledgers ${start} → ${end}`);
  const events = await fetchEvents(start, end);

  for (const event of events) {
    await prisma.contract.upsert({
      where: { address: event.contractId },
      update: {},
      create: { address: event.contractId },
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

      // Publish to feed
      await feedOrchestrator.publishTransaction(transaction).catch(console.error);
    }

    const { eventType, decoded } = decodeEvent(event.topics, event.data);
    const eventId = `${event.transactionHash}-${event.topics[0] ?? '0'}`;
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

export async function runIndexer() {
  await startIndexerService();
}

export async function startIndexerService() {
  const worker = new SorobanEventWorker();
  await worker.start();
}

class SorobanEventWorker {
  private websocket?: WebSocket;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectDelayMs = 1000;
  private isProcessing = false;
  private shouldStop = false;

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
