import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

// Stub prom-client metrics
vi.mock('../src/metrics', () => ({
  httpRequestDuration: { observe: vi.fn() },
  httpRequestTotal: { inc: vi.fn() },
}));

import { metricsMiddleware } from '../src/middleware/metricsMiddleware';
import { httpRequestDuration, httpRequestTotal } from '../src/metrics';

type FinishListener = () => void;

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    method: 'GET',
    path: '/api/test',
    route: { path: '/api/test' },
    ...overrides,
  } as Request;
}

function makeRes(): { res: Response; triggerFinish: () => void } {
  const listeners: FinishListener[] = [];
  const res = {
    statusCode: 200,
    on: vi.fn((event: string, cb: FinishListener) => {
      if (event === 'finish') listeners.push(cb);
    }),
  } as unknown as Response;
  return { res, triggerFinish: () => listeners.forEach((fn) => fn()) };
}

describe('metricsMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls next immediately', () => {
    const next = vi.fn() as NextFunction;
    const { res } = makeRes();
    metricsMiddleware(makeReq(), res, next);
    expect(next).toHaveBeenCalled();
  });

  it('records duration and increments counter on finish', () => {
    const next = vi.fn() as NextFunction;
    const { res, triggerFinish } = makeRes();
    metricsMiddleware(makeReq(), res, next);
    triggerFinish();
    expect(httpRequestDuration.observe).toHaveBeenCalledOnce();
    expect(httpRequestTotal.inc).toHaveBeenCalledOnce();
  });

  it('uses correct method and status_code labels', () => {
    const next = vi.fn() as NextFunction;
    const req = makeReq({ method: 'POST' });
    const { res, triggerFinish } = makeRes();
    (res as any).statusCode = 201;
    metricsMiddleware(req, res, next);
    triggerFinish();
    const [labels] = (httpRequestTotal.inc as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(labels.method).toBe('POST');
    expect(labels.status_code).toBe('201');
  });

  it('normalises numeric path segments to :id', () => {
    const next = vi.fn() as NextFunction;
    const req = makeReq({ method: 'GET', path: '/api/transactions/12345', route: undefined });
    const { res, triggerFinish } = makeRes();
    metricsMiddleware(req, res, next);
    triggerFinish();
    const [labels] = (httpRequestDuration.observe as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(labels.route).toBe('/api/transactions/:id');
  });

  it('normalises UUID path segments to :id', () => {
    const next = vi.fn() as NextFunction;
    const uuid = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
    const req = makeReq({ method: 'GET', path: `/api/events/${uuid}`, route: undefined });
    const { res, triggerFinish } = makeRes();
    metricsMiddleware(req, res, next);
    triggerFinish();
    const [labels] = (httpRequestDuration.observe as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(labels.route).toBe('/api/events/:id');
  });

  // Performance: middleware itself should add negligible latency
  it('adds less than 5ms overhead before finish event', () => {
    const next = vi.fn() as NextFunction;
    const { res } = makeRes();
    const start = Date.now();
    metricsMiddleware(makeReq(), res, next);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5);
  });

  it('does not record metrics before finish is emitted', () => {
    const next = vi.fn() as NextFunction;
    const { res } = makeRes();
    metricsMiddleware(makeReq(), res, next);
    // finish not triggered yet
    expect(httpRequestDuration.observe).not.toHaveBeenCalled();
    expect(httpRequestTotal.inc).not.toHaveBeenCalled();
  });

  it('handles 5xx status codes correctly', () => {
    const next = vi.fn() as NextFunction;
    const { res, triggerFinish } = makeRes();
    (res as any).statusCode = 500;
    metricsMiddleware(makeReq(), res, next);
    triggerFinish();
    const [labels] = (httpRequestTotal.inc as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(labels.status_code).toBe('500');
  });
});
