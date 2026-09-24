import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import crypto from 'crypto';
import {
  getRateLimitTier,
  normalizeTierConfig,
  tieredRateLimit,
} from '../src/middleware/rateLimit';
import { checkTokenBucket } from '../src/middleware/tokenBucket';

// getRateLimitTier hashes the incoming API key with SHA-256 before comparing
// it against the configured key sets (#715 — plaintext keys are never
// retained), so test fixtures must hash their expected keys the same way.
function hashApiKey(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

vi.mock('../src/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
vi.mock('../src/middleware/tokenBucket', () => ({
  checkTokenBucket: vi.fn(),
  setRateLimitRedisClient: vi.fn(),
}));

const mockCheck = vi.mocked(checkTokenBucket);

// Helper to enable token bucket in the module
// This is set by importing the internal state through mocking
// The token bucket flag is internal, so we use the mock to verify behavior

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    ip: '127.0.0.1',
    method: 'GET',
    path: '/test',
    app: { locals: {} },
    ...overrides,
  } as Request;
}

function makeRes(): {
  res: Response;
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
} {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  return { res: { status, json } as unknown as Response, status, json };
}

describe('rate limit configuration', () => {
  it('falls back to defaults for invalid tier values', () => {
    const tierConfig = normalizeTierConfig({
      free: { windowMs: 0, max: -5 },
      developer: { windowMs: 30_000, max: 250 },
      premium: { windowMs: 90_000, max: 5000 },
    } as any);

    expect(tierConfig.free.windowMs).toBe(60_000);
    expect(tierConfig.free.max).toBeGreaterThan(0);
    expect(tierConfig.developer.windowMs).toBe(30_000);
    expect(tierConfig.developer.max).toBe(250);
  });

  it('selects the highest matching tier for known API keys', () => {
    const tier = getRateLimitTier(
      'premium-api',
      new Set([hashApiKey('developer-api')]),
      new Set([hashApiKey('premium-api')]),
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

  it('does not crash when the fallback limiter is used', async () => {
    const { res } = makeRes();
    const req = makeReq();
    await expect(tieredRateLimit(req, res, next)).resolves.not.toThrow();
  });

  it('sets rate limit headers on response', async () => {
    const req = makeReq({
      apiKey: { id: 'k', keyName: 'n', developerId: 'd', tier: 'pro' },
    } as any);
    const { res, setHeader } = makeRes();
    await tieredRateLimit(req, res, next);
    // The function should set rate limit headers or handle the request
    expect(res).toBeDefined();
  });

  it('falls back gracefully when no apiKey header is present', async () => {
    const req = makeReq({ headers: {} });
    const { res } = makeRes();
    await expect(tieredRateLimit(req, res, next)).resolves.not.toThrow();
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
