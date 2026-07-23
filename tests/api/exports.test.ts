import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const DEV_A = 'dev-a';
const DEV_B = 'dev-b';

vi.mock('../../src/middleware/apiKeyAuth', () => ({
  apiKeyAuth: (req: any, _res: any, next: any) => {
    req.apiKey = {
      id: 'key-1',
      developerId: req.headers['x-test-developer'] ?? DEV_A,
      tier: 'developer',
      keyName: 'test',
    };
    next();
  },
  requireApiKey: (_req: any, res: any, next: any) => next(),
}));

vi.mock('../../src/db', () => ({
  prismaRead: {
    exportJob: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
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
      expect(enqueueExport).toHaveBeenCalledWith('transactions', { limit: 100 }, DEV_A);
    });

    it('returns 202 with empty filters when omitted', async () => {
      (enqueueExport as any).mockResolvedValue('job-xyz');

      const res = await request(app).post('/api/v1/exports').send({ exportType: 'events' });

      expect(res.status).toBe(202);
      expect(enqueueExport).toHaveBeenCalledWith('events', {}, DEV_A);
    });

    it('returns 400 for invalid exportType', async () => {
      const res = await request(app).post('/api/v1/exports').send({ exportType: 'invalid_type' });
      expect(res.status).toBe(400);
      expect(enqueueExport).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/v1/exports — list jobs', () => {
    it('scopes list to authenticated developer', async () => {
      (prisma.exportJob.findMany as any).mockResolvedValue([]);

      await request(app).get('/api/v1/exports');

      expect(prisma.exportJob.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { developerId: DEV_A } }),
      );
    });
  });

  describe('GET /api/v1/exports/:id — job status', () => {
    it('returns job when owned by developer', async () => {
      const job = { id: 'job-1', status: 'running', exportType: 'wallet_history' };
      (prisma.exportJob.findFirst as any).mockResolvedValue(job);

      const res = await request(app).get('/api/v1/exports/job-1');

      expect(res.status).toBe(200);
      expect(prisma.exportJob.findFirst).toHaveBeenCalledWith({
        where: { developerId: DEV_A, id: 'job-1' },
      });
    });

    it('returns 404 when job belongs to another developer', async () => {
      (prisma.exportJob.findFirst as any).mockResolvedValue(null);

      const res = await request(app)
        .get('/api/v1/exports/foreign-job')
        .set('X-Test-Developer', DEV_B);

      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/v1/exports/:id/file — download', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-test-'));
      process.env.EXPORT_DIR = tmpDir;
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      delete process.env.EXPORT_DIR;
    });

    it('returns 404 for cross-tenant download attempt', async () => {
      (prisma.exportJob.findFirst as any).mockResolvedValue(null);

      const res = await request(app)
        .get('/api/v1/exports/other-dev-job/file')
        .set('X-Test-Developer', DEV_B);

      expect(res.status).toBe(404);
    });

    it('rejects absolute filePath in database', async () => {
      (prisma.exportJob.findFirst as any).mockResolvedValue({
        id: 'job-done',
        status: 'done',
        filePath: '/etc/passwd',
        exportType: 'transactions',
      });

      const res = await request(app).get('/api/v1/exports/job-done/file');
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invalid export path/i);
    });

    it('rejects path traversal in filePath', async () => {
      (prisma.exportJob.findFirst as any).mockResolvedValue({
        id: 'job-done',
        status: 'done',
        filePath: '../../../etc/passwd',
        exportType: 'transactions',
      });

      const res = await request(app).get('/api/v1/exports/job-done/file');
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/escapes export directory/i);
    });

    it('streams file when relative path is inside EXPORT_DIR', async () => {
      const fileName = 'transactions-job-done.csv';
      fs.writeFileSync(path.join(tmpDir, fileName), 'hash,amount\n1,100\n');

      (prisma.exportJob.findFirst as any).mockResolvedValue({
        id: 'job-done',
        status: 'done',
        filePath: fileName,
        exportType: 'transactions',
      });

      const res = await request(app).get('/api/v1/exports/job-done/file');
      expect(res.status).toBe(200);
      expect(res.text).toContain('hash,amount');
    });

    it('returns 409 when export is not yet done', async () => {
      (prisma.exportJob.findFirst as any).mockResolvedValue({
        id: 'job-pending',
        status: 'running',
        filePath: null,
      });

      const res = await request(app).get('/api/v1/exports/job-pending/file');
      expect(res.status).toBe(409);
    });
  });
});
