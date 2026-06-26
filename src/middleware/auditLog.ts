/**
 * API Audit Log Middleware
 *
 * Logs every API request to ApiAuditLog with:
 *   api_key_id, key_name, tier, ip, method, endpoint,
 *   status, response_time_ms, rate_limit info, user_agent
 *
 * Written async after response is sent — never blocks the request.
 * Auto-partitioned by month via the "month" field.
 */

import { randomUUID } from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { prismaWrite } from '../db';
import { logger } from '../logger';
import type { TokenBucketResult } from './tokenBucket';

export const AUDIT_LOG_TTL_DAYS: Record<string, number> = {
  unauthenticated: 7,
  free:            90,
  developer:       90,
  pro:             365,
  enterprise:      1095,
};

const SKIP_PATHS = new Set(['/health', '/metrics', '/api/docs', '/api/docs.json']);

export function auditLogMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (SKIP_PATHS.has(req.path)) return next();

  const requestId = randomUUID();
  const startedAt = Date.now();
  res.setHeader('X-Request-Id', requestId);

  res.on('finish', () => {
    const responseTimeMs = Date.now() - startedAt;
    const rl = (req as Request & { rateLimitResult?: TokenBucketResult }).rateLimitResult;
    const keyCtx = req.apiKey;
    const tier = keyCtx?.tier ?? 'unauthenticated';
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const ip = (req.ip ?? req.socket?.remoteAddress ?? '').replace('::ffff:', '');

    const endpoint = req.path
      .replace(/\/[0-9a-f-]{8,}/gi, '/:id')
      .replace(/\/\d+/g, '/:id');

    prismaWrite.apiAuditLog.create({
      data: {
        id: randomUUID(),
        apiKeyId:          keyCtx?.id ?? null,
        keyName:           keyCtx?.keyName ?? null,
        tier,
        ip,
        method:            req.method,
        endpoint,
        statusCode:        res.statusCode,
        responseTimeMs,
        rateLimitRemaining: rl?.remaining ?? null,
        rateLimitLimit:    rl?.limit ?? null,
        userAgent:         req.headers['user-agent'] ?? null,
        requestId,
        isRateLimited:     res.statusCode === 429,
        month,
      },
    }).catch((err: unknown) =>
      logger.warn(`[audit-log] Failed to persist: ${String(err)}`),
    );
  });

  next();
}

export async function queryAuditLogs(opts: {
  apiKeyId?: string;
  ip?: string;
  endpoint?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  cursor?: string;
}) {
  const where: Record<string, unknown> = {};
  if (opts.apiKeyId) where.apiKeyId = opts.apiKeyId;
  if (opts.ip)       where.ip = opts.ip;
  if (opts.endpoint) where.endpoint = { contains: opts.endpoint };
  if (opts.from || opts.to) {
    where.createdAt = {
      ...(opts.from ? { gte: opts.from } : {}),
      ...(opts.to   ? { lte: opts.to }   : {}),
    };
  }
  if (opts.cursor) where.id = { gt: opts.cursor };

  return prismaWrite.apiAuditLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: opts.limit ?? 50,
  });
}
