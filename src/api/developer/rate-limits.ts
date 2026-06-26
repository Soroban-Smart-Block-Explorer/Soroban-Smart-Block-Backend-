import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prismaRead } from '../../db';
import { asyncHandler } from '../../middleware/asyncHandler';

export const rateLimitsRouter = Router();
export const quotaRouter = Router();

const PLAN_LIMITS: Record<string, { perDay: number; perMinute: number }> = {
  free: { perDay: 100, perMinute: 10 },
  developer: { perDay: 10000, perMinute: 100 },
  pro: { perDay: 100000, perMinute: 500 },
  enterprise: { perDay: Infinity, perMinute: 2000 },
};

// GET /developer/rate-limits
rateLimitsRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const { developerId } = z.object({ developerId: z.string() }).parse(req.query);

    const developer = await prismaRead.developer.findUnique({
      where: { id: developerId },
      include: { plan: true },
    });
    if (!developer) return res.status(404).json({ error: 'Developer not found' });

    const planName = developer.plan?.name ?? 'free';
    const limits = PLAN_LIMITS[planName] ?? PLAN_LIMITS.free;

    const [usedToday, usedLastMinute] = await Promise.all([
      prismaRead.usageRecord.count({
        where: { developerId, createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } },
      }),
      prismaRead.usageRecord.count({
        where: { developerId, createdAt: { gte: new Date(Date.now() - 60000) } },
      }),
    ]);

    res.json({
      plan: planName,
      perDay: {
        limit: limits.perDay,
        used: usedToday,
        remaining: Math.max(0, limits.perDay - usedToday),
      },
      perMinute: {
        limit: limits.perMinute,
        used: usedLastMinute,
        remaining: Math.max(0, limits.perMinute - usedLastMinute),
      },
      headers: {
        'X-Key-RateLimit-Remaining': String(Math.max(0, limits.perDay - usedToday)),
        'X-IP-RateLimit-Remaining': String(Math.max(0, limits.perMinute - usedLastMinute)),
      },
    });
  }),
);

// POST /developer/rate-limits/burst
rateLimitsRouter.post(
  '/burst',
  asyncHandler(async (req: Request, res: Response) => {
    const { developerId, reason } = z
      .object({ developerId: z.string(), reason: z.string().optional() })
      .parse(req.body);

    const developer = await prismaRead.developer.findUnique({
      where: { id: developerId },
      include: { plan: true },
    });
    if (!developer) return res.status(404).json({ error: 'Developer not found' });

    // Pro and above get burst allowance; free/developer get a limited burst
    const planName = developer.plan?.name ?? 'free';
    const burstMultiplier = planName === 'enterprise' ? 5 : planName === 'pro' ? 3 : 2;

    res.json({
      granted: true,
      burstMultiplier,
      validForMs: 300000, // 5 minutes
      reason: reason ?? 'Burst allowance requested',
      message: `Burst allowance of ${burstMultiplier}x granted for 5 minutes`,
    });
  }),
);

// GET /developer/quota
quotaRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const { developerId } = z.object({ developerId: z.string() }).parse(req.query);

    const developer = await prismaRead.developer.findUnique({
      where: { id: developerId },
      include: { plan: true },
    });
    if (!developer) return res.status(404).json({ error: 'Developer not found' });

    const planName = developer.plan?.name ?? 'free';
    const plan = developer.plan;

    const now = new Date();
    const startOfDay = new Date(now.setHours(0, 0, 0, 0));
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [usedToday, usedThisMonth] = await Promise.all([
      prismaRead.usageRecord.count({ where: { developerId, createdAt: { gte: startOfDay } } }),
      prismaRead.usageRecord.count({ where: { developerId, createdAt: { gte: startOfMonth } } }),
    ]);

    const dailyLimit = plan?.requestsPerDay ?? PLAN_LIMITS[planName]?.perDay ?? 100;
    const monthlyLimit = plan?.requestsPerMonth ?? (PLAN_LIMITS[planName]?.perDay ?? 100) * 30;

    const dailyPct = dailyLimit === Infinity ? 0 : (usedToday / dailyLimit) * 100;
    const monthlyPct = monthlyLimit === Infinity ? 0 : (usedThisMonth / monthlyLimit) * 100;

    res.json({
      plan: planName,
      daily: {
        limit: dailyLimit,
        used: usedToday,
        remaining: Math.max(0, dailyLimit - usedToday),
        percentUsed: dailyPct,
      },
      monthly: {
        limit: monthlyLimit,
        used: usedThisMonth,
        remaining: Math.max(0, monthlyLimit - usedThisMonth),
        percentUsed: monthlyPct,
      },
      warning: dailyPct >= 80 || monthlyPct >= 80,
      resetAt: {
        daily: new Date(new Date().setHours(24, 0, 0, 0)).toISOString(),
        monthly: new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString(),
      },
    });
  }),
);
