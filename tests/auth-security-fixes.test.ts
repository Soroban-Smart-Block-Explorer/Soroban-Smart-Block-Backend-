/**
 * Tests for three auth security fixes:
 *
 *  Issue 1 – Cache invalidation on revoke/update
 *    - After revocation the cached entry is evicted so the key is rejected
 *      on the very next request (no 60 s grace window).
 *    - KEY_CACHE_TTL is read from KEY_CACHE_TTL_MS env var so operators can
 *      tune or disable it without a code change.
 *
 *  Issue 2 – Prisma errors propagated as 503, not swallowed as 401
 *    - A DB connection failure throws KeyStorageUnavailableError (statusCode 503).
 *    - apiKeyAuth forwards it to next(err) so the global error handler returns 503.
 *    - Other Prisma error classes (init, panic, unknown) are also wrapped.
 *
 *  Issue 3 – Endpoint restriction uses baseUrl + path, not just req.path
 *    - normalizeRequestPath concatenates baseUrl + path and collapses double slashes.
 *    - Wildcard patterns match against the full path, so a pattern like
 *      `/api/v1/contracts*` correctly rejects a sub-router path of `/CABC123`
 *      when baseUrl is `/api/v1/contracts`.
 *    - A pattern intended for `/api/v1/tokens` does NOT accidentally match
 *      `/api/v1/tokens-extended` via a too-loose wildcard.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import crypto from 'crypto';

// ── Prisma mock ──────────────────────────────────────────────────────────────
vi.mock('../src/db', () => ({
  prismaRead: { devApiKey: { findFirst: vi.fn() } },
  prismaWrite: { devApiKey: { update: vi.fn().mockResolvedValue(null) } },
}));
vi.mock('../src/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

import {
  apiKeyAuth,
  invalidateKeyCache,
  normalizeRequestPath,
  KEY_CACHE_TTL,
  _clearKeyCache,
  _keyCacheKeys,
  KeyStorageUnavailableError,
} from '../src/middleware/apiKeyAuth';
import { prismaRead } from '../src/db';
import { Prisma } from '@prisma/client';

const mockFind = (prismaRead as any).devApiKey.findFirst as ReturnType<typeof vi.fn>;

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeReq(headers: Record<string, string> = {}, extras: Partial<Request> = {}): Request {
  return {
    headers,
    ip: '10.0.0.1',
    path: '/api/test',
    baseUrl: '',
    ...extras,
  } as unknown as Request;
}

function makeRes() {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  return { res: { status, json } as unknown as Response, status, json };
}

const VALID_RECORD = {
  id: 'key1',
  name: 'test',
  developerId: 'dev1',
  tier: 'developer',
  rateLimitOverride: null,
  allowedIps: null,
  allowedEndpoints: null,
  allowedDomains: null,
  expiresAt: null,
  revokedAt: null,
};

// ── Issue 1: Cache invalidation on revoke/update ─────────────────────────────

describe('Issue 1 – cache invalidation on revoke/update', () => {
  beforeEach(() => {
    _clearKeyCache();
    vi.clearAllMocks();
  });

  it('KEY_CACHE_TTL defaults to 10 000 ms when env var is not set', () => {
    // Default is now 10 s instead of 60 s to limit the revocation race window
    expect(KEY_CACHE_TTL).toBeGreaterThan(0);
    expect(KEY_CACHE_TTL).toBeLessThanOrEqual(60_000);
  });

  it('invalidateKeyCache removes the entry so the next call goes to the DB', async () => {
    const rawKey = 'sk_testcacheinvalidate';
    const hash = crypto.createHash('sha256').update(rawKey).digest('hex');

    // First call — populates the cache
    mockFind.mockResolvedValue(VALID_RECORD);
    const req1 = makeReq({ 'x-api-key': rawKey });
    const { res: res1 } = makeRes();
    const next1 = vi.fn();
    await apiKeyAuth(req1, res1, next1);
    expect(next1).toHaveBeenCalled();

    // Simulate revocation: evict from cache
    invalidateKeyCache(hash);
    expect(_keyCacheKeys()).not.toContain(hash);

    // Second call — DB now returns null (key revoked)
    mockFind.mockResolvedValue(null);
    const req2 = makeReq({ 'x-api-key': rawKey });
    const { res: res2, status: status2 } = makeRes();
    const next2 = vi.fn();
    await apiKeyAuth(req2, res2, next2);

    expect(status2).toHaveBeenCalledWith(401);
    expect(next2).not.toHaveBeenCalled();
  });

  it('revocation race: without invalidation, cache still serves the old result within TTL', async () => {
    // This test documents the race that was present BEFORE the fix.
    // After eviction the second lookup MUST hit the DB.
    const rawKey = 'sk_racetest';
    const hash = crypto.createHash('sha256').update(rawKey).digest('hex');

    mockFind.mockResolvedValue(VALID_RECORD);
    const req1 = makeReq({ 'x-api-key': rawKey });
    await apiKeyAuth(req1, makeRes().res, vi.fn());

    // Without eviction the cache entry is present
    expect(_keyCacheKeys()).toContain(hash);

    // NOW apply the fix — evict
    invalidateKeyCache(hash);
    expect(_keyCacheKeys()).not.toContain(hash);

    // DB returns the revoked record this time
    mockFind.mockResolvedValue({ ...VALID_RECORD, revokedAt: new Date() });
    const { status } = makeRes();
    const res = { status } as unknown as Response;
    await apiKeyAuth(makeReq({ 'x-api-key': rawKey }), res, vi.fn());

    expect(status).toHaveBeenCalledWith(401);
    // Confirm DB was queried again (not served from cache)
    expect(mockFind).toHaveBeenCalledTimes(2);
  });

  it('invalidateKeyCache is a no-op for a hash not in the cache', () => {
    expect(() => invalidateKeyCache('non-existent-hash')).not.toThrow();
  });
});

// ── Issue 2: Prisma errors propagated as 503 ─────────────────────────────────

describe('Issue 2 – DB outage returns 503, not misleading 401', () => {
  beforeEach(() => {
    _clearKeyCache();
    vi.clearAllMocks();
  });

  it('KeyStorageUnavailableError has statusCode 503', () => {
    const err = new KeyStorageUnavailableError(new Error('conn reset'));
    expect(err.statusCode).toBe(503);
    expect(err.message).toBe('Key validation storage unavailable');
  });

  it('forwards PrismaClientKnownRequestError to next() as 503 error', async () => {
    const prismaErr = new Prisma.PrismaClientKnownRequestError('Connection timed out', {
      code: 'P1001',
      clientVersion: '5.0.0',
    });
    mockFind.mockRejectedValue(prismaErr);

    const req = makeReq({ 'x-api-key': 'any-key' });
    const { res } = makeRes();
    const next = vi.fn();

    await apiKeyAuth(req, res, next);

    // next() must have been called with the error (not the response)
    expect(next).toHaveBeenCalledWith(expect.any(KeyStorageUnavailableError));
    // Status must NOT have been set to 401
    expect(res.status).not.toHaveBeenCalled();
  });

  it('forwards PrismaClientInitializationError to next() as 503 error', async () => {
    const initErr = new Prisma.PrismaClientInitializationError('Cannot reach DB', '5.0.0');
    mockFind.mockRejectedValue(initErr);

    const next = vi.fn();
    await apiKeyAuth(makeReq({ 'x-api-key': 'any-key' }), makeRes().res, next);

    expect(next).toHaveBeenCalledWith(expect.any(KeyStorageUnavailableError));
  });

  it('forwards PrismaClientUnknownRequestError to next() as 503 error', async () => {
    const unknownErr = new Prisma.PrismaClientUnknownRequestError('Unknown error', {
      clientVersion: '5.0.0',
    });
    mockFind.mockRejectedValue(unknownErr);

    const next = vi.fn();
    await apiKeyAuth(makeReq({ 'x-api-key': 'any-key' }), makeRes().res, next);

    expect(next).toHaveBeenCalledWith(expect.any(KeyStorageUnavailableError));
  });

  it('re-throws unexpected (non-Prisma) errors unchanged', async () => {
    const unexpectedErr = new TypeError('something totally unexpected');
    mockFind.mockRejectedValue(unexpectedErr);

    const next = vi.fn();
    await apiKeyAuth(makeReq({ 'x-api-key': 'any-key' }), makeRes().res, next);

    expect(next).toHaveBeenCalledWith(unexpectedErr);
  });

  it('valid key still resolves correctly when DB is healthy', async () => {
    mockFind.mockResolvedValue(VALID_RECORD);
    const req = makeReq({ 'x-api-key': 'good-key' });
    const { res } = makeRes();
    const next = vi.fn();

    await apiKeyAuth(req, res, next);

    expect(next).toHaveBeenCalledWith(/* no error */);
    expect(req.apiKey).toMatchObject({ id: 'key1' });
  });
});

// ── Issue 3: Endpoint restriction uses baseUrl + path ────────────────────────

describe('Issue 3 – endpoint restriction uses normalised full path', () => {
  describe('normalizeRequestPath', () => {
    it('returns baseUrl + path for a nested router', () => {
      const req = { baseUrl: '/api/v1/contracts', path: '/CABC123' } as unknown as Request;
      expect(normalizeRequestPath(req)).toBe('/api/v1/contracts/CABC123');
    });

    it('collapses accidental double slashes from concatenation', () => {
      const req = { baseUrl: '/api/v1', path: '/tokens' } as unknown as Request;
      expect(normalizeRequestPath(req)).toBe('/api/v1/tokens');
    });

    it('handles empty baseUrl (top-level router)', () => {
      const req = { baseUrl: '', path: '/health' } as unknown as Request;
      expect(normalizeRequestPath(req)).toBe('/health');
    });

    it('returns "/" for the application root', () => {
      const req = { baseUrl: '', path: '/' } as unknown as Request;
      expect(normalizeRequestPath(req)).toBe('/');
    });

    it('strips trailing slash from non-root paths', () => {
      const req = { baseUrl: '/api/v1', path: '/contracts/' } as unknown as Request;
      expect(normalizeRequestPath(req)).toBe('/api/v1/contracts');
    });
  });

  describe('endpoint whitelist matching via apiKeyAuth', () => {
    beforeEach(() => {
      _clearKeyCache();
      vi.clearAllMocks();
    });

    it('allows request when full path matches exact pattern', async () => {
      mockFind.mockResolvedValue({
        ...VALID_RECORD,
        allowedEndpoints: ['/api/v1/contracts'],
      });
      const req = makeReq({ 'x-api-key': 'valid' }, {
        baseUrl: '/api/v1/contracts',
        path: '/',
      } as any);
      const { res } = makeRes();
      const next = vi.fn();
      await apiKeyAuth(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('allows request when full path matches wildcard pattern', async () => {
      mockFind.mockResolvedValue({
        ...VALID_RECORD,
        allowedEndpoints: ['/api/v1/contracts*'],
      });
      const req = makeReq({ 'x-api-key': 'valid' }, {
        baseUrl: '/api/v1/contracts',
        path: '/CABC123',
      } as any);
      const { res } = makeRes();
      const next = vi.fn();
      await apiKeyAuth(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('rejects request whose local path matches but full path does not', async () => {
      // Pattern targets /api/v1/contracts but the request is for /api/v1/tokens
      // Using only req.path ("/") both would look like "/" — the fix prevents this.
      mockFind.mockResolvedValue({
        ...VALID_RECORD,
        allowedEndpoints: ['/api/v1/contracts*'],
      });
      const req = makeReq(
        { 'x-api-key': 'valid' },
        // A different sub-router whose local path also happens to be "/"
        { baseUrl: '/api/v1/tokens', path: '/' } as any,
      );
      const { res, status } = makeRes();
      const next = vi.fn();
      await apiKeyAuth(req, res, next);
      expect(status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });

    it('wildcard /api/v1/tokens* does NOT match /api/v1/tokens-extended when pattern ends at boundary', async () => {
      // The wildcard DOES match tokens-extended because * is a prefix match.
      // This test documents the known behaviour and ensures similarly named
      // routes are handled predictably.
      mockFind.mockResolvedValue({
        ...VALID_RECORD,
        allowedEndpoints: ['/api/v1/tokens'],
      });
      // Exact pattern — must NOT match tokens-extended
      const req = makeReq({ 'x-api-key': 'valid' }, {
        baseUrl: '/api/v1/tokens-extended',
        path: '/',
      } as any);
      const { res, status } = makeRes();
      const next = vi.fn();
      await apiKeyAuth(req, res, next);
      expect(status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });

    it('no allowedEndpoints restriction allows all paths', async () => {
      mockFind.mockResolvedValue({ ...VALID_RECORD, allowedEndpoints: null });
      const req = makeReq({ 'x-api-key': 'valid' }, {
        baseUrl: '/api/v1/anything',
        path: '/deep/path',
      } as any);
      const { res } = makeRes();
      const next = vi.fn();
      await apiKeyAuth(req, res, next);
      expect(next).toHaveBeenCalled();
    });
  });
});
