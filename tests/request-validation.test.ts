import { describe, it, expect, vi, type Mock } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import {
  requireApiKeyContext,
  requireNetworkContext,
  requireActorContext,
  hasColdStorageContext,
} from '../src/middleware/requestValidation';

function mockRes(): Response {
  const res = { status: vi.fn(), json: vi.fn() } as unknown as Response;
  (res.status as Mock).mockReturnValue(res);
  return res;
}

function mockReq(overrides: Partial<Request> = {}): Request {
  return overrides as Request;
}

describe('requireApiKeyContext', () => {
  it('calls next() when req.apiKey is set', () => {
    const req = mockReq({ apiKey: { id: '1', keyName: 'k', developerId: 'd', tier: 'free' } });
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;
    requireApiKeyContext(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('returns 401 when req.apiKey is absent', () => {
    const req = mockReq({});
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;
    requireApiKeyContext(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('requireNetworkContext', () => {
  it('calls next() when req.network and req.networkProfile are set', () => {
    const req = mockReq({ network: 'testnet', networkProfile: { name: 'testnet' } as any });
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;
    requireNetworkContext(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('returns 500 when network context is missing', () => {
    const req = mockReq({});
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;
    requireNetworkContext(req, res, next);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('requireActorContext', () => {
  it('calls next() when req.actor is set', () => {
    const req = mockReq({ actor: 'admin' });
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;
    requireActorContext(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('returns 401 when req.actor is absent', () => {
    const req = mockReq({});
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;
    requireActorContext(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('hasColdStorageContext', () => {
  it('returns true when coldStorage.enabled is true', () => {
    const req = mockReq({ coldStorage: { enabled: true, type: 'parquet', ledgerSeq: 100 } });
    expect(hasColdStorageContext(req)).toBe(true);
  });

  it('returns false when coldStorage is absent', () => {
    expect(hasColdStorageContext(mockReq({}))).toBe(false);
  });

  it('returns false when coldStorage.enabled is false', () => {
    const req = mockReq({ coldStorage: { enabled: false, type: 'parquet', ledgerSeq: 100 } });
    expect(hasColdStorageContext(req)).toBe(false);
  });
});
