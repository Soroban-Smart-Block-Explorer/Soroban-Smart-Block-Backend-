/**
 * Freeze API Router
 *
 * Account and asset freeze management for Stellar. Handles regulatory
 * freeze orders, emergency asset lockdowns, and frozen account queries
 * for compliance and risk management.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prismaWrite as prisma } from '../db';
import { invalidateFreezeCache } from '../indexer/freeze-scanner';

export const freezeRouter = Router();

// Middleware to mock admin auth if needed
const adminAuth = (req: Request, res: Response, next: any) => {
  const actor = req.headers['x-admin-token'] || req.headers['x-actor'];
  if (!actor) {
    return res.status(401).json({ error: 'Unauthorized: admin token required' });
  }
  req.actor = typeof actor === 'string' ? actor : String(actor);
  next();
};

const getActor = (req: Request) => req.actor ?? 'unknown';

async function logAudit(
  actor: string,
  action: string,
  target: string,
  previousState: any,
  newState: any,
  reason?: string,
) {
  await prisma.auditLog.create({
    data: {
      actor,
      action,
      target,
      previousState: previousState ? JSON.stringify(previousState) : undefined,
      newState: newState ? JSON.stringify(newState) : undefined,
      reason,
    },
  });
}

// ── GET /keys ─────────────────────────────────────────────────────────────────
freezeRouter.get('/keys', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(200, parseInt((req.query.limit as string) ?? '50', 10));
    const offset = parseInt((req.query.offset as string) ?? '0', 10);
    const active = req.query.active !== undefined ? req.query.active === 'true' : undefined;
    const contractAddress = req.query.contractAddress as string;

    const where: any = {};
    if (active !== undefined) where.active = active;
    if (contractAddress) where.contractAddress = contractAddress;

    const keys = await prisma.frozenLedgerKey.findMany({
      where,
      take: limit,
      skip: offset,
      orderBy: { createdAt: 'desc' },
    });

    const total = await prisma.frozenLedgerKey.count({ where });

    res.json({ data: keys, total, limit, offset });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ── GET /keys/:id ─────────────────────────────────────────────────────────────
freezeRouter.get('/keys/:id', async (req: Request, res: Response) => {
  try {
    const key = await prisma.frozenLedgerKey.findUnique({
      where: { id: req.params.id },
    });
    if (!key) return res.status(404).json({ error: 'Key not found' });
    res.json(key);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ── POST /keys ────────────────────────────────────────────────────────────────
freezeRouter.post('/keys', adminAuth, async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      ledgerKey: z.string(),
      contractAddress: z.string().optional(),
      reason: z.string().optional(),
      metadata: z.record(z.any()).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const actor = getActor(req);
    const { ledgerKey, contractAddress, reason, metadata } = parsed.data;

    // Default frozenAtLedger to current max or 0, this should ideally come from network
    const state = await prisma.indexerState.findUnique({ where: { id: 'singleton' } });
    const frozenAtLedger = state?.lastLedger || 0;

    const newKey = await prisma.frozenLedgerKey.create({
      data: {
        ledgerKey,
        contractAddress: contractAddress ?? '',
        active: true,
        frozenAtLedger,
        frozenAtTime: new Date(),
        reason,
      },
    });

    invalidateFreezeCache();
    await logAudit(actor, 'CREATE_FREEZE', newKey.id, null, newKey, reason);

    res.status(201).json(newKey);
  } catch (error: any) {
    if (error.code === 'P2002') return res.status(409).json({ error: 'Key already frozen' });
    res.status(500).json({ error: error.message });
  }
});

// ── PATCH /keys/:id ───────────────────────────────────────────────────────────
freezeRouter.patch('/keys/:id', adminAuth, async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      reason: z.string().optional(),
      active: z.boolean().optional(),
      metadata: z.record(z.any()).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const actor = getActor(req);

    const existing = await prisma.frozenLedgerKey.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Key not found' });

    const updated = await prisma.frozenLedgerKey.update({
      where: { id: req.params.id },
      data: parsed.data,
    });

    if (parsed.data.active !== undefined) {
      invalidateFreezeCache();
    }
    await logAudit(
      actor,
      'UPDATE_FREEZE',
      updated.id,
      existing,
      updated,
      parsed.data.reason || 'Update',
    );

    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ── DELETE /keys/:id ──────────────────────────────────────────────────────────
freezeRouter.delete('/keys/:id', adminAuth, async (req: Request, res: Response) => {
  try {
    const actor = getActor(req);
    const reason = req.body.reason || 'Manual delete';

    const existing = await prisma.frozenLedgerKey.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Key not found' });

    await prisma.frozenLedgerKey.delete({ where: { id: req.params.id } });

    invalidateFreezeCache();
    await logAudit(actor, 'DELETE_FREEZE', req.params.id, existing, null, reason);

    res.json({ message: 'Deleted successfully' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ── GET /violations ───────────────────────────────────────────────────────────
freezeRouter.get('/violations', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(200, parseInt((req.query.limit as string) ?? '50', 10));
    const offset = parseInt((req.query.offset as string) ?? '0', 10);
    const severity = req.query.severity as string;

    const where: any = {};
    if (severity) where.severity = severity;

    const violations = await prisma.freezeViolation.findMany({
      where,
      take: limit,
      skip: offset,
      orderBy: { createdAt: 'desc' },
    });

    const total = await prisma.freezeViolation.count({ where });

    res.json({ data: violations, total, limit, offset });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ── GET /violations/:id ───────────────────────────────────────────────────────
freezeRouter.get('/violations/:id', async (req: Request, res: Response) => {
  try {
    const violation = await prisma.freezeViolation.findUnique({
      where: { id: req.params.id },
    });
    if (!violation) return res.status(404).json({ error: 'Violation not found' });
    res.json(violation);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ── PATCH /violations/:id ─────────────────────────────────────────────────────
freezeRouter.patch('/violations/:id', adminAuth, async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      resolution: z.enum(['pending', 'resolved', 'false_positive']),
      severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
      reason: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const actor = getActor(req);

    const existing = await prisma.freezeViolation.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Violation not found' });

    const updated = await prisma.freezeViolation.update({
      where: { id: req.params.id },
      data: {
        resolution: parsed.data.resolution,
        ...(parsed.data.severity && { severity: parsed.data.severity }),
      },
    });

    await logAudit(
      actor,
      'RESOLVE_VIOLATION',
      updated.id,
      existing,
      updated,
      parsed.data.reason || 'Resolution updated',
    );

    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ── GET /stats ────────────────────────────────────────────────────────────────
freezeRouter.get('/stats', async (req: Request, res: Response) => {
  try {
    const [totalKeys, activeKeys, totalViolations, criticalViolations] = await Promise.all([
      prisma.frozenLedgerKey.count(),
      prisma.frozenLedgerKey.count({ where: { active: true } }),
      prisma.freezeViolation.count(),
      prisma.freezeViolation.count({ where: { severity: 'critical' } }),
    ]);

    res.json({
      totalKeys,
      activeKeys,
      totalViolations,
      criticalViolations,
      computedAt: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ── GET /audit-log ────────────────────────────────────────────────────────────
freezeRouter.get('/audit-log', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(200, parseInt((req.query.limit as string) ?? '50', 10));
    const offset = parseInt((req.query.offset as string) ?? '0', 10);
    const actor = req.query.actor as string;
    const action = req.query.action as string;

    const where: any = {};
    if (actor) where.actor = actor;
    if (action) where.action = action;

    const logs = await prisma.auditLog.findMany({
      where,
      take: limit,
      skip: offset,
      orderBy: { createdAt: 'desc' },
    });

    const total = await prisma.auditLog.count({ where });

    res.json({ data: logs, total, limit, offset });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});
