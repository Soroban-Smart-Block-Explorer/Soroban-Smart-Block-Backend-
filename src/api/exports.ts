/**
 * POST /api/v1/exports          — enqueue a new CSV export job
 * GET  /api/v1/exports          — list export jobs
 * GET  /api/v1/exports/:id      — job status
 * GET  /api/v1/exports/:id/file — download the CSV file
 */

import fs from 'fs';
import path from 'path';
import { Router, Request, Response } from 'express';
import { prismaRead as prisma } from '../db';
import { enqueueExport } from '../indexer/csv-exporter';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';

export const exportsRouter = Router();

const EXPORT_DIR = process.env.EXPORT_DIR ?? '/tmp/soroban-exports';

const createSchema = z.object({
  exportType: z.enum(['transactions', 'events', 'wallet_history']),
  filters: z.record(z.unknown()).optional().default({}),
});

// POST /exports — enqueue
exportsRouter.post('/', async (req: Request, res: Response) => {
  try {
    const body = createSchema.parse(req.body);
    const jobId = await enqueueExport(body.exportType, body.filters as Record<string, unknown>);
    res.status(202).json({ jobId, status: 'pending' });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// GET /exports — list
exportsRouter.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    const jobs = await prisma.exportJob.findMany({
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
    const job = await prisma.exportJob.findUnique({ where: { id: req.params.id } });
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
  }),
);

// GET /exports/:id/file — download
exportsRouter.get(
  '/:id/file',
  asyncHandler(async (req: Request, res: Response) => {
    const job = await prisma.exportJob.findUnique({ where: { id: req.params.id } });
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'done' || !job.filePath) {
      return res.status(409).json({ error: `Export not ready (status: ${job.status})` });
    }

    const absPath = path.isAbsolute(job.filePath)
      ? job.filePath
      : path.join(EXPORT_DIR, job.filePath);

    if (!fs.existsSync(absPath)) {
      return res.status(410).json({ error: 'Export file no longer available' });
    }

    const fileName = `${job.exportType}-${job.id}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    fs.createReadStream(absPath).pipe(res);
  }),
);
