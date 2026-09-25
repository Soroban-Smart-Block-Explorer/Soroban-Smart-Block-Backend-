/**
 * SorobanClient — the official TypeScript SDK entry point (DX01).
 *
 *   const client = new SorobanClient({ apiKey: process.env.SOROBAN_API_KEY });
 *   const tx = await client.transactions.get('9f…');
 *   const any = await client.call('getContractsByAddressStats', { path: { address: 'C…' } });
 *
 * `call` covers 100% of the REST surface with types generated from the
 * OpenAPI spec; curated namespaces wrap the most-used operations; `realtime`
 * covers GraphQL subscriptions (SSE) and the feed WebSocket/SSE transports.
 */
import {
  Transport,
  normalizeBaseUrl,
  type FetchLike,
  type Logger,
  type RequestEvent,
} from './core/http';
import { buildRequest, type CallParams } from './core/request';
import { SorobanError } from './core/errors';
import {
  OPERATIONS,
  type OperationId,
  type OperationParams,
  type OperationSpec,
  type OperationTypes,
} from './generated/operations';

/** Widened view: indexing the literal map by a generic key exceeds TS's union limit. */
const OPS: Readonly<Record<string, OperationSpec>> = OPERATIONS;
import { SorobanFeed } from './feed';

export const SDK_VERSION = '1.1.0';
export const DEFAULT_BASE_URL = 'https://api.soroban.network/api/v1';

export interface SorobanClientOptions {
  /** API key sent as X-Api-Key. Optional (public tier without it). */
  apiKey?: string;
  /** API base including the version prefix, e.g. https://host/api/v1. */
  baseUrl?: string;
  /** Per-attempt timeout (default 10 000 ms). */
  timeoutMs?: number;
  /** Retries for retryable failures (default 2). */
  maxRetries?: number;
  /** Upper bound for a single backoff / Retry-After wait (default 30 000 ms). */
  maxRetryDelayMs?: number;
  /** Custom fetch (defaults to global fetch; Node ≥ 18). */
  fetch?: FetchLike;
  /** Structured logger; the SDK logs nothing unless one is supplied. */
  logger?: Logger;
  /** Per-attempt telemetry hook (latency, status, retries, rate limit). */
  onRequest?: (event: RequestEvent) => void;
}

/** Parameters accepted by `call(id, …)` (generated from the OpenAPI spec). */
export type ParamsOf<K extends OperationId> = OperationParams[K];

export type ResponseOf<K extends OperationId> = OperationTypes[K]['response'];

export interface Page<T> {
  data: T[];
  hasNext?: boolean;
  nextCursor?: string | number | null;
}

function defaultFetch(): FetchLike {
  if (typeof globalThis.fetch !== 'function') {
    throw new SorobanError('No global fetch available; pass options.fetch (Node >= 18 has one).');
  }
  return globalThis.fetch.bind(globalThis) as unknown as FetchLike;
}

export class SorobanClient {
  private readonly transport: Transport;
  readonly baseUrl: string;

  constructor(private readonly options: SorobanClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.transport = new Transport({
      baseUrl: this.baseUrl,
      apiKey: options.apiKey,
      timeoutMs: options.timeoutMs ?? 10_000,
      maxRetries: options.maxRetries ?? 2,
      maxRetryDelayMs: options.maxRetryDelayMs ?? 30_000,
      userAgent: `soroban-explorer-client-ts/${SDK_VERSION}`,
      fetch: options.fetch ?? defaultFetch(),
      logger: options.logger,
      onRequest: options.onRequest,
    });
  }

  /** Call any operation in the OpenAPI spec by its operation id. */
  call<K extends OperationId>(operationId: K, params?: ParamsOf<K>): Promise<ResponseOf<K>>;
  async call(operationId: string, rawParams?: unknown): Promise<unknown> {
    const spec = OPS[operationId];
    if (!spec) throw new SorobanError(`Unknown operation: ${operationId}`);
    const params = (rawParams ?? {}) as CallParams & {
      signal?: AbortSignal;
      headers?: Record<string, string>;
    };
    const built = buildRequest(operationId, spec, params);
    const res = await this.transport.request<unknown>({
      method: spec.method,
      path: built.path,
      body: built.body,
      contentType: built.contentType,
      operationId,
      signal: params.signal,
      headers: params.headers,
    });
    return res.data;
  }

  /**
   * Iterate every item of a paginated list operation. Supports the cursor
   * envelope (`{data, hasNext, nextCursor}`) and falls back to page/offset
   * pagination (`page` query param) when no cursor is returned.
   */
  paginate<K extends OperationId>(
    operationId: K,
    params?: ParamsOf<K>,
    options?: { maxPages?: number },
  ): AsyncGenerator<unknown, void, undefined>;
  async *paginate(
    operationId: string,
    params?: unknown,
    options: { maxPages?: number } = {},
  ): AsyncGenerator<unknown, void, undefined> {
    const maxPages = options.maxPages ?? 1000;
    const base = (params ?? {}) as CallParams;
    const spec = OPS[operationId];
    if (!spec) throw new SorobanError(`Unknown operation: ${operationId}`);
    const hasPage = spec.query.some((q) => q.name === 'page');
    let cursor: string | number | undefined;
    for (let page = 1; page <= maxPages; page++) {
      const query: Record<string, unknown> = { ...(base.query ?? {}) };
      if (cursor !== undefined) query.cursor = cursor;
      else if (hasPage && page > 1) query.page = page;
      const invoke = this.call as unknown as (id: string, p: CallParams) => Promise<unknown>;
      const res = (await invoke.call(this, operationId, { ...base, query })) as
        Partial<Page<unknown>> | unknown[];
      const items = Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : [];
      for (const item of items) yield item;
      if (Array.isArray(res) || items.length === 0) return;
      if (res.nextCursor !== undefined && res.nextCursor !== null) {
        cursor = res.nextCursor;
        continue;
      }
      if (res.hasNext === true && hasPage && cursor === undefined) continue;
      return;
    }
  }

  /** Untyped internal entry used by the curated resources below. */
  private invoke<K extends OperationId>(
    operationId: K,
    params?: CallParams,
  ): Promise<ResponseOf<K>> {
    const call = this.call as unknown as (id: string, p?: CallParams) => Promise<ResponseOf<K>>;
    return call.call(this, operationId, params);
  }

  // ── Curated resources ────────────────────────────────────────────────────

  readonly transactions = {
    list: (query?: OperationTypes['getTransactions']['query']) =>
      this.invoke<'getTransactions'>('getTransactions', { query }),
    get: (hash: string) =>
      this.invoke<'getTransactionsByHash'>('getTransactionsByHash', { path: { hash } }),
  };

  readonly events = {
    list: (query?: OperationTypes['getEvents']['query']) =>
      this.invoke<'getEvents'>('getEvents', { query }),
    get: (id: string) => this.invoke<'getEventsById'>('getEventsById', { path: { id } }),
  };

  readonly contracts = {
    list: (query?: OperationTypes['getContracts']['query']) =>
      this.invoke<'getContracts'>('getContracts', { query }),
    get: (address: string) =>
      this.invoke<'getContractsByAddress'>('getContractsByAddress', { path: { address } }),
  };

  readonly tokens = {
    list: (query?: OperationTypes['getTokens']['query']) =>
      this.invoke<'getTokens'>('getTokens', { query }),
    get: (address: string) =>
      this.invoke<'getTokensByAddress'>('getTokensByAddress', { path: { address } }),
  };

  readonly wallets = {
    transactions: (
      address: string,
      query?: OperationTypes['getWalletsByAddressTransactions']['query'],
    ) =>
      this.invoke<'getWalletsByAddressTransactions'>('getWalletsByAddressTransactions', {
        path: { address },
        query,
      }),
    events: (address: string, query?: OperationTypes['getWalletsByAddressEvents']['query']) =>
      this.invoke<'getWalletsByAddressEvents'>('getWalletsByAddressEvents', {
        path: { address },
        query,
      }),
  };

  readonly network = {
    status: () => this.invoke<'getNetwork'>('getNetwork'),
  };

  readonly search = {
    suggest: (query: OperationTypes['getSearchSuggest']['query']) =>
      this.invoke<'getSearchSuggest'>('getSearchSuggest', { query }),
  };

  // ── Realtime ─────────────────────────────────────────────────────────────

  readonly realtime = {
    /**
     * GraphQL subscription over SSE (POST /api/graphql, Accept:
     * text/event-stream). Yields each `data` payload; throws on GraphQL errors
     * (e.g. SUBSCRIPTION_LIMIT_EXCEEDED). Abort via `signal`.
     */
    graphql: (
      query: string,
      variables: Record<string, unknown> = {},
      signal?: AbortSignal,
    ): AsyncGenerator<Record<string, unknown>, void, undefined> =>
      this.graphqlStream(query, variables, signal),
    /** Feed REST/WebSocket/SSE client (subscriptions, backfill, live streams). */
    feed: (): SorobanFeed =>
      new SorobanFeed({ apiKey: this.options.apiKey, baseUrl: this.baseUrl }),
  };

  private async *graphqlStream(
    query: string,
    variables: Record<string, unknown>,
    signal?: AbortSignal,
  ): AsyncGenerator<Record<string, unknown>, void, undefined> {
    const endpoint = new URL('/api/graphql', this.baseUrl).toString();
    const fetchImpl = (this.options.fetch ?? defaultFetch()) as unknown as typeof fetch;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'User-Agent': `soroban-explorer-client-ts/${SDK_VERSION}`,
    };
    if (this.options.apiKey) headers['X-Api-Key'] = this.options.apiKey;
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables }),
      signal,
    });
    if (!res.ok || !res.body)
      throw new SorobanError(`GraphQL subscription failed: HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const lines = frame.split('\n');
          const event = lines.find((l) => l.startsWith('event: '))?.slice(7);
          const data = lines
            .filter((l) => l.startsWith('data: '))
            .map((l) => l.slice(6))
            .join('\n');
          if (event === 'complete') return;
          if (event !== 'next' || !data) continue;
          const payload = JSON.parse(data) as {
            data?: Record<string, unknown>;
            errors?: Array<{ message: string; extensions?: { code?: string } }>;
          };
          if (payload.errors?.length) {
            const e = payload.errors[0];
            throw new SorobanError(`${e.extensions?.code ?? 'GRAPHQL_ERROR'}: ${e.message}`);
          }
          if (payload.data) yield payload.data;
        }
      }
    } finally {
      reader.cancel().catch(() => undefined);
    }
  }
}
