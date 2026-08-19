/**
 * Response Envelope Middleware
 *
 * Provides a consistent response format for all successful responses:
 * {
 *   "success": true,
 *   "data": { ... },
 *   "meta": {
 *     "requestId": "550e8400-e29b-41d4-a716-446655440000",
 *     "timestamp": "2026-07-28T10:00:00.000Z"
 *   }
 * }
 *
 * Error responses are handled separately by the error handler.
 * Use res.sendEnveloped(data) instead of res.json(data) to use this format.
 *
 * Mount after correlationMiddleware so requestId is available:
 *   app.use(correlationMiddleware);
 *   app.use(responseEnvelopeMiddleware);
 */

import { Request, Response, NextFunction } from 'express';
import { traceStorage } from './correlation';

export interface ResponseEnvelope<T = unknown> {
  success: boolean;
  data?: T;
  meta: {
    requestId: string;
    timestamp: string;
  };
}

/**
 * Extends Express Response with sendEnveloped method.
 * Send data wrapped in consistent response format.
 */
function responseEnvelopeMiddleware(req: Request, res: Response, next: NextFunction): void {
  /**
   * Send response in standard envelope format.
   * Includes requestId and timestamp automatically.
   *
   * Usage:
   *   res.sendEnveloped({ items: [...] });
   *
   * Output:
   *   {
   *     "success": true,
   *     "data": { "items": [...] },
   *     "meta": {
   *       "requestId": "...",
   *       "timestamp": "..."
   *     }
   *   }
   */
  res.sendEnveloped = function <T>(data: T, statusCode?: number): Response {
    const ctx = traceStorage.getStore();
    const requestId = ctx?.requestId ?? (req as any).requestId ?? 'unknown';

    const envelope: ResponseEnvelope<T> = {
      success: true,
      data,
      meta: {
        requestId,
        timestamp: new Date().toISOString(),
      },
    };

    if (statusCode) {
      return this.status(statusCode).json(envelope);
    }

    return this.json(envelope);
  };

  /**
   * Send paginated response in standard envelope format.
   * Includes pagination metadata.
   *
   * Usage:
   *   res.sendPaginated(items, { total: 100, page: 1, limit: 20 });
   *
   * Output:
   *   {
   *     "success": true,
   *     "data": { ... },
   *     "meta": {
   *       "requestId": "...",
   *       "timestamp": "...",
   *       "pagination": {
   *         "total": 100,
   *         "page": 1,
   *         "limit": 20,
   *         "pages": 5
   *       }
   *     }
   *   }
   */
  res.sendPaginated = function <T>(
    data: T,
    pagination: { total: number; page: number; limit: number },
  ): Response {
    const ctx = traceStorage.getStore();
    const requestId = ctx?.requestId ?? (req as any).requestId ?? 'unknown';

    const pages = Math.ceil(pagination.total / pagination.limit);

    const envelope: ResponseEnvelope<T> & { meta: { pagination: any } } = {
      success: true,
      data,
      meta: {
        requestId,
        timestamp: new Date().toISOString(),
        pagination: {
          total: pagination.total,
          page: pagination.page,
          limit: pagination.limit,
          pages,
        },
      },
    };

    return this.json(envelope);
  };

  /**
   * Send cursor-based paginated response.
   *
   * Usage:
   *   res.sendCursorPaginated(items, { cursor: 'next-cursor', hasMore: true });
   *
   * Output:
   *   {
   *     "success": true,
   *     "data": { ... },
   *     "meta": {
   *       "requestId": "...",
   *       "timestamp": "...",
   *       "cursor": {
   *         "next": "next-cursor",
   *         "hasMore": true
   *       }
   *     }
   *   }
   */
  res.sendCursorPaginated = function <T>(
    data: T,
    cursor: { next?: string | null; hasMore: boolean },
  ): Response {
    const ctx = traceStorage.getStore();
    const requestId = ctx?.requestId ?? (req as any).requestId ?? 'unknown';

    const envelope: ResponseEnvelope<T> & { meta: { cursor: any } } = {
      success: true,
      data,
      meta: {
        requestId,
        timestamp: new Date().toISOString(),
        cursor: {
          next: cursor.next ?? null,
          hasMore: cursor.hasMore,
        },
      },
    };

    return this.json(envelope);
  };

  next();
}

export { responseEnvelopeMiddleware };
