import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoist mocks so vi.mock factories can reference them ───────────────────────
const { mockFindMany, mockUpdateMany, mockUploadToS3 } = vi.hoisted(() => ({
  mockFindMany: vi.fn(),
  mockUpdateMany: vi.fn(),
  mockUploadToS3: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/archival/s3Client', () => ({
  ARCHIVE_BUCKET: 'test-bucket',
  uploadToS3: mockUploadToS3,
  downloadFromS3: vi.fn().mockResolvedValue('{}'),
}));

vi.mock('../src/db', () => ({
  prismaWrite: {
    transaction: {
      findMany: mockFindMany,
      updateMany: mockUpdateMany,
    },
  },
}));

import { archiveRawXdr } from '../src/archival/archiver';

const MOCK_TX = {
  id: 'cuid1',
  hash: 'abc123',
  ledgerSequence: 1000,
  ledgerCloseTime: new Date('2025-01-15T00:00:00Z'),
  contractAddress: 'CXXX',
  rawXdr: 'AAAA==',
};

describe('archiveRawXdr', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindMany.mockResolvedValueOnce([MOCK_TX]).mockResolvedValueOnce([]);
    mockUpdateMany.mockResolvedValue({ count: 1 });
  });

  it('uploads each transaction rawXdr to S3 with correct key', async () => {
    await archiveRawXdr();

    expect(mockUploadToS3).toHaveBeenCalledOnce();
    const [key, body] = mockUploadToS3.mock.calls[0];
    expect(key).toBe('xdr/2025/01/1000/abc123.json');
    const parsed = JSON.parse(body);
    expect(parsed.hash).toBe('abc123');
    expect(parsed.rawXdr).toBe('AAAA==');
  });

  it('nullifies rawXdr in DB after successful upload', async () => {
    await archiveRawXdr();

    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ['cuid1'] } },
      data: { rawXdr: '' },
    });
  });

  it('returns correct counts', async () => {
    const result = await archiveRawXdr();
    expect(result.archived).toBe(1);
    expect(result.nullified).toBe(1);
    expect(result.errors).toBe(0);
  });

  it('counts S3 upload failures as errors and does not nullify those rows', async () => {
    mockUploadToS3.mockRejectedValueOnce(new Error('S3 down'));

    const result = await archiveRawXdr();

    expect(result.errors).toBe(1);
    expect(result.nullified).toBe(0);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it('stops when no rows are returned', async () => {
    mockFindMany.mockReset().mockResolvedValue([]);

    const result = await archiveRawXdr();

    expect(result.archived).toBe(0);
    expect(mockUploadToS3).not.toHaveBeenCalled();
  });
});
