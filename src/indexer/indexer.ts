import WebSocket from 'ws';
import { prismaWrite as prisma } from '../db';
import { config } from '../config';
import { getLatestLedger, getRpcWebsocketUrl } from './rpc';
import { processLedgerRange } from './ledgerProcessor';

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
  await prisma.indexerState.update({ where: { id: 'singleton' }, data: { lastLedger: ledger } });
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
    `(chunk size ~${chunks[0][1] - chunks[0][0] + 1})`
  );
  await Promise.all(chunks.map(([s, e]) => processLedgerRange(s, e)));
  await setLastIndexedLedger(to);
  console.log(`[catch-up] done — cursor advanced to ${to}`);
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
  private reconnectDelayMs = 1000;
  private isProcessing = false;
  private shouldStop = false;

  async start() {
    console.log('🔍 Soroban event worker starting...');
    this.connectWebsocket();

    while (!this.shouldStop) {
      try {
        const latest = await getLatestLedger();
        const last = await getLastIndexedLedger();
        const gap = latest - last;

        if (gap <= 0) {
          await sleep(config.indexerPollIntervalMs);
          continue;
        }

        if (gap > BATCH && WORKERS > 1) {
          // Large gap — use parallel catch-up workers
          await catchUp(last + 1, latest);
        } else {
          // Small gap (≤ one batch) or single-worker mode — process inline
          const end = Math.min(last + BATCH, latest);
          await processLedgerRange(last + 1, end);
          await setLastIndexedLedger(end);
        }
      } catch (err) {
        console.error('Indexer error:', err);
        await sleep(config.indexerPollIntervalMs);
      }
    }
  }

  // -------------------------------------------------------------------------
  // WebSocket live-tail (triggers onLedgerClose for real-time updates)
  // -------------------------------------------------------------------------

  private connectWebsocket() {
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
    this.websocket.send(JSON.stringify({
      jsonrpc: '2.0',
      method: 'subscribe',
      params: { topic: 'ledger' },
      id: 1,
    }));
  }

  private handleWsMessage(data: WebSocket.Data) {
    const payload = this.dataToString(data);
    if (!payload) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const message: any = JSON.parse(payload);
      const ledgerNumber = this.extractLedgerNumber(message);
      if (typeof ledgerNumber === 'number') {
        this.onLedgerClose(ledgerNumber).catch((err) =>
          console.error('Ledger close handler failed:', err)
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
    this.isProcessing = true;
    try {
      const last = await getLastIndexedLedger();
      if (ledger <= last) return;
      console.log(`Ledger close event received for ledger ${ledger}`);
      const end = Math.min(last + BATCH, ledger);
      await processLedgerRange(last + 1, end);
      await setLastIndexedLedger(end);
    } finally {
      this.isProcessing = false;
    }
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
    setTimeout(() => this.connectWebsocket(), this.reconnectDelayMs);
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
