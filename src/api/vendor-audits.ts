/**
 * Third-Party Audit & Vendor Report Ingestion (VE09)
 *
 * Admins onboard audit vendors; verified vendors publish report metadata
 * (scope, verdict, link) against contracts. Reports start in `pending` review
 * and only `approved` reports are displayed publicly alongside built-in analyses.
 */
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'crypto';
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireRole } from '../auth/middleware';

export const vendorAuditsRouter = Router();

export type ReviewState = 'pending' | 'approved' | 'rejected';

interface Vendor { id: string; name: string; website: string; keyHash: string; createdAt: string }
export interface VendorReport {
  id: string;
  vendorId: string;
  contractId: string;
  scope: string;
  verdict: 'pass' | 'pass_with_findings' | 'fail';
  reportUrl: string;
  reviewState: ReviewState;
  publishedAt: string;
}

const vendors = new Map<string, Vendor>();
const reports = new Map<string, VendorReport>();

const contractIdSchema = z.string().regex(/^C[A-Z2-7]{55}$/);
const httpsUrl = z.string().url().max(500).refine((u) => /^https:\/\//i.test(u), 'must be https');
const vendorSchema = z.object({ name: z.string().trim().min(2).max(100), website: httpsUrl });
const reportSchema = z.object({
  scope: z.string().trim().min(1).max(500),
  verdict: z.enum(['pass', 'pass_with_findings', 'fail']),
  reportUrl: httpsUrl,
});
const reviewSchema = z.object({ state: z.enum(['approved', 'rejected']) });

const hashKey = (k: string) => createHash('sha256').update(k).digest();

/** POST /vendor-audits/vendors: onboard a vendor (admin). Returns the API key once. */
vendorAuditsRouter.post('/vendors', requireRole('admin'), (req: Request, res: Response) => {
  const body = vendorSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'Invalid request', details: body.error.issues });
  const apiKey = randomBytes(32).toString('hex');
  const vendor: Vendor = {
    id: randomUUID(),
    ...body.data,
    keyHash: hashKey(apiKey).toString('hex'),
    createdAt: new Date().toISOString(),
  };
  vendors.set(vendor.id, vendor);
  res.status(201).json({ id: vendor.id, name: vendor.name, website: vendor.website, apiKey });
});

/** POST /vendor-audits/vendors/:vendorId/contracts/:contractId/reports: verified vendor publishes a report. */
vendorAuditsRouter.post('/vendors/:vendorId/contracts/:contractId/reports', (req: Request, res: Response) => {
  const vendor = vendors.get(req.params.vendorId);
  const key = req.header('x-vendor-key') ?? '';
  const ok = vendor && timingSafeEqual(hashKey(key), Buffer.from(vendor.keyHash, 'hex'));
  if (!vendor || !ok) return res.status(401).json({ error: 'Invalid vendor credentials' });
  const cid = contractIdSchema.safeParse(req.params.contractId);
  const body = reportSchema.safeParse(req.body);
  if (!cid.success || !body.success) {
    return res.status(400).json({ error: 'Invalid request', details: body.success ? undefined : body.error.issues });
  }
  const report: VendorReport = {
    id: randomUUID(),
    vendorId: vendor.id,
    contractId: cid.data,
    ...body.data,
    reviewState: 'pending',
    publishedAt: new Date().toISOString(),
  };
  reports.set(report.id, report);
  res.status(201).json(report);
});

/** PATCH /vendor-audits/vendors/reports/:reportId/review: admin approves or rejects a report. */
vendorAuditsRouter.patch('/vendors/reports/:reportId/review', requireRole('admin'), (req: Request, res: Response) => {
  const report = reports.get(req.params.reportId);
  const body = reviewSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'Invalid request', details: body.error.issues });
  if (!report) return res.status(404).json({ error: 'Report not found' });
  report.reviewState = body.data.state;
  res.json(report);
});

/** GET /vendor-audits/vendors/contracts/:contractId/reports: approved vendor reports for display. */
vendorAuditsRouter.get('/vendors/contracts/:contractId/reports', (req: Request, res: Response) => {
  const cid = contractIdSchema.safeParse(req.params.contractId);
  if (!cid.success) return res.status(400).json({ error: 'Invalid contract id' });
  const items = [...reports.values()]
    .filter((r) => r.contractId === cid.data && r.reviewState === 'approved')
    .map((r) => ({ ...r, vendorName: vendors.get(r.vendorId)?.name ?? null }));
  res.json({ contractId: cid.data, source: 'third_party', items });
});
