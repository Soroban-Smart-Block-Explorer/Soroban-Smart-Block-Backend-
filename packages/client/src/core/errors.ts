/**
 * SDK error taxonomy. Every failure surfaced by the SDK is a `SorobanError`;
 * HTTP failures are `SorobanApiError` subclasses keyed by status so callers
 * can `instanceof`-match without parsing messages.
 *
 *   SorobanError
 *   ├── RequestValidationError    client-side: bad params, request not sent
 *   ├── NetworkError              transport failure (DNS, reset, …)
 *   ├── TimeoutError              no response within `timeoutMs`
 *   └── SorobanApiError           non-2xx response
 *       ├── BadRequestError       400
 *       ├── AuthenticationError   401
 *       ├── PermissionDeniedError 403
 *       ├── NotFoundError         404
 *       ├── ConflictError         409
 *       ├── UnprocessableError    422
 *       ├── RateLimitError        429 (retryAfterMs)
 *       └── ServerError           5xx
 */

export interface RateLimitInfo {
  limit?: number;
  remaining?: number;
  /** Unix epoch seconds when the window resets. */
  reset?: number;
  tier?: string;
}

export class SorobanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class RequestValidationError extends SorobanError {
  constructor(
    readonly operationId: string,
    readonly issues: string[],
  ) {
    super(`Invalid parameters for ${operationId}: ${issues.join('; ')}`);
  }
}

export class NetworkError extends SorobanError {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
  }
}

export class TimeoutError extends SorobanError {
  constructor(readonly timeoutMs: number) {
    super(`Request timed out after ${timeoutMs} ms`);
  }
}

export interface ApiErrorInit {
  status: number;
  message: string;
  code?: string;
  requestId?: string;
  body: unknown;
  rateLimit: RateLimitInfo;
  operationId?: string;
}

export class SorobanApiError extends SorobanError {
  readonly status: number;
  readonly code?: string;
  readonly requestId?: string;
  readonly body: unknown;
  readonly rateLimit: RateLimitInfo;
  readonly operationId?: string;

  constructor(init: ApiErrorInit) {
    super(init.message);
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
    this.body = init.body;
    this.rateLimit = init.rateLimit;
    this.operationId = init.operationId;
  }
}

export class BadRequestError extends SorobanApiError {}
export class AuthenticationError extends SorobanApiError {}
export class PermissionDeniedError extends SorobanApiError {}
export class NotFoundError extends SorobanApiError {}
export class ConflictError extends SorobanApiError {}
export class UnprocessableError extends SorobanApiError {}
export class ServerError extends SorobanApiError {}

export class RateLimitError extends SorobanApiError {
  constructor(
    init: ApiErrorInit,
    readonly retryAfterMs: number | undefined,
  ) {
    super(init);
  }
}

function pickString(body: unknown, key: string): string | undefined {
  if (body && typeof body === 'object' && key in body) {
    const v = (body as Record<string, unknown>)[key];
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object' && typeof (v as { message?: unknown }).message === 'string') {
      return (v as { message: string }).message;
    }
  }
  return undefined;
}

/** Map a non-2xx response onto the taxonomy. */
export function errorFromResponse(
  status: number,
  body: unknown,
  rateLimit: RateLimitInfo,
  requestId: string | undefined,
  retryAfterMs: number | undefined,
  operationId?: string,
): SorobanApiError {
  const code = pickString(body, 'code');
  const message =
    pickString(body, 'error') ??
    pickString(body, 'message') ??
    (typeof body === 'string' && body ? body.slice(0, 200) : `HTTP ${status}`);
  const init: ApiErrorInit = { status, message, code, requestId, body, rateLimit, operationId };
  switch (status) {
    case 400:
      return new BadRequestError(init);
    case 401:
      return new AuthenticationError(init);
    case 403:
      return new PermissionDeniedError(init);
    case 404:
      return new NotFoundError(init);
    case 409:
      return new ConflictError(init);
    case 422:
      return new UnprocessableError(init);
    case 429:
      return new RateLimitError(init, retryAfterMs);
    default:
      return status >= 500 ? new ServerError(init) : new SorobanApiError(init);
  }
}
