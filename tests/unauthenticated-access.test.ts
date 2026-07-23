import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

vi.mock('../src/db', () => ({
  prismaRead: { devApiKey: { findFirst: vi.fn() } },
  prismaWrite: { devApiKey: { update: vi.fn().mockResolvedValue(null) } },
}));
vi.mock('../src/logger', () => ({ logger: { warn: vi.fn() } }));

import { requireApiKey, requireKeyTier } from '../src/middleware/apiKeyAuth';
import type { ApiKeyContext } from '../src/middleware/apiKeyAuth';

function makeReq(apiKey?: ApiKeyContext): Request {
  return { apiKey, headers: {}, ip: '10.0.0.1', path: '/test' } as unknown as Request;
}

function makeRes() {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  return { res: { status, json } as unknown as Response, status, json };
}

describe('requireApiKey — regression: protected routes must reject unauthenticated requests', () => {
  let next: NextFunction;

  beforeEach(() => {
    next = vi.fn();
  });

  it('rejects request with no API key', () => {
    const { res, status } = makeRes();
    requireApiKey(makeReq(undefined), res, next);
    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns JSON error body on rejection', () => {
    const json = vi.fn();
    const status = vi.fn().mockReturnValue({ json });
    requireApiKey(makeReq(undefined), { status } as unknown as Response, next);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }));
  });

  it('allows request when API key is present', () => {
    const { res } = makeRes();
    const key: ApiKeyContext = {
      id: 'k1',
      keyName: 'test',
      developerId: 'dev1',
      tier: 'developer',
    };
    requireApiKey(makeReq(key), res, next);
    expect(next).toHaveBeenCalled();
  });

  const protectedRoutes = [
    'simulate',
    'verify',
    'aa',
    'compliance',
    'query',
    'data-market',
    'freeze',
    'predict',
    'forecast',
    'exports',
  ];

  it.each(protectedRoutes)('route /%s must return 401 for unauthenticated request', (route) => {
    const req = makeReq(undefined);
    (req as any).path = `/api/v1/${route}`;
    const { res, status } = makeRes();
    requireApiKey(req, res, next);
    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('requireKeyTier — tier enforcement on protected compute routes', () => {
  let next: NextFunction;

  beforeEach(() => {
    next = vi.fn();
  });

  it('blocks unauthenticated tier from developer+ route', () => {
    const req = makeReq(undefined);
    const { res, status } = makeRes();
    requireKeyTier('developer')(req, res, next);
    expect(status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('blocks free tier from pro+ route', () => {
    const req = makeReq({ id: 'k', keyName: 'k', developerId: 'd', tier: 'free' });
    const { res, status } = makeRes();
    requireKeyTier('pro')(req, res, next);
    expect(status).toHaveBeenCalledWith(403);
  });

  it('allows enterprise tier on any route', () => {
    const req = makeReq({ id: 'k', keyName: 'k', developerId: 'd', tier: 'enterprise' });
    const { res } = makeRes();
    requireKeyTier('pro')(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('allows developer tier on developer route', () => {
    const req = makeReq({ id: 'k', keyName: 'k', developerId: 'd', tier: 'developer' });
    const { res } = makeRes();
    requireKeyTier('developer')(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});
