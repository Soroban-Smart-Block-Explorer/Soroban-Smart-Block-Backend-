/**
 * Request Context Middleware
 *
 * Generates a unique requestId and captures request start time
 * for every incoming request. Must be mounted early in the middleware
 * stack so that downstream middleware (audit log, error handler)
 * can access correlation IDs.
 */

import { randomUUID } from 'crypto';
import { Request, Response, NextFunction } from 'express';

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const requestId = randomUUID();
  const startedAt = Date.now();

  req.requestId = requestId;
  req.startedAt = startedAt;

  // Expose requestId to clients for correlation
  res.setHeader('X-Request-Id', requestId);

  next();
}
