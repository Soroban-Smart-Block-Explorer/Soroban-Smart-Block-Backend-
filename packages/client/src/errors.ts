/** Typed, categorized SDK errors mapped to HTTP semantics. */
export type SdkErrorCategory =
  | 'validation'
  | 'auth'
  | 'forbidden'
  | 'not_found'
  | 'rate_limit'
  | 'server'
  | 'unknown';

export class SorobanApiError extends Error {
  readonly category: SdkErrorCategory = 'unknown';
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends SorobanApiError {
  readonly category = 'validation' as const;
}
export class AuthenticationError extends SorobanApiError {
  readonly category = 'auth' as const;
}
export class ForbiddenError extends SorobanApiError {
  readonly category = 'forbidden' as const;
}
export class NotFoundError extends SorobanApiError {
  readonly category = 'not_found' as const;
}
export class RateLimitError extends SorobanApiError {
  readonly category = 'rate_limit' as const;
  constructor(
    message: string,
    status: number,
    code?: string,
    details?: unknown,
    /** Seconds to wait before retrying, from the Retry-After header. */
    readonly retryAfter?: number,
  ) {
    super(message, status, code, details);
  }
}
export class ServerError extends SorobanApiError {
  readonly category = 'server' as const;
}

/** Maps an HTTP status (and parsed error body) to the matching typed error. */
export function errorFromResponse(
  status: number,
  body: unknown,
  statusText = '',
  retryAfter?: number,
): SorobanApiError {
  const b = (body ?? {}) as { error?: string | { code?: string; message?: string; details?: unknown }; message?: string };
  const e = b.error;
  const message =
    (typeof e === 'string' ? e : e?.message) ?? b.message ?? (statusText || `HTTP ${status}`);
  const code = typeof e === 'object' ? e?.code : undefined;
  const details = typeof e === 'object' ? e?.details : undefined;
  if (status === 400 || status === 422) return new ValidationError(message, status, code, details);
  if (status === 401) return new AuthenticationError(message, status, code, details);
  if (status === 403) return new ForbiddenError(message, status, code, details);
  if (status === 404) return new NotFoundError(message, status, code, details);
  if (status === 429) return new RateLimitError(message, status, code, details, retryAfter);
  if (status >= 500) return new ServerError(message, status, code, details);
  return new SorobanApiError(message, status, code, details);
}

export interface RetryOptions {
  maxRetries?: number;
  /** Fallback delay in ms when the server sends no Retry-After. */
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Retries `fn` when it throws RateLimitError, honoring Retry-After. */
export async function retryOnRateLimit<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { maxRetries = 3, baseDelayMs = 500, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = opts;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof RateLimitError) || attempt >= maxRetries) throw err;
      await sleep(err.retryAfter !== undefined ? err.retryAfter * 1000 : baseDelayMs * 2 ** attempt);
    }
  }
}
