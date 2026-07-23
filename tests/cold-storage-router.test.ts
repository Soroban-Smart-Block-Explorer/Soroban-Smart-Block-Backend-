import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

// Stub heavy deps before importing the module under test
vi.mock('parquetjs-lite', () => ({ ParquetReader: { openFile: vi.fn() } }));
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(() => ({ send: vi.fn() })),
  GetObjectCommand: vi.fn(),
  HeadObjectCommand: vi.fn(),
  RestoreObjectCommand: vi.fn(),
  ListObjectsV2Command: vi.fn(),
}));
vi.mock('../src/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('prom-client', () => {
  const make = () => ({ observe: vi.fn(), inc: vi.fn(), set: vi.fn() });
  return {
    Histogram: vi.fn(make),
    Counter: vi.fn(make),
    Gauge: vi.fn(make),
    register: { registerMetric: vi.fn() },
  };
});

import {
  coldStorageRouter,
  isColdStorageRequest,
  getColdStorageType,
  getColdStorageConfig,
} from '../src/middleware/coldStorageRouter';

function makeReq(overrides: Partial<Request> = {}): Request {
  return { params: {}, query: {}, headers: {}, ...overrides } as Request;
}

function makeRes(): Response {
  const res = { set: vi.fn() } as unknown as Response;
  return res;
}

describe('coldStorageRouter middleware', () => {
  let next: NextFunction;

  beforeEach(() => {
    next = vi.fn();
  });

  it('calls next with no ledger in request', () => {
    coldStorageRouter(makeReq(), makeRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it('tags recent ledger as hot storage', () => {
    const res = makeRes();
    const req = makeReq({ query: { ledger: '999999999' } });
    coldStorageRouter(req, res, next);
    expect(res.set).toHaveBeenCalledWith('X-Storage-Tier', 'hot');
    expect(next).toHaveBeenCalled();
  });

  it('tags old ledger as cold storage and attaches req.coldStorage', () => {
    const res = makeRes();
    const req = makeReq({ query: { ledger: '1' } });
    coldStorageRouter(req, res, next);
    expect(res.set).toHaveBeenCalledWith('X-Storage-Tier', 'cold');
    expect(req.coldStorage?.enabled).toBe(true);
    expect(req.coldStorage?.ledgerSeq).toBe(1);
  });

  it('reads ledger from params.sequence', () => {
    const res = makeRes();
    const req = makeReq({ params: { sequence: '1' } });
    coldStorageRouter(req, res, next);
    expect(req.coldStorage?.enabled).toBe(true);
  });

  it('reads ledger from params.ledger', () => {
    const res = makeRes();
    const req = makeReq({ params: { ledger: '1' } });
    coldStorageRouter(req, res, next);
    expect(req.coldStorage?.enabled).toBe(true);
  });

  it('ignores non-numeric ledger param and calls next', () => {
    const res = makeRes();
    const req = makeReq({ query: { ledger: 'abc' } });
    coldStorageRouter(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.coldStorage).toBeUndefined();
  });
});

describe('isColdStorageRequest', () => {
  it('returns false when coldStorage is absent', () => {
    expect(isColdStorageRequest(makeReq())).toBe(false);
  });
  it('returns true when coldStorage.enabled is true', () => {
    const req = makeReq({ coldStorage: { enabled: true, type: 'parquet', ledgerSeq: 1 } });
    expect(isColdStorageRequest(req)).toBe(true);
  });
});

describe('getColdStorageType', () => {
  it('returns hot when no coldStorage', () => {
    expect(getColdStorageType(makeReq())).toBe('hot');
  });
  it('returns storage type when set', () => {
    const req = makeReq({ coldStorage: { enabled: true, type: 'glacier', ledgerSeq: 1 } });
    expect(getColdStorageType(req)).toBe('glacier');
  });
});

describe('getColdStorageConfig', () => {
  it('returns an object with coldStorageType', () => {
    const cfg = getColdStorageConfig();
    expect(cfg).toHaveProperty('coldStorageType');
    expect(['parquet', 'glacier', 'archive']).toContain(cfg.coldStorageType);
  });
});

// ── Security: injection in ledger param ──────────────────────────────────────
describe('security', () => {
  it('ignores SQL injection attempt in ledger query param', () => {
    const res = makeRes();
    const req = makeReq({ query: { ledger: '1; DROP TABLE transactions;--' } });
    coldStorageRouter(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.coldStorage).toBeUndefined();
  });

  it('ignores script tag in ledger param', () => {
    const res = makeRes();
    const req = makeReq({ query: { ledger: '<script>alert(1)</script>' } });
    coldStorageRouter(req, res, next);
    expect(req.coldStorage).toBeUndefined();
  });
});
