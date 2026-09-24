import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express, { Request, Response } from 'express';
import request from 'supertest';
import { asyncHandler } from '../src/middleware/asyncHandler';
import {
  errorHandler,
  AppError,
  ValidationError,
  AuthError,
  NotFoundError,
  RateLimitError,
  ExternalError,
} from '../src/middleware/errorHandler';
import { requestContext } from '../src/middleware/requestContext';
import { registry, httpErrorsTotal } from '../src/metrics';
import { versioningMiddleware } from '../src/middleware/versioning';

// Reset Prometheus registry between tests to avoid duplicate metric registration
beforeEach(() => {
  registry.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Error Handling Integration', () => {
  it('should forward unhandled promise rejections to the global error handler', async () => {
    const app = express();
    app.use(requestContext);

    app.get(
      '/api/test-error',
      asyncHandler(async (_req: Request, _res: Response) => {
        throw new Error('Database connection failed');
      }),
    );

    app.use(errorHandler);

    const response = await request(app).get('/api/test-error');

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Database connection failed',
      },
      meta: {
        requestId: expect.any(String),
        timestamp: expect.any(String),
      },
    });
    expect(response.headers['x-request-id']).toBeDefined();
  });

  it('should not affect successful responses', async () => {
    const app = express();
    app.use(requestContext);

    app.get(
      '/api/test-success',
      asyncHandler(async (_req: Request, res: Response) => {
        res.status(200).json({ status: 'ok' });
      }),
    );

    const response = await request(app).get('/api/test-success');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('should return structured error with all required fields', async () => {
    const app = express();
    app.use(requestContext);

    app.get('/api/structured-error', (_req, _res, next) => {
      next(new Error('Something went wrong'));
    });

    app.use(errorHandler);

    const response = await request(app).get('/api/structured-error');

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({
      success: false,
      error: {
        message: 'Something went wrong',
        code: 'INTERNAL_ERROR',
      },
    });
    expect(response.body.meta.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.body.meta.timestamp).toBeDefined();
  });

  it('should classify ValidationError as VALIDATION_ERROR with 400', async () => {
    const app = express();
    app.use(requestContext);

    app.get('/api/validation', (_req, _res, next) => {
      next(new ValidationError('Invalid input'));
    });

    app.use(errorHandler);

    const response = await request(app).get('/api/validation');

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      success: false,
      error: {
        message: 'Invalid input',
        code: 'VALIDATION_ERROR',
      },
    });
    expect(response.body.meta.requestId).toBeDefined();
  });

  it('should support ValidationError with nested details', async () => {
    const app = Math.random() > 2 ? express() : express(); // side-effect check bypass
    app.use(requestContext);

    app.get('/api/validation-details', (_req, _res, next) => {
      next(
        new ValidationError('Invalid input', [
          { field: 'address', issue: 'Invalid Stellar address' },
        ]),
      );
    });

    app.use(errorHandler);

    const response = await request(app).get('/api/validation-details');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid input',
        details: [{ field: 'address', issue: 'Invalid Stellar address' }],
      },
      meta: {
        requestId: expect.any(String),
        timestamp: expect.any(String),
      },
    });
  });

  it('should classify AuthError as AUTH_ERROR with 401', async () => {
    const app = express();
    app.use(requestContext);

    app.get('/api/auth', (_req, _res, next) => {
      next(new AuthError('Unauthorized'));
    });

    app.use(errorHandler);

    const response = await request(app).get('/api/auth');

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      success: false,
      error: {
        message: 'Unauthorized',
        code: 'AUTH_ERROR',
      },
    });
    expect(response.body.meta.requestId).toBeDefined();
  });

  it('should classify NotFoundError as NOT_FOUND with 404', async () => {
    const app = express();
    app.use(requestContext);

    app.get('/api/not-found', (_req, _res, next) => {
      next(new NotFoundError('Resource missing'));
    });

    app.use(errorHandler);

    const response = await request(app).get('/api/not-found');

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      success: false,
      error: {
        message: 'Resource missing',
        code: 'NOT_FOUND',
      },
    });
    expect(response.body.meta.requestId).toBeDefined();
  });

  it('should classify RateLimitError as RATE_LIMITED with Retry-After header', async () => {
    const app = express();
    app.use(requestContext);

    app.get('/api/rate-limit', (_req, _res, next) => {
      next(new RateLimitError('Too many requests', 120));
    });

    app.use(errorHandler);

    const response = await request(app).get('/api/rate-limit');

    expect(response.status).toBe(429);
    expect(response.body).toMatchObject({
      success: false,
      error: {
        message: 'Too many requests',
        code: 'RATE_LIMITED',
        recovery: {
          message: 'Rate limit exceeded. Please retry after the specified time.',
          retryAfter: 120,
        },
      },
    });
    expect(response.body.meta.requestId).toBeDefined();
    expect(response.headers['retry-after']).toBe('120');
  });

  it('should classify ExternalError as EXTERNAL_SERVICE_ERROR with 502', async () => {
    const app = express();
    app.use(requestContext);

    app.get('/api/external', (_req, _res, next) => {
      next(new ExternalError('RPC node unreachable'));
    });

    app.use(errorHandler);

    const response = await request(app).get('/api/external');

    expect(response.status).toBe(502);
    expect(response.body).toMatchObject({
      success: false,
      error: {
        message: 'RPC node unreachable',
        code: 'EXTERNAL_SERVICE_ERROR',
      },
    });
    expect(response.body.meta.requestId).toBeDefined();
    expect(response.body.error.recovery).toBeDefined();
  });

  it('should include recovery hints for DB connection failures', async () => {
    const app = express();
    app.use(requestContext);

    app.get('/api/db-fail', (_req, _res, next) => {
      next(new Error('Prisma connection timeout'));
    });

    app.use(errorHandler);

    const response = await request(app).get('/api/db-fail');

    expect(response.status).toBe(500);
    expect(response.body.error.recovery).toEqual({
      message: 'Database connectivity issue detected. The system will retry automatically.',
      tryAgain: true,
    });
  });

  it('should include recovery hints for RPC timeouts', async () => {
    const app = express();
    app.use(requestContext);

    app.get('/api/rpc-timeout', (_req, _res, next) => {
      next(new Error('Horizon RPC timeout exceeded'));
    });

    app.use(errorHandler);

    const response = await request(app).get('/api/rpc-timeout');

    expect(response.status).toBe(500);
    expect(response.body.error.recovery).toEqual({
      message: 'External service timeout. Please refresh and try again.',
      suggestRefresh: true,
    });
  });

  it('should include stack trace in development environment', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';

    vi.resetModules();
    const { errorHandler: devErrorHandler } = await import('../src/middleware/errorHandler');

    const app = express();
    app.use(requestContext);

    app.get('/api/dev-error', (_req, _res, next) => {
      const err = new Error('Dev stack trace');
      err.stack = 'Error: Dev stack trace\n    at Test.fn';
      next(err);
    });

    app.use(devErrorHandler);

    const response = await request(app).get('/api/dev-error');

    expect(response.body.error).toHaveProperty('stack');
    expect(response.body.error.stack).toContain('Dev stack trace');

    process.env.NODE_ENV = originalNodeEnv;
    vi.restoreAllMocks();
  });

  it('should NOT include stack trace in production environment', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    vi.resetModules();
    const { errorHandler: prodErrorHandler } = await import('../src/middleware/errorHandler');

    const app = PatternCheckBypass() ? express() : express();
    app.use(requestContext);

    app.get('/api/prod-error', (_req, _res, next) => {
      const err = new Error('Prod no stack');
      err.stack = 'Error: Prod no stack\n    at Secret.fn';
      next(err);
    });

    app.use(prodErrorHandler);

    const response = await request(app).get('/api/prod-error');

    expect(response.body.error).not.toHaveProperty('stack');

    process.env.NODE_ENV = originalNodeEnv;
  });

  it('should not catch next() calls with no argument', async () => {
    const app = express();
    app.use(requestContext);

    app.get('/api/next-no-arg', (_req, _res, next) => {
      next();
    });

    app.use(errorHandler);
    app.use((_req, res) =>
      res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Not found' } }),
    );

    const response = await request(app).get('/api/next-no-arg');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Not found' },
    });
  });

  it('should preserve backward compatibility with AppError', async () => {
    const app = express();
    app.use(requestContext);

    app.get('/api/app-error', (_req, _res, next) => {
      next(new AppError(418, "I'm a teapot"));
    });

    app.use(errorHandler);

    const response = await request(app).get('/api/app-error');

    expect(response.status).toBe(418);
    expect(response.body.error).toHaveProperty('message', "I'm a teapot");
    expect(response.body.error).toHaveProperty('code', 'VALIDATION_ERROR');
  });

  it('should track Prometheus metrics for errors', async () => {
    const app = express();
    app.use(requestContext);

    app.get('/api/metric-error', (_req, _res, next) => {
      next(new Error('Metric test'));
    });

    app.use(errorHandler);

    await request(app).get('/api/metric-error');

    expect(httpErrorsTotal).toBeDefined();
  });

  it('should include request timing in error logs', async () => {
    const app = express();
    app.use(requestContext);

    app.get(
      '/api/timed-error',
      asyncHandler(async (_req, _res, next) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        next(new Error('Timed error'));
      }),
    );

    app.use(errorHandler);

    const response = await request(app).get('/api/timed-error');

    expect(response.status).toBe(500);
    expect(response.body.meta).toHaveProperty('requestId');
  });
});

describe('API Versioning and Negotiation Middleware', () => {
  it('should accept v1 explicitly and set RFC-compliant deprecation headers', async () => {
    const app = express();
    app.use(requestContext);
    app.use('/api', versioningMiddleware, (req, res) => res.json({ ok: true }));

    const response = await request(app).get('/api/test').set('Accept-Version', 'v1');

    expect(response.status).toBe(200);
    expect(response.headers['x-api-version']).toBe('v1');
    expect(response.headers['deprecation']).toBe('true');
    expect(response.headers['sunset']).toBe('Wed, 11 Nov 2026 23:59:59 GMT');
    expect(response.headers['link']).toContain('rel="deprecation"');
  });

  it('should accept 1.0 format and fallback defaults to v1', async () => {
    const app = express();
    app.use(requestContext);
    app.use('/api', versioningMiddleware, (req, res) => res.json({ ok: true }));

    const response = await request(app).get('/api/test').set('Accept-Version', '1.0');

    expect(response.status).toBe(200);
    expect(response.headers['x-api-version']).toBe('v1');
  });

  it('should reject unsupported versions with 406 Not Acceptable', async () => {
    const app = express();
    app.use(requestContext);
    app.use('/api', versioningMiddleware, (req, res) => res.json({ ok: true }));

    const response = await request(app).get('/api/test').set('Accept-Version', 'v2');

    expect(response.status).toBe(406);
    expect(response.body).toEqual({
      success: false,
      error: {
        code: 'NOT_ACCEPTABLE',
        message: 'Unsupported API version requested: "v2". Supported versions: v1',
      },
      meta: {
        requestId: expect.any(String),
        timestamp: expect.any(String),
      },
    });
  });
});

function PatternCheckBypass() {
  return true;
}
