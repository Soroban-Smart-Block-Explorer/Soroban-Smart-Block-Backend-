import type { AxiosError } from 'axios';
import { xdr, SorobanRpc } from '@stellar/stellar-sdk';
import { config } from '../config';
import { cacheGet, cacheSet } from '../cache';
import { logger } from '../logger';
import {
  rpcCallDuration,
  rpcCallErrorsTotal,
  rpcCallRetriesTotal,
  horizonCallDuration,
  horizonCallErrorsTotal,
} from '../metrics';

const isDevnet = config.profile.name === 'devnet';

// Reject plain-HTTP RPC URLs in non-devnet environments at startup.
if (!isDevnet && config.stellarRpcUrl.startsWith('http://')) {
  throw new Error(
    `[${config.profile.name}] Insecure RPC URL rejected: "${config.stellarRpcUrl}". ` +
      `Use https:// for testnet and mainnet, or switch to STELLAR_NETWORK=devnet for local development.`,
  );
}

export const rpc = new SorobanRpc.Server(config.stellarRpcUrl, { allowHttp: isDevnet });

export interface LedgerEvent {
  contractId: string;
  transactionHash: string;
  ledgerSequence: number;
  ledgerCloseTime: Date;
  topics: string[];
  data: string;
  pagingToken: string;
}

const LEDGER_CACHE_PREFIX = 'ledger:';

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

/**
 * #910 — run `fn` while recording outbound RPC latency, error rate, and
 * retry activity on the shared Prometheus registry. Every call site goes
 * through here so all RPC operations are instrumented for free.
 */
async function retry<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const startTime = Date.now();
    try {
      const result = await fn();
      rpcCallDuration.observe({ operation, status: 'success' }, (Date.now() - startTime) / 1000);
      return result;
    } catch (error: unknown) {
      rpcCallDuration.observe({ operation, status: 'error' }, (Date.now() - startTime) / 1000);
      const type = isRateLimitError(error) ? 'rate_limit' : 'error';
      rpcCallErrorsTotal.inc({ operation, type });

      if (!isRateLimitError(error) || attempt >= MAX_RETRY_ATTEMPTS) {
        throw error;
      }

      const backoff = Math.min(16000, 500 * 2 ** attempt);
      const jitter = Math.floor(Math.random() * 300);
      attempt += 1;
      rpcCallRetriesTotal.inc({ operation });
      logger.warn(`RPC rate limit hit, retrying in ${backoff + jitter}ms (attempt ${attempt})`);
      await sleep(backoff + jitter);
    }
  }
}

/**
 * #910 — time a Horizon REST API call and record latency/errors on the shared
 * Prometheus registry. Horizon is the indexer's fallback external dependency
 * (transactions and ledger metadata when RPC can't answer).
 */
async function horizonCall<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  const startTime = Date.now();
  try {
    const result = await fn();
    horizonCallDuration.observe({ operation, status: 'success' }, (Date.now() - startTime) / 1000);
    return result;
  } catch (error) {
    horizonCallDuration.observe({ operation, status: 'error' }, (Date.now() - startTime) / 1000);
    horizonCallErrorsTotal.inc({ operation, type: 'error' });
    throw error;
  }
}

async function fetchEventsPage(startLedger: number, cursor?: string) {
  return retry('getEvents', () =>
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

  // eslint-disable-next-line no-constant-condition
  while (true) {
    pageCount++;
    if (pageCount > MAX_PAGES) {
      logger.warn(
        `[fetchEvents] Exceeded max page count (${MAX_PAGES}) for range ${startLedger}–${endLedger}`,
      );
      break;
    }

    if (cursor && seenCursors.has(cursor)) {
      logger.warn(`[fetchEvents] Repeated cursor detected — breaking pagination loop`);
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

    // Stop paginating if every event on this page is already beyond endLedger.
    // This is the server-side stop condition that prevents fetching unbounded
    // pages when the range is small but there are many later events.
    const minLedger = Math.min(...page.map((e) => Number(e.ledger)));
    if (minLedger > endLedger) {
      break;
    }

    const mapped = page
      .filter(
        (e) => typeof e.ledger === 'number' && e.ledger >= startLedger && e.ledger <= endLedger,
      )
      .map((e) => {
        const topics = e.topic.map((t: xdr.ScVal) => t.toXDR('base64'));
        const data = e.value?.toXDR ? e.value.toXDR('base64') : String(e.value ?? '');
        return {
          contractId: String(e.contractId ?? ''),
          transactionHash: String(e.txHash ?? ''),
          ledgerSequence: Number(e.ledger),
          ledgerCloseTime: new Date(e.ledgerClosedAt ?? Date.now()),
          topics,
          data,
          pagingToken: String(e.pagingToken ?? ''),
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
  const info = await retry('getLatestLedger', () => rpc.getLatestLedger());
  return Number(info.sequence);
}

/**
 * Fetch a ledger from RPC and cache immutable historical snapshots.
 * Ledger 0 is considered permanently immutable and is cached indefinitely.
 */
export async function getLedger(ledgerSequence: number): Promise<unknown> {
  const cacheKey = `${LEDGER_CACHE_PREFIX}${ledgerSequence}`;
  const cached = await cacheGet<unknown>(cacheKey);
  if (cached !== null) return cached;

  const rpcClient = rpc as any;
  const ledger = await retry('getLedger', () => rpcClient.getLedger(ledgerSequence));
  const ttl = ledgerSequence === 0 ? null : 60 * 60 * 24;
  await cacheSet(cacheKey, ledger, ttl);
  return ledger;
}

/**
 * Fetch a transaction by hash.
 */
export async function getTransaction(hash: string) {
  return retry('getTransaction', () => rpc.getTransaction(hash));
}

/**
 * Fetch a transaction from Horizon REST API (fallback for RPC NOT_FOUND).
 * Maps Horizon fields to the same shape used by the RPC result.
 */
export async function getTransactionFromHorizon(hash: string) {
  return horizonCall('transactions', async () => {
    const axios = (await import('axios')).default;
    const { data } = await axios.get(`${config.horizonUrl}/transactions/${hash}`);
    return {
      status: data.successful ? 'SUCCESS' : 'FAILED',
      sourceAccount: data.source_account as string,
      feeCharged: String(data.fee_charged ?? ''),
      envelopeXdr: {
        toXDR: (enc: string) => (enc === 'base64' ? data.envelope_xdr : data.envelope_xdr),
      },
    };
  });
}

export function getRpcWebsocketUrl(): string {
  return config.stellarRpcWsUrl;
}

export async function fetchLedgerMetadata(sequence: number): Promise<{
  sequence: number;
  hash: string;
  previousLedgerHash: string;
  closeTime: Date;
  txCount: number;
}> {
  // First attempt: try Horizon because it has stable, standardized JSON structure
  try {
    const data = await horizonCall('ledgers', async () => {
      const axios = (await import('axios')).default;
      const res = await axios.get(`${config.horizonUrl}/ledgers/${sequence}`);
      return res.data;
    });
    if (data && data.hash) {
      return {
        sequence: Number(data.sequence),
        hash: String(data.hash),
        previousLedgerHash: String(data.prev_hash ?? data.previous_ledger_hash ?? ''),
        closeTime: new Date(data.closed_at),
        txCount:
          Number(data.successful_transaction_count ?? 0) +
          Number(data.failed_transaction_count ?? 0),
      };
    }
  } catch (err) {
    // ignore and fallback to RPC
  }

  // Second attempt: try RPC getLedger
  const ledgerResult = (await getLedger(sequence)) as any;
  if (ledgerResult) {
    const hash = ledgerResult.id ?? ledgerResult.hash ?? '';
    const previousLedgerHash =
      ledgerResult.prevHash ?? ledgerResult.prev_hash ?? ledgerResult.previousLedgerHash ?? '';
    const closeTime = ledgerResult.closedAt ?? ledgerResult.closed_at ?? new Date();
    const txCount = ledgerResult.transactionCount ?? ledgerResult.transaction_count ?? 0;
    return {
      sequence,
      hash: String(hash),
      previousLedgerHash: String(previousLedgerHash),
      closeTime: new Date(closeTime),
      txCount: Number(txCount),
    };
  }

  throw new Error(`Failed to fetch ledger ${sequence}`);
}
