/**
 * Contract License & Attribution Registry (VE08)
 *
 * Registers license and free-text attribution metadata for contracts and
 * exposes it for detail pages and search filtering.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireRole } from '../auth/middleware';

export const contractLicensesRouter = Router();

export const SPDX_LICENSES = [
  'MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'GPL-2.0-only', 'GPL-3.0-only',
  'LGPL-3.0-only', 'AGPL-3.0-only', 'MPL-2.0', 'ISC', 'Unlicense', 'CC0-1.0',
  'BUSL-1.1', 'PROPRIETARY', 'UNLICENSED',
] as const;

export interface LicenseRecord {
  contractId: string;
  license: (typeof SPDX_LICENSES)[number];
  attribution: string;
  sourceUrl?: string;
  registeredBy?: string;
  updatedAt: string;
}

const store = new Map<string, LicenseRecord>();

const contractIdSchema = z.string().regex(/^C[A-Z2-7]{55}$/, 'Invalid contract id');
const bodySchema = z.object({
  license: z.enum(SPDX_LICENSES),
  attribution: z.string().trim().max(1000).default(''),
  sourceUrl: z
    .string()
    .url()
    .max(500)
    .refine((u) => /^https:\/\//i.test(u), 'sourceUrl must be https')
    .optional(),
});

/** Projection used by contract detail pages and search results. */
export function getLicenseProjection(contractId: string) {
  const r = store.get(contractId);
  return r
    ? { license: r.license, attribution: r.attribution, sourceUrl: r.sourceUrl ?? null }
    : { license: null, attribution: null, sourceUrl: null };
}

/**
 * @swagger
 * /contracts/licenses:
 *   get:
 *     summary: Search registered contract licenses (?license=MIT&limit=20)
 *     tags: [Contract Licenses]
 *     responses:
 *       200:
 *         description: Matching license records
 */
contractLicensesRouter.get('/', (req: Request, res: Response) => {
  const license = typeof req.query.license === 'string' ? req.query.license : undefined;
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10) || 20));
  const items = [...store.values()].filter((r) => !license || r.license === license);
  res.json({ items: items.slice(0, limit), total: items.length, limit });
});

/**
 * @swagger
 * /contracts/licenses/{contractId}:
 *   get:
 *     summary: License and attribution for a contract
 *     tags: [Contract Licenses]
 *     responses:
 *       200:
 *         description: License projection
 *       404:
 *         description: Not registered
 */
contractLicensesRouter.get('/:contractId', (req: Request, res: Response) => {
  const id = contractIdSchema.safeParse(req.params.contractId);
  if (!id.success) return res.status(400).json({ error: 'Invalid contract id' });
  const record = store.get(id.data);
  if (!record) return res.status(404).json({ error: 'No license registered' });
  res.json(record);
});

/**
 * @swagger
 * /contracts/licenses/{contractId}:
 *   put:
 *     summary: Register or update license metadata (authenticated)
 *     tags: [Contract Licenses]
 *     responses:
 *       200:
 *         description: Stored record
 */
contractLicensesRouter.put('/:contractId', requireRole('developer'), (req: Request, res: Response) => {
  const id = contractIdSchema.safeParse(req.params.contractId);
  const body = bodySchema.safeParse(req.body);
  if (!id.success || !body.success) {
    return res.status(400).json({
      error: 'Invalid request',
      details: [...(id.success ? [] : id.error.issues), ...(body.success ? [] : body.error.issues)],
    });
  }
  const record: LicenseRecord = {
    contractId: id.data,
    ...body.data,
    registeredBy: req.user?.address,
    updatedAt: new Date().toISOString(),
  };
  store.set(id.data, record);
  res.json(record);
});
