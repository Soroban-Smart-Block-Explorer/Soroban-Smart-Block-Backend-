/**
 * HTTP transport: timeouts, retries with exponential backoff + jitter,
 * Retry-After handling, rate-limit header parsing, telemetry hooks.
 *
 * Retry policy (default): network errors, timeouts, 429, 502, 503, 504 are
 * retried for idempotent methods (GET, PUT, DELETE) up to `maxRetries`.
 * POST/PATCH are retried only on 429 (the server rejected them before any
 * side effect). Retry-After is honoured, capped at `maxRetryDelayMs`.
 */
import {
  NetworkError,
  TimeoutError,
  errorFromResponse,
  type RateLimitInfo,
  type SorobanApiError,
} from './errors';

export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

/** Emitted once per attempt; wire to OpenTelemetry, Prometheus, logs, … */
export interface RequestEvent {
  operationId?: string;
  method: string;
  path: string;
  attempt: number;
  status?: number;
  durationMs: number;
  outcome: 'success' | 'http_error' | 'network_error' | 'timeout';
  willRetry: boolean;
  requestId?: string;
  rateLimit: RateLimitInfo;
}

export interface TransportOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  maxRetries: number;
  maxRetryDelayMs: number;
  userAgent: string;
  fetch: FetchLike;
  logger?: Logger;
  onRequest?: (event: RequestEvent) => void;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface TransportRequest {
  method: string;
  /** Path relative to baseUrl, already encoded, may include a query string. */
  path: string;
  body?: string;
  contentType?: string;
  headers?: Record<string, string>;
  operationId?: string;
  signal?: AbortSignal;
}

export interface TransportResponse<T> {
  data: T;
  status: number;
  requestId?: string;
  rateLimit: RateLimitInfo;
  headers: { get(name: string): string | null };
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const IDEMPOTENT = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']);

function num(v: string | null): number | undefined {
  if (v === null || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function parseRateLimit(headers: { get(name: string): string | null }): RateLimitInfo {
  return {
    limit: num(headers.get('x-ratelimit-limit')),
    remaining: num(headers.get('x-ratelimit-remaining')),
    reset: num(headers.get('x-ratelimit-reset')),
    tier: headers.get('x-ratelimit-tier') ?? undefined,
  };
}

/** Retry-After as delta-seconds or HTTP-date → milliseconds. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** Validate the base URL once: http(s) only, no credentials, no fragment. */
export function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError(`baseUrl is not a valid absolute URL: ${raw}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TypeError(`baseUrl must use http or https, got ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new TypeError('baseUrl must not embed credentials; use the apiKey option');
  }
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/$/, '');
}

export class Transport {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(private readonly options: TransportOptions) {
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = options.random ?? Math.random;
  }

  get baseUrl(): string {
    return this.options.baseUrl;
  }

  private backoff(attempt: number, retryAfterMs: number | undefined): number {
    const cap = this.options.maxRetryDelayMs;
    if (retryAfterMs !== undefined) return Math.min(retryAfterMs, cap);
    const exp = Math.min(cap, 250 * 2 ** (attempt - 1));
    return Math.round(exp / 2 + (this.random() * exp) / 2);
  }

  async request<T>(req: TransportRequest): Promise<TransportResponse<T>> {
    const method = req.method.toUpperCase();
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': this.options.userAgent,
      ...req.headers,
    };
    if (this.options.apiKey) headers['X-Api-Key'] = this.options.apiKey;
    if (req.body !== undefined) headers['Content-Type'] = req.contentType ?? 'application/json';
    const url = this.options.baseUrl + req.path;

    for (let attempt = 1; ; attempt++) {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
      const onAbort = () => controller.abort();
      req.signal?.addEventListener('abort', onAbort);
      const canRetryMore = attempt <= this.options.maxRetries;
      try {
        let res: Awaited<ReturnType<FetchLike>>;
        try {
          res = await this.options.fetch(url, {
            method,
            headers,
            body: req.body,
            signal: controller.signal,
          });
        } catch (err) {
          const timedOut = controller.signal.aborted && !req.signal?.aborted;
          const retry = canRetryMore && IDEMPOTENT.has(method) && !req.signal?.aborted;
          this.emit(
            req,
            method,
            attempt,
            started,
            undefined,
            timedOut ? 'timeout' : 'network_error',
            retry,
            undefined,
            {},
          );
          if (retry) {
            await this.sleep(this.backoff(attempt, undefined));
            continue;
          }
          if (timedOut) throw new TimeoutError(this.options.timeoutMs);
          throw new NetworkError(err instanceof Error ? err.message : String(err), err);
        }
        const text = await res.text();
        const rateLimit = parseRateLimit(res.headers);
        const requestId = res.headers.get('x-request-id') ?? undefined;
        let data: unknown = text;
        if (text) {
          try {
            data = JSON.parse(text);
          } catch {
            data = text;
          }
        } else {
          data = undefined;
        }
        if (res.ok) {
          this.emit(
            req,
            method,
            attempt,
            started,
            res.status,
            'success',
            false,
            requestId,
            rateLimit,
          );
          return {
            data: data as T,
            status: res.status,
            requestId,
            rateLimit,
            headers: res.headers,
          };
        }
        const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
        const retry =
          canRetryMore &&
          RETRYABLE_STATUS.has(res.status) &&
          (IDEMPOTENT.has(method) || res.status === 429);
        this.emit(
          req,
          method,
          attempt,
          started,
          res.status,
          'http_error',
          retry,
          requestId,
          rateLimit,
        );
        if (retry) {
          this.options.logger?.warn('soroban-explorer: retrying request', {
            method,
            path: req.path,
            status: res.status,
            attempt,
          });
          await this.sleep(this.backoff(attempt, retryAfterMs));
          continue;
        }
        throw errorFromResponse(
          res.status,
          data,
          rateLimit,
          requestId,
          retryAfterMs,
          req.operationId,
        ) as SorobanApiError;
      } finally {
        clearTimeout(timer);
        req.signal?.removeEventListener('abort', onAbort);
      }
    }
  }

  private emit(
    req: TransportRequest,
    method: string,
    attempt: number,
    started: number,
    status: number | undefined,
    outcome: RequestEvent['outcome'],
    willRetry: boolean,
    requestId: string | undefined,
    rateLimit: RateLimitInfo,
  ): void {
    const event: RequestEvent = {
      operationId: req.operationId,
      method,
      path: req.path.split('?')[0],
      attempt,
      status,
      durationMs: Date.now() - started,
      outcome,
      willRetry,
      requestId,
      rateLimit,
    };
    this.options.logger?.debug('soroban-explorer: request', { ...event });
    try {
      this.options.onRequest?.(event);
    } catch {
      // Telemetry hooks must never break requests.
    }
  }
}
