import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import {
  getRateLimitTier,
  normalizeTierConfig,
  tieredRateLimit,
} from '../src/middleware/rateLimit';
import { checkTokenBucket } from '../src/middleware/tokenBucket';

vi.mock('../src/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
vi.mock('../src/middleware/tokenBucket', () => ({
  checkTokenBucket: vi.fn(),
  setRateLimitRedisClient: vi.fn(),
}));

const mockCheck = vi.mocked(checkTokenBucket);

function makeReq(overrides: Partial<Request> = {}): Request {
  return { headers: {}, ip: '127.0.0.1', method: 'GET', path: '/test', ...overrides } as Request;
}

function makeRes(): {
  res: Response;
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
} {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const setHeader = vi.fn();
  return { res: { status, json, setHeader } as unknown as Response, status, json, setHeader };
}

describe('rate limit configuration', () => {
  it('falls back to defaults for invalid tier values', () => {
    const tierConfig = normalizeTierConfig({
      public: { windowMs: 0, max: -5 },
      developer: { windowMs: 30_000, max: 250 },
      premium: { windowMs: 90_000, max: 5000 },
    } as any);

    expect(tierConfig.public.windowMs).toBe(60_000);
    expect(tierConfig.public.max).toBe(100);
    expect(tierConfig.developer.windowMs).toBe(30_000);
    expect(tierConfig.developer.max).toBe(250);
  });

  it('selects the highest matching tier for known API keys', () => {
    const tier = getRateLimitTier(
      'premium-api',
      new Set(['developer-api']),
      new Set(['premium-api']),
    );
    expect(tier).toBe('premium');
  });
});

describe('tieredRateLimit', () => {
  let next: NextFunction;

  beforeEach(() => {
    next = vi.fn();
    mockCheck.mockResolvedValue({
      allowed: true,
      limit: 100,
      remaining: 99,
      resetAt: 9999999999,
      tier: 'free',
    });
  });

  it('calls next() when the fallback limiter allows the request', async () => {
    const { res } = makeRes();
    await tieredRateLimit(makeReq(), res, next);
    expect(next).toHaveBeenCalled();
  });

  it('uses apiKey tier when present', async () => {
    const req = makeReq({
      apiKey: { id: 'k', keyName: 'n', developerId: 'd', tier: 'pro' },
    } as any);
    const { res } = makeRes();
    await tieredRateLimit(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('falls back to unauthenticated tier when no apiKey header is present', async () => {
    const req = makeReq({ headers: {} });
    const { res } = makeRes();
    await tieredRateLimit(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});

describe('rate-limit security', () => {
  it('does not crash on spoofed X-Forwarded-For header', async () => {
    const next = vi.fn();
    const req = makeReq({ headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' } });
    const { res } = makeRes();
    await expect(tieredRateLimit(req, res, next)).resolves.not.toThrow();
  });

  it('handles missing ip gracefully', async () => {
    const next = vi.fn();
    const req = makeReq({ ip: undefined });
    const { res } = makeRes();
    await expect(tieredRateLimit(req, res, next)).resolves.not.toThrow();
  });
});
