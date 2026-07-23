import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db', () => ({
  prismaRead: {
    transaction: { findMany: vi.fn() },
    event: { findMany: vi.fn() },
  },
  prismaWrite: {
    exportJob: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  },
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    mkdirSync: vi.fn(),
    createWriteStream: vi.fn().mockReturnValue({
      write: vi.fn(),
      end: vi.fn().mockImplementation(function (cb: (err: null) => void) {
        cb(null);
      }),
    }),
  };
});

import * as db from '../../src/db';
import { enqueueExport, runExportJob } from '../../src/indexer/csv-exporter';

describe('enqueueExport', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates an export job with developer ownership', async () => {
    vi.mocked(db.prismaWrite.exportJob.create).mockResolvedValue({
      id: 'job-abc',
      exportType: 'transactions',
      filters: {},
      status: 'pending',
      developerId: 'dev-1',
    } as any);
    vi.mocked(db.prismaWrite.exportJob.findUnique).mockResolvedValue({
      id: 'job-abc',
      exportType: 'transactions',
      filters: {},
      status: 'pending',
      developerId: 'dev-1',
    } as any);
    vi.mocked(db.prismaRead.transaction.findMany).mockResolvedValue([]);
    vi.mocked(db.prismaWrite.exportJob.update).mockResolvedValue({} as any);

    const jobId = await enqueueExport('transactions', { contract: 'CA...' }, 'dev-1');
    expect(jobId).toBe('job-abc');
    expect(db.prismaWrite.exportJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ developerId: 'dev-1', status: 'pending' }),
    });
  });
});

describe('runExportJob', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stores relative filePath on completion', async () => {
    vi.mocked(db.prismaWrite.exportJob.findUnique).mockResolvedValue({
      id: 'job-tx',
      exportType: 'transactions',
      filters: {},
      status: 'pending',
    } as any);
    vi.mocked(db.prismaRead.transaction.findMany).mockResolvedValue([]);
    vi.mocked(db.prismaWrite.exportJob.update).mockResolvedValue({} as any);

    await runExportJob('job-tx');

    expect(db.prismaWrite.exportJob.update).toHaveBeenCalledWith({
      where: { id: 'job-tx' },
      data: expect.objectContaining({
        status: 'done',
        filePath: 'transactions-job-tx.csv',
      }),
    });
  });
});
