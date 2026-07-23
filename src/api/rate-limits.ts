import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { prismaWrite } from '../db';
import { clearRateLimitOverrideCache } from '../middleware/rateLimit';
import { asyncHandler } from '../middleware/asyncHandler';

const rateLimitOverrideSchema = z.object({
  identifier: z.string().min(1).max(128),
  endpoint: z.string().min(1).max(256).optional().default('/'),
  max: z.number().int().positive().max(100_000),
  windowMs: z.number().int().positive().max(86_400_000),
});

export const rateLimitAdminRouter = Router();

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
      console.error('Failed to save rate limit override', error);
      return res.status(500).json({ error: 'Unable to save rate limit override' });
    }
  }),
);
