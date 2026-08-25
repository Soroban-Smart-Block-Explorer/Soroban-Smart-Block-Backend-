/**
 * Feature Flag Admin API
 *
 * Operator endpoints for the DB-backed feature-flag system at
 * /api/v1/admin/feature-flags. Supports:
 *   - listing all registered flags with resolved state
 *   - adjusting a flag's default toggle + gradual-rollout percentage
 *   - per-environment and per-developer overrides (runtime, no redeploy)
 *
 * All endpoints require authentication + the admin role (see requireRole in
 * auth/middleware), matching the other admin routers (e.g. admin/errors).
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../auth/middleware';
import { asyncHandler } from '../middleware/asyncHandler';
import { featureFlags } from '../feature-flags';
import { findFlagDefinition } from '../feature-flags/registry';

export const featureFlagsAdminRouter = Router();

featureFlagsAdminRouter.use(requireAuth);
featureFlagsAdminRouter.use(requireRole('admin'));

const FLAG_SCOPE_TYPES = ['environment', 'developer'] as const;
type FlagScopeType = (typeof FLAG_SCOPE_TYPES)[number];

function isRegisteredKey(key: string): boolean {
  return findFlagDefinition(key) !== undefined;
}

// GET /api/v1/admin/feature-flags — list all flags with resolved state
featureFlagsAdminRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const flags = await featureFlags.list();
    res.json({ flags });
  }),
);

// PUT /api/v1/admin/feature-flags/:key — update default toggle / rollout
const updateBodySchema = z
  .object({
    defaultEnabled: z.boolean().optional(),
    rolloutPercent: z.number().int().min(0).max(100).optional(),
    description: z.string().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'Provide at least one of defaultEnabled, rolloutPercent, or description',
  });

featureFlagsAdminRouter.put(
  '/:key',
  asyncHandler(async (req, res) => {
    const { key } = req.params;
    if (!isRegisteredKey(key)) {
      return res.status(404).json({ error: `Unknown feature flag: ${key}` });
    }
    const parsed = updateBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' });
    }
    const flag = await featureFlags.updateFlag(key, parsed.data);
    res.json({ flag });
  }),
);

// PUT /api/v1/admin/feature-flags/:key/overrides/:scopeType/:scopeValue
const overrideBodySchema = z.object({ enabled: z.boolean() });

featureFlagsAdminRouter.put(
  '/:key/overrides/:scopeType/:scopeValue',
  asyncHandler(async (req, res) => {
    const { key, scopeType, scopeValue } = req.params;
    if (!isRegisteredKey(key)) {
      return res.status(404).json({ error: `Unknown feature flag: ${key}` });
    }
    if (!FLAG_SCOPE_TYPES.includes(scopeType as FlagScopeType)) {
      return res
        .status(400)
        .json({ error: `scopeType must be one of: ${FLAG_SCOPE_TYPES.join(', ')}` });
    }
    if (!scopeValue) {
      return res.status(400).json({ error: 'scopeValue is required' });
    }
    const parsed = overrideBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    const flag = await featureFlags.setOverride(
      key,
      scopeType as FlagScopeType,
      scopeValue,
      parsed.data.enabled,
    );
    res.json({ flag });
  }),
);

// DELETE /api/v1/admin/feature-flags/:key/overrides/:scopeType/:scopeValue
featureFlagsAdminRouter.delete(
  '/:key/overrides/:scopeType/:scopeValue',
  asyncHandler(async (req, res) => {
    const { key, scopeType, scopeValue } = req.params;
    if (!isRegisteredKey(key)) {
      return res.status(404).json({ error: `Unknown feature flag: ${key}` });
    }
    if (!FLAG_SCOPE_TYPES.includes(scopeType as FlagScopeType)) {
      return res
        .status(400)
        .json({ error: `scopeType must be one of: ${FLAG_SCOPE_TYPES.join(', ')}` });
    }
    await featureFlags.clearOverride(key, scopeType as FlagScopeType, scopeValue);
    res.json({ ok: true });
  }),
);
