import { describe, it, expect, vi } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { asyncHandler } from '../src/middleware/asyncHandler';

describe('Error Handling Integration', () => {
  it('should forward unhandled promise rejections to the global error handler', async () => {
    const app = express();

    // A mock route that throws an async error
    app.get(
      '/api/test-error',
      asyncHandler(async (_req: Request, _res: Response) => {
        throw new Error('Database connection failed');
      })
    );

    // Global error handler mock
    app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
      res.status(500).json({ error: err.message });
    });

    const response = await request(app).get('/api/test-error');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Database connection failed' });
  });

  it('should not affect successful responses', async () => {
    const app = express();

    app.get(
      '/api/test-success',
      asyncHandler(async (_req: Request, res: Response) => {
        res.status(200).json({ status: 'ok' });
      })
    );

    const response = await request(app).get('/api/test-success');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });
});
