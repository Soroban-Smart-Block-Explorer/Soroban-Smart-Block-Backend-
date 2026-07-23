import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../src/db', () => ({
  prisma: {
    verificationJob: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('../../src/middleware/asyncHandler', () => ({
  asyncHandler: (fn: Mock) => fn,
}));

vi.mock('../../src/api/compiler', () => ({
  extractArchive: vi.fn(),
  compileSandboxed: vi.fn(),
  hashFile: vi.fn().mockReturnValue('abc123hash'),
  cleanupDir: vi.fn().mockResolvedValue(undefined),
  extractSourceFiles: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/indexer/wasm-decompiler', () => ({
  decompileWasm: vi.fn(),
}));

vi.mock('../../src/utils/background', () => ({
  background: vi.fn().mockImplementation((_label: string, fn: Mock) => fn()),
}));

import * as db from '../../src/db';
import { verifyRouter } from '../../src/api/verify';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/verify', verifyRouter);
  return app;
}

describe('GET /verify/:id', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 404 when job not found', async () => {
    vi.mocked(db.prisma.verificationJob.findUnique).mockResolvedValue(null);

    const res = await request(makeApp()).get('/verify/nonexistent');
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('Job not found');
  });

  it('returns job status when found', async () => {
    vi.mocked(db.prisma.verificationJob.findUnique).mockResolvedValue({
      id: 'job-1',
      status: 'verified',
      contractAddress: 'CA_CONTRACT',
    } as any);

    const res = await request(makeApp()).get('/verify/job-1');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('verified');
  });
});

describe('GET /verify/:id/snippet', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 404 when job not found', async () => {
    vi.mocked(db.prisma.verificationJob.findUnique).mockResolvedValue(null);

    const res = await request(makeApp()).get('/verify/nonexistent/snippet');
    expect(res.status).toBe(404);
  });

  it('returns 404 when sourceFiles not available', async () => {
    vi.mocked(db.prisma.verificationJob.findUnique).mockResolvedValue({
      id: 'job-1',
      status: 'pending',
      sourceFiles: null,
    } as any);

    const res = await request(makeApp()).get('/verify/job-1/snippet');
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('Source files not available');
  });

  it('returns source files when available', async () => {
    vi.mocked(db.prisma.verificationJob.findUnique).mockResolvedValue({
      id: 'job-1',
      status: 'verified',
      sourceFiles: [{ name: 'lib.rs', content: 'fn main() {}' }],
    } as any);

    const res = await request(makeApp()).get('/verify/job-1/snippet');
    expect(res.status).toBe(200);
    expect(res.body.files).toBeDefined();
    expect(res.body.jobId).toBe('job-1');
  });
});

describe('POST /verify', () => {
  it('returns 400 when no archive is uploaded', async () => {
    const res = await request(makeApp()).post('/verify').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('No archive');
  });
});
