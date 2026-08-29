/**
 * Unit tests for the /metrics authentication & rate-limiting middleware (#907).
 *
 * Covers:
 * - IP/CIDR allowlist matching (METRICS_ALLOWED_IPS)
 * - Bearer token matching (METRICS_TOKEN)
 * - Fail-closed (403) in production when neither is configured
 * - Fail-open (dev convenience) in non-production when neither is configured
 * - 401 on an invalid token, 403 on a rejected IP with no token presented
 * - Rate limiting returns 429 once the window's request budget is exhausted
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Request, Response } from 'express';

vi.mock('../config', () => ({
  config: {
    metricsAllowedIps: '',
    metricsToken: undefined as string | undefined,
    metricsRateLimitMax: 1000,
    metricsRateLimitWindowMs: 60_000,
    nodeEnv: 'test',
  },
}));

vi.mock('../logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { config } from '../config';
import {
  metricsAuth,
  metricsRateLimiter,
  _clearMetricsRateLimitBuckets,
} from '../middleware/metricsAuth';

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    ip: '203.0.113.10',
    headers: {},
    ...overrides,
  } as Request;
}

function mockRes(): Response & { statusCode?: number; body?: unknown } {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res as Response;
  }) as unknown as Response['status'];
  res.json = vi.fn((body: unknown) => {
    res.body = body;
    return res as Response;
  }) as unknown as Response['json'];
  res.setHeader = vi.fn() as unknown as Response['setHeader'];
  return res as Response & { statusCode?: number; body?: unknown };
}

describe('metricsAuth middleware', () => {
  beforeEach(() => {
    (config as unknown as { metricsAllowedIps: string }).metricsAllowedIps = '';
    (config as unknown as { metricsToken?: string }).metricsToken = undefined;
    (config as unknown as { nodeEnv: string }).nodeEnv = 'test';
    _clearMetricsRateLimitBuckets();
  });

  describe('no allowlist / no token configured', () => {
    it('allows the request outside production', () => {
      const req = mockReq();
      const res = mockRes();
      const next = vi.fn();

      metricsAuth(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('denies with 403 in production (fail closed)', () => {
      (config as unknown as { nodeEnv: string }).nodeEnv = 'production';
      const req = mockReq();
      const res = mockRes();
      const next = vi.fn();

      metricsAuth(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });
  });

  describe('IP allowlist', () => {
    beforeEach(() => {
      (config as unknown as { metricsAllowedIps: string }).metricsAllowedIps =
        '203.0.113.0/24, 198.51.100.5';
    });

    it('allows a request from an IP inside the allowlisted CIDR', () => {
      const req = mockReq({ ip: '203.0.113.42' });
      const res = mockRes();
      const next = vi.fn();

      metricsAuth(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
    });

    it('allows a request from an exact allowlisted IP', () => {
      const req = mockReq({ ip: '198.51.100.5' });
      const res = mockRes();
      const next = vi.fn();

      metricsAuth(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
    });

    it('rejects a non-allowlisted IP with no token provided (403)', () => {
      const req = mockReq({ ip: '192.0.2.99' });
      const res = mockRes();
      const next = vi.fn();

      metricsAuth(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });
  });

  describe('bearer token', () => {
    beforeEach(() => {
      (config as unknown as { metricsToken?: string }).metricsToken = 'super-secret-token';
    });

    it('allows a request with the correct bearer token', () => {
      const req = mockReq({
        ip: '192.0.2.1',
        headers: { authorization: 'Bearer super-secret-token' },
      });
      const res = mockRes();
      const next = vi.fn();

      metricsAuth(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
    });

    it('rejects a request with an incorrect bearer token (401)', () => {
      const req = mockReq({
        ip: '192.0.2.1',
        headers: { authorization: 'Bearer wrong-token' },
      });
      const res = mockRes();
      const next = vi.fn();

      metricsAuth(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('rejects a request with no Authorization header and no IP match (403)', () => {
      const req = mockReq({ ip: '192.0.2.1', headers: {} });
      const res = mockRes();
      const next = vi.fn();

      metricsAuth(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });
  });

  describe('metricsRateLimiter', () => {
    beforeEach(() => {
      (config as unknown as { metricsRateLimitMax: number }).metricsRateLimitMax = 2;
      (config as unknown as { metricsRateLimitWindowMs: number }).metricsRateLimitWindowMs = 60_000;
    });

    it('allows requests within the budget', () => {
      const req = mockReq({ ip: '203.0.113.10' });

      const res1 = mockRes();
      const next1 = vi.fn();
      metricsRateLimiter(req, res1, next1);
      expect(next1).toHaveBeenCalledTimes(1);

      const res2 = mockRes();
      const next2 = vi.fn();
      metricsRateLimiter(req, res2, next2);
      expect(next2).toHaveBeenCalledTimes(1);
    });

    it('returns 429 once the budget is exhausted', () => {
      const req = mockReq({ ip: '203.0.113.10' });

      // Two requests consume the max=2 budget for this window.
      metricsRateLimiter(req, mockRes(), vi.fn());
      metricsRateLimiter(req, mockRes(), vi.fn());

      const res3 = mockRes();
      const next3 = vi.fn();
      metricsRateLimiter(req, res3, next3);

      expect(next3).not.toHaveBeenCalled();
      expect(res3.status).toHaveBeenCalledWith(429);
    });

    it('tracks separate budgets per client IP', () => {
      const reqA = mockReq({ ip: '203.0.113.10' });
      const reqB = mockReq({ ip: '203.0.113.11' });

      metricsRateLimiter(reqA, mockRes(), vi.fn());
      metricsRateLimiter(reqA, mockRes(), vi.fn());

      const resB = mockRes();
      const nextB = vi.fn();
      metricsRateLimiter(reqB, resB, nextB);

      expect(nextB).toHaveBeenCalledTimes(1);
      expect(resB.status).not.toHaveBeenCalled();
    });
  });
});
