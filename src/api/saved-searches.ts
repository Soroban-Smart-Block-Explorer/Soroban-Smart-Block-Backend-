/**
 * Saved Search API
 *
 * Authenticated CRUD for saved searches plus an on-demand matcher trigger.
 * A saved search persists a target family ("contract" | "event") and criteria;
 * the indexer runner (src/indexer/savedSearchRunner.ts) periodically matches
 * newly indexed rows against it and delivers notifications over push + webhook.
 *
 * Routes (mounted at /api/v1/saved-searches):
 *   - POST   /            create a saved search
 *   - GET    /            list the caller's saved searches
 *   - GET    /:id         fetch one
 *   - PUT    /:id         update name/criteria/notify/isActive
 *   - DELETE /:id         delete one
 *   - POST   /:id/run     evaluate now against newly indexed data
 *
 * Every route is scoped to the authenticated user (`requireAuth`) and the
 * router is rate-limited per IP, mirroring the admin feature-flag router.
 */

import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { Prisma } from '@prisma/client';
import { requireAuth } from '../auth/middleware';
import { asyncHandler } from '../middleware/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { config } from '../config';
import { prismaRead, prismaWrite } from '../db';
import { toSavedSearchRecord } from '../notifications/savedSearchMatcher';
import { runSavedSearch } from '../indexer/savedSearchRunner';

export const savedSearchesRouter = Router();

// Explicit limiter, matching the admin routers: the global tieredRateLimit in
// app.ts also applies, but CodeQL's js/missing-rate-limiting query only
// recognizes a limiter attached directly to the route handlers.
savedSearchesRouter.use(
  rateLimit({
    windowMs: config.rateLimitWindowMs,
    max: config.rateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ error: 'Rate limit exceeded' });
    },
  }),
);

savedSearchesRouter.use(requireAuth);

const criteriaSchema = z
  .object({
    contractAddress: z.string().min(1).optional(),
    eventType: z.string().min(1).optional(),
    topicSymbol: z.string().min(1).optional(),
    nameContains: z.string().min(1).optional(),
    isToken: z.boolean().optional(),
    isVerified: z.boolean().optional(),
    minSafetyScore: z.number().int().min(0).max(100).optional(),
  })
  .passthrough();

const notifySchema = z
  .object({
    webhookUrl: z.string().url().optional(),
    slack: z.boolean().optional(),
    push: z.boolean().optional(),
  })
  .passthrough();

const createSchema = z.object({
  name: z.string().min(1).max(120),
  targetType: z.enum(['contract', 'event']),
  criteria: criteriaSchema.default({}),
  notify: notifySchema.default({}),
});

const updateSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    targetType: z.enum(['contract', 'event']).optional(),
    criteria: criteriaSchema.optional(),
    notify: notifySchema.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update',
  });

/** Load a saved search owned by the caller, or 404 (never leak existence). */
async function findOwnedSearch(id: string, userId: string) {
  const search = await prismaRead.savedSearch.findFirst({ where: { id, userId } });
  if (!search) throw new AppError(404, 'Saved search not found');
  return search;
}

// POST /api/v1/saved-searches
savedSearchesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' });
    }
    const created = await prismaWrite.savedSearch.create({
      data: {
        userId: req.user!.id,
        name: parsed.data.name,
        targetType: parsed.data.targetType,
        criteria: parsed.data.criteria as Prisma.InputJsonValue,
        notify: parsed.data.notify as Prisma.InputJsonValue,
      },
    });
    res.status(201).json({ savedSearch: created });
  }),
);

// GET /api/v1/saved-searches
savedSearchesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const activeOnly = req.query.active === 'true';
    const searches = await prismaRead.savedSearch.findMany({
      where: { userId: req.user!.id, ...(activeOnly ? { isActive: true } : {}) },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ savedSearches: searches });
  }),
);

// GET /api/v1/saved-searches/:id
savedSearchesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const search = await findOwnedSearch(req.params.id, req.user!.id);
    res.json({ savedSearch: search });
  }),
);

// PUT /api/v1/saved-searches/:id
savedSearchesRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await findOwnedSearch(req.params.id, req.user!.id);
    const parsed = updateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' });
    }
    // `criteria` / `notify` arrive as zod passthrough objects; narrow them to
    // Prisma's JSON input type (same cast used elsewhere, e.g. src/api/tip.ts).
    const { criteria, notify, ...rest } = parsed.data;
    const updated = await prismaWrite.savedSearch.update({
      where: { id: existing.id },
      data: {
        ...rest,
        ...(criteria !== undefined ? { criteria: criteria as Prisma.InputJsonValue } : {}),
        ...(notify !== undefined ? { notify: notify as Prisma.InputJsonValue } : {}),
      },
    });
    res.json({ savedSearch: updated });
  }),
);

// DELETE /api/v1/saved-searches/:id
savedSearchesRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await findOwnedSearch(req.params.id, req.user!.id);
    await prismaWrite.savedSearch.delete({ where: { id: existing.id } });
    res.status(204).send();
  }),
);

// POST /api/v1/saved-searches/:id/run — evaluate now against newly indexed data
savedSearchesRouter.post(
  '/:id/run',
  asyncHandler(async (req, res) => {
    const existing = await findOwnedSearch(req.params.id, req.user!.id);
    const matches = await runSavedSearch(toSavedSearchRecord(existing));
    res.json({ matched: matches.length, matches });
  }),
);
