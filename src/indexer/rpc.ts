import type { AxiosError } from 'axios';
import { xdr, SorobanRpc } from '@stellar/stellar-sdk';
import { config } from '../config';

export const rpc = new SorobanRpc.Server(config.stellarRpcUrl, { allowHttp: true });

export interface LedgerEvent {
  contractId: string;
  transactionHash: string;
  ledger: number;
  ledgerCloseTime: Date;
  topics: string[];
  data: string;
}

const EVENT_PAGE_SIZE = 200;
const MAX_RETRY_ATTEMPTS = 6;
const MAX_PAGES = 100;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getStatus(error: unknown): number | undefined {
  if (error && typeof error === 'object' && 'status' in error) {
    return (error as { status: number }).status;
  }
  return undefined;
}

function getMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: string }).message);
  }
  return '';
}

function isRateLimitError(error: unknown): boolean {
  const axiosError = error as AxiosError | undefined;
  const status = axiosError?.response?.status ?? getStatus(error);
  return status === 429 || getMessage(error).includes('429');
}

async function retry<T>(fn: () => Promise<T>): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (error: unknown) {
      if (!isRateLimitError(error) || attempt >= MAX_RETRY_ATTEMPTS) {
        throw error;
      }

      const backoff = Math.min(16000, 500 * 2 ** attempt);
      const jitter = Math.floor(Math.random() * 300);
      attempt += 1;
      console.warn(`RPC rate limit hit, retrying in ${backoff + jitter}ms (attempt ${attempt})`);
      await sleep(backoff + jitter);
    }
  }
}

async function fetchEventsPage(startLedger: number, cursor?: string) {
  return retry(() =>
    rpc.getEvents({
      startLedger,
      filters: [{ type: 'contract' }],
      limit: EVENT_PAGE_SIZE,
      cursor,
    }),
  );
}

/**
 * Fetch Soroban events for a ledger range from the RPC node.
 */
export async function fetchEvents(startLedger: number, endLedger: number): Promise<LedgerEvent[]> {
  const events: LedgerEvent[] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  let pageCount = 0;

  while (true) {
    pageCount++;
    if (pageCount > MAX_PAGES) {
      console.warn(`[fetchEvents] Exceeded max page count (${MAX_PAGES}) for range ${startLedger}–${endLedger}`);
      break;
    }

    if (cursor && seenCursors.has(cursor)) {
      console.warn(`[fetchEvents] Repeated cursor detected — breaking pagination loop`);
      break;
    }
    if (cursor) {
      seenCursors.add(cursor);
    }

    const response = await fetchEventsPage(startLedger, cursor);
    const page = response.events ?? [];

    if (!page.length) {
      break;
    }

    const mapped = page
      .filter((e) => typeof e.ledger === 'number' && e.ledger >= startLedger && e.ledger <= endLedger)
      .map((e) => {
        const contractId = String(e.contractId ?? '');
        const topics = e.topic.map((t: xdr.ScVal) => t.toXDR('base64'));
        const data = e.value?.toXDR ? e.value.toXDR('base64') : String(e.value ?? '');
        return {
          contractId,
          transactionHash: String(e.txHash ?? ''),
          ledger: Number(e.ledger),
          ledgerCloseTime: new Date(e.ledgerClosedAt ?? Date.now()),
          topics,
          data,
        };
      });

    events.push(...mapped);

    if (page.length < EVENT_PAGE_SIZE) {
      break;
    }

    cursor = page[page.length - 1].pagingToken;
    if (!cursor) {
      break;
    }
  }

  return events;
}

/**
 * Fetch the latest ledger number from the RPC node.
 */
export async function getLatestLedger(): Promise<number> {
  const info = await retry(() => rpc.getLatestLedger());
  return Number(info.sequence);
}

/**
 * Fetch a transaction by hash.
 */
export async function getTransaction(hash: string) {
  return retry(() => rpc.getTransaction(hash));
}

export function getRpcWebsocketUrl(): string {
  return config.stellarRpcWsUrl;
}
