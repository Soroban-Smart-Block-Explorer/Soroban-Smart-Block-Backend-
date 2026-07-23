/**
 * Enterprise Global Error Handler
 *
 * Catches all unhandled errors in Express middleware and route handlers.
 * Returns structured JSON responses with correlation IDs, error classification,
 * recovery hints, and integrates with monitoring/alerting.
 *
 * Mount AFTER all routes but BEFORE the 404 catch-all:
 * app.use(errorHandler);
 * app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
 */

import { Request, Response, NextFunction } from 'express';
import { logger } from '../logger';
import { config } from '../config';
import { httpErrorsTotal } from '../metrics';
import {
  type ErrorCode,
  type StructuredErrorResponse,
  type RecoveryHint,
  classifyError,
  buildRecoveryHint,
} from '../types/errors';

/* ─── AppError (backward-compatible) ─────────────────────────────────────── */

export class AppError extends Error {
  statusCode: number;
  code: ErrorCode;

  constructor(statusCode: number, message: string, code?: ErrorCode) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code ?? 'VALIDATION_ERROR';
  }
}

/* ─── Extended error classes for classification ──────────────────────────── */

export class ValidationError extends AppError {
  constructor(message: string) {
    super(400, message, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
  }
}

export class AuthError extends AppError {
  constructor(message: string) {
    super(401, message, 'AUTH_ERROR');
    this.name = 'AuthError';
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super(404, message, 'NOT_FOUND');
    this.name = 'NotFoundError';
  }
}

export class RateLimitError extends AppError {
  retryAfter: number;

  constructor(message: string, retryAfter: number) {
    super(429, message, 'RATE_LIMITED');
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

export class ExternalError extends AppError {
  constructor(message: string) {
    super(502, message, 'EXTERNAL_SERVICE_ERROR');
    this.name = 'ExternalError';
  }
}

/* ─── Rate-limited error logging (prevents log floods) ───────────────────── */

interface LogBucket {
  count: number;
  windowStart: number;
}

const LOG_RATE_LIMIT = 10; // max errors per minute per error code
const LOG_WINDOW_MS = 60_000;

const errorLogBuckets = new Map<string, LogBucket>();

function shouldLogError(code: string): boolean {
  const now = Date.now();
  const bucket = errorLogBuckets.get(code);

  if (!bucket || now - bucket.windowStart > LOG_WINDOW_MS) {
    errorLogBuckets.set(code, { count: 1, windowStart: now });
    return true;
  }

  if (bucket.count < LOG_RATE_LIMIT) {
    bucket.count++;
    return true;
  }

  return false;
}

/* ─── Helper: normalise route for metrics labels ─────────────────────────── */

function normaliseRoute(path: string): string {
  return path
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
    .replace(/\/c[a-z0-9]{20,}/g, '/:id')
    .replace(/\/\d+/g, '/:id');
}

/* ─── Main error handler ─────────────────────────────────────────────────── */

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  const classification = classifyError(err);
  const statusCode = (err as AppError).statusCode ?? classification.statusCode;
  const code = (err as AppError).code ?? classification.code;

  // Request context
  const requestId = req.requestId ?? 'unknown';
  const startedAt = req.startedAt ?? Date.now();
  const durationMs = Date.now() - startedAt;

  // Recovery hints
  let recovery: RecoveryHint | undefined = buildRecoveryHint(err, classification);

  // Override recovery for RateLimitError (has explicit retryAfter)
  if (err instanceof RateLimitError) {
    recovery = {
      message: 'Rate limit exceeded. Please retry after the specified time.',
      retryAfter: err.retryAfter,
    };
    res.setHeader('Retry-After', String(err.retryAfter));
  }

  // Build structured response
  const responseBody: StructuredErrorResponse = {
    error: err.message || 'Internal Server Error',
    code,
    requestId,
    statusCode,
  };

  // Include stack trace in development only
  if (config.nodeEnv === 'development') {
    responseBody.stack = err.stack;
  }

  // Include recovery hints when available
  if (recovery) {
    responseBody.recovery = recovery;
  }

  // Structured logging
  const logMeta: Record<string, unknown> = {
    requestId,
    code,
    statusCode,
    severity: classification.severity,
    error: err.message,
    method: req.method,
    endpoint: req.path,
    route: normaliseRoute(req.path),
    durationMs,
    userAgent: req.headers['user-agent'],
    ip: (req.ip ?? req.socket?.remoteAddress ?? '').replace('::ffff:', ''),
  };

  // Add auth context when available
  if (req.user) {
    logMeta.userId = req.user.id;
    logMeta.userRole = req.user.role;
    logMeta.userTier = req.user.tier;
  }

  if (req.apiKey) {
    logMeta.apiKeyId = req.apiKey.id;
    logMeta.apiKeyTier = req.apiKey.tier;
  }

  // Rate-limited logging
  if (shouldLogError(code)) {
    if (statusCode >= 500) {
      logger.error('Unhandled server error', logMeta);
    } else {
      logger.warn('Request error', logMeta);
    }
  } else {
    // Still log at debug level so we don't lose visibility entirely
    logger.debug('Error (rate-limited logging)', { requestId, code, error: err.message });
  }

  // Prometheus metrics
  httpErrorsTotal.inc({
    code,
    severity: classification.severity,
    route: normaliseRoute(req.path),
  });

  // Send response
  res.status(statusCode).json(responseBody);
} // <--- Closes the errorHandler function properly

/** Any error that carries a numeric statusCode is treated as an HTTP error. */
function hasStatusCode(err: unknown): err is { statusCode: number; message: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'statusCode' in err &&
    typeof (err as Record<string, unknown>).statusCode === 'number'
  );
}
