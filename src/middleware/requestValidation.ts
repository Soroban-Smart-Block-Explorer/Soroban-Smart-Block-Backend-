/**
 * Request Property Validation Middleware
 *
 * Guards that enforce required request extensions are present before
 * entering a handler. Use these after the middleware that populates them.
 */

import type { Request, Response, NextFunction } from 'express';

/** Assert req.apiKey is populated (set by apiKeyAuth). */
export function requireApiKeyContext(req: Request, res: Response, next: NextFunction): void {
  if (!req.apiKey) {
    res.status(401).json({ error: 'API key required' });
    return;
  }
  next();
}

/** Assert req.network and req.networkProfile are populated (set by networkRouter). */
export function requireNetworkContext(req: Request, res: Response, next: NextFunction): void {
  if (!req.network || !req.networkProfile) {
    res.status(500).json({ error: 'Network context not initialised' });
    return;
  }
  next();
}

/** Assert req.actor is populated (set by adminAuth). */
export function requireActorContext(req: Request, res: Response, next: NextFunction): void {
  if (!req.actor) {
    res.status(401).json({ error: 'Admin actor context required' });
    return;
  }
  next();
}

/** Returns true if the cold-storage context is both present and enabled. */
export function hasColdStorageContext(req: Request): boolean {
  return req.coldStorage?.enabled === true;
}
