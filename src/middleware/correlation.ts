/**
 * Correlation-ID middleware
 *
 * - Reads `x-request-id` from incoming headers (upstream gateway) or generates a new UUID.
 * - Reads `x-b3-traceid` / `x-b3-spanid` from upstream, or falls back to the active
 *   OpenTelemetry span so that OTel-instrumented calls propagate automatically.
 * - Writes requestId / traceId / spanId onto `req` for use in handlers and the logger.
 * - Sets `X-Request-Id` response header so callers can correlate their logs.
 * - Stores context in `traceStorage` (AsyncLocalStorage) so the logger picks it up
 *   without needing explicit passing.
 */
import { randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import type { Request, Response, NextFunction } from 'express';
import { trace } from '@opentelemetry/api';

export interface TraceContext {
  requestId: string;
  traceId: string;
  spanId: string;
}

export const traceStorage = new AsyncLocalStorage<TraceContext>();

export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();

  // Prefer B3 headers (Zipkin / upstream gateway).
  let traceId = (req.headers['x-b3-traceid'] as string | undefined) ?? '';
  let spanId = (req.headers['x-b3-spanid'] as string | undefined) ?? '';

  // Fall back to the active OTel span (set by auto-instrumentation).
  if (!traceId || !spanId) {
    const otelSpan = trace.getActiveSpan();
    if (otelSpan) {
      const sc = otelSpan.spanContext();
      traceId = traceId || sc.traceId;
      spanId = spanId || sc.spanId;
    }
  }

  // Annotate the active OTel span with requestId for cross-signal correlation.
  const activeSpan = trace.getActiveSpan();
  if (activeSpan) {
    activeSpan.setAttribute('request.id', requestId);
  }

  const ctx: TraceContext = { requestId, traceId, spanId };

  req.requestId = requestId;
  req.traceId = traceId;
  req.spanId = spanId;

  res.setHeader('X-Request-Id', requestId);

  traceStorage.run(ctx, next);
}
