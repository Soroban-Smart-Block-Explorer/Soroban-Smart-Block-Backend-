/**
 * POST /api/v1/exports          — enqueue a new export job (CSV/JSON/Parquet)
 * GET  /api/v1/exports          — list export jobs
 * GET  /api/v1/exports/:id      — job status
 * GET  /api/v1/exports/:id/file — download the export file
 *
 * Audit-trail exports (exportType: 'audit_trail') cover admin actions, freeze
 * changes, and signer changes for compliance ingestion. They support
 * date-range filtering via filters.from / filters.to (ISO-8601) and are
 * emitted in CSV, JSON, or Parquet. Audit-trail records are sourced from
 * append-only storage and are immutable once written.
 */

import fs from 'fs';
import { Router, Request, Response } from 'express';
import { prismaRead as prisma } from '../db';
import { enqueueExport } from '../indexer/csv-exporter';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';
import { apiKeyAuth, requireApiKey } from '../middleware/apiKeyAuth';
import { ExportPathError, resolveExportFilePath } from '../exports/resolve-path';

export const exportsRouter = Router();

exportsRouter.use(apiKeyAuth, requireApiKey);

const EXPORT_FORMATS = ['csv', 'json', 'parquet'] as const;
const AUDIT_TRAIL_CATEGORIES = ['admin_action', 'freeze_change', 'signer_change'] as const;

const isoDate = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), { message: 'must be an ISO-8601 date' });

const auditTrailFiltersSchema = z
  .object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    categories: z.array(z.enum(AUDIT_TRAIL_CATEGORIES)).min(1).optional(),
  })
  .refine((f) => !f.from || !f.to || Date.parse(f.from) <= Date.parse(f.to), {
    message: 'from must be on or before to',
  });

const createSchema = z.object({
  exportType: z.enum(['transactions', 'events', 'wallet_history', 'audit_trail']),
  format: z.enum(EXPORT_FORMATS).optional().default('csv'),
  filters: z.record(z.unknown()).optional().default({}),
});

const CONTENT_TYPES: Record<(typeof EXPORT_FORMATS)[number], string> = {
  csv: 'text/csv',
  json: 'application/json',
  parquet: 'application/vnd.apache.parquet',
};

function ownedJobWhere(req: Request, jobId?: string) {
  const where: { developerId: string; id?: string } = {
    developerId: req.apiKey!.developerId,
  };
  if (jobId) where.id = jobId;
  return where;
}

// POST /exports — enqueue
exportsRouter.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const body = createSchema.parse(req.body);

      let filters = body.filters as Record<string, unknown>;
      if (body.exportType === 'audit_trail') {
        filters = auditTrailFiltersSchema.parse(filters);
      }

      const jobId = await enqueueExport(
        body.exportType,
        { ...filters, format: body.format },
        req.apiKey!.developerId,
      );
      res.status(202).json({ jobId, status: 'pending', format: body.format });
    } catch (e) {
      res.status(400).json({ error: String(e) });
    }
  }),
);

// GET /exports — list
exportsRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const jobs = await prisma.exportJob.findMany({
      where: { developerId: req.apiKey!.developerId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        status: true,
        exportType: true,
        rowCount: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    res.json(jobs);
  }),
);

// GET /exports/:id — status
exportsRouter.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const job = await prisma.exportJob.findFirst({
      where: ownedJobWhere(req, req.params.id),
    });
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
  }),
);

// GET /exports/:id/file — download
exportsRouter.get(
  '/:id/file',
  asyncHandler(async (req: Request, res: Response) => {
    const job = await prisma.exportJob.findFirst({
      where: ownedJobWhere(req, req.params.id),
    });
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'done' || !job.filePath) {
      return res.status(409).json({ error: `Export not ready (status: ${job.status})` });
    }

    let absPath: string;
    try {
      absPath = resolveExportFilePath(job.filePath);
    } catch (err) {
      if (err instanceof ExportPathError) {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }

    if (!fs.existsSync(absPath)) {
      return res.status(410).json({ error: 'Export file no longer available' });
    }

    const format = (job.format as (typeof EXPORT_FORMATS)[number]) ?? 'csv';
    const ext = format === 'parquet' ? 'parquet' : format;
    const fileName = `${job.exportType}-${job.id}.${ext}`;
    res.setHeader('Content-Type', CONTENT_TYPES[format] ?? 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    fs.createReadStream(absPath).pipe(res);
  }),
);
