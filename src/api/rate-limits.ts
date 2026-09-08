import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { prismaWrite } from '../db';
import { prismaRead } from '../db';
import { clearRateLimitOverrideCache } from '../middleware/rateLimit';
import { asyncHandler } from '../middleware/asyncHandler';
import { adminAuth } from '../middleware/adminAuth';
import { logger } from '../logger';
import {
  setEnterpriseTierConfig,
  clearEnterpriseTierCache,
  ENTERPRISE_DEFAULTS,
  type EnterpriseTierConfig,
} from '../middleware/enterpriseTierCache';

// ── Zod schemas ───────────────────────────────────────────────────────────────

const rateLimitOverrideSchema = z.object({
  identifier: z.string().min(1).max(128),
  endpoint: z.string().min(1).max(256).optional().default('/'),
  max: z.number().int().positive().max(100_000),
  windowMs: z.number().int().positive().max(86_400_000),
});

const graceDegradationSchema = z.enum(['drop', 'queue', 'fallback']);

const enterpriseTierSchema = z.object({
  orgId: z.string().min(1).max(128),
  maxPerMinute: z.number().int().positive().max(10_000_000),
  maxBurst: z.number().int().positive().max(10_000_000),
  windowMs: z.number().int().positive().max(86_400_000).default(60_000),
  label: z.string().min(1).max(128),
  featureFlags: z.array(z.string().min(1).max(64)).default([]),
  graceDegradation: graceDegradationSchema.default('fallback'),
});

// ── Persistence helpers ───────────────────────────────────────────────────────

/**
 * Map a prisma row (stored as a RateLimitOverride with a structured identifier)
 * back to an EnterpriseTierConfig.  We store enterprise tiers in the existing
 * RateLimitOverride table using a dedicated identifier prefix `ent:<orgId>` and
 * a JSON-encoded endpoint field to carry the extra fields.
 */
function rowToTierConfig(row: {
  identifier: string;
  endpoint: string;
  max: number;
  windowMs: number;
}): { orgId: string; config: EnterpriseTierConfig } | null {
  try {
    const orgId = row.identifier.replace(/^ent:/, '');
    const meta: Partial<EnterpriseTierConfig> = JSON.parse(row.endpoint);
    const config: EnterpriseTierConfig = {
      maxPerMinute: row.max,
      maxBurst: meta.maxBurst ?? ENTERPRISE_DEFAULTS.maxBurst,
      windowMs: row.windowMs,
      label: meta.label ?? 'enterprise-custom',
      featureFlags: meta.featureFlags ?? [],
      graceDegradation: meta.graceDegradation ?? 'fallback',
    };
    return { orgId, config };
  } catch {
    return null;
  }
}

function tierConfigToRow(
  orgId: string,
  config: EnterpriseTierConfig,
): { identifier: string; endpoint: string; max: number; windowMs: number } {
  return {
    identifier: `ent:${orgId}`,
    endpoint: JSON.stringify({
      maxBurst: config.maxBurst,
      label: config.label,
      featureFlags: config.featureFlags,
      graceDegradation: config.graceDegradation,
    }),
    max: config.maxPerMinute,
    windowMs: config.windowMs,
  };
}

// ── Router ────────────────────────────────────────────────────────────────────

export const rateLimitAdminRouter = Router();

// ── Legacy override endpoint ──────────────────────────────────────────────────

rateLimitAdminRouter.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = rateLimitOverrideSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid rate limit override payload',
        details: parsed.error.flatten(),
      });
    }

    try {
      const override = await prismaWrite.rateLimitOverride.upsert({
        where: {
          identifier_endpoint: {
            identifier: parsed.data.identifier,
            endpoint: parsed.data.endpoint,
          },
        },
        update: { max: parsed.data.max, windowMs: parsed.data.windowMs },
        create: {
          identifier: parsed.data.identifier,
          endpoint: parsed.data.endpoint,
          max: parsed.data.max,
          windowMs: parsed.data.windowMs,
        },
      });

      clearRateLimitOverrideCache();

      return res.json({
        success: true,
        override: {
          identifier: override.identifier,
          endpoint: override.endpoint,
          max: override.max,
          windowMs: override.windowMs,
        },
      });
    } catch (error) {
      logger.error('Failed to save rate limit override', { error });
      return res.status(500).json({ error: 'Unable to save rate limit override' });
    }
  }),
);

// ── Enterprise tier routes ─────────────────────────────────────────────────────

/**
 * GET /enterprise-tiers
 * List all enterprise custom tiers stored in the database.
 * Requires admin auth.
 */
rateLimitAdminRouter.get(
  '/enterprise-tiers',
  adminAuth,
  asyncHandler(async (_req: Request, res: Response) => {
    try {
      const prisma = prismaRead as any;
      const rows = await prisma.rateLimitOverride.findMany({
        where: { identifier: { startsWith: 'ent:' } },
        orderBy: { createdAt: 'asc' },
      });

      const tiers = rows
        .map((row: { identifier: string; endpoint: string; max: number; windowMs: number }) =>
          rowToTierConfig(row),
        )
        .filter(
          (
            t: { orgId: string; config: EnterpriseTierConfig } | null,
          ): t is { orgId: string; config: EnterpriseTierConfig } => t !== null,
        )
        .map(({ orgId, config }: { orgId: string; config: EnterpriseTierConfig }) => ({
          orgId,
          ...config,
        }));

      return res.json({ success: true, tiers });
    } catch (error) {
      logger.error('[rate-limit] Failed to list enterprise tiers', { error });
      return res.status(500).json({ error: 'Unable to list enterprise tiers' });
    }
  }),
);

/**
 * POST /enterprise-tiers
 * Create or update the enterprise tier config for an org.
 * Requires admin auth.
 */
rateLimitAdminRouter.post(
  '/enterprise-tiers',
  adminAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = enterpriseTierSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid enterprise tier payload',
        details: parsed.error.flatten(),
      });
    }

    const { orgId, ...tierFields } = parsed.data;
    const config: EnterpriseTierConfig = tierFields;
    const row = tierConfigToRow(orgId, config);

    try {
      await prismaWrite.rateLimitOverride.upsert({
        where: {
          identifier_endpoint: {
            identifier: row.identifier,
            endpoint: row.endpoint,
          },
        },
        update: { max: row.max, windowMs: row.windowMs },
        create: {
          identifier: row.identifier,
          endpoint: row.endpoint,
          max: row.max,
          windowMs: row.windowMs,
        },
      });

      // Populate cache immediately so next request uses the new config.
      setEnterpriseTierConfig(orgId, config);
      clearEnterpriseTierCache(orgId); // invalidate then re-populate on next read

      logger.info('[rate-limit] Enterprise tier upserted', { orgId, label: config.label });

      return res.status(201).json({
        success: true,
        orgId,
        config,
      });
    } catch (error) {
      logger.error('[rate-limit] Failed to upsert enterprise tier', { orgId, error });
      return res.status(500).json({ error: 'Unable to save enterprise tier' });
    }
  }),
);

/**
 * GET /enterprise-tiers/:orgId
 * Retrieve the enterprise tier config for a specific org.
 * Requires admin auth.
 */
rateLimitAdminRouter.get(
  '/enterprise-tiers/:orgId',
  adminAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const { orgId } = req.params;
    if (!orgId) {
      return res.status(400).json({ error: 'orgId is required' });
    }

    try {
      const prisma = prismaRead as any;
      const rows = await prisma.rateLimitOverride.findMany({
        where: { identifier: `ent:${orgId}` },
      });

      if (!rows || rows.length === 0) {
        return res.status(404).json({
          error: 'No custom enterprise tier found for this org',
          orgId,
          defaults: ENTERPRISE_DEFAULTS,
        });
      }

      const parsedRow = rowToTierConfig(rows[0]);
      if (!parsedRow) {
        return res.status(500).json({ error: 'Corrupt enterprise tier record' });
      }

      return res.json({ success: true, orgId, config: parsedRow.config });
    } catch (error) {
      logger.error('[rate-limit] Failed to fetch enterprise tier', { orgId, error });
      return res.status(500).json({ error: 'Unable to fetch enterprise tier' });
    }
  }),
);

/**
 * DELETE /enterprise-tiers/:orgId
 * Delete the custom enterprise tier for an org, resetting it to standard
 * enterprise defaults.
 * Requires admin auth.
 */
rateLimitAdminRouter.delete(
  '/enterprise-tiers/:orgId',
  adminAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const { orgId } = req.params;
    if (!orgId) {
      return res.status(400).json({ error: 'orgId is required' });
    }

    try {
      const prisma = prismaWrite as any;
      // Delete all rows for this org (endpoint field varies by encoding).
      await prisma.rateLimitOverride.deleteMany({
        where: { identifier: `ent:${orgId}` },
      });

      clearEnterpriseTierCache(orgId);

      logger.info('[rate-limit] Enterprise tier deleted, reset to standard defaults', { orgId });

      return res.json({
        success: true,
        orgId,
        message: 'Custom enterprise tier removed. Org will use standard enterprise defaults.',
        defaults: ENTERPRISE_DEFAULTS,
      });
    } catch (error) {
      logger.error('[rate-limit] Failed to delete enterprise tier', { orgId, error });
      return res.status(500).json({ error: 'Unable to delete enterprise tier' });
    }
  }),
);
