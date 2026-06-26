import { Router, Request, Response } from 'express';
import { prismaRead as prisma, prismaWrite } from '../db';
import { z } from 'zod';
import { validateAddressParam } from '../middleware/sanitize';
import { isValidCronExpression, nextCronDate } from '../indexer/cron-engine';

/**
 * @swagger
 * tags:
 *   name: Schedule
 *   description: Scheduled operations, vesting, governance timelocks, cron jobs, timer alerts, and calendar exports
 */

export const scheduleRouter = Router();

// ── Shared query schemas ──────────────────────────────────────────────────────

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// ── GET /schedule/contracts/:address ─────────────────────────────────────────
// All scheduled operations for a contract

/**
 * @swagger
 * /api/v1/schedule/contracts/{address}:
 *   get:
 *     summary: List scheduled operations for a contract
 *     tags: [Schedule]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *         description: Stellar contract address (validated before the handler runs)
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [PENDING, ACTIVE, EXECUTED, EXPIRED, CANCELLED, FAILED]
 *         description: Filter by timer status
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [TIMELOCK, VESTING, DEADLINE, COOLDOWN, RECURRING, TIME_WEIGHTED, MULTI_STAGE, ABSOLUTE]
 *         description: Filter by timer type
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
 *     responses:
 *       200:
 *         description: Paginated scheduled operations for the contract
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/ScheduledOperation' }
 *                 total: { type: integer, example: 42 }
 *                 page: { type: integer, example: 1 }
 *                 limit: { type: integer, example: 20 }
 *       400:
 *         description: Invalid Stellar address (rejected before the handler) or invalid query parameters
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Invalid Stellar address: NOTANADDRESS' }
 */
scheduleRouter.get('/contracts/:address', validateAddressParam('address'), async (req: Request, res: Response) => {
  try {
    const { page, limit } = paginationSchema.parse(req.query);
    const address = req.params.address;
    const skip = (page - 1) * limit;

    const q = z.object({ status: z.string().optional(), type: z.string().optional() }).parse(req.query);
    const where: Record<string, unknown> = { contractAddress: address };
    if (q.status) where.status = q.status;
    if (q.type) where.timerType = q.type;

    const [data, total] = await Promise.all([
      prisma.scheduledOperation.findMany({ where, orderBy: { triggerTime: 'asc' }, skip, take: limit }),
      prisma.scheduledOperation.count({ where }),
    ]);

    res.json({ data, total, page, limit });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ── GET /schedule/contracts/:address/timeline ─────────────────────────────────
// Visual timeline of upcoming events for a contract

/**
 * @swagger
 * /api/v1/schedule/contracts/{address}/timeline:
 *   get:
 *     summary: Upcoming events timeline for a contract
 *     description: Scheduled operations triggering at or after now, ordered ascending.
 *     tags: [Schedule]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *         description: Stellar contract address (validated before the handler runs)
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 200, default: 50 }
 *     responses:
 *       200:
 *         description: Timeline of upcoming operations (subset of each operation's fields)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 contractAddress: { type: string, example: CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5 }
 *                 events:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string, example: clz9q1x4t0000s6h2schedop1 }
 *                       functionName: { type: string, example: release }
 *                       timerType: { type: string, enum: [TIMELOCK, VESTING, DEADLINE, COOLDOWN, RECURRING, TIME_WEIGHTED, MULTI_STAGE, ABSOLUTE], example: VESTING }
 *                       status: { type: string, enum: [PENDING, ACTIVE, EXECUTED, EXPIRED, CANCELLED, FAILED], example: PENDING }
 *                       triggerTime: { type: string, format: date-time, example: '2026-06-19T07:24:26.000Z' }
 *                       description: { type: string, nullable: true, example: 'Cliff unlock for team allocation' }
 *       400:
 *         description: Invalid Stellar address (rejected before the handler) or invalid limit
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Invalid Stellar address: NOTANADDRESS' }
 */
scheduleRouter.get('/contracts/:address/timeline', validateAddressParam('address'), async (req: Request, res: Response) => {
  try {
    const address = req.params.address;
    const now = new Date();
    const limit = z.coerce.number().int().min(1).max(200).default(50).parse(req.query.limit);

    const ops = await prisma.scheduledOperation.findMany({
      where: { contractAddress: address, triggerTime: { gte: now } },
      orderBy: { triggerTime: 'asc' },
      take: limit,
      select: { id: true, functionName: true, timerType: true, status: true, triggerTime: true, description: true },
    });

    res.json({ contractAddress: address, events: ops });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ── GET /schedule/upcoming ────────────────────────────────────────────────────
// Upcoming operations across all contracts

/**
 * @swagger
 * /api/v1/schedule/upcoming:
 *   get:
 *     summary: Upcoming operations across all contracts
 *     description: Operations with status PENDING or ACTIVE triggering within the next N hours, ordered ascending.
 *     tags: [Schedule]
 *     parameters:
 *       - in: query
 *         name: hours
 *         schema: { type: integer, minimum: 1, maximum: 8760, default: 24 }
 *         description: Look-ahead window in hours
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 200, default: 50 }
 *     responses:
 *       200:
 *         description: Upcoming operations within the window
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 from: { type: string, format: date-time, example: '2026-06-19T07:24:26.000Z' }
 *                 to: { type: string, format: date-time, example: '2026-06-20T07:24:26.000Z' }
 *                 total: { type: integer, example: 12 }
 *                 data:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/ScheduledOperation' }
 *       400:
 *         description: Invalid query parameters
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'ZodError: hours must be less than or equal to 8760' }
 */
scheduleRouter.get('/upcoming', async (req: Request, res: Response) => {
  try {
    const q = z.object({
      hours: z.coerce.number().int().min(1).max(8760).default(24),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }).parse(req.query);

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

/**
 * @swagger
 * /api/v1/schedule/contracts/{address}/vesting:
 *   get:
 *     summary: List vesting schedules for a contract
 *     tags: [Schedule]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *         description: Stellar contract address (validated before the handler runs)
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
 *     responses:
 *       200:
 *         description: Paginated vesting schedules for the contract
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/VestingSchedule' }
 *                 total: { type: integer, example: 8 }
 *                 page: { type: integer, example: 1 }
 *                 limit: { type: integer, example: 20 }
 *       400:
 *         description: Invalid Stellar address (rejected before the handler) or invalid query parameters
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Invalid Stellar address: NOTANADDRESS' }
 */
scheduleRouter.get('/contracts/:address/vesting', validateAddressParam('address'), async (req: Request, res: Response) => {
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
});

// ── GET /schedule/contracts/:address/governance ───────────────────────────────
// Governance timelocks for a contract

/**
 * @swagger
 * /api/v1/schedule/contracts/{address}/governance:
 *   get:
 *     summary: List governance timelocks for a contract
 *     tags: [Schedule]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *         description: Stellar contract address (validated before the handler runs)
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
 *     responses:
 *       200:
 *         description: Paginated governance timelocks for the contract
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/GovernanceTimelock' }
 *                 total: { type: integer, example: 5 }
 *                 page: { type: integer, example: 1 }
 *                 limit: { type: integer, example: 20 }
 *       400:
 *         description: Invalid Stellar address (rejected before the handler) or invalid query parameters
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Invalid Stellar address: NOTANADDRESS' }
 */
scheduleRouter.get('/contracts/:address/governance', validateAddressParam('address'), async (req: Request, res: Response) => {
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
});

// ── GET /schedule/contracts/:address/cron ────────────────────────────────────
// Cron jobs for a contract

/**
 * @swagger
 * /api/v1/schedule/contracts/{address}/cron:
 *   get:
 *     summary: List cron jobs for a contract
 *     tags: [Schedule]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *         description: Stellar contract address (validated before the handler runs)
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
 *     responses:
 *       200:
 *         description: Paginated cron jobs for the contract
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/CronJob' }
 *                 total: { type: integer, example: 3 }
 *                 page: { type: integer, example: 1 }
 *                 limit: { type: integer, example: 20 }
 *       400:
 *         description: Invalid Stellar address (rejected before the handler) or invalid query parameters
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Invalid Stellar address: NOTANADDRESS' }
 */
scheduleRouter.get('/contracts/:address/cron', validateAddressParam('address'), async (req: Request, res: Response) => {
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
});

// ── GET /schedule/calendar ────────────────────────────────────────────────────
// Calendar view of all events in a time range

/**
 * @swagger
 * /api/v1/schedule/calendar:
 *   get:
 *     summary: Calendar view of events in a time range
 *     description: Scheduled operations, vesting unlocks, and governance executions between `from` and `to` (defaults to the next 7 days).
 *     tags: [Schedule]
 *     parameters:
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date-time }
 *         description: Range start (ISO 8601). Defaults to now.
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date-time }
 *         description: Range end (ISO 8601). Defaults to now + 7 days.
 *     responses:
 *       200:
 *         description: Calendar entries grouped by type (subset of each record's fields)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 from: { type: string, format: date-time, example: '2026-06-19T07:24:26.000Z' }
 *                 to: { type: string, format: date-time, example: '2026-06-26T07:24:26.000Z' }
 *                 scheduledOperations:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string, example: clz9q1x4t0000s6h2schedop1 }
 *                       contractAddress: { type: string, example: CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5 }
 *                       functionName: { type: string, example: release }
 *                       timerType: { type: string, enum: [TIMELOCK, VESTING, DEADLINE, COOLDOWN, RECURRING, TIME_WEIGHTED, MULTI_STAGE, ABSOLUTE], example: VESTING }
 *                       triggerTime: { type: string, format: date-time, example: '2026-06-19T07:24:26.000Z' }
 *                       status: { type: string, enum: [PENDING, ACTIVE, EXECUTED, EXPIRED, CANCELLED, FAILED], example: PENDING }
 *                 vestingUnlocks:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string, example: clz9q1x4t0000s6h2vesting1 }
 *                       contractAddress: { type: string, example: CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5 }
 *                       beneficiary: { type: string, example: GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI }
 *                       tokenSymbol: { type: string, nullable: true, example: USDC }
 *                       nextUnlockDate: { type: string, format: date-time, nullable: true, example: '2026-06-19T07:24:26.000Z' }
 *                       nextUnlockAmount: { type: string, nullable: true, description: 'Decimal serialised as a string', example: '1000000000' }
 *                 governanceExecutions:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string, example: clz9q1x4t0000s6h2govtl001 }
 *                       contractAddress: { type: string, example: CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5 }
 *                       title: { type: string, nullable: true, example: 'Upgrade router to v2' }
 *                       executionTime: { type: string, format: date-time, example: '2026-06-19T07:24:26.000Z' }
 *                       status: { type: string, example: queued }
 *       400:
 *         description: Invalid `from`/`to` query values or an unparseable date range
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Invalid date range' }
 */
scheduleRouter.get('/calendar', async (req: Request, res: Response) => {
  try {
    const q = z.object({
      from: z.string().default(() => new Date().toISOString()),
      to: z.string().default(() => new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString()),
    }).parse(req.query);

    const from = new Date(q.from);
    const to = new Date(q.to);
    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      return res.status(400).json({ error: 'Invalid date range' });
    }

    const [ops, vestings, timelocks] = await Promise.all([
      prisma.scheduledOperation.findMany({
        where: { triggerTime: { gte: from, lte: to } },
        orderBy: { triggerTime: 'asc' },
        select: { id: true, contractAddress: true, functionName: true, timerType: true, triggerTime: true, status: true },
      }),
      prisma.vestingSchedule.findMany({
        where: { nextUnlockDate: { gte: from, lte: to } },
        orderBy: { nextUnlockDate: 'asc' },
        select: { id: true, contractAddress: true, beneficiary: true, tokenSymbol: true, nextUnlockDate: true, nextUnlockAmount: true },
      }),
      prisma.governanceTimelock.findMany({
        where: { executionTime: { gte: from, lte: to } },
        orderBy: { executionTime: 'asc' },
        select: { id: true, contractAddress: true, title: true, executionTime: true, status: true },
      }),
    ]);

    res.json({ from, to, scheduledOperations: ops, vestingUnlocks: vestings, governanceExecutions: timelocks });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ── GET /schedule/calendar.ics ────────────────────────────────────────────────
// iCal export

/**
 * @swagger
 * /api/v1/schedule/calendar.ics:
 *   get:
 *     summary: Export upcoming operations as an iCalendar file
 *     description: Scheduled operations for the next 90 days (max 500) as a downloadable text/calendar (.ics) attachment.
 *     tags: [Schedule]
 *     responses:
 *       200:
 *         description: iCalendar file attachment (filename soroban-schedule.ics)
 *         content:
 *           text/calendar:
 *             schema: { type: string }
 *             example: |
 *               BEGIN:VCALENDAR
 *               VERSION:2.0
 *               PRODID:-//Soroban Explorer//Temporal Orchestrator//EN
 *               CALSCALE:GREGORIAN
 *               METHOD:PUBLISH
 *               BEGIN:VEVENT
 *               UID:clz9q1x4t0000s6h2schedop1@soroban-explorer
 *               DTSTART:20260619T072426Z
 *               DTEND:20260619T082426Z
 *               SUMMARY:[VESTING] release @ CALLD5GH
 *               DESCRIPTION:Contract: CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5
 *               END:VEVENT
 *               END:VCALENDAR
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
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
      d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

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

/**
 * @swagger
 * /api/v1/schedule/operations/{opId}:
 *   get:
 *     summary: Get a scheduled operation by id
 *     tags: [Schedule]
 *     parameters:
 *       - in: path
 *         name: opId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: The scheduled operation
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ScheduledOperation' }
 *       404:
 *         description: Operation not found
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Operation not found' }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
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

/**
 * @swagger
 * /api/v1/schedule/discover:
 *   get:
 *     summary: Discover contracts with scheduled operations
 *     description: Top 50 contracts by scheduled-operation count.
 *     tags: [Schedule]
 *     responses:
 *       200:
 *         description: Contracts ranked by scheduled-operation count
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 contracts:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       contractAddress: { type: string, example: CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5 }
 *                       scheduledOperationCount: { type: integer, example: 27 }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
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

/**
 * @swagger
 * /api/v1/schedule/stats:
 *   get:
 *     summary: Platform-wide schedule statistics
 *     tags: [Schedule]
 *     responses:
 *       200:
 *         description: Aggregate counts plus the largest upcoming vesting unlocks
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 totalScheduledOps: { type: integer, example: 1543 }
 *                 pendingExecutions: { type: integer, example: 312 }
 *                 upcoming24h: { type: integer, example: 18 }
 *                 upcoming7d: { type: integer, example: 96 }
 *                 byType:
 *                   type: object
 *                   description: Operation counts keyed by lower-cased timer type
 *                   example: { vesting: 820, timelock: 410, recurring: 95 }
 *                 largeUnlocksUpcoming:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       contract: { type: string, example: CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5 }
 *                       token: { type: string, description: 'Token symbol, or UNKNOWN when unset', example: USDC }
 *                       amount: { type: string, description: 'Next-unlock amount as a string, or 0 when unset', example: '1000000000' }
 *                       date: { type: string, format: date, description: 'Unlock date (YYYY-MM-DD); omitted when nextUnlockDate is unset', example: '2026-06-19' }
 *                       beneficiary: { type: string, example: GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI }
 *                 expiredTimelocks: { type: integer, example: 7 }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
scheduleRouter.get('/stats', async (_req: Request, res: Response) => {
  try {
    const now = new Date();
    const in24h = new Date(now.getTime() + 24 * 3600 * 1000);
    const in7d = new Date(now.getTime() + 7 * 24 * 3600 * 1000);

    const [totalScheduledOps, pendingExecutions, upcoming24h, upcoming7d, byTypeRaw, expiredTimelocks, largeUnlocks] =
      await Promise.all([
        prisma.scheduledOperation.count(),
        prisma.scheduledOperation.count({ where: { status: { in: ['PENDING', 'ACTIVE'] } } }),
        prisma.scheduledOperation.count({ where: { status: { in: ['PENDING', 'ACTIVE'] }, triggerTime: { lte: in24h } } }),
        prisma.scheduledOperation.count({ where: { status: { in: ['PENDING', 'ACTIVE'] }, triggerTime: { lte: in7d } } }),
        prisma.scheduledOperation.groupBy({ by: ['timerType'], _count: { timerType: true } }),
        prisma.governanceTimelock.count({ where: { status: 'expired' } }),
        prisma.vestingSchedule.findMany({
          where: { status: 'active', nextUnlockDate: { lte: in7d } },
          orderBy: { nextUnlockAmount: 'desc' },
          take: 10,
          select: { contractAddress: true, tokenSymbol: true, nextUnlockAmount: true, nextUnlockDate: true, beneficiary: true },
        }),
      ]);

    const byType = Object.fromEntries(byTypeRaw.map((r) => [r.timerType.toLowerCase(), r._count.timerType]));

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

/**
 * @swagger
 * /api/v1/schedule/alerts:
 *   get:
 *     summary: List unacknowledged timer alerts
 *     tags: [Schedule]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
 *     responses:
 *       200:
 *         description: Paginated unacknowledged alerts
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/TimerAlert' }
 *                 total: { type: integer, example: 14 }
 *                 page: { type: integer, example: 1 }
 *                 limit: { type: integer, example: 20 }
 *       500:
 *         description: Server error. Invalid pagination also returns 500 (not 400) because query parsing runs inside the try block.
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
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

/**
 * @swagger
 * /api/v1/schedule/alerts/{id}/acknowledge:
 *   post:
 *     summary: Acknowledge a timer alert
 *     tags: [Schedule]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: The updated (acknowledged) alert
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/TimerAlert' }
 *       404:
 *         description: Alert not found
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Alert not found' }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
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

/**
 * @swagger
 * /api/v1/schedule/search:
 *   get:
 *     summary: Search scheduled operations
 *     description: Case-insensitive substring search across contract address, function name, and description, with optional type/status filters.
 *     tags: [Schedule]
 *     parameters:
 *       - in: query
 *         name: q
 *         schema: { type: string }
 *         description: Substring matched against contractAddress, functionName, and description
 *       - in: query
 *         name: type
 *         schema: { type: string }
 *         description: Timer type filter (upper-cased before matching), e.g. VESTING
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *         description: Timer status filter (upper-cased before matching), e.g. PENDING
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
 *     responses:
 *       200:
 *         description: Paginated matching operations
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/ScheduledOperation' }
 *                 total: { type: integer, example: 17 }
 *                 page: { type: integer, example: 1 }
 *                 limit: { type: integer, example: 20 }
 *       400:
 *         description: Invalid query parameters
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'ZodError: limit must be less than or equal to 100' }
 */
scheduleRouter.get('/search', async (req: Request, res: Response) => {
  try {
    const q = z.object({
      q: z.string().optional(),
      type: z.string().optional(),
      status: z.string().optional(),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20),
    }).parse(req.query);

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
      prisma.scheduledOperation.findMany({ where, orderBy: { triggerTime: 'asc' }, skip, take: q.limit }),
      prisma.scheduledOperation.count({ where }),
    ]);

    res.json({ data, total, page: q.page, limit: q.limit });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ── GET /schedule/vesting/large-unlocks ──────────────────────────────────────

/**
 * @swagger
 * /api/v1/schedule/vesting/large-unlocks:
 *   get:
 *     summary: Large upcoming vesting unlocks
 *     description: Active vesting schedules unlocking within the next N days above a minimum amount, ordered by unlock amount descending (capped at 100).
 *     tags: [Schedule]
 *     parameters:
 *       - in: query
 *         name: days
 *         schema: { type: integer, minimum: 1, maximum: 365, default: 7 }
 *         description: Look-ahead window in days
 *       - in: query
 *         name: minAmount
 *         schema: { type: number, default: 10000 }
 *         description: Minimum next-unlock amount threshold
 *     responses:
 *       200:
 *         description: Matching large unlocks
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/VestingSchedule' }
 *                 total: { type: integer, example: 6 }
 *       400:
 *         description: Invalid query parameters
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'ZodError: days must be less than or equal to 365' }
 */
scheduleRouter.get('/vesting/large-unlocks', async (req: Request, res: Response) => {
  try {
    const q = z.object({
      days: z.coerce.number().int().min(1).max(365).default(7),
      minAmount: z.coerce.number().default(10000),
    }).parse(req.query);

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

/**
 * @swagger
 * /api/v1/schedule/vesting/{beneficiaryAddress}:
 *   get:
 *     summary: List vesting schedules for a beneficiary
 *     description: Vesting schedules where the given address is the beneficiary. This route does not run Stellar-address validation middleware.
 *     tags: [Schedule]
 *     parameters:
 *       - in: path
 *         name: beneficiaryAddress
 *         required: true
 *         schema: { type: string }
 *         description: Beneficiary account address
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
 *     responses:
 *       200:
 *         description: Paginated vesting schedules for the beneficiary
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/VestingSchedule' }
 *                 total: { type: integer, example: 4 }
 *                 page: { type: integer, example: 1 }
 *                 limit: { type: integer, example: 20 }
 *       400:
 *         description: Invalid query parameters
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'ZodError: page must be greater than or equal to 1' }
 */
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

/**
 * @swagger
 * /api/v1/schedule/vesting/leaderboard:
 *   get:
 *     summary: Top upcoming vesting unlocks across all beneficiaries
 *     description: Up to 20 active schedules unlocking within the next 30 days, ordered by next-unlock amount descending.
 *     tags: [Schedule]
 *     responses:
 *       200:
 *         description: Leaderboard entries (subset of each vesting schedule's fields)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       beneficiary: { type: string, example: GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI }
 *                       tokenSymbol: { type: string, nullable: true, example: USDC }
 *                       nextUnlockAmount: { type: string, nullable: true, description: 'Decimal serialised as a string', example: '1000000000' }
 *                       nextUnlockDate: { type: string, format: date-time, nullable: true, example: '2026-06-19T07:24:26.000Z' }
 *                       contractAddress: { type: string, example: CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5 }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
scheduleRouter.get('/vesting/leaderboard', async (_req: Request, res: Response) => {
  try {
    const until = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    const top = await prisma.vestingSchedule.findMany({
      where: { status: 'active', nextUnlockDate: { lte: until } },
      orderBy: { nextUnlockAmount: 'desc' },
      take: 20,
      select: { beneficiary: true, tokenSymbol: true, nextUnlockAmount: true, nextUnlockDate: true, contractAddress: true },
    });
    res.json({ data: top });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /schedule/governance/pending ─────────────────────────────────────────

/**
 * @swagger
 * /api/v1/schedule/governance/pending:
 *   get:
 *     summary: List pending (queued or executable) governance timelocks
 *     description: Each entry is augmented with countdown fields computed at request time.
 *     tags: [Schedule]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
 *     responses:
 *       200:
 *         description: Paginated pending timelocks with countdown fields
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     allOf:
 *                       - $ref: '#/components/schemas/GovernanceTimelock'
 *                       - type: object
 *                         properties:
 *                           secondsUntilExecution: { type: integer, description: 'Seconds until executionTime (0 if already elapsed)', example: 43200 }
 *                           gracePeriodRemaining: { type: integer, nullable: true, description: 'Seconds until expiryTime (0 if elapsed), or null when expiryTime is unset', example: 86400 }
 *                 total: { type: integer, example: 5 }
 *                 page: { type: integer, example: 1 }
 *                 limit: { type: integer, example: 20 }
 *       500:
 *         description: Server error. Invalid pagination also returns 500 (not 400) because query parsing runs inside the try block.
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
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
        secondsUntilExecution: Math.max(0, Math.floor((t.executionTime.getTime() - now.getTime()) / 1000)),
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

/**
 * @swagger
 * /api/v1/schedule/governance/expired:
 *   get:
 *     summary: List expired governance timelocks
 *     tags: [Schedule]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
 *     responses:
 *       200:
 *         description: Paginated expired timelocks
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/GovernanceTimelock' }
 *                 total: { type: integer, example: 9 }
 *                 page: { type: integer, example: 1 }
 *                 limit: { type: integer, example: 20 }
 *       500:
 *         description: Server error. Invalid pagination also returns 500 (not 400) because query parsing runs inside the try block.
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
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

/**
 * @swagger
 * /api/v1/schedule/governance/stats:
 *   get:
 *     summary: Governance timelock statistics
 *     tags: [Schedule]
 *     responses:
 *       200:
 *         description: Status counts plus average delay and execution utilization
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 total: { type: integer, example: 120 }
 *                 queued: { type: integer, example: 12 }
 *                 executable: { type: integer, example: 5 }
 *                 executed: { type: integer, example: 88 }
 *                 expired: { type: integer, example: 9 }
 *                 cancelled: { type: integer, example: 6 }
 *                 avgDelaySeconds: { type: number, description: 'Average minDelay across all timelocks (0 when none)', example: 172800 }
 *                 utilizationRate: { type: number, description: 'executed / total (0 when none)', example: 0.733 }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
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

/**
 * @swagger
 * /api/v1/schedule/cron:
 *   post:
 *     summary: Create a cron job
 *     tags: [Schedule]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [contract, cronExpression, function]
 *             properties:
 *               contract: { type: string, description: 'Target contract address (stored as contractAddress)', example: CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5 }
 *               cronExpression: { type: string, example: '0 0 * * *' }
 *               function: { type: string, description: 'Function to invoke (stored as functionName)', example: distribute }
 *               args: { type: object, default: {}, description: 'Function arguments (stored as functionArgs)' }
 *               description: { type: string, example: 'Daily distribution' }
 *               maxRuns: { type: integer, minimum: 1, example: 30 }
 *               enabled: { type: boolean, default: true }
 *               createdBy: { type: string, example: clz9q1x4t0000s6h2apikey01 }
 *     responses:
 *       201:
 *         description: The created cron job
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/CronJob' }
 *       400:
 *         description: Invalid request body or an invalid cron expression
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Invalid cron expression' }
 */
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

/**
 * @swagger
 * /api/v1/schedule/cron/{id}:
 *   put:
 *     summary: Update a cron job
 *     description: All fields are optional; only supplied fields are changed. Supplying `cronExpression` recomputes the next run time.
 *     tags: [Schedule]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               contract: { type: string, example: CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5 }
 *               cronExpression: { type: string, example: '0 0,6,12,18 * * *' }
 *               function: { type: string, example: distribute }
 *               args: { type: object }
 *               description: { type: string, example: 'Every 6 hours' }
 *               maxRuns: { type: integer, minimum: 1, example: 100 }
 *               enabled: { type: boolean }
 *               createdBy: { type: string }
 *     responses:
 *       200:
 *         description: The updated cron job
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/CronJob' }
 *       400:
 *         description: Invalid request body or an invalid cron expression
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Invalid cron expression' }
 *       404:
 *         description: Cron job not found
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Cron job not found' }
 */
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
        ...(body.cronExpression && { cronExpression: body.cronExpression, nextRunAt: nextCronDate(body.cronExpression) }),
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

/**
 * @swagger
 * /api/v1/schedule/cron/{id}:
 *   delete:
 *     summary: Delete a cron job
 *     description: Removes the cron job and its execution history.
 *     tags: [Schedule]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: The cron job was deleted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 deleted: { type: boolean, example: true }
 *       404:
 *         description: Cron job not found
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Cron job not found' }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
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

/**
 * @swagger
 * /api/v1/schedule/cron/{id}/trigger:
 *   post:
 *     summary: Manually trigger a cron job
 *     description: Records a successful manual execution and bumps the job's run counters.
 *     tags: [Schedule]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: The recorded execution
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 triggered: { type: boolean, example: true }
 *                 execution: { $ref: '#/components/schemas/CronExecution' }
 *       404:
 *         description: Cron job not found
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Cron job not found' }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
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
      data: { lastRunAt: new Date(), totalRuns: { increment: 1 }, successfulRuns: { increment: 1 } },
    });

    res.json({ triggered: true, execution: exec });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /schedule/cron/:id/history ───────────────────────────────────────────

/**
 * @swagger
 * /api/v1/schedule/cron/{id}/history:
 *   get:
 *     summary: List a cron job's execution history
 *     tags: [Schedule]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
 *     responses:
 *       200:
 *         description: Paginated execution history (newest first)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/CronExecution' }
 *                 total: { type: integer, example: 42 }
 *                 page: { type: integer, example: 1 }
 *                 limit: { type: integer, example: 20 }
 *       404:
 *         description: Cron job not found
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Cron job not found' }
 *       500:
 *         description: Server error. Invalid pagination also returns 500 (not 400) because query parsing runs inside the try block.
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
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

/**
 * @swagger
 * /api/v1/schedule/cron/{id}/toggle:
 *   patch:
 *     summary: Toggle a cron job's enabled flag
 *     tags: [Schedule]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: The updated cron job (enabled flipped)
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/CronJob' }
 *       404:
 *         description: Cron job not found
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Cron job not found' }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
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

/**
 * @swagger
 * /api/v1/schedule/health:
 *   get:
 *     summary: Scheduler health metrics
 *     tags: [Schedule]
 *     responses:
 *       200:
 *         description: Active/stalled timer counts, cron success rate, and failing jobs
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 activeTimers: { type: integer, example: 128 }
 *                 stalledTimers: { type: integer, description: 'PENDING operations whose nextTriggerAt is in the past', example: 3 }
 *                 expiredTimelocks: { type: integer, example: 7 }
 *                 cronSuccessRate7d: { type: number, description: 'Successful / total cron executions over the last 7 days (1 when none)', example: 0.98 }
 *                 avgExecutionDelayMs: { type: number, description: 'Average cron execution duration over the last 7 days (ms)', example: 240.5 }
 *                 failedCronJobs:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string, example: clz9q1x4t0000s6h2cronjob1 }
 *                       contractAddress: { type: string, example: CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5 }
 *                       failedRuns: { type: integer, example: 4 }
 *                       functionName: { type: string, example: distribute }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               allOf: [{ $ref: '#/components/schemas/Error' }]
 *               example: { error: 'Database connection failed' }
 */
scheduleRouter.get('/health', async (_req: Request, res: Response) => {
  try {
    const now = new Date();
    const week = new Date(now.getTime() - 7 * 24 * 3600 * 1000);

    const [activeOps, stalledOps, expiredTimelocks, recentExec, failedJobs] = await Promise.all([
      prisma.scheduledOperation.count({ where: { status: 'ACTIVE' } }),
      prisma.scheduledOperation.count({ where: { status: 'PENDING', nextTriggerAt: { lt: now } } }),
      prisma.governanceTimelock.count({ where: { status: 'expired' } }),
      prisma.cronExecution.findMany({ where: { executedAt: { gte: week } }, select: { success: true, duration: true } }),
      prisma.cronJob.findMany({ where: { failedRuns: { gt: 0 } }, select: { id: true, contractAddress: true, failedRuns: true, functionName: true }, take: 10 }),
    ]);

    const totalExec = recentExec.length;
    const successExec = recentExec.filter((e) => e.success).length;
    const avgDuration = totalExec > 0 ? recentExec.reduce((s, e) => s + (e.duration ?? 0), 0) / totalExec : 0;

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
