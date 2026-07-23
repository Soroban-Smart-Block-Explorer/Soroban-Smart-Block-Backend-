import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

// Mock prisma before module import
vi.mock('../src/db', () => ({
  prismaRead: { devApiKey: { findFirst: vi.fn() } },
  prismaWrite: { devApiKey: { update: vi.fn().mockResolvedValue(null) } },
}));
vi.mock('../src/logger', () => ({ logger: { warn: vi.fn() } }));

import {
  apiKeyAuth,
  requireApiKey,
  requireKeyTier,
  _keyCacheKeys,
  _clearKeyCache,
} from '../src/middleware/apiKeyAuth';
import { prismaRead } from '../src/db';
import crypto from 'crypto';

const mockFind = (prismaRead as any).devApiKey.findFirst as ReturnType<typeof vi.fn>;

function makeReq(headers: Record<string, string> = {}, extras: Partial<Request> = {}): Request {
  return { headers, ip: '10.0.0.1', path: '/api/test', ...extras } as unknown as Request;
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

describe('apiKeyAuth', () => {
  let next: NextFunction;

  beforeEach(() => {
    next = vi.fn();
    mockFind.mockResolvedValue(null);
    vi.clearAllMocks();
    _clearKeyCache();
  });

  it('calls next without setting apiKey when no header present', async () => {
    const req = makeReq();
    const { res } = makeRes();
    await apiKeyAuth(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.apiKey).toBeUndefined();
  });

  it('returns 401 for unknown/invalid key', async () => {
    mockFind.mockResolvedValue(null);
    const req = makeReq({ 'x-api-key': 'bad-key' });
    const { res, status } = makeRes();
    await apiKeyAuth(req, res, next);
    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('attaches apiKey to req on valid key', async () => {
    mockFind.mockResolvedValue(VALID_RECORD);
    const req = makeReq({ 'x-api-key': 'valid-key' });
    const { res } = makeRes();
    await apiKeyAuth(req, res, next);
    expect(req.apiKey).toMatchObject({ id: 'key1', tier: 'developer' });
    expect(next).toHaveBeenCalled();
  });

  it('returns 401 for revoked key', async () => {
    mockFind.mockResolvedValue({ ...VALID_RECORD, revokedAt: new Date() });
    const req = makeReq({ 'x-api-key': 'revoked' });
    const { res, status } = makeRes();
    await apiKeyAuth(req, res, next);
    expect(status).toHaveBeenCalledWith(401);
  });

  it('returns 401 for expired key', async () => {
    mockFind.mockResolvedValue({ ...VALID_RECORD, expiresAt: new Date(0) });
    const req = makeReq({ 'x-api-key': 'expired' });
    const { res, status } = makeRes();
    await apiKeyAuth(req, res, next);
    expect(status).toHaveBeenCalledWith(401);
  });

  it('returns 403 when IP not in whitelist', async () => {
    mockFind.mockResolvedValue({ ...VALID_RECORD, allowedIps: ['192.168.1.1'] });
    const req = makeReq({ 'x-api-key': 'valid' }, { ip: '10.0.0.1' } as any);
    const { res, status } = makeRes();
    await apiKeyAuth(req, res, next);
    expect(status).toHaveBeenCalledWith(403);
  });

  describe('domain whitelist', () => {
    const DOMAIN_RECORD = { ...VALID_RECORD, allowedDomains: ['example.com'] };

    it('allows request when Origin matches allowedDomains', async () => {
      mockFind.mockResolvedValue(DOMAIN_RECORD);
      const req = makeReq({ 'x-api-key': 'valid', origin: 'https://example.com' });
      const { res } = makeRes();
      await apiKeyAuth(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('allows request when Referer hostname matches allowedDomains (fallback)', async () => {
      mockFind.mockResolvedValue(DOMAIN_RECORD);
      const req = makeReq({
        'x-api-key': 'valid',
        referer: 'https://example.com/some/path?q=1',
      });
      const { res } = makeRes();
      await apiKeyAuth(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('returns 403 when Origin does not match allowedDomains', async () => {
      mockFind.mockResolvedValue(DOMAIN_RECORD);
      const req = makeReq({ 'x-api-key': 'valid', origin: 'https://evil.com' });
      const { res, status } = makeRes();
      await apiKeyAuth(req, res, next);
      expect(status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 403 when neither Origin nor Referer header is present', async () => {
      mockFind.mockResolvedValue(DOMAIN_RECORD);
      const req = makeReq({ 'x-api-key': 'valid' });
      const { res, status } = makeRes();
      await apiKeyAuth(req, res, next);
      expect(status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });

    it('allows request when no domain restriction is configured', async () => {
      mockFind.mockResolvedValue(VALID_RECORD); // allowedDomains: null
      const req = makeReq({ 'x-api-key': 'valid', origin: 'https://any-domain.io' });
      const { res } = makeRes();
      await apiKeyAuth(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('wildcard *.example.com matches sub.example.com', async () => {
      mockFind.mockResolvedValue({ ...VALID_RECORD, allowedDomains: ['*.example.com'] });
      const req = makeReq({ 'x-api-key': 'valid', origin: 'https://app.example.com' });
      const { res } = makeRes();
      await apiKeyAuth(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('wildcard *.example.com does NOT match bare example.com', async () => {
      mockFind.mockResolvedValue({ ...VALID_RECORD, allowedDomains: ['*.example.com'] });
      const req = makeReq({ 'x-api-key': 'valid', origin: 'https://example.com' });
      const { res, status } = makeRes();
      await apiKeyAuth(req, res, next);
      expect(status).toHaveBeenCalledWith(403);
    });

    it('prefers Origin header over Referer when both are present', async () => {
      mockFind.mockResolvedValue(DOMAIN_RECORD);
      const req = makeReq({
        'x-api-key': 'valid',
        origin: 'https://example.com',
        referer: 'https://evil.com/page',
      });
      const { res } = makeRes();
      await apiKeyAuth(req, res, next);
      expect(next).toHaveBeenCalled();
    });
  });

  it('returns 403 when endpoint not in whitelist', async () => {
    mockFind.mockResolvedValue({ ...VALID_RECORD, allowedEndpoints: ['/api/allowed'] });
    const req = makeReq({ 'x-api-key': 'valid' }, {
      ip: '10.0.0.1',
      path: '/api/forbidden',
    } as any);
    const { res, status } = makeRes();
    await apiKeyAuth(req, res, next);
    expect(status).toHaveBeenCalledWith(403);
  });

  // Security: auth bypass attempts
  it('handles extremely long api key without crashing', async () => {
    const req = makeReq({ 'x-api-key': 'x'.repeat(10000) });
    const { res } = makeRes();
    await expect(apiKeyAuth(req, res, next)).resolves.not.toThrow();
  });

  it('handles key with SQL injection characters gracefully', async () => {
    const req = makeReq({ 'x-api-key': "'; DROP TABLE devApiKey;--" });
    const { res, status } = makeRes();
    await apiKeyAuth(req, res, next);
    // Should hash the key and do a safe DB lookup — not crash
    expect(status).toHaveBeenCalledWith(401);
  });

  it('stores only SHA-256 hash in cache, never the raw credential', async () => {
    const rawKey = 'super-secret-api-key-do-not-store';
    mockFind.mockResolvedValue(VALID_RECORD);
    const req = makeReq({ 'x-api-key': rawKey });
    const { res } = makeRes();
    await apiKeyAuth(req, res, next);

    const cacheKeys = _keyCacheKeys();
    const expectedHash = crypto.createHash('sha256').update(rawKey).digest('hex');

    expect(cacheKeys).not.toContain(rawKey);
    expect(cacheKeys).toContain(expectedHash);
  });
});

describe('requireApiKey', () => {
  it('calls next when apiKey is set', () => {
    const req = { apiKey: { id: '1' } } as unknown as Request;
    const next = vi.fn() as NextFunction;
    requireApiKey(req, {} as Response, next);
    expect(next).toHaveBeenCalled();
  });

  it('returns 401 when apiKey is absent', () => {
    const json = vi.fn();
    const status = vi.fn().mockReturnValue({ json });
    requireApiKey({} as Request, { status } as unknown as Response, vi.fn() as NextFunction);
    expect(status).toHaveBeenCalledWith(401);
  });
});

describe('requireKeyTier', () => {
  it('passes when tier meets minimum', () => {
    const req = { apiKey: { tier: 'pro' } } as unknown as Request;
    const next = vi.fn() as NextFunction;
    requireKeyTier('developer')(req, {} as Response, next);
    expect(next).toHaveBeenCalled();
  });

  it('returns 403 when tier is below minimum', () => {
    const json = vi.fn();
    const status = vi.fn().mockReturnValue({ json });
    const req = { apiKey: { tier: 'free' } } as unknown as Request;
    requireKeyTier('pro')(req, { status } as unknown as Response, vi.fn() as NextFunction);
    expect(status).toHaveBeenCalledWith(403);
  });
});
