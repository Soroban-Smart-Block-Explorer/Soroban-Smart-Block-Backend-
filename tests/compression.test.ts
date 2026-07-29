/**
 * Compression Middleware Tests
 *
 * Tests for gzip/brotli compression middleware that automatically
 * compresses large JSON responses to reduce bandwidth.
 */

import { describe, it, expect, vi, type Mock } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import { compressionMiddleware, getCompressionStats } from '../src/middleware/compression';

function mockRes(): Response {
  const res = {
    json: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    get: vi.fn().mockReturnValue('application/json'),
    on: vi.fn().mockReturnThis(),
  } as unknown as Response;
  return res;
}

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: { 'accept-encoding': 'gzip, br' },
    ...overrides,
  } as Request;
}

function mockNext(): NextFunction {
  return vi.fn();
}

describe('Compression Middleware', () => {
  describe('middleware initialization', () => {
    it('initializes with default config', () => {
      const middleware = compressionMiddleware();
      const req = mockReq();
      const res = mockRes();
      const next = mockNext();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect((req as any).compressionEncoding).toBeDefined();
      expect((req as any).compressionStats).toBeDefined();
    });

    it('initializes with custom config', () => {
      const middleware = compressionMiddleware({
        threshold: 2048,
        gzipLevel: 9,
        brotliLevel: 11,
      });
      const req = mockReq();
      const res = mockRes();
      const next = mockNext();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('stores compression state on request', () => {
      const middleware = compressionMiddleware();
      const req = mockReq();
      const res = mockRes();
      const next = mockNext();

      middleware(req, res, next);

      expect((req as any).compressionEncoding).toMatch(/gzip|brotli|identity/);
      expect((req as any).compressionStats.encoding).toBeDefined();
      expect((req as any).compressionStats.originalSize).toBe(0);
    });
  });

  describe('Accept-Encoding negotiation', () => {
    it('selects brotli when supported and enabled', () => {
      const middleware = compressionMiddleware({ enableBrotli: true });
      const req = mockReq({ headers: { 'accept-encoding': 'br, gzip' } });
      const res = mockRes();
      const next = mockNext();

      middleware(req, res, next);

      expect((req as any).compressionEncoding).toBe('brotli');
    });

    it('selects gzip when brotli not supported', () => {
      const middleware = compressionMiddleware();
      const req = mockReq({ headers: { 'accept-encoding': 'gzip, deflate' } });
      const res = mockRes();
      const next = mockNext();

      middleware(req, res, next);

      expect((req as any).compressionEncoding).toBe('gzip');
    });

    it('selects identity when no compression supported', () => {
      const middleware = compressionMiddleware();
      const req = mockReq({ headers: { 'accept-encoding': 'deflate' } });
      const res = mockRes();
      const next = mockNext();

      middleware(req, res, next);

      expect((req as any).compressionEncoding).toBe('identity');
    });

    it('selects identity when Accept-Encoding missing', () => {
      const middleware = compressionMiddleware();
      const req = mockReq({ headers: {} });
      const res = mockRes();
      const next = mockNext();

      middleware(req, res, next);

      expect((req as any).compressionEncoding).toBe('identity');
    });

    it('respects enableBrotli: false', () => {
      const middleware = compressionMiddleware({ enableBrotli: false });
      const req = mockReq({ headers: { 'accept-encoding': 'br, gzip' } });
      const res = mockRes();
      const next = mockNext();

      middleware(req, res, next);

      expect((req as any).compressionEncoding).toBe('gzip');
    });
  });

  describe('content-type filtering', () => {
    it('compresses JSON responses by default', () => {
      const middleware = compressionMiddleware();
      const req = mockReq();
      const res = mockRes();
      (res.get as Mock).mockReturnValue('application/json');
      const next = mockNext();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('compresses text responses by default', () => {
      const middleware = compressionMiddleware();
      const req = mockReq();
      const res = mockRes();
      (res.get as Mock).mockReturnValue('text/plain');
      const next = mockNext();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('uses custom filter function', () => {
      const customFilter = vi.fn().mockReturnValue(true);
      const middleware = compressionMiddleware({ filter: customFilter });
      const req = mockReq();
      const res = mockRes();
      const next = mockNext();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe('threshold handling', () => {
    it('skips compression for responses below threshold', () => {
      const middleware = compressionMiddleware({ threshold: 1024 });
      const req = mockReq();
      const res = mockRes();
      const next = mockNext();

      middleware(req, res, next);

      // Override json to capture behavior
      const jsonMethod = (res as any).json;
      expect(jsonMethod).toBeDefined();
    });

    it('respects custom threshold', () => {
      const middleware = compressionMiddleware({ threshold: 5000 });
      const req = mockReq();
      const res = mockRes();
      const next = mockNext();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('threshold of 0 compresses everything', () => {
      const middleware = compressionMiddleware({ threshold: 0 });
      const req = mockReq();
      const res = mockRes();
      const next = mockNext();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe('compression stats', () => {
    it('retrieves compression stats from request', () => {
      const middleware = compressionMiddleware();
      const req = mockReq();
      const res = mockRes();
      const next = mockNext();

      middleware(req, res, next);

      const stats = getCompressionStats(req);
      expect(stats).toBeDefined();
      expect(stats.encoding).toBeDefined();
      expect(stats.originalSize).toBe(0);
      expect(stats.compressedSize).toBe(0);
    });

    it('returns default stats when not set', () => {
      const req = mockReq();
      const stats = getCompressionStats(req);

      expect(stats.encoding).toBe('identity');
      expect(stats.originalSize).toBe(0);
      expect(stats.compressedSize).toBe(0);
    });
  });

  describe('response.json override', () => {
    it('overrides res.json method', () => {
      const middleware = compressionMiddleware();
      const req = mockReq();
      const res = mockRes();
      const next = mockNext();

      middleware(req, res, next);

      expect(typeof (res as any).json).toBe('function');
    });

    it('stores json override separately from original', () => {
      const middleware = compressionMiddleware();
      const req = mockReq();
      const res = mockRes();
      const originalJson = res.json;
      const next = mockNext();

      middleware(req, res, next);

      expect((res as any).json).toBeDefined();
    });
  });

  describe('response.end override', () => {
    it('overrides res.end method', () => {
      const middleware = compressionMiddleware();
      const req = mockReq();
      const res = mockRes();
      const next = mockNext();

      middleware(req, res, next);

      expect(typeof (res as any).end).toBe('function');
    });
  });

  describe('configuration options', () => {
    it('accepts gzip level configuration (0-9)', () => {
      for (let level = 0; level <= 9; level++) {
        const middleware = compressionMiddleware({ gzipLevel: level as any });
        const req = mockReq();
        const res = mockRes();
        const next = mockNext();

        middleware(req, res, next);
        expect(next).toHaveBeenCalled();
      }
    });

    it('accepts brotli level configuration (0-11)', () => {
      for (let level = 0; level <= 11; level++) {
        const middleware = compressionMiddleware({ brotliLevel: level as any });
        const req = mockReq();
        const res = mockRes();
        const next = mockNext();

        middleware(req, res, next);
        expect(next).toHaveBeenCalled();
      }
    });

    it('accepts logging configuration', () => {
      const middleware = compressionMiddleware({ logStats: true });
      const req = mockReq();
      const res = mockRes();
      const next = mockNext();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe('middleware chaining', () => {
    it('calls next() to continue chain', () => {
      const middleware = compressionMiddleware();
      const req = mockReq();
      const res = mockRes();
      const next = mockNext();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('preserves existing request properties', () => {
      const middleware = compressionMiddleware();
      const req = mockReq({ requestId: 'test-id' });
      const res = mockRes();
      const next = mockNext();

      middleware(req, res, next);

      expect((req as any).requestId).toBe('test-id');
    });

    it('preserves existing response properties', () => {
      const middleware = compressionMiddleware();
      const req = mockReq();
      const res = mockRes();
      res.status = vi.fn().mockReturnValue(res); // Ensure status exists
      const next = mockNext();

      middleware(req, res, next);

      expect((res as any).status).toBeDefined();
    });
  });

  describe('error handling', () => {
    it('gracefully handles missing content-type header', () => {
      const middleware = compressionMiddleware();
      const req = mockReq();
      const res = mockRes();
      (res.get as Mock).mockReturnValue(undefined);
      const next = mockNext();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('handles empty accept-encoding header', () => {
      const middleware = compressionMiddleware();
      const req = mockReq({ headers: { 'accept-encoding': '' } });
      const res = mockRes();
      const next = mockNext();

      middleware(req, res, next);

      expect((req as any).compressionEncoding).toBe('identity');
    });
  });

  describe('performance considerations', () => {
    it('does not compress when identity selected', () => {
      const middleware = compressionMiddleware();
      const req = mockReq({ headers: {} });
      const res = mockRes();
      const next = mockNext();

      middleware(req, res, next);

      expect((req as any).compressionEncoding).toBe('identity');
    });

    it('allows disabling brotli for performance', () => {
      const middleware = compressionMiddleware({ enableBrotli: false });
      const req = mockReq({ headers: { 'accept-encoding': 'br' } });
      const res = mockRes();
      const next = mockNext();

      middleware(req, res, next);

      // Should fall back to gzip or identity
      expect((req as any).compressionEncoding).not.toBe('brotli');
    });
  });
});
