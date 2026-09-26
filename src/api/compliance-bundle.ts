/**
 * Consolidated compliance report bundle export (VE04).
 * GET /compliance/bundle?from=&to=&limit=&format=json|markdown
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';
import { sensitiveReadLog } from '../middleware/sensitiveReadLog';
import { buildComplianceBundle, renderBundleMarkdown } from '../exports/compliance-bundle';

export const complianceBundleRouter = Router();

complianceBundleRouter.use(sensitiveReadLog('compliance_bundle_read', (req) => req.path));

const querySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  format: z.enum(['json', 'markdown']).default('json'),
});

complianceBundleRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const { from, to, limit, format } = parsed.data;
    const bundle = await buildComplianceBundle({
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      limit,
    });
    if (format === 'markdown') {
      res.type('text/markdown').send(renderBundleMarkdown(bundle));
      return;
    }
    res.setHeader('X-Bundle-Schema-Version', bundle.schemaVersion);
    res.json(bundle);
  }),
);
