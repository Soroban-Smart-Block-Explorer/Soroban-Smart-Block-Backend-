/**
 * Token Accreditation & Risk Labeling API (VE07)
 *
 * Serves regulatory-ready labels for tokens: accredited categories, transfer
 * restrictions and known counterparty risks. Every label carries an
 * explainable reason and the compliance module that sourced it. Results are
 * cached.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { cacheGet, cacheSet, buildCacheKey } from '../cache';
import { requireRole } from '../auth/middleware';

export const tokenLabelsRouter = Router();

export const LABEL_KINDS = ['accreditation', 'transfer_restriction', 'counterparty_risk'] as const;
export const LABEL_SOURCES = ['rwa-compliance', 'commodity-compliance', 'compliance', 'tokens'] as const;
export const LABEL_SEVERITIES = ['info', 'low', 'medium', 'high'] as const;

export type LabelKind = (typeof LABEL_KINDS)[number];

export interface TokenLabel {
  kind: LabelKind;
  code: string;
  severity: (typeof LABEL_SEVERITIES)[number];
  source: (typeof LABEL_SOURCES)[number];
  reason: string;
  updatedAt: string;
}

const CACHE_TTL_SECONDS = 60;
const MAX_LABELS_PER_TOKEN = 50;
const labelStore = new Map<string, TokenLabel[]>();

const idSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9:_-]+$/);

const labelSchema = z.object({
  kind: z.enum(LABEL_KINDS),
  code: z.string().trim().min(1).max(64),
  severity: z.enum(LABEL_SEVERITIES),
  source: z.enum(LABEL_SOURCES),
  reason: z.string().trim().min(1).max(500),
});

const cacheKey = (id: string) => buildCacheKey('token-labels', id);

/** Reduce a label set to an overall risk level (highest severity wins). */
export function summarizeLabels(labels: TokenLabel[]) {
  const rank = { info: 0, low: 1, medium: 2, high: 3 } as const;
  const overallRisk = labels.reduce<keyof typeof rank>(
    (max, l) => (rank[l.severity] > rank[max] ? l.severity : max),
    'info',
  );
  return {
    overallRisk,
    accredited: labels.some((l) => l.kind === 'accreditation'),
    restricted: labels.some((l) => l.kind === 'transfer_restriction'),
    counterpartyRisk: labels.some((l) => l.kind === 'counterparty_risk'),
  };
}

/**
 * @swagger
 * /compliance/token-labels/{tokenId}:
 *   get:
 *     summary: Accreditation and risk labels for a token, with reasons
 *     tags: [Token Labels]
 *     responses:
 *       200:
 *         description: Labels and summary
 *       400:
 *         description: Invalid token id
 */
tokenLabelsRouter.get('/:tokenId', async (req: Request, res: Response) => {
  const id = idSchema.safeParse(req.params.tokenId);
  if (!id.success) return res.status(400).json({ error: 'Invalid token id' });

  const cached = await cacheGet<object>(cacheKey(id.data)).catch(() => null);
  if (cached) return res.json({ ...cached, cached: true });

  const labels = labelStore.get(id.data) ?? [];
  const body = { tokenId: id.data, labels, summary: summarizeLabels(labels) };
  await cacheSet(cacheKey(id.data), body, CACHE_TTL_SECONDS).catch(() => undefined);
  res.json({ ...body, cached: false });
});

/**
 * @swagger
 * /compliance/token-labels/{tokenId}:
 *   put:
 *     summary: Upsert a label (admin). One label per kind+code+source.
 *     tags: [Token Labels]
 *     responses:
 *       200:
 *         description: Updated labels
 */
tokenLabelsRouter.put('/:tokenId', requireRole('admin'), async (req: Request, res: Response) => {
  const id = idSchema.safeParse(req.params.tokenId);
  const body = labelSchema.safeParse(req.body);
  if (!id.success || !body.success) {
    return res.status(400).json({ error: 'Invalid request', details: body.success ? undefined : body.error.issues });
  }
  const labels = labelStore.get(id.data) ?? [];
  const idx = labels.findIndex(
    (l) => l.kind === body.data.kind && l.code === body.data.code && l.source === body.data.source,
  );
  const label: TokenLabel = { ...body.data, updatedAt: new Date().toISOString() };
  if (idx >= 0) labels[idx] = label;
  else if (labels.length >= MAX_LABELS_PER_TOKEN) {
    return res.status(409).json({ error: 'Label limit reached for token' });
  } else labels.push(label);
  labelStore.set(id.data, labels);
  await cacheSet(cacheKey(id.data), null, 1).catch(() => undefined);
  res.json({ tokenId: id.data, labels });
});
