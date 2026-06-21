import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prismaRead } from '../../db';
import { asyncHandler } from '../../middleware/asyncHandler';

export const usageRouter = Router();

const developerQuery = z.object({ developerId: z.string() });

// GET /developer/usage — usage dashboard
usageRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const { developerId } = developerQuery.parse(req.query);

    const [totalRequests, byEndpoint, byKey, byDay, byHour, errors, activeKeys] = await Promise.all(
      [
        prismaRead.usageRecord.count({ where: { developerId } }),
        prismaRead.usageRecord.groupBy({
          by: ['endpoint'],
          where: { developerId },
          _count: { endpoint: true },
          orderBy: { _count: { endpoint: 'desc' } },
          take: 10,
        }),
        prismaRead.usageRecord.groupBy({
          by: ['apiKeyId'],
          where: { developerId, apiKeyId: { not: null } },
          _count: { apiKeyId: true },
          orderBy: { _count: { apiKeyId: 'desc' } },
          take: 10,
        }),
        prismaRead.$queryRawUnsafe<{ date: string; count: bigint }[]>(
          `SELECT DATE("createdAt") as date, COUNT(*) as count FROM "UsageRecord" WHERE "developerId" = $1 GROUP BY DATE("createdAt") ORDER BY date DESC LIMIT 30`,
          developerId,
        ),
        prismaRead.$queryRawUnsafe<{ hour: string; count: bigint }[]>(
          `SELECT TO_CHAR("createdAt", 'HH24:00') as hour, COUNT(*) as count FROM "UsageRecord" WHERE "developerId" = $1 GROUP BY TO_CHAR("createdAt", 'HH24:00') ORDER BY hour`,
          developerId,
        ),
        prismaRead.usageRecord.groupBy({
          by: ['statusCode'],
          where: { developerId, statusCode: { gte: 400 } },
          _count: { statusCode: true },
          orderBy: { _count: { statusCode: 'desc' } },
        }),
        prismaRead.devApiKey.count({ where: { developerId, status: 'active' } }),
      ],
    );

    const latencyStats = await prismaRead.$queryRawUnsafe<
      { avg: number; p50: number; p95: number; p99: number }[]
    >(
      `SELECT AVG("latencyMs")::float as avg, PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY "latencyMs") as p50, PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY "latencyMs") as p95, PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY "latencyMs") as p99 FROM "UsageRecord" WHERE "developerId" = $1`,
      developerId,
    );

    res.json({
      totalRequests,
      requestsByEndpoint: byEndpoint.map((r) => ({
        endpoint: r.endpoint,
        count: r._count.endpoint,
      })),
      requestsByKey: byKey.map((r) => ({ keyId: r.apiKeyId, count: r._count.apiKeyId })),
      requestsByDay: byDay.map((r) => ({ date: r.date, count: Number(r.count) })),
      requestsByHour: byHour.map((r) => ({ hour: r.hour, count: Number(r.count) })),
      latency: latencyStats[0] ?? { avg: 0, p50: 0, p95: 0, p99: 0 },
      errors: errors.map((r) => ({ status: r.statusCode, count: r._count.statusCode })),
      activeKeys,
    });
  }),
);

// GET /developer/usage/logs
usageRouter.get(
  '/logs',
  asyncHandler(async (req: Request, res: Response) => {
    const { developerId } = developerQuery.parse(req.query);
    const { page, limit } = z
      .object({
        page: z.coerce.number().min(1).default(1),
        limit: z.coerce.number().min(1).max(100).default(50),
      })
      .parse(req.query);

    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      prismaRead.usageRecord.findMany({
        where: { developerId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prismaRead.usageRecord.count({ where: { developerId } }),
    ]);

    res.json({ data, total, page, limit, pages: Math.ceil(total / limit) });
  }),
);

// GET /developer/usage/export
usageRouter.get(
  '/export',
  asyncHandler(async (req: Request, res: Response) => {
    const { developerId, format } = z
      .object({
        developerId: z.string(),
        format: z.enum(['csv', 'json']).default('json'),
      })
      .parse(req.query);

    const records = await prismaRead.usageRecord.findMany({
      where: { developerId },
      orderBy: { createdAt: 'desc' },
      take: 10000,
    });

    if (format === 'csv') {
      const header = 'id,endpoint,method,statusCode,latencyMs,ipAddress,createdAt\n';
      const rows = records
        .map(
          (r) =>
            `${r.id},${r.endpoint},${r.method},${r.statusCode},${r.latencyMs},${r.ipAddress ?? ''},${r.createdAt.toISOString()}`,
        )
        .join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="usage.csv"');
      return res.send(header + rows);
    }

    res.json({ data: records });
  }),
);

// GET /developer/usage/realtime — SSE stream
usageRouter.get('/realtime', (req: Request, res: Response) => {
  const { developerId } = developerQuery.parse(req.query);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send a heartbeat + latest stats every 5 seconds
  const interval = setInterval(async () => {
    try {
      const [count, errors] = await Promise.all([
        prismaRead.usageRecord.count({
          where: { developerId, createdAt: { gte: new Date(Date.now() - 60000) } },
        }),
        prismaRead.usageRecord.count({
          where: {
            developerId,
            statusCode: { gte: 400 },
            createdAt: { gte: new Date(Date.now() - 60000) },
          },
        }),
      ]);
      res.write(
        `data: ${JSON.stringify({ requestsLastMinute: count, errorsLastMinute: errors, timestamp: new Date().toISOString() })}\n\n`,
      );
    } catch {
      res.write('data: {}\n\n');
    }
  }, 5000);

  req.on('close', () => clearInterval(interval));
});
