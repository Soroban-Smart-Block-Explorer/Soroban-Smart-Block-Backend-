/**
 * Response Envelope Middleware Tests
 *
 * Tests for consistent response format middleware that wraps all responses
 * with metadata including request ID and timestamp.
 */

import { describe, it, expect, vi, type Mock } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import { responseEnvelopeMiddleware } from '../src/middleware/responseEnvelope';
import { randomUUID } from 'crypto';

function mockRes(): Response {
  const res = {
    json: vi.fn().mockReturnThis(),
    status: vi.fn().mockReturnThis(),
  } as unknown as Response;
  return res;
}

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    requestId: randomUUID(),
    ...overrides,
  } as Request;
}

function mockNext(): NextFunction {
  return vi.fn();
}

describe('Response Envelope Middleware', () => {
  describe('middleware initialization', () => {
    it('attaches sendEnveloped method to response', () => {
      const req = mockReq();
      const res = mockRes();
      const next = mockNext();

      responseEnvelopeMiddleware(req, res, next);

      expect((res as any).sendEnveloped).toBeDefined();
      expect(typeof (res as any).sendEnveloped).toBe('function');
    });

    it('attaches sendPaginated method to response', () => {
      const req = mockReq();
      const res = mockRes();
      const next = mockNext();

      responseEnvelopeMiddleware(req, res, next);

      expect((res as any).sendPaginated).toBeDefined();
      expect(typeof (res as any).sendPaginated).toBe('function');
    });

    it('attaches sendCursorPaginated method to response', () => {
      const req = mockReq();
      const res = mockRes();
      const next = mockNext();

      responseEnvelopeMiddleware(req, res, next);

      expect((res as any).sendCursorPaginated).toBeDefined();
      expect(typeof (res as any).sendCursorPaginated).toBe('function');
    });

    it('calls next() to continue middleware chain', () => {
      const req = mockReq();
      const res = mockRes();
      const next = mockNext();

      responseEnvelopeMiddleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe('sendEnveloped', () => {
    it('wraps data in envelope format', () => {
      const req = mockReq();
      const res = mockRes();
      const next: NextFunction = () => {
        const data = { id: 1, name: 'Item' };
        (res as any).sendEnveloped(data);

        const jsonCall = (res.json as Mock).mock.calls[0][0];
        expect(jsonCall.success).toBe(true);
        expect(jsonCall.data).toEqual(data);
        expect(jsonCall.meta).toBeDefined();
      };

      responseEnvelopeMiddleware(req, res, next);
    });

    it('includes requestId from request', () => {
      const requestId = randomUUID();
      const req = mockReq({ requestId });
      const res = mockRes();
      const next: NextFunction = () => {
        (res as any).sendEnveloped({ id: 1 });

        const jsonCall = (res.json as Mock).mock.calls[0][0];
        expect(jsonCall.meta.requestId).toBe(requestId);
      };

      responseEnvelopeMiddleware(req, res, next);
    });

    it('includes ISO 8601 timestamp', () => {
      const req = mockReq();
      const res = mockRes();
      const next: NextFunction = () => {
        (res as any).sendEnveloped({ id: 1 });

        const jsonCall = (res.json as Mock).mock.calls[0][0];
        const timestamp = jsonCall.meta.timestamp;

        expect(timestamp).toBeDefined();
        expect(typeof timestamp).toBe('string');
        // Verify ISO 8601 format
        expect(new Date(timestamp).toISOString()).toBe(timestamp);
      };

      responseEnvelopeMiddleware(req, res, next);
    });

    it('accepts optional status code', () => {
      const req = mockReq();
      const res = mockRes();
      const next: NextFunction = () => {
        (res as any).sendEnveloped({ id: 1 }, 201);

        expect(res.status).toHaveBeenCalledWith(201);
      };

      responseEnvelopeMiddleware(req, res, next);
    });

    it('returns response chain for method chaining', () => {
      const req = mockReq();
      const res = mockRes();
      const next: NextFunction = () => {
        const result = (res as any).sendEnveloped({ id: 1 });
        expect(result).toBe(res);
      };

      responseEnvelopeMiddleware(req, res, next);
    });

    it('handles different data types', () => {
      const req = mockReq();
      const res = mockRes();
      const next: NextFunction = () => {
        // Array
        (res as any).sendEnveloped([1, 2, 3]);
        expect((res.json as Mock).mock.calls[0][0].data).toEqual([1, 2, 3]);

        // Object
        (res as any).sendEnveloped({ key: 'value' });
        expect((res.json as Mock).mock.calls[1][0].data).toEqual({ key: 'value' });

        // Null
        (res as any).sendEnveloped(null);
        expect((res.json as Mock).mock.calls[2][0].data).toBeNull();

        // String
        (res as any).sendEnveloped('test');
        expect((res.json as Mock).mock.calls[3][0].data).toBe('test');
      };

      responseEnvelopeMiddleware(req, res, next);
    });
  });

  describe('sendPaginated', () => {
    it('includes pagination metadata', () => {
      const req = mockReq();
      const res = mockRes();
      const next: NextFunction = () => {
        const data = [{ id: 1 }, { id: 2 }];
        (res as any).sendPaginated(data, { total: 100, page: 1, limit: 20 });

        const jsonCall = (res.json as Mock).mock.calls[0][0];
        expect(jsonCall.meta.pagination).toBeDefined();
        expect(jsonCall.meta.pagination.total).toBe(100);
        expect(jsonCall.meta.pagination.page).toBe(1);
        expect(jsonCall.meta.pagination.limit).toBe(20);
      };

      responseEnvelopeMiddleware(req, res, next);
    });

    it('calculates pages automatically', () => {
      const req = mockReq();
      const res = mockRes();
      const next: NextFunction = () => {
        (res as any).sendPaginated([], { total: 100, page: 1, limit: 20 });

        const jsonCall = (res.json as Mock).mock.calls[0][0];
        expect(jsonCall.meta.pagination.pages).toBe(5); // Math.ceil(100/20)
      };

      responseEnvelopeMiddleware(req, res, next);
    });

    it('includes requestId and timestamp', () => {
      const requestId = randomUUID();
      const req = mockReq({ requestId });
      const res = mockRes();
      const next: NextFunction = () => {
        (res as any).sendPaginated([], { total: 100, page: 1, limit: 20 });

        const jsonCall = (res.json as Mock).mock.calls[0][0];
        expect(jsonCall.meta.requestId).toBe(requestId);
        expect(jsonCall.meta.timestamp).toBeDefined();
      };

      responseEnvelopeMiddleware(req, res, next);
    });

    it('returns response for chaining', () => {
      const req = mockReq();
      const res = mockRes();
      const next: NextFunction = () => {
        const result = (res as any).sendPaginated([], { total: 10, page: 1, limit: 5 });
        expect(result).toBe(res);
      };

      responseEnvelopeMiddleware(req, res, next);
    });
  });

  describe('sendCursorPaginated', () => {
    it('includes cursor metadata', () => {
      const req = mockReq();
      const res = mockRes();
      const next: NextFunction = () => {
        (res as any).sendCursorPaginated([{ id: 1 }], { next: 'cursor123', hasMore: true });

        const jsonCall = (res.json as Mock).mock.calls[0][0];
        expect(jsonCall.meta.cursor).toBeDefined();
        expect(jsonCall.meta.cursor.next).toBe('cursor123');
        expect(jsonCall.meta.cursor.hasMore).toBe(true);
      };

      responseEnvelopeMiddleware(req, res, next);
    });

    it('handles null cursor', () => {
      const req = mockReq();
      const res = mockRes();
      const next: NextFunction = () => {
        (res as any).sendCursorPaginated([{ id: 1 }], { next: null, hasMore: false });

        const jsonCall = (res.json as Mock).mock.calls[0][0];
        expect(jsonCall.meta.cursor.next).toBeNull();
        expect(jsonCall.meta.cursor.hasMore).toBe(false);
      };

      responseEnvelopeMiddleware(req, res, next);
    });

    it('handles undefined cursor', () => {
      const req = mockReq();
      const res = mockRes();
      const next: NextFunction = () => {
        (res as any).sendCursorPaginated([{ id: 1 }], { next: undefined, hasMore: false });

        const jsonCall = (res.json as Mock).mock.calls[0][0];
        expect(jsonCall.meta.cursor.next).toBeNull();
        expect(jsonCall.meta.cursor.hasMore).toBe(false);
      };

      responseEnvelopeMiddleware(req, res, next);
    });

    it('includes requestId and timestamp', () => {
      const requestId = randomUUID();
      const req = mockReq({ requestId });
      const res = mockRes();
      const next: NextFunction = () => {
        (res as any).sendCursorPaginated([], { next: null, hasMore: false });

        const jsonCall = (res.json as Mock).mock.calls[0][0];
        expect(jsonCall.meta.requestId).toBe(requestId);
        expect(jsonCall.meta.timestamp).toBeDefined();
      };

      responseEnvelopeMiddleware(req, res, next);
    });

    it('returns response for chaining', () => {
      const req = mockReq();
      const res = mockRes();
      const next: NextFunction = () => {
        const result = (res as any).sendCursorPaginated([], { next: null, hasMore: false });
        expect(result).toBe(res);
      };

      responseEnvelopeMiddleware(req, res, next);
    });
  });

  describe('requestId resolution', () => {
    it('uses requestId from req object', () => {
      const requestId = randomUUID();
      const req = mockReq({ requestId });
      const res = mockRes();
      const next: NextFunction = () => {
        (res as any).sendEnveloped({});

        const jsonCall = (res.json as Mock).mock.calls[0][0];
        expect(jsonCall.meta.requestId).toBe(requestId);
      };

      responseEnvelopeMiddleware(req, res, next);
    });

    it('falls back to unknown if requestId not available', () => {
      const req = mockReq({ requestId: undefined });
      const res = mockRes();
      const next: NextFunction = () => {
        (res as any).sendEnveloped({});

        const jsonCall = (res.json as Mock).mock.calls[0][0];
        expect(jsonCall.meta.requestId).toBe('unknown');
      };

      responseEnvelopeMiddleware(req, res, next);
    });
  });

  describe('response structure', () => {
    it('always includes success flag', () => {
      const req = mockReq();
      const res = mockRes();
      const next: NextFunction = () => {
        (res as any).sendEnveloped({});

        const jsonCall = (res.json as Mock).mock.calls[0][0];
        expect(jsonCall.success).toBe(true);
      };

      responseEnvelopeMiddleware(req, res, next);
    });

    it('includes data field', () => {
      const req = mockReq();
      const res = mockRes();
      const next: NextFunction = () => {
        const data = { test: 'value' };
        (res as any).sendEnveloped(data);

        const jsonCall = (res.json as Mock).mock.calls[0][0];
        expect(jsonCall.data).toEqual(data);
      };

      responseEnvelopeMiddleware(req, res, next);
    });

    it('includes meta object with requestId and timestamp', () => {
      const req = mockReq();
      const res = mockRes();
      const next: NextFunction = () => {
        (res as any).sendEnveloped({});

        const jsonCall = (res.json as Mock).mock.calls[0][0];
        expect(jsonCall.meta).toBeDefined();
        expect(jsonCall.meta.requestId).toBeDefined();
        expect(jsonCall.meta.timestamp).toBeDefined();
      };

      responseEnvelopeMiddleware(req, res, next);
    });

    it('envelope has correct structure', () => {
      const req = mockReq();
      const res = mockRes();
      const next: NextFunction = () => {
        (res as any).sendEnveloped({ id: 1 });

        const jsonCall = (res.json as Mock).mock.calls[0][0];
        const keys = Object.keys(jsonCall).sort();
        expect(keys).toContain('success');
        expect(keys).toContain('data');
        expect(keys).toContain('meta');
      };

      responseEnvelopeMiddleware(req, res, next);
    });
  });

  describe('pagination edge cases', () => {
    it('handles single page pagination', () => {
      const req = mockReq();
      const res = mockRes();
      const next: NextFunction = () => {
        (res as any).sendPaginated([{ id: 1 }], { total: 5, page: 1, limit: 20 });

        const jsonCall = (res.json as Mock).mock.calls[0][0];
        expect(jsonCall.meta.pagination.pages).toBe(1);
      };

      responseEnvelopeMiddleware(req, res, next);
    });

    it('handles large pagination values', () => {
      const req = mockReq();
      const res = mockRes();
      const next: NextFunction = () => {
        (res as any).sendPaginated([], { total: 1000000, page: 500, limit: 100 });

        const jsonCall = (res.json as Mock).mock.calls[0][0];
        expect(jsonCall.meta.pagination.pages).toBe(10000);
      };

      responseEnvelopeMiddleware(req, res, next);
    });

    it('handles cursor with empty results', () => {
      const req = mockReq();
      const res = mockRes();
      const next: NextFunction = () => {
        (res as any).sendCursorPaginated([], { next: null, hasMore: false });

        const jsonCall = (res.json as Mock).mock.calls[0][0];
        expect(jsonCall.data).toEqual([]);
        expect(jsonCall.meta.cursor.hasMore).toBe(false);
      };

      responseEnvelopeMiddleware(req, res, next);
    });
  });
});
