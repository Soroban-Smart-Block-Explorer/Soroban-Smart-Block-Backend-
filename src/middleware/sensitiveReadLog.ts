/**
 * Sensitive Read Audit Middleware (#890)
 *
 * Records an immutable SensitiveReadAudit row whenever a tagged route is
 * accessed, capturing: actor, IP, endpoint, method, target resource, and
 * correlation request-ID. Written async after the response is sent so it
 * never blocks the request path.
 *
 * SensitiveReadAudit rows are NEVER pruned — retention matches compliance
 * requirements. Do not add them to any data-pruner job.
 *
 * Usage:
 *   router.get('/screen/:address', sensitiveReadLog('compliance_screen', (req) => req.params.address), handler);
 *
 * The `targetExtractor` callback receives the request and returns the
 * resource identifier logged in the `target` column. Default: req.path.
 */

import type { Request, Response, NextFunction } from 'express';
import { prismaWrite } from '../db';
import { logger } from '../logger';

type TargetExtractor = (req: Request) => string;

function resolveActor(req: Request): string {
  // Prefer authenticated user, fall back to API key, then admin actor, then IP
  if (req.user?.id) return `user:${req.user.id}`;
  if (req.apiKey?.id) return `apiKey:${req.apiKey.id}`;
  if (req.actor) return req.actor;
  return `ip:${(req.ip ?? req.socket?.remoteAddress ?? 'unknown').replace('::ffff:', '')}`;
}

/**
 * Returns an Express middleware that logs a SensitiveReadAudit record for the
 * matched route after the response has been sent.
 *
 * @param _label   Human-readable label for the audit entry (stored in endpoint)
 * @param targetFn Optional function to extract the resource target from the request
 */
export function sensitiveReadLog(
  _label?: string,
  targetFn?: TargetExtractor,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.on('finish', () => {
      // Only audit successful reads — skip 4xx/5xx so failed auth attempts
      // don't inflate the audit trail with noise (they're already in the
      // request audit log and error logs).
      if (res.statusCode >= 400) return;

      const actor = resolveActor(req);
      const ip = (req.ip ?? req.socket?.remoteAddress ?? 'unknown').replace('::ffff:', '');
      const endpoint = (req.baseUrl ?? '') + (req.route?.path ?? req.path ?? '');
      const target = targetFn ? targetFn(req) : req.path;
      const requestId = req.requestId ?? undefined;
      const userAgent = req.headers['user-agent'] ?? undefined;

      // SensitiveReadAudit table is added via migration 20260828000000_security_issues_888_890.
      // Until `prisma generate` runs against the updated schema the type doesn't appear on the
      // Prisma client, so we access it via the dynamic delegation API. (#890)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (prismaWrite as any).sensitiveReadAudit
        .create({
          data: {
            actor,
            ip,
            endpoint,
            method: req.method,
            target,
            requestId,
            userAgent,
          },
        })
        .catch((err: unknown) =>
          logger.warn(`[sensitive-read-audit] Failed to persist: ${String(err)}`),
        );
    });

    next();
  };
}
