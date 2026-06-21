import { Router, Request, Response } from 'express';
import { prismaRead as prisma, prismaWrite } from '../db';
import { z } from 'zod';
import { validateAddressParam } from '../middleware/sanitize';
import { isValidCronExpression, nextCronDate } from '../indexer/cron-engine';

export const scheduleRouter = Router();

// ── Shared query schemas ──────────────────────────────────────────────────────

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// ── GET /schedule/contracts/:address ─────────────────────────────────────────
// All scheduled operations for a contract

scheduleRouter.get(
  '/contracts/:address',
  validateAddressParam('address'),
  async (req: Request, res: Response) => {
    try {
      const { page, limit } = paginationSchema.parse(req.query);
      const address = req.params.address;
      const skip = (page - 1) * limit;

      const q = z
        .object({ status: z.string().optional(), type: z.string().optional() })
        .parse(req.query);
      const where: Record<string, unknown> = { contractAddress: address };
      if (q.status) where.status = q.status;
      if (q.type) where.timerType = q.type;

      const [data, total] = await Promise.all([
        prisma.scheduledOperation.findMany({
          where,
          orderBy: { triggerTime: 'asc' },
          skip,
          take: limit,
        }),
        prisma.scheduledOperation.count({ where }),
      ]);

      res.json({ data, total, page, limit });
    } catch (e) {
      res.status(400).json({ error: String(e) });
    }
  },
);

// ── GET /schedule/contracts/:address/timeline ─────────────────────────────────
// Visual timeline of upcoming events for a contract

scheduleRouter.get(
  '/contracts/:address/timeline',
  validateAddressParam('address'),
  async (req: Request, res: Response) => {
    try {
      const address = req.params.address;
      const now = new Date();
      const limit = z.coerce.number().int().min(1).max(200).default(50).parse(req.query.limit);

      const ops = await prisma.scheduledOperation.findMany({
        where: { contractAddress: address, triggerTime: { gte: now } },
        orderBy: { triggerTime: 'asc' },
        take: limit,
        select: {
          id: true,
          functionName: true,
          timerType: true,
          status: true,
          triggerTime: true,
          description: true,
        },
      });

      res.json({ contractAddress: address, events: ops });
    } catch (e) {
      res.status(400).json({ error: String(e) });
    }
  },
);

// ── GET /schedule/upcoming ────────────────────────────────────────────────────
// Upcoming operations across all contracts

scheduleRouter.get('/upcoming', async (req: Request, res: Response) => {
  try {
    const q = z
      .object({
        hours: z.coerce.number().int().min(1).max(8760).default(24),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query);

    const now = new Date();
    const until = new Date(now.getTime() + q.hours * 3600 * 1000);

    const ops = await prisma.scheduledOperation.findMany({
      where: { status: { in: ['PENDING', 'ACTIVE'] }, triggerTime: { gte: now, lte: until } },
      orderBy: { triggerTime: 'asc' },
      take: q.limit,
    });

    res.json({ from: now, to: until, total: ops.length, data: ops });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ── GET /schedule/contracts/:address/vesting ──────────────────────────────────
// Vesting schedule details for a contract

scheduleRouter.get(
  '/contracts/:address/vesting',
  validateAddressParam('address'),
  async (req: Request, res: Response) => {
    try {
      const address = req.params.address;
      const { page, limit } = paginationSchema.parse(req.query);
      const skip = (page - 1) * limit;

      const [data, total] = await Promise.all([
        prisma.vestingSchedule.findMany({
          where: { contractAddress: address },
          orderBy: { nextUnlockDate: 'asc' },
          skip,
          take: limit,
        }),
        prisma.vestingSchedule.count({ where: { contractAddress: address } }),
      ]);

      res.json({ data, total, page, limit });
    } catch (e) {
      res.status(400).json({ error: String(e) });
    }
  },
);

// ── GET /schedule/contracts/:address/governance ───────────────────────────────
// Governance timelocks for a contract

scheduleRouter.get(
  '/contracts/:address/governance',
  validateAddressParam('address'),
  async (req: Request, res: Response) => {
    try {
      const address = req.params.address;
      const { page, limit } = paginationSchema.parse(req.query);
      const skip = (page - 1) * limit;

      const [data, total] = await Promise.all([
        prisma.governanceTimelock.findMany({
          where: { contractAddress: address },
          orderBy: { executionTime: 'asc' },
          skip,
          take: limit,
        }),
        prisma.governanceTimelock.count({ where: { contractAddress: address } }),
      ]);

      res.json({ data, total, page, limit });
    } catch (e) {
      res.status(400).json({ error: String(e) });
    }
  },
);

// ── GET /schedule/contracts/:address/cron ────────────────────────────────────
// Cron jobs for a contract

scheduleRouter.get(
  '/contracts/:address/cron',
  validateAddressParam('address'),
  async (req: Request, res: Response) => {
    try {
      const address = req.params.address;
      const { page, limit } = paginationSchema.parse(req.query);
      const skip = (page - 1) * limit;

      const [data, total] = await Promise.all([
        prisma.cronJob.findMany({
          where: { contractAddress: address },
          orderBy: { nextRunAt: 'asc' },
          skip,
          take: limit,
        }),
        prisma.cronJob.count({ where: { contractAddress: address } }),
      ]);

      res.json({ data, total, page, limit });
    } catch (e) {
      res.status(400).json({ error: String(e) });
    }
  },
);

// ── GET /schedule/calendar ────────────────────────────────────────────────────
// Calendar view of all events in a time range

scheduleRouter.get('/calendar', async (req: Request, res: Response) => {
  try {
    const q = z
      .object({
        from: z.string().default(() => new Date().toISOString()),
        to: z.string().default(() => new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString()),
      })
      .parse(req.query);

    const from = new Date(q.from);
    const to = new Date(q.to);
    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      return res.status(400).json({ error: 'Invalid date range' });
    }

    const [ops, vestings, timelocks] = await Promise.all([
      prisma.scheduledOperation.findMany({
        where: { triggerTime: { gte: from, lte: to } },
        orderBy: { triggerTime: 'asc' },
        select: {
          id: true,
          contractAddress: true,
          functionName: true,
          timerType: true,
          triggerTime: true,
          status: true,
        },
      }),
      prisma.vestingSchedule.findMany({
        where: { nextUnlockDate: { gte: from, lte: to } },
        orderBy: { nextUnlockDate: 'asc' },
        select: {
          id: true,
          contractAddress: true,
          beneficiary: true,
          tokenSymbol: true,
          nextUnlockDate: true,
          nextUnlockAmount: true,
        },
      }),
      prisma.governanceTimelock.findMany({
        where: { executionTime: { gte: from, lte: to } },
        orderBy: { executionTime: 'asc' },
        select: { id: true, contractAddress: true, title: true, executionTime: true, status: true },
      }),
    ]);

    res.json({
      from,
      to,
      scheduledOperations: ops,
      vestingUnlocks: vestings,
      governanceExecutions: timelocks,
    });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ── GET /schedule/calendar.ics ────────────────────────────────────────────────
// iCal export

scheduleRouter.get('/calendar.ics', async (_req: Request, res: Response) => {
  try {
    const now = new Date();
    const until = new Date(now.getTime() + 90 * 24 * 3600 * 1000);

    const ops = await prisma.scheduledOperation.findMany({
      where: { triggerTime: { gte: now, lte: until } },
      orderBy: { triggerTime: 'asc' },
      take: 500,
    });

    const formatDt = (d: Date) =>
      d
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d{3}/, '');

    const events = ops
      .map((op) => {
        const uid = `${op.id}@soroban-explorer`;
        const dtstart = formatDt(op.triggerTime);
        const dtend = formatDt(new Date(op.triggerTime.getTime() + 3600 * 1000));
        const summary = `[${op.timerType}] ${op.functionName} @ ${op.contractAddress.slice(0, 8)}`;
        return [
          'BEGIN:VEVENT',
          `UID:${uid}`,
          `DTSTART:${dtstart}`,
          `DTEND:${dtend}`,
          `SUMMARY:${summary}`,
          `DESCRIPTION:Contract: ${op.contractAddress}\\nStatus: ${op.status}`,
          'END:VEVENT',
        ].join('\r\n');
      })
      .join('\r\n');

    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Soroban Explorer//Temporal Orchestrator//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      events,
      'END:VCALENDAR',
    ].join('\r\n');

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="soroban-schedule.ics"');
    res.send(ics);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /schedule/operations/:opId ───────────────────────────────────────────
// Detailed operation info

scheduleRouter.get('/operations/:opId', async (req: Request, res: Response) => {
  try {
    const op = await prisma.scheduledOperation.findUnique({ where: { id: req.params.opId } });
    if (!op) return res.status(404).json({ error: 'Operation not found' });
    res.json(op);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /schedule/discover ────────────────────────────────────────────────────
// Discover contracts with time-dependent operations

scheduleRouter.get('/discover', async (_req: Request, res: Response) => {
  try {
    const contracts = await prisma.scheduledOperation.groupBy({
      by: ['contractAddress'],
      _count: { contractAddress: true },
      orderBy: { _count: { contractAddress: 'desc' } },
      take: 50,
    });

    res.json({
      contracts: contracts.map((c) => ({
        contractAddress: c.contractAddress,
        scheduledOperationCount: c._count.contractAddress,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /schedule/stats ───────────────────────────────────────────────────────
// Platform statistics

scheduleRouter.get('/stats', async (_req: Request, res: Response) => {
  try {
    const now = new Date();
    const in24h = new Date(now.getTime() + 24 * 3600 * 1000);
    const in7d = new Date(now.getTime() + 7 * 24 * 3600 * 1000);

    const [
      totalScheduledOps,
      pendingExecutions,
      upcoming24h,
      upcoming7d,
      byTypeRaw,
      expiredTimelocks,
      largeUnlocks,
    ] = await Promise.all([
      prisma.scheduledOperation.count(),
      prisma.scheduledOperation.count({ where: { status: { in: ['PENDING', 'ACTIVE'] } } }),
      prisma.scheduledOperation.count({
        where: { status: { in: ['PENDING', 'ACTIVE'] }, triggerTime: { lte: in24h } },
      }),
      prisma.scheduledOperation.count({
        where: { status: { in: ['PENDING', 'ACTIVE'] }, triggerTime: { lte: in7d } },
      }),
      prisma.scheduledOperation.groupBy({ by: ['timerType'], _count: { timerType: true } }),
      prisma.governanceTimelock.count({ where: { status: 'expired' } }),
      prisma.vestingSchedule.findMany({
        where: { status: 'active', nextUnlockDate: { lte: in7d } },
        orderBy: { nextUnlockAmount: 'desc' },
        take: 10,
        select: {
          contractAddress: true,
          tokenSymbol: true,
          nextUnlockAmount: true,
          nextUnlockDate: true,
          beneficiary: true,
        },
      }),
    ]);

    const byType = Object.fromEntries(
      byTypeRaw.map((r) => [r.timerType.toLowerCase(), r._count.timerType]),
    );

    res.json({
      totalScheduledOps,
      pendingExecutions,
      upcoming24h,
      upcoming7d,
      byType,
      largeUnlocksUpcoming: largeUnlocks.map((u) => ({
        contract: u.contractAddress,
        token: u.tokenSymbol ?? 'UNKNOWN',
        amount: u.nextUnlockAmount?.toString() ?? '0',
        date: u.nextUnlockDate?.toISOString().split('T')[0],
        beneficiary: u.beneficiary,
      })),
      expiredTimelocks,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /schedule/alerts ──────────────────────────────────────────────────────
// Pending timer alerts

scheduleRouter.get('/alerts', async (req: Request, res: Response) => {
  try {
    const { page, limit } = paginationSchema.parse(req.query);
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      prisma.timerAlert.findMany({
        where: { acknowledged: false },
        orderBy: { triggerTime: 'asc' },
        skip,
        take: limit,
      }),
      prisma.timerAlert.count({ where: { acknowledged: false } }),
    ]);

    res.json({ data, total, page, limit });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── POST /schedule/alerts/:id/acknowledge ────────────────────────────────────
// Acknowledge an alert

scheduleRouter.post('/alerts/:id/acknowledge', async (req: Request, res: Response) => {
  try {
    const alert = await prismaWrite.timerAlert.findUnique({ where: { id: req.params.id } });
    if (!alert) return res.status(404).json({ error: 'Alert not found' });

    const updated = await prismaWrite.timerAlert.update({
      where: { id: req.params.id },
      data: { acknowledged: true },
    });
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /schedule/search ──────────────────────────────────────────────────────
// Search scheduled operations

scheduleRouter.get('/search', async (req: Request, res: Response) => {
  try {
    const q = z
      .object({
        q: z.string().optional(),
        type: z.string().optional(),
        status: z.string().optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(20),
      })
      .parse(req.query);

    const skip = (q.page - 1) * q.limit;
    const where: Record<string, unknown> = {};
    if (q.type) where.timerType = q.type.toUpperCase();
    if (q.status) where.status = q.status.toUpperCase();
    if (q.q) {
      where.OR = [
        { contractAddress: { contains: q.q, mode: 'insensitive' } },
        { functionName: { contains: q.q, mode: 'insensitive' } },
        { description: { contains: q.q, mode: 'insensitive' } },
      ];
    }

    const [data, total] = await Promise.all([
      prisma.scheduledOperation.findMany({
        where,
        orderBy: { triggerTime: 'asc' },
        skip,
        take: q.limit,
      }),
      prisma.scheduledOperation.count({ where }),
    ]);

    res.json({ data, total, page: q.page, limit: q.limit });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ── GET /schedule/vesting/large-unlocks ──────────────────────────────────────

scheduleRouter.get('/vesting/large-unlocks', async (req: Request, res: Response) => {
  try {
    const q = z
      .object({
        days: z.coerce.number().int().min(1).max(365).default(7),
        minAmount: z.coerce.number().default(10000),
      })
      .parse(req.query);

    const until = new Date(Date.now() + q.days * 24 * 3600 * 1000);

    const unlocks = await prisma.vestingSchedule.findMany({
      where: {
        status: 'active',
        nextUnlockDate: { lte: until },
        nextUnlockAmount: { gte: q.minAmount },
      },
      orderBy: { nextUnlockAmount: 'desc' },
      take: 100,
    });

    res.json({ data: unlocks, total: unlocks.length });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ── GET /schedule/vesting/:beneficiaryAddress ─────────────────────────────────

scheduleRouter.get('/vesting/:beneficiaryAddress', async (req: Request, res: Response) => {
  try {
    const { page, limit } = paginationSchema.parse(req.query);
    const skip = (page - 1) * limit;
    const beneficiary = req.params.beneficiaryAddress;

    const [data, total] = await Promise.all([
      prisma.vestingSchedule.findMany({
        where: { beneficiary },
        orderBy: { nextUnlockDate: 'asc' },
        skip,
        take: limit,
      }),
      prisma.vestingSchedule.count({ where: { beneficiary } }),
    ]);

    res.json({ data, total, page, limit });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ── GET /schedule/vesting/leaderboard ────────────────────────────────────────

scheduleRouter.get('/vesting/leaderboard', async (_req: Request, res: Response) => {
  try {
    const until = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    const top = await prisma.vestingSchedule.findMany({
      where: { status: 'active', nextUnlockDate: { lte: until } },
      orderBy: { nextUnlockAmount: 'desc' },
      take: 20,
      select: {
        beneficiary: true,
        tokenSymbol: true,
        nextUnlockAmount: true,
        nextUnlockDate: true,
        contractAddress: true,
      },
    });
    res.json({ data: top });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /schedule/governance/pending ─────────────────────────────────────────

scheduleRouter.get('/governance/pending', async (req: Request, res: Response) => {
  try {
    const { page, limit } = paginationSchema.parse(req.query);
    const skip = (page - 1) * limit;
    const now = new Date();

    const [data, total] = await Promise.all([
      prisma.governanceTimelock.findMany({
        where: { status: { in: ['queued', 'executable'] } },
        orderBy: { executionTime: 'asc' },
        skip,
        take: limit,
      }),
      prisma.governanceTimelock.count({ where: { status: { in: ['queued', 'executable'] } } }),
    ]);

    res.json({
      data: data.map((t) => ({
        ...t,
        secondsUntilExecution: Math.max(
          0,
          Math.floor((t.executionTime.getTime() - now.getTime()) / 1000),
        ),
        gracePeriodRemaining: t.expiryTime
          ? Math.max(0, Math.floor((t.expiryTime.getTime() - now.getTime()) / 1000))
          : null,
      })),
      total,
      page,
      limit,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /schedule/governance/expired ─────────────────────────────────────────

scheduleRouter.get('/governance/expired', async (req: Request, res: Response) => {
  try {
    const { page, limit } = paginationSchema.parse(req.query);
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      prisma.governanceTimelock.findMany({
        where: { status: 'expired' },
        orderBy: { expiryTime: 'desc' },
        skip,
        take: limit,
      }),
      prisma.governanceTimelock.count({ where: { status: 'expired' } }),
    ]);

    res.json({ data, total, page, limit });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /schedule/governance/stats ───────────────────────────────────────────

scheduleRouter.get('/governance/stats', async (_req: Request, res: Response) => {
  try {
    const [total, queued, executable, executed, expired, cancelled] = await Promise.all([
      prisma.governanceTimelock.count(),
      prisma.governanceTimelock.count({ where: { status: 'queued' } }),
      prisma.governanceTimelock.count({ where: { status: 'executable' } }),
      prisma.governanceTimelock.count({ where: { status: 'executed' } }),
      prisma.governanceTimelock.count({ where: { status: 'expired' } }),
      prisma.governanceTimelock.count({ where: { status: 'cancelled' } }),
    ]);

    const avgDelayResult = await prisma.governanceTimelock.aggregate({ _avg: { minDelay: true } });

    res.json({
      total,
      queued,
      executable,
      executed,
      expired,
      cancelled,
      avgDelaySeconds: avgDelayResult._avg.minDelay ?? 0,
      utilizationRate: total > 0 ? executed / total : 0,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── POST /schedule/cron ───────────────────────────────────────────────────────
// Create a cron job

const cronCreateSchema = z.object({
  contract: z.string().min(1),
  cronExpression: z.string().min(1),
  function: z.string().min(1),
  args: z.record(z.unknown()).default({}),
  description: z.string().optional(),
  maxRuns: z.number().int().positive().optional(),
  enabled: z.boolean().default(true),
  createdBy: z.string().optional(),
});

scheduleRouter.post('/cron', async (req: Request, res: Response) => {
  try {
    const body = cronCreateSchema.parse(req.body);

    if (!isValidCronExpression(body.cronExpression)) {
      return res.status(400).json({ error: 'Invalid cron expression' });
    }

    const nextRunAt = nextCronDate(body.cronExpression);

    const job = await prismaWrite.cronJob.create({
      data: {
        contractAddress: body.contract,
        cronExpression: body.cronExpression,
        functionName: body.function,
        functionArgs: body.args as object,
        description: body.description ?? null,
        maxRuns: body.maxRuns ?? null,
        enabled: body.enabled,
        createdBy: body.createdBy ?? null,
        nextRunAt,
        createdAt: new Date(),
      },
    });

    res.status(201).json(job);
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ── PUT /schedule/cron/:id ────────────────────────────────────────────────────

scheduleRouter.put('/cron/:id', async (req: Request, res: Response) => {
  try {
    const body = cronCreateSchema.partial().parse(req.body);
    const existing = await prismaWrite.cronJob.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Cron job not found' });

    const expr = body.cronExpression ?? existing.cronExpression;
    if (body.cronExpression && !isValidCronExpression(expr)) {
      return res.status(400).json({ error: 'Invalid cron expression' });
    }

    const updated = await prismaWrite.cronJob.update({
      where: { id: req.params.id },
      data: {
        ...(body.contract && { contractAddress: body.contract }),
        ...(body.cronExpression && {
          cronExpression: body.cronExpression,
          nextRunAt: nextCronDate(body.cronExpression),
        }),
        ...(body.function && { functionName: body.function }),
        ...(body.args && { functionArgs: body.args as object }),
        ...(body.description !== undefined && { description: body.description }),
        ...(body.maxRuns !== undefined && { maxRuns: body.maxRuns }),
        ...(body.enabled !== undefined && { enabled: body.enabled }),
      },
    });

    res.json(updated);
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ── DELETE /schedule/cron/:id ─────────────────────────────────────────────────

scheduleRouter.delete('/cron/:id', async (req: Request, res: Response) => {
  try {
    const existing = await prismaWrite.cronJob.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Cron job not found' });

    // Delete executions first (FK constraint)
    await prismaWrite.cronExecution.deleteMany({ where: { cronJobId: req.params.id } });
    await prismaWrite.cronJob.delete({ where: { id: req.params.id } });

    res.json({ deleted: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── POST /schedule/cron/:id/trigger ──────────────────────────────────────────
// Manually trigger a cron job now

scheduleRouter.post('/cron/:id/trigger', async (req: Request, res: Response) => {
  try {
    const job = await prismaWrite.cronJob.findUnique({ where: { id: req.params.id } });
    if (!job) return res.status(404).json({ error: 'Cron job not found' });

    // Record a manual execution
    const exec = await prismaWrite.cronExecution.create({
      data: {
        cronJobId: job.id,
        executedAt: new Date(),
        success: true,
        duration: 0,
      },
    });

    await prismaWrite.cronJob.update({
      where: { id: job.id },
      data: {
        lastRunAt: new Date(),
        totalRuns: { increment: 1 },
        successfulRuns: { increment: 1 },
      },
    });

    res.json({ triggered: true, execution: exec });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /schedule/cron/:id/history ───────────────────────────────────────────

scheduleRouter.get('/cron/:id/history', async (req: Request, res: Response) => {
  try {
    const { page, limit } = paginationSchema.parse(req.query);
    const skip = (page - 1) * limit;

    const job = await prisma.cronJob.findUnique({ where: { id: req.params.id } });
    if (!job) return res.status(404).json({ error: 'Cron job not found' });

    const [data, total] = await Promise.all([
      prisma.cronExecution.findMany({
        where: { cronJobId: req.params.id },
        orderBy: { executedAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.cronExecution.count({ where: { cronJobId: req.params.id } }),
    ]);

    res.json({ data, total, page, limit });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── PATCH /schedule/cron/:id/toggle ──────────────────────────────────────────

scheduleRouter.patch('/cron/:id/toggle', async (req: Request, res: Response) => {
  try {
    const job = await prismaWrite.cronJob.findUnique({ where: { id: req.params.id } });
    if (!job) return res.status(404).json({ error: 'Cron job not found' });

    const updated = await prismaWrite.cronJob.update({
      where: { id: req.params.id },
      data: { enabled: !job.enabled },
    });

    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /schedule/health ──────────────────────────────────────────────────────

scheduleRouter.get('/health', async (_req: Request, res: Response) => {
  try {
    const now = new Date();
    const week = new Date(now.getTime() - 7 * 24 * 3600 * 1000);

    const [activeOps, stalledOps, expiredTimelocks, recentExec, failedJobs] = await Promise.all([
      prisma.scheduledOperation.count({ where: { status: 'ACTIVE' } }),
      prisma.scheduledOperation.count({ where: { status: 'PENDING', nextTriggerAt: { lt: now } } }),
      prisma.governanceTimelock.count({ where: { status: 'expired' } }),
      prisma.cronExecution.findMany({
        where: { executedAt: { gte: week } },
        select: { success: true, duration: true },
      }),
      prisma.cronJob.findMany({
        where: { failedRuns: { gt: 0 } },
        select: { id: true, contractAddress: true, failedRuns: true, functionName: true },
        take: 10,
      }),
    ]);

    const totalExec = recentExec.length;
    const successExec = recentExec.filter((e) => e.success).length;
    const avgDuration =
      totalExec > 0 ? recentExec.reduce((s, e) => s + (e.duration ?? 0), 0) / totalExec : 0;

    res.json({
      activeTimers: activeOps,
      stalledTimers: stalledOps,
      expiredTimelocks,
      cronSuccessRate7d: totalExec > 0 ? successExec / totalExec : 1,
      avgExecutionDelayMs: avgDuration,
      failedCronJobs: failedJobs,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});
