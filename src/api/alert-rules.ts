/**
 * /alert-rules — central suspicious activity alert service API.
 *
 *   GET    /alert-rules/rules    — registered rule registry + defaults
 *   GET    /alert-rules/config   — resolved config for the calling tenant
 *   PUT    /alert-rules/config   — enable/disable rules, tune cooldowns, add webhooks
 *   DELETE /alert-rules/config   — reset the tenant back to defaults
 *   GET    /alert-rules/recent   — recent alerts for the calling tenant
 *   GET    /alert-rules/inbox    — in-app inbox for the calling tenant
 *   GET    /alert-rules/stats    — engine stats (window size, sinks, tenants)
 *   POST   /alert-rules/ingest   — evaluate indexed activity (API key required)
 *
 * Tenant identity is the API key id, falling back to the developer id and then
 * the `x-user-id` header. Requests without any identity share the `default`
 * tenant, so per-tenant defaults still apply.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';
import { requireApiKey } from '../middleware/apiKeyAuth';
import {
  ALERT_SEVERITIES,
  getSuspiciousActivityAlertService,
  type TenantAlertConfigInput,
} from '../services/suspiciousActivityAlerts';

export const alertRulesRouter = Router();

const service = getSuspiciousActivityAlertService();

function resolveTenant(req: Request): string {
  return (
    req.apiKey?.id ??
    req.apiKey?.developerId ??
    (req.headers['x-user-id'] as string | undefined) ??
    'default'
  );
}

const severitySchema = z.enum(['low', 'medium', 'high', 'critical']);

const ruleOverrideSchema = z.object({
  enabled: z.boolean().optional(),
  cooldownMs: z.number().int().min(0).max(86_400_000).optional(),
  minSeverity: severitySchema.optional(),
});

const configSchema = z.object({
  rules: z
    .object({
      rapid_value_movement: ruleOverrideSchema.optional(),
      unusual_approval: ruleOverrideSchema.optional(),
      wash_trading: ruleOverrideSchema.optional(),
      velocity_anomaly: ruleOverrideSchema.optional(),
    })
    .optional(),
  webhookUrls: z.array(z.string().url()).max(10).optional(),
  webhookSecret: z.string().min(8).max(256).optional(),
});

const activitySchema = z.object({
  id: z.string().optional(),
  kind: z.enum(['transaction', 'event']).optional(),
  transactionHash: z.string().optional(),
  contractAddress: z.string().optional(),
  sourceAccount: z.string().optional(),
  destinationAccount: z.string().optional(),
  eventType: z.string().optional(),
  topicSymbol: z.string().optional(),
  asset: z.string().optional(),
  amount: z.number().optional(),
  spender: z.string().optional(),
  ledgerSequence: z.number().int().optional(),
  timestamp: z.union([z.string(), z.number()]).optional(),
  decoded: z.record(z.unknown()).optional(),
});

const ingestSchema = z.object({
  activities: z.array(activitySchema).min(1).max(500),
});

// GET /rules — registry metadata (public)
alertRulesRouter.get('/rules', (_req: Request, res: Response) => {
  res.json({ rules: service.listRules(), severities: ALERT_SEVERITIES });
});

// GET /stats — engine stats (public read-only)
alertRulesRouter.get('/stats', (_req: Request, res: Response) => {
  res.json(service.stats());
});

// GET /config — resolved per-tenant configuration
alertRulesRouter.get('/config', (req: Request, res: Response) => {
  const tenantId = resolveTenant(req);
  res.json(service.getTenantConfig(tenantId));
});

// PUT /config — update per-tenant overrides
alertRulesRouter.put(
  '/config',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = configSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Invalid alert rule configuration', details: parsed.error.flatten() });
    }

    const tenantId = resolveTenant(req);
    const updated = service.setTenantConfig(tenantId, parsed.data as TenantAlertConfigInput);
    return res.json(updated);
  }),
);

// DELETE /config — restore defaults for the tenant
alertRulesRouter.delete('/config', (req: Request, res: Response) => {
  const tenantId = resolveTenant(req);
  res.json(service.resetTenantConfig(tenantId));
});

// GET /recent — recent alerts for the tenant
alertRulesRouter.get('/recent', (req: Request, res: Response) => {
  const limit = Math.min(200, parseInt((req.query.limit as string) ?? '50', 10) || 50);
  const tenantId = resolveTenant(req);
  res.json({ tenantId, alerts: service.getRecentAlerts(limit, tenantId) });
});

// GET /inbox — in-app notification inbox for the tenant
alertRulesRouter.get('/inbox', (req: Request, res: Response) => {
  const limit = Math.min(200, parseInt((req.query.limit as string) ?? '50', 10) || 50);
  const tenantId = resolveTenant(req);
  res.json({ tenantId, alerts: service.getInbox(tenantId, limit) });
});

// POST /ingest — feed indexed activity into the engine
alertRulesRouter.post(
  '/ingest',
  requireApiKey,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = ingestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Invalid activity payload', details: parsed.error.flatten() });
    }

    const tenantId = resolveTenant(req);
    const emitted = await service.ingest(parsed.data.activities, tenantId);
    return res.status(202).json({ tenantId, evaluated: parsed.data.activities.length, emitted });
  }),
);
