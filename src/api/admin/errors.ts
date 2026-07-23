/**
 * Admin Error Dashboard API
 *
 * Exposes aggregated error data for operators at /api/v1/admin/errors.
 * Queries the audit log for recent errors and returns summary statistics.
 */

import { Router } from 'express';
import { prismaRead } from '../../db';
import { requireAuth, requireRole } from '../../auth/middleware';
import { logger } from '../../logger';
import { asyncHandler } from '../../middleware/asyncHandler';

export const adminErrorsRouter = Router();

// All admin endpoints require authentication + admin role
adminErrorsRouter.use(requireAuth);
adminErrorsRouter.use(requireRole('admin'));

interface ErrorSummary {
  code: string;
  count: number;
  lastOccurred: Date;
  endpoints: string[];
}

interface DashboardResponse {
  window: string;
  totalErrors: number;
  total5xx: number;
  errorRate: number;
  byCode: ErrorSummary[];
  recentErrors: Array<{
    requestId: string;
    code: number;
    endpoint: string;
    method: string;
    responseTimeMs: number;
    occurredAt: Date;
    tier: string | null;
  }>;
}

/**
 * GET /api/v1/admin/errors
 *
 * Query params:
 *   - windowMinutes: number (default 60, max 1440)
 *   - limit: number (default 50, max 200)
 */
adminErrorsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const windowMinutes = Math.min(parseInt(req.query.windowMinutes as string) || 60, 1440);
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

    const since = new Date(Date.now() - windowMinutes * 60_000);

    try {
      // Total requests in window
      const totalRequests = await prismaRead.apiAuditLog.count({
        where: { createdAt: { gte: since } },
      });

      // Total errors (status >= 400)
      const totalErrors = await prismaRead.apiAuditLog.count({
        where: {
          createdAt: { gte: since },
          statusCode: { gte: 400 },
        },
      });

      // Total 5xx errors
      const total5xx = await prismaRead.apiAuditLog.count({
        where: {
          createdAt: { gte: since },
          statusCode: { gte: 500 },
        },
      });

      // Error rate
      const errorRate = totalRequests > 0 ? (totalErrors / totalRequests) * 100 : 0;

      // Errors grouped by status code
      const byCodeRaw = await prismaRead.apiAuditLog.groupBy({
        by: ['statusCode'],
        where: {
          createdAt: { gte: since },
          statusCode: { gte: 400 },
        },
        _count: { statusCode: true },
        _max: { createdAt: true },
      });

      // Get endpoints per code
      const byCode: ErrorSummary[] = await Promise.all(
        byCodeRaw.map(async (group) => {
          const endpoints = await prismaRead.apiAuditLog.findMany({
            where: {
              createdAt: { gte: since },
              statusCode: group.statusCode,
            },
            select: { endpoint: true },
            distinct: ['endpoint'],
            take: 10,
          });
          return {
            code: String(group.statusCode),
            count: group._count.statusCode,
            lastOccurred: group._max.createdAt ?? since,
            endpoints: endpoints.map((e) => e.endpoint),
          };
        }),
      );

      // Recent errors
      const recentErrors = await prismaRead.apiAuditLog.findMany({
        where: {
          createdAt: { gte: since },
          statusCode: { gte: 400 },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          requestId: true,
          statusCode: true,
          endpoint: true,
          method: true,
          responseTimeMs: true,
          createdAt: true,
          tier: true,
        },
      });

      const response: DashboardResponse = {
        window: `${windowMinutes}m`,
        totalErrors,
        total5xx,
        errorRate: parseFloat(errorRate.toFixed(2)),
        byCode,
        recentErrors: recentErrors.map((e) => ({
          requestId: e.requestId ?? '',
          code: e.statusCode,
          endpoint: e.endpoint,
          method: e.method,
          responseTimeMs: e.responseTimeMs,
          occurredAt: e.createdAt,
          tier: e.tier,
        })),
      };

      res.json(response);
    } catch (err) {
      logger.error('[admin/errors] Dashboard query failed', {
        error: (err as Error).message,
      });
      res.status(500).json({ error: 'Failed to load error dashboard' });
    }
  }),
);
