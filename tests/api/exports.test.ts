import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../src/db', () => ({
  prismaRead: {
    exportJob: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
  },
  prismaWrite: {},
}));

vi.mock('../../src/indexer/csv-exporter', () => ({
  enqueueExport: vi.fn(),
}));

import { prismaRead as prisma } from '../../src/db';
import { enqueueExport } from '../../src/indexer/csv-exporter';
import { exportsRouter } from '../../src/api/exports';

const app = express();
app.use(express.json());
app.use('/api/v1/exports', exportsRouter);

describe('CSV Exports API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /api/v1/exports — enqueue export job', () => {
    it('returns 202 with jobId for valid request', async () => {
      (enqueueExport as any).mockResolvedValue('job-abc-123');

      const res = await request(app)
        .post('/api/v1/exports')
        .send({ exportType: 'transactions', filters: { limit: 100 } });

      expect(res.status).toBe(202);
      expect(res.body.jobId).toBe('job-abc-123');
      expect(res.body.status).toBe('pending');
      expect(enqueueExport).toHaveBeenCalledWith('transactions', { limit: 100 });
    });

    it('returns 202 with empty filters when omitted', async () => {
      (enqueueExport as any).mockResolvedValue('job-xyz');

      const res = await request(app).post('/api/v1/exports').send({ exportType: 'events' });

      expect(res.status).toBe(202);
      expect(res.body.jobId).toBe('job-xyz');
      expect(enqueueExport).toHaveBeenCalledWith('events', {});
    });

    it('returns 400 for invalid exportType', async () => {
      const res = await request(app).post('/api/v1/exports').send({ exportType: 'invalid_type' });

      expect(res.status).toBe(400);
      expect(enqueueExport).not.toHaveBeenCalled();
    });

    it('returns 400 when exportType is missing', async () => {
      const res = await request(app).post('/api/v1/exports').send({});
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/v1/exports — list jobs', () => {
    it('returns list of export jobs', async () => {
      const jobs = [
        {
          id: 'j1',
          status: 'done',
          exportType: 'transactions',
          rowCount: 500,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 'j2',
          status: 'pending',
          exportType: 'events',
          rowCount: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];
      (prisma.exportJob.findMany as any).mockResolvedValue(jobs);

      const res = await request(app).get('/api/v1/exports');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0].id).toBe('j1');
      expect(res.body[1].status).toBe('pending');
    });

    it('returns empty array when no jobs exist', async () => {
      (prisma.exportJob.findMany as any).mockResolvedValue([]);

      const res = await request(app).get('/api/v1/exports');

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe('GET /api/v1/exports/:id — job status', () => {
    it('returns job when found', async () => {
      const job = { id: 'job-1', status: 'running', exportType: 'wallet_history' };
      (prisma.exportJob.findUnique as any).mockResolvedValue(job);

      const res = await request(app).get('/api/v1/exports/job-1');

      expect(res.status).toBe(200);
      expect(res.body.id).toBe('job-1');
      expect(res.body.status).toBe('running');
    });

    it('returns 404 when job not found', async () => {
      (prisma.exportJob.findUnique as any).mockResolvedValue(null);

      const res = await request(app).get('/api/v1/exports/nonexistent');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Job not found');
    });
  });

  describe('GET /api/v1/exports/:id/file — download', () => {
    it('returns 404 when job not found', async () => {
      (prisma.exportJob.findUnique as any).mockResolvedValue(null);

      const res = await request(app).get('/api/v1/exports/missing/file');

      expect(res.status).toBe(404);
    });

    it('returns 409 when export is not yet done', async () => {
      (prisma.exportJob.findUnique as any).mockResolvedValue({
        id: 'job-pending',
        status: 'running',
        filePath: null,
      });

      const res = await request(app).get('/api/v1/exports/job-pending/file');

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/not ready/i);
    });

    it('returns 410 when file has been deleted from disk', async () => {
      (prisma.exportJob.findUnique as any).mockResolvedValue({
        id: 'job-done',
        status: 'done',
        filePath: '/nonexistent/path/export.csv',
        exportType: 'transactions',
      });

      const res = await request(app).get('/api/v1/exports/job-done/file');

      expect(res.status).toBe(410);
      expect(res.body.error).toMatch(/no longer available/i);
    });
  });
});
