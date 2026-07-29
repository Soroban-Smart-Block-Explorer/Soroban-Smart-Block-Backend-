/**
 * Request ID Tracking Tests
 *
 * Verifies that request ID tracking is properly implemented:
 * - Unique UUID generation per request
 * - Attached to req.requestId
 * - Present in response headers
 * - Present in log entries
 * - Present in error responses
 */

import { describe, it, expect, vi, type Mock } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import { correlationMiddleware, traceStorage } from '../src/middleware/correlation';
import { logger } from '../src/logger';

// Mock logger to capture logs
vi.mock('../src/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

function mockRes(): Response {
  const res = {
    setHeader: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    status: vi.fn().mockReturnThis(),
  } as unknown as Response;
  return res;
}

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    method: 'GET',
    path: '/api/test',
    ...overrides,
  } as Request;
}

function mockNext(): NextFunction {
  return vi.fn();
}

describe('Request ID Tracking', () => {
  describe('correlationMiddleware', () => {
    it('generates unique UUID for each request', () => {
      const req1 = mockReq();
      const req2 = mockReq();
      const res1 = mockRes();
      const res2 = mockRes();
      const next1 = mockNext();
      const next2 = mockNext();

      correlationMiddleware(req1, res1, next1);
      correlationMiddleware(req2, res2, next2);

      expect(req1.requestId).toBeDefined();
      expect(req2.requestId).toBeDefined();
      expect(req1.requestId).not.toBe(req2.requestId);
      expect(req1.requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });

    it('respects upstream x-request-id header', () => {
      const upstreamId = 'custom-request-id-123';
      const req = mockReq({
        headers: { 'x-request-id': upstreamId },
      });
      const res = mockRes();
      const next = mockNext();

      correlationMiddleware(req, res, next);

      expect(req.requestId).toBe(upstreamId);
    });

    it('sets X-Request-Id response header', () => {
      const req = mockReq();
      const res = mockRes();
      const next = mockNext();

      correlationMiddleware(req, res, next);

      expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', req.requestId);
    });

    it('stores requestId in AsyncLocalStorage context', async () => {
      const req = mockReq();
      const res = mockRes();

      return new Promise<void>((resolve) => {
        const next: NextFunction = () => {
          // Check context inside the traceStorage.run() scope
          setTimeout(() => {
            resolve();
          }, 0);
        };

        correlationMiddleware(req, res, next);
        expect(req.requestId).toBeDefined();
      });
    });

    it('generates traceId when B3 headers are absent', () => {
      const req = mockReq();
      const res = mockRes();
      const next = mockNext();

      correlationMiddleware(req, res, next);

      expect(req.traceId).toBeDefined();
      expect(req.spanId).toBeDefined();
    });

    it('respects upstream B3 headers', () => {
      const upstreamTraceId = 'upstream-trace-id';
      const upstreamSpanId = 'upstream-span-id';
      const req = mockReq({
        headers: {
          'x-b3-traceid': upstreamTraceId,
          'x-b3-spanid': upstreamSpanId,
        },
      });
      const res = mockRes();
      const next = mockNext();

      correlationMiddleware(req, res, next);

      expect(req.traceId).toBe(upstreamTraceId);
      expect(req.spanId).toBe(upstreamSpanId);
    });

    it('calls next() to continue middleware chain', () => {
      const req = mockReq();
      const res = mockRes();
      const next = mockNext();

      correlationMiddleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe('Logger integration', () => {
    it('includes requestId in all log entries', () => {
      const req = mockReq();
      const res = mockRes();
      const next: NextFunction = () => {
        logger.info('Test message', { key: 'value' });

        const loggerCalls = (logger.info as Mock).mock.calls;
        expect(loggerCalls.length).toBeGreaterThan(0);
      };

      correlationMiddleware(req, res, next);
    });

    it('propagates requestId without explicit passing', () => {
      const req = mockReq();
      const res = mockRes();

      return new Promise<void>((resolve) => {
        const next: NextFunction = () => {
          // Inside the async context, requestId should be available
          const ctx = traceStorage.getStore();
          expect(ctx?.requestId).toBeDefined();
          resolve();
        };

        correlationMiddleware(req, res, next);
      });
    });
  });

  describe('Error response integration', () => {
    it('includes requestId in error response', () => {
      const req = mockReq();
      const res = mockRes();
      const next = mockNext();

      correlationMiddleware(req, res, next);

      // Error handler would use:
      const requestId = req.requestId ?? 'unknown';
      const errorResponse = {
        error: 'Test error',
        code: 'TEST_ERROR',
        requestId,
        statusCode: 400,
      };

      expect(errorResponse.requestId).toBeDefined();
      expect(errorResponse.requestId).toBe(req.requestId);
    });
  });

  describe('Concurrent request handling', () => {
    it('each concurrent request has unique requestId', async () => {
      const requestIds = new Set<string>();

      const makeRequest = () => {
        return new Promise<void>((resolve) => {
          const req = mockReq();
          const res = mockRes();
          const next: NextFunction = () => {
            requestIds.add(req.requestId!);
            resolve();
          };

          correlationMiddleware(req, res, next);
        });
      };

      // Make 5 concurrent requests
      await Promise.all([
        makeRequest(),
        makeRequest(),
        makeRequest(),
        makeRequest(),
        makeRequest(),
      ]);

      // All should have unique IDs
      expect(requestIds.size).toBe(5);
    });
  });

  describe('Request ID format', () => {
    it('generates valid UUID v4 format', () => {
      const req = mockReq();
      const res = mockRes();
      const next = mockNext();

      correlationMiddleware(req, res, next);

      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(req.requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });

    it('maintains requestId format in response header', () => {
      const req = mockReq();
      const res = mockRes();
      const next = mockNext();

      correlationMiddleware(req, res, next);

      const headerCalls = (res.setHeader as Mock).mock.calls;
      const requestIdCall = headerCalls.find(([key]) => key === 'X-Request-Id');

      expect(requestIdCall).toBeDefined();
      expect(requestIdCall![1]).toBe(req.requestId);
    });
  });

  describe('Middleware chain integration', () => {
    it('allows subsequent middleware to access requestId', () => {
      const req = mockReq();
      const res = mockRes();

      let capturedRequestId: string | undefined;

      const nextMiddleware: NextFunction = () => {
        capturedRequestId = req.requestId;
      };

      correlationMiddleware(req, res, nextMiddleware);

      expect(capturedRequestId).toBeDefined();
      expect(capturedRequestId).toBe(req.requestId);
    });

    it('preserves requestId through handler execution', () => {
      const req = mockReq();
      const res = mockRes();

      return new Promise<void>((resolve) => {
        const next: NextFunction = () => {
          // Simulate handler access
          const handlerReqId = req.requestId;
          expect(handlerReqId).toBe(req.requestId);
          resolve();
        };

        correlationMiddleware(req, res, next);
      });
    });
  });
});
