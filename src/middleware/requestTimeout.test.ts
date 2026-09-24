/**
 * Unit tests for the request timeout middleware.
 *
 * Tests cover:
 * - Timeout firing after specified duration
 * - Correct route-to-timeout mapping
 * - Socket destruction on timeout
 * - No timeout when request completes in time
 * - Correct HTTP 408 response
 */

import { Request, Response } from 'express';
import { requestTimeout, setCustomTimeout, getTimeoutConfig } from './requestTimeout';
import { logger } from '../logger';

// Mock logger
jest.mock('../logger', () => ({
  logger: {
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  },
}));

describe('requestTimeout middleware', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();

    // Mock request
    req = {
      path: '/api/v1/transactions',
      url: '/api/v1/transactions?page=1',
      method: 'GET',
      ip: '192.168.1.100',
      socket: {
        destroy: jest.fn(),
        destroyed: false,
      } as any,
    } as any;

    // Mock response
    res = {
      headersSent: false,
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      on: jest.fn(function (this: any, event: string, handler: any) {
        // Store handlers for manual triggering in tests
        if (!this._handlers) this._handlers = {};
        this._handlers[event] = handler;
        return this;
      }),
      emit: jest.fn(),
    } as any;

    next = jest.fn();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('Route-to-timeout mapping', () => {
    it('should assign 5s timeout to health endpoints', () => {
      const healthRoutes = ['/health', '/livez', '/readyz', '/ready'];

      for (const route of healthRoutes) {
        req.path = route;
        const middleware = requestTimeout();
        middleware(req as Request, res as Response, next);

        // Fast timeout (5s) should fire first
        jest.advanceTimersByTime(5000);

        expect(res.status).toHaveBeenCalledWith(408);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'REQUEST_TIMEOUT' }));
      }
    });

    it('should assign 30s timeout to standard API endpoints', () => {
      const apiRoutes = [
        '/api/v1/transactions',
        '/api/v1/events',
        '/api/v1/contracts',
        '/api/v1/tokens',
      ];

      for (const route of apiRoutes) {
        jest.clearAllMocks();
        req.path = route;
        const middleware = requestTimeout();
        middleware(req as Request, res as Response, next);

        // Should not timeout at 5s
        jest.advanceTimersByTime(5000);
        expect(res.status).not.toHaveBeenCalled();

        // Should timeout at 30s
        jest.advanceTimersByTime(25000);
        expect(res.status).toHaveBeenCalledWith(408);
      }
    });

    it('should assign 5min timeout to analytics endpoints', () => {
      req.path = '/api/v1/analytics/query';
      const middleware = requestTimeout();
      middleware(req as Request, res as Response, next);

      // Should not timeout at 30s
      jest.advanceTimersByTime(30000);
      expect(res.status).not.toHaveBeenCalled();

      // Should timeout at 5min
      jest.advanceTimersByTime(270000);
      expect(res.status).toHaveBeenCalledWith(408);
    });

    it('should assign 15min timeout to bulk endpoints', () => {
      req.path = '/api/v1/bulk/import';
      const middleware = requestTimeout();
      middleware(req as Request, res as Response, next);

      // Should not timeout at 5min
      jest.advanceTimersByTime(300000);
      expect(res.status).not.toHaveBeenCalled();

      // Should timeout at 15min
      jest.advanceTimersByTime(600000);
      expect(res.status).toHaveBeenCalledWith(408);
    });

    it('should use default timeout for unmapped routes', () => {
      req.path = '/unknown/route';
      const middleware = requestTimeout();
      middleware(req as Request, res as Response, next);

      // Should use normal timeout (30s)
      jest.advanceTimersByTime(30000);
      expect(res.status).toHaveBeenCalledWith(408);
    });
  });

  describe('Timeout behavior', () => {
    it('should send 408 response on timeout', () => {
      req.path = '/api/v1/transactions';
      const middleware = requestTimeout();
      middleware(req as Request, res as Response, next);

      jest.advanceTimersByTime(30000);

      expect(res.status).toHaveBeenCalledWith(408);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Request Timeout',
        message: 'Request exceeded 30000ms timeout limit for transactions-api',
        code: 'REQUEST_TIMEOUT',
      });
    });

    it('should destroy socket on timeout', () => {
      req.path = '/api/v1/transactions';
      const middleware = requestTimeout();
      middleware(req as Request, res as Response, next);

      jest.advanceTimersByTime(30000);

      expect(req.socket!.destroy).toHaveBeenCalled();
    });

    it('should log warning when timeout fires', () => {
      req.path = '/api/v1/transactions';
      const middleware = requestTimeout();
      middleware(req as Request, res as Response, next);

      jest.advanceTimersByTime(30000);

      expect(logger.warn).toHaveBeenCalledWith(
        '[timeout] Request exceeded limit',
        expect.objectContaining({
          method: 'GET',
          path: '/api/v1/transactions',
          label: 'transactions-api',
          timeoutMs: 30000,
          remoteAddr: '192.168.1.100',
        }),
      );
    });

    it('should not timeout if response sent before timeout', () => {
      req.path = '/api/v1/transactions';
      const middleware = requestTimeout();
      middleware(req as Request, res as Response, next);

      // Simulate response being sent
      (res as any).headersSent = true;

      jest.advanceTimersByTime(30000);

      // Should not send 408 since headers already sent
      expect(res.status).not.toHaveBeenCalledWith(408);
    });

    it('should clear timeout on response finish', () => {
      req.path = '/api/v1/transactions';
      const middleware = requestTimeout();
      middleware(req as Request, res as Response, next);

      // Get the finish handler
      const handlers = (res as any)._handlers;
      handlers.finish();

      // Advance time past timeout — should not trigger
      jest.advanceTimersByTime(30000);

      expect(res.status).not.toHaveBeenCalledWith(408);
    });

    it('should clear timeout on response close', () => {
      req.path = '/api/v1/transactions';
      const middleware = requestTimeout();
      middleware(req as Request, res as Response, next);

      const handlers = (res as any)._handlers;
      handlers.close();

      jest.advanceTimersByTime(30000);

      expect(res.status).not.toHaveBeenCalledWith(408);
    });
  });

  describe('Configuration', () => {
    it('should export timeout configuration', () => {
      const config = getTimeoutConfig();

      expect(config).toHaveProperty('health-check', 5000);
      expect(config).toHaveProperty('transactions-api', 30000);
      expect(config).toHaveProperty('analytics-query', 300000);
      expect(config).toHaveProperty('bulk-operation', 900000);
    });

    it('should support custom timeout via setCustomTimeout', () => {
      setCustomTimeout(/^\/custom-slow/, 120000, 'custom-slow-endpoint');

      req.path = '/custom-slow/operation';
      const middleware = requestTimeout();
      middleware(req as Request, res as Response, next);

      // Custom timeout (2min) should fire
      jest.advanceTimersByTime(120000);
      expect(res.status).toHaveBeenCalledWith(408);
    });
  });

  describe('Edge cases', () => {
    it('should handle missing socket gracefully', () => {
      req.socket = undefined;
      req.path = '/api/v1/transactions';
      const middleware = requestTimeout();

      expect(() => {
        middleware(req as Request, res as Response, next);
        jest.advanceTimersByTime(30000);
      }).not.toThrow();
    });

    it('should handle already destroyed socket', () => {
      (req.socket as any).destroyed = true;
      req.path = '/api/v1/transactions';
      const middleware = requestTimeout();

      expect(() => {
        middleware(req as Request, res as Response, next);
        jest.advanceTimersByTime(30000);
      }).not.toThrow();
    });

    it('should call next() to allow request processing', () => {
      req.path = '/api/v1/transactions';
      const middleware = requestTimeout();
      middleware(req as Request, res as Response, next);

      expect(next).toHaveBeenCalled();
    });
  });
});
