/**
 * POST /api/v1/exports          — enqueue a new CSV export job
 * GET  /api/v1/exports          — list export jobs
 * GET  /api/v1/exports/:id      — job status
 * GET  /api/v1/exports/:id/file — download the CSV file
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

const createSchema = z.object({
  exportType: z.enum(['transactions', 'events', 'wallet_history']),
  filters: z.record(z.unknown()).optional().default({}),
});

function ownedJobWhere(req: Request, jobId?: string) {
  const where: { developerId: string; id?: string } = {
    developerId: req.apiKey!.developerId,
  };
  if (jobId) where.id = jobId;
  return where;
}

// POST /exports — enqueue
exportsRouter.post('/', async (req: Request, res: Response) => {
  try {
    const body = createSchema.parse(req.body);
    const jobId = await enqueueExport(
      body.exportType,
      body.filters as Record<string, unknown>,
      req.apiKey!.developerId,
    );
    res.status(202).json({ jobId, status: 'pending' });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

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

    const fileName = `${job.exportType}-${job.id}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    fs.createReadStream(absPath).pipe(res);
  }),
);
